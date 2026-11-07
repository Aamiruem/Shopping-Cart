// Creates the tables on the Vercel store's database, using the backend's own schema so the full API can take over the
// same database later. Safe to run again. Run from the repository root: npm run db:setup
import { readFileSync } from 'node:fs';
import { Pool } from '@neondatabase/serverless';
import { STORE_SCHEMA } from '../api/_schema.mjs';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Run: npx vercel env pull .env.local');

const schema = readFileSync(new URL('../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics');

const pool = new Pool({ connectionString: url });
try {
  await pool.query(schema);
  await pool.query(STORE_SCHEMA);
  const { rows } = await pool.query("SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'");
  console.log(`Database ready: ${rows[0].tables} tables`);
} finally {
  await pool.end();
}
