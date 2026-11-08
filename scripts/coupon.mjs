// Create and manage coupon codes on the store's database. Run from the repository root:
//   npm run coupon -- add DIWALI10 --percent 10 --max 300 --min 999 --until 2026-11-15 --desc "10% off festive orders"
//   npm run coupon -- add WELCOME100 --flat 100 --min 499 --private
//   npm run coupon -- list
//   npm run coupon -- disable DIWALI10
// Each customer can use a code once; cancelling the order gives the use back.
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Run: npx vercel env pull .env.local');
const sql = neon(url);
const [command, code, ...rest] = process.argv.slice(2);

function options(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i].replace(/^--/, '');
    const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[(i += 1)] : true;
    out[key] = value;
  }
  return out;
}

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (command === 'add') {
  const o = options(rest);
  const name = String(code || '').toUpperCase();
  if (!/^[A-Z0-9_-]{3,30}$/.test(name)) fail('Code: 3-30 letters, digits, - or _');
  const kind = o.percent ? 'percent' : o.flat ? 'flat' : fail('Give --percent N or --flat N');
  const value = Number(o.percent ?? o.flat);
  if (!(value > 0) || (kind === 'percent' && value > 90)) fail('The discount must be above 0 (and at most 90%)');
  if (kind === 'percent' && !o.max) console.warn('Tip: add --max to cap a percentage discount on big orders');
  const until = o.until ? new Date(`${o.until}T23:59:59+05:30`) : null; // end of that day in India
  const desc = o.desc || (kind === 'percent' ? `${value}% off${o.max ? ` up to ₹${o.max}` : ''}` : `₹${value} off`) + (o.min ? ` on orders of ₹${o.min} or more` : '');
  await sql.query(
    `INSERT INTO coupons (code, description, kind, value, min_order, max_discount, ends_at, public)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [name, desc, kind, value, Number(o.min || 0), o.max ? Number(o.max) : null, until, !o.private],
  );
  console.log(`Added ${name}: ${desc}${until ? `, until ${o.until}` : ''}${o.private ? ' (private)' : ''}`);
} else if (command === 'list') {
  const rows = await sql.query(
    `SELECT c.code, c.description, c.active, c.public, c.ends_at, count(r.order_id)::int AS uses
       FROM coupons c LEFT JOIN coupon_redemptions r ON r.code = c.code GROUP BY c.code ORDER BY c.created_at DESC`,
  );
  console.table(rows.map((r) => ({ code: r.code, offer: r.description, active: r.active, listed: r.public, ends: r.ends_at?.toISOString().slice(0, 10) ?? '', uses: r.uses })));
} else if (command === 'disable') {
  const rows = await sql.query('UPDATE coupons SET active = FALSE WHERE code = $1 RETURNING code', [String(code || '').toUpperCase()]);
  console.log(rows.length ? `Disabled ${rows[0].code}` : 'No such coupon');
} else {
  fail('Usage: npm run coupon -- add CODE (--percent N | --flat N) [--max N] [--min N] [--until YYYY-MM-DD] [--desc "..."] [--private] | list | disable CODE');
}
