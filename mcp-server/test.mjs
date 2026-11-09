// End to end: the real store API (scripts/local-store.mjs, in-memory database with demo data) and this MCP server
// started over stdio, the way Claude Desktop starts it. Run with: npm test (from mcp-server/).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PORT = 5099;
const STORE_URL = `http://127.0.0.1:${PORT}`;
const root = fileURLToPath(new URL('..', import.meta.url));
let store;

async function connect(env = {}) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', STORE_URL, ...env },
  }));
  return client;
}
const textOf = (result) => result.content.map((c) => c.text).join('\n');

before(async () => {
  store = spawn(process.execPath, ['scripts/local-store.mjs'], { cwd: root, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('local store did not start')), 120_000);
    store.stdout.on('data', (d) => d.toString().includes('Local store API') && (clearTimeout(timer), resolve()));
    store.on('exit', (code) => reject(new Error(`local store exited ${code}`)));
  });
});

after(() => store?.kill());

test('lists its tools, each with a description and input schema', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'get_product', 'list_complaints', 'list_returns', 'low_stock', 'my_orders', 'order_details', 'payment_history',
    'process_return', 'read_complaint', 'related_products', 'reply_to_complaint', 'search_products', 'trending_products', 'update_product',
  ]);
  assert.ok(tools.every((t) => t.description && t.inputSchema?.type === 'object'));
  assert.equal(tools.find((t) => t.name === 'search_products').annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === 'update_product').annotations.readOnlyHint, false);
  await client.close();
});

test('catalog tools work without an account; account tools say what they need', async () => {
  const client = await connect();
  const found = textOf(await client.callTool({ name: 'search_products', arguments: { category: 'mobiles', limit: 3 } }));
  assert.match(found, /^3 product\(s\):/);
  const id = found.match(/id ([0-9a-f]{24})/)[1];
  assert.match(textOf(await client.callTool({ name: 'get_product', arguments: { product_id: id } })), /stock \d+/);
  assert.match(textOf(await client.callTool({ name: 'trending_products', arguments: { limit: 2 } })), /id [0-9a-f]{24}/);
  const orders = await client.callTool({ name: 'my_orders', arguments: {} });
  assert.equal(orders.isError, true);
  assert.match(textOf(orders), /STORE_EMAIL/);
  await client.close();
});

test('a shopper sees their own orders, order timeline and payments', async () => {
  const client = await connect({ STORE_EMAIL: 'asha@example.com', STORE_PASSWORD: 'secret123' });
  const orders = textOf(await client.callTool({ name: 'my_orders', arguments: { limit: 5 } }));
  assert.match(orders, /#1 · .* · delivered/);
  assert.match(textOf(await client.callTool({ name: 'order_details', arguments: { order_id: 1 } })), /Timeline:\n- .*Order placed/);
  assert.match(textOf(await client.callTool({ name: 'payment_history', arguments: {} })), /^Paid ₹/);
  const notAdmin = await client.callTool({ name: 'low_stock', arguments: {} });
  assert.equal(notAdmin.isError, true); // the store API refuses: not the admin
  await client.close();
});

test('the admin handles returns, complaints and stock through the store API', async () => {
  const client = await connect({ STORE_EMAIL: 'owner@example.com', STORE_PASSWORD: 'secret123' });
  const returns = textOf(await client.callTool({ name: 'list_returns', arguments: {} }));
  const orderId = Number(returns.match(/Order #(\d+) .* approved/)[1]);
  assert.match(textOf(await client.callTool({ name: 'process_return', arguments: { order_id: orderId, action: 'receive' } })), /return received, refund cod_manual/);

  const tickets = textOf(await client.callTool({ name: 'list_complaints', arguments: {} }));
  const ticketId = Number(tickets.match(/#(\d+)/)[1]);
  assert.match(textOf(await client.callTool({ name: 'reply_to_complaint', arguments: { ticket_id: ticketId, message: 'Delivered today.', resolve: true } })), /marked it resolved/);
  assert.match(textOf(await client.callTool({ name: 'read_complaint', arguments: { ticket_id: ticketId } })), /resolved[\s\S]*Support .*: Delivered today\./);

  const product = textOf(await client.callTool({ name: 'search_products', arguments: { category: 'beauty', limit: 1 } })).match(/id ([0-9a-f]{24})/)[1];
  assert.match(textOf(await client.callTool({ name: 'update_product', arguments: { product_id: product, stock: 3 } })), /stock 3/);
  assert.match(textOf(await client.callTool({ name: 'low_stock', arguments: {} })), new RegExp(product));
  const bad = await client.callTool({ name: 'update_product', arguments: { product_id: product, price: 500, mrp: 100 } });
  assert.equal(bad.isError, true); // the store's own checks still apply
  assert.match(textOf(bad), /MRP/);
  await client.close();
});
