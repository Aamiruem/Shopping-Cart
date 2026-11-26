// Run with: npm test (from frontend/). The live database updates itself (ensureStoreSchema in api/_auth.mjs): a deploy
// whose STORE_SCHEMA is newer than the database applies it once, before its first query. On PGlite, a real PostgreSQL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { ensureStoreSchema, safely, STORE_SCHEMA_VERSION } from '../../api/_auth.mjs';

const BASE = readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics');

// The same shape as the Neon adapter: `check` is one statement, `open` a session that also runs whole scripts
function adapter(pg) {
  const opened = { count: 0 };
  const query = async (statement, params) => (params ? (await pg.query(statement, params)).rows : (await pg.exec(statement)).at(-1)?.rows ?? []);
  return {
    opened,
    check: async (statement) => (await pg.query(statement)).rows,
    open: async () => {
      opened.count += 1;
      return { query, close: async () => {} };
    },
  };
}

const columns = async (pg, table) => (await pg.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table])).rows.map((r) => r.column_name);

test('a database that missed db:setup is brought up to date before use, once', async () => {
  const pg = new PGlite();
  await pg.exec(BASE); // the live database as it was: the backend schema only, none of the store's later changes
  await pg.query("INSERT INTO users (name, email, password_hash) VALUES ('Asha', 'asha@example.com', 'x')");
  assert.ok(!(await columns(pg, 'users')).includes('disabled_at'));

  const db = adapter(pg);
  assert.equal(await ensureStoreSchema(db), 'updated');
  assert.ok((await columns(pg, 'users')).includes('disabled_at'), 'sign-in reads users.disabled_at');
  assert.ok((await columns(pg, 'sellers')).includes('seller_code'), 'seller applications need the new seller columns');
  assert.match((await pg.query("SELECT customer_code FROM users WHERE email = 'asha@example.com'")).rows[0].customer_code, /^ARV-CUS-\d{4}-\d{6}$/);
  assert.equal((await pg.query("SELECT value FROM store_meta WHERE key = 'store_schema'")).rows[0].value, STORE_SCHEMA_VERSION);

  // Every later request on this or any other instance: one small check, no session, no update
  assert.equal(await ensureStoreSchema(db), 'current');
  assert.equal(db.opened.count, 1);
  await pg.close();
});

test('the next deploy with a changed schema applies it again, safely, keeping the data', async () => {
  const pg = new PGlite();
  await pg.exec(BASE);
  const db = adapter(pg);
  await ensureStoreSchema(db);
  await pg.query("INSERT INTO users (name, email, password_hash) VALUES ('Ravi', 'ravi@example.com', 'x')");
  const before = (await pg.query("SELECT customer_code FROM users WHERE email = 'ravi@example.com'")).rows[0].customer_code;
  await pg.query("UPDATE store_meta SET value = 'older-deploy' WHERE key = 'store_schema'");

  assert.equal(await ensureStoreSchema(db), 'updated');
  const after = (await pg.query("SELECT customer_code FROM users WHERE email = 'ravi@example.com'")).rows[0].customer_code;
  assert.equal(after, before, 'existing customer numbers are never rewritten');
  assert.equal((await pg.query("SELECT value FROM store_meta WHERE key = 'store_schema'")).rows[0].value, STORE_SCHEMA_VERSION);
  await pg.close();
});

test('an unexpected server error carries a reference that also goes to the logs', async () => {
  process.env.JWT_SECRET ||= 'test-secret-for-schema-tests-0123456789';
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const res = await safely(async () => {
      throw new Error('column "disabled_at" does not exist');
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /^Something went wrong\. Please try again\. \(ref [0-9a-f]{8}\)$/);
    assert.doesNotMatch(res.body.error, /disabled_at/, 'no internals reach the user');
    assert.ok(logged.some((line) => line.includes(`ref ${res.body.ref}`) && line.includes('disabled_at')));
  } finally {
    console.error = original;
  }
});
