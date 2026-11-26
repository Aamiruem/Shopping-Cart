// Creates the tables on the Vercel store's database, using the backend's own schema so the full API can take over the
// same database later. Safe to run again. Run from the repository root: npm run db:setup
import { readFileSync } from 'node:fs';
import { Pool } from '@neondatabase/serverless';
import { STORE_SCHEMA_VERSION } from '../api/_auth.mjs';
import { STORE_SCHEMA } from '../api/_schema.mjs';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Run: npx vercel env pull .env.local');

const schema = readFileSync(new URL('../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics');

const pool = new Pool({ connectionString: url });
try {
  await pool.query(schema);
  await pool.query(STORE_SCHEMA);
  // Same record the API keeps (ensureStoreSchema in api/_auth.mjs), so a deploy of this code doesn't apply it again
  await pool.query('CREATE TABLE IF NOT EXISTS store_meta (key VARCHAR(40) PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query(
    `INSERT INTO store_meta (key, value) VALUES ('store_schema', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [STORE_SCHEMA_VERSION],
  );
  // Product verification is NOT switched on here: that is a business decision (the unverified catalogue becomes
  // Coming Soon and nothing can be bought). The admin switches it on in CRM → Product verification when ready.
  const { rows } = await pool.query("SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'");
  console.log(`Database ready: ${rows[0].tables} tables`);
} finally {
  await pool.end();
}
