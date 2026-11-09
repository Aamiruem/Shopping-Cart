#!/usr/bin/env node
// Arvixa Store MCP server: an AI assistant (Claude Desktop, Claude Code or any MCP client) can search the catalog,
// follow orders and payments, and, signed in as the store admin, handle returns, complaints, prices and stock.
//
// It talks only to the store's own HTTP API, so every rule the website enforces (who may see or change what, price
// checks, refund steps) applies here too. Nothing reaches the database directly.
//
// Settings (environment variables):
//   STORE_URL       the store, default https://arvixa-store.vercel.app (http://127.0.0.1:5000 with `npm run local`)
//   STORE_EMAIL     an account to act as, with STORE_PASSWORD; leave both out for catalog tools only
//   STORE_PASSWORD
//   STORE_TOKEN     or a login token instead of email and password
// Admin tools work only when that account is the store admin; the API refuses them otherwise.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** A small client for the store API: JSON in and out, a login when needed, readable errors. */
export function storeClient({ env = process.env, fetchImpl = fetch } = {}) {
  const base = (env.STORE_URL || 'https://arvixa-store.vercel.app').replace(/\/$/, '');
  let token = env.STORE_TOKEN || null;

  async function login() {
    if (token) return token;
    if (!env.STORE_EMAIL || !env.STORE_PASSWORD) {
      throw new Error('This tool needs a store account. Set STORE_EMAIL and STORE_PASSWORD (or STORE_TOKEN) for the MCP server.');
    }
    const res = await fetchImpl(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: env.STORE_EMAIL, password: env.STORE_PASSWORD }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Store login failed: ${data.error || res.status}`);
    token = data.token;
    return token;
  }

  async function call(method, path, { body, auth = false, query } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]))}` : '';
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bearer ${await login()}`;
    const res = await fetchImpl(`${base}/api${path}${qs}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (res.status === 401 && auth && !env.STORE_TOKEN) token = null; // log in again next time
    if (!res.ok) throw new Error(data?.error || data?.detail || `Store API error ${res.status}`);
    return data;
  }
  return { call, base };
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (err) => ({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
const tool = (fn) => async (args) => {
  try {
    return await fn(args ?? {});
  } catch (err) {
    return fail(err);
  }
};
const productLine = (p) =>
  `- ${p.name} (${p.brand || 'no brand'}, ${p.category}) · ${rupees(p.price)}${p.mrp > p.price ? ` (MRP ${rupees(p.mrp)})` : ''} · stock ${p.stock}` +
  `${p.reviewCount ? ` · ${p.reviewRating}★ from ${p.reviewCount} review${p.reviewCount === 1 ? '' : 's'}` : ''} · id ${p._id}`;

export function createServer(options = {}) {
  const store = storeClient(options);
  const server = new McpServer({ name: 'arvixa-store', version: '1.0.0' });
  const read = { readOnlyHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  // ---------- Catalog (no login) ----------
  server.registerTool('search_products', {
    title: 'Search products',
    description: 'Search the Arvixa Store catalog by words, category and price. Returns name, brand, price, stock, real review rating and product id.',
    inputSchema: {
      query: z.string().max(100).optional().describe('Words to look for, e.g. "running shoes"'),
      category: z.enum(['mobiles', 'electronics', 'fashion', 'accessories', 'beauty', 'home', 'kitchen', 'sports', 'grocery']).optional(),
      min_price: z.number().nonnegative().optional(),
      max_price: z.number().positive().optional(),
      sort: z.enum(['relevance', 'popularity', 'price_asc', 'price_desc', 'rating']).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    },
    annotations: read,
  }, tool(async ({ query, category, min_price, max_price, sort, limit = 10 }) => {
    const items = await store.call('GET', '/products', { query: { q: query, category, minPrice: min_price, maxPrice: max_price, sort, limit } });
    const list = Array.isArray(items) ? items : items.products || [];
    return text(list.length ? `${list.length} product(s):\n${list.map(productLine).join('\n')}` : 'No products match.');
  }));

  server.registerTool('get_product', {
    title: 'Product details',
    description: 'One product with its description, price, stock and what verified buyers rated it.',
    inputSchema: { product_id: z.string().regex(/^[0-9a-f]{24}$/).describe('24-character product id') },
    annotations: read,
  }, tool(async ({ product_id }) => {
    const [p, reviews] = await Promise.all([store.call('GET', `/products/${product_id}`), store.call('GET', `/products/${product_id}/reviews`).catch(() => null)]);
    const lines = [productLine(p), '', p.description || ''];
    if (reviews?.count) {
      lines.push('', `Ratings: ${reviews.average}★ from ${reviews.count} verified buyer(s); 5★ ${reviews.histogram[5]}, 4★ ${reviews.histogram[4]}, 3★ ${reviews.histogram[3]}, 2★ ${reviews.histogram[2]}, 1★ ${reviews.histogram[1]}`);
      reviews.items.slice(0, 5).forEach((r) => lines.push(`- ${r.rating}★ ${r.title || ''} ${r.body ? `"${r.body.slice(0, 200)}"` : ''} (${r.author}, ${day(r.createdAt)})`));
    } else lines.push('', 'No reviews yet.');
    return text(lines.join('\n'));
  }));

  server.registerTool('trending_products', {
    title: 'Trending products',
    description: 'What shoppers are buying and browsing right now (orders, carts, wishlists and views, recent activity counting most).',
    inputSchema: { category: z.string().optional(), limit: z.number().int().min(1).max(30).default(10) },
    annotations: read,
  }, tool(async ({ category, limit = 10 }) => {
    const list = await store.call('GET', '/recommendations/trending', { query: { category, k: limit } });
    return text(list.length ? list.map(productLine).join('\n') : 'Nothing trending yet.');
  }));

  server.registerTool('related_products', {
    title: 'Bought or viewed together',
    description: 'Products bought in the same orders as this one, then viewed by the same shoppers, then similar products.',
    inputSchema: { product_id: z.string().regex(/^[0-9a-f]{24}$/), limit: z.number().int().min(1).max(12).default(6) },
    annotations: read,
  }, tool(async ({ product_id, limit = 6 }) => {
    const { strategy, items } = await store.call('GET', `/recommendations/together/${product_id}`, { query: { k: limit } });
    const why = { bought_together: 'Frequently bought together', similar_shoppers: 'Viewed by the same shoppers', similar: 'Similar products' }[strategy] || strategy;
    return text(`${why}:\n${items.map(productLine).join('\n')}`);
  }));

  // ---------- The signed-in account ----------
  server.registerTool('my_orders', {
    title: 'My orders',
    description: 'Orders of the signed-in account with status, delivery progress and total.',
    inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
    annotations: read,
  }, tool(async ({ limit = 10 }) => {
    const orders = (await store.call('GET', '/orders', { auth: true })).slice(0, limit);
    if (!orders.length) return text('No orders yet.');
    return text(orders.map((o) => {
      const steps = ['pending', 'packed', 'shipped', 'delivered'];
      const stage = steps[Math.min(...o.items.map((i) => steps.indexOf(i.fulfilment ?? 'pending')))];
      return `#${o.id} · ${day(o.created_at)} · ${o.status === 'placed' ? stage : o.status} · ${rupees(o.total)} · ${o.payment_method} · ${o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}`;
    }).join('\n'));
  }));

  server.registerTool('order_details', {
    title: 'Order details',
    description: 'One order: items, address, payment, its full timeline, tracking, and any return or refund.',
    inputSchema: { order_id: z.number().int().positive() },
    annotations: read,
  }, tool(async ({ order_id }) => {
    const o = await store.call('GET', `/orders/${order_id}`, { auth: true });
    const lines = [
      `Order #${o.id}, ${o.status}, placed ${day(o.created_at)}, total ${rupees(o.total)} (${o.payment_method}, payment ${o.payment_status || 'n/a'})`,
      `Ship to: ${o.address}`,
      'Items:', ...o.items.map((i) => `- ${i.qty}× ${i.name} at ${rupees(i.price)} · ${i.fulfilment}${i.tracking_number ? ` · ${i.courier || 'courier'} ${i.tracking_number}` : ''}`),
      'Timeline:', ...(o.events || []).map((e) => `- ${day(e.created_at)}: ${e.note || e.status}`),
    ];
    if (o.return) lines.push(`Return: ${o.return.status}${o.return.refund ? `, refund ${o.return.refund}` : ''} (${o.return.reason})`);
    return text(lines.join('\n'));
  }));

  server.registerTool('payment_history', {
    title: 'Payment history',
    description: 'Every payment and refund of the signed-in account, with totals paid, refunded and still on the way.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    annotations: read,
  }, tool(async ({ limit = 20 }) => {
    const { summary, entries } = await store.call('GET', '/payments/history', { auth: true });
    return text([
      `Paid ${rupees(summary.paid)} · refunded ${rupees(summary.refunded)} · refunds on the way ${rupees(summary.refundPending)} · due on delivery ${rupees(summary.dueOnDelivery)}`,
      ...entries.slice(0, limit).map((e) => `- ${day(e.date)} ${e.kind}${e.order ? ` order #${e.order.id}` : ''}: ${rupees(e.amount)} via ${e.method} · ${e.status}${e.reference ? ` · ref ${e.reference}` : ''}`),
    ].join('\n'));
  }));

  // ---------- Store admin ----------
  server.registerTool('list_returns', {
    title: 'Return requests (admin)',
    description: 'Return requests waiting for a decision, a pickup or a refund (or all of them).',
    inputSchema: { view: z.enum(['open', 'all']).default('open') },
    annotations: read,
  }, tool(async ({ view = 'open' }) => {
    const list = await store.call('GET', '/seller/returns', { auth: true, query: { view } });
    if (!list.length) return text('No return requests.');
    return text(list.map((r) => `Order #${r.order_id} · ${r.customer} · ${rupees(r.amount ?? r.total)} · ${r.status}${r.refund ? ` · refund ${r.refund}` : ''} · ${r.reason} · refund to ${r.refund_to}`).join('\n'));
  }));

  server.registerTool('process_return', {
    title: 'Move a return along (admin)',
    description: 'approve (book pickup), reject (note required, the customer sees it), receive (item picked up: the refund goes out), or refund (retry an online refund, or record a bank/UPI transfer with its UTR reference).',
    inputSchema: {
      order_id: z.number().int().positive(),
      action: z.enum(['approve', 'reject', 'receive', 'refund']),
      note: z.string().max(500).optional(),
      reference: z.string().max(30).optional().describe('UTR of a manual bank or UPI refund'),
    },
    annotations: write,
  }, tool(async ({ order_id, action, note, reference }) => {
    const r = await store.call('PATCH', `/seller/returns/${order_id}`, { auth: true, body: { action, note, reference } });
    return text(`Order #${order_id}: return ${r.status}${r.refund ? `, refund ${r.refund}` : ''}.`);
  }));

  server.registerTool('list_complaints', {
    title: 'Customer complaints (admin)',
    description: 'Support tickets, unresolved and most urgent first, with team, priority and order.',
    inputSchema: { status: z.enum(['open', 'in_progress', 'resolved']).optional() },
    annotations: read,
  }, tool(async ({ status }) => {
    const list = await store.call('GET', '/support/tickets', { auth: true, query: { status } });
    if (!list.length) return text('No tickets.');
    return text(list.map((t) => `#${t.id} [${t.priority}] ${t.status} · ${t.categoryLabel} · ${t.customer_name || ''}${t.order_id ? ` · order #${t.order_id}` : ''}: ${t.subject}`).join('\n'));
  }));

  server.registerTool('read_complaint', {
    title: 'Read a complaint',
    description: 'One ticket with its whole conversation.',
    inputSchema: { ticket_id: z.number().int().positive() },
    annotations: read,
  }, tool(async ({ ticket_id }) => {
    const t = await store.call('GET', `/support/tickets/${ticket_id}`, { auth: true });
    return text([
      `#${t.id} ${t.subject} · ${t.status} · ${t.priority} · ${t.categoryLabel}${t.order_id ? ` · order #${t.order_id}` : ''}`,
      `Customer: ${t.message}`,
      ...(t.messages || []).map((m) => `${m.staff ? 'Support' : 'Customer'} (${day(m.created_at)}): ${m.body}`),
    ].join('\n'));
  }));

  server.registerTool('reply_to_complaint', {
    title: 'Reply to a complaint (admin)',
    description: 'Send a reply the customer sees on their account, and optionally mark the ticket resolved.',
    inputSchema: { ticket_id: z.number().int().positive(), message: z.string().min(2).max(4000), resolve: z.boolean().default(false) },
    annotations: write,
  }, tool(async ({ ticket_id, message, resolve = false }) => {
    await store.call('POST', `/support/tickets/${ticket_id}/messages`, { auth: true, body: { message } });
    if (resolve) await store.call('PATCH', `/support/tickets/${ticket_id}`, { auth: true, body: { status: 'resolved' } });
    return text(`Replied to ticket #${ticket_id}${resolve ? ' and marked it resolved' : ''}.`);
  }));

  server.registerTool('low_stock', {
    title: 'Low stock (admin)',
    description: 'Store catalog products with fewer than 10 left.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    annotations: read,
  }, tool(async ({ limit = 20 }) => {
    const { items, total } = await store.call('GET', '/seller/catalog', { auth: true, query: { status: 'low_stock', limit } });
    return text(total ? `${total} product(s) low on stock:\n${items.map(productLine).join('\n')}` : 'Nothing is low on stock.');
  }));

  server.registerTool('update_product', {
    title: 'Edit a store product (admin)',
    description: 'Change price, MRP, stock on the shelf, name or description of a store catalog product, or hide/list it. Shoppers see it within a minute.',
    inputSchema: {
      product_id: z.string().regex(/^[0-9a-f]{24}$/),
      price: z.number().positive().optional(),
      mrp: z.number().positive().optional(),
      stock: z.number().int().min(0).optional(),
      name: z.string().min(3).max(200).optional(),
      description: z.string().max(5000).optional(),
      listed: z.boolean().optional(),
    },
    annotations: write,
  }, tool(async ({ product_id, listed, ...changes }) => {
    const body = { ...changes, ...(listed === undefined ? {} : { active: listed }) };
    const p = await store.call('PATCH', `/seller/catalog/${product_id}`, { auth: true, body });
    return text(`Saved: ${productLine(p)}${p.active ? '' : ' · hidden from the store'}`);
  }));

  return server;
}

// Run over stdio when started directly (not when a test imports it). Logs go to stderr: stdout carries the protocol.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`Arvixa Store MCP server ready (store: ${storeClient().base})`);
}
