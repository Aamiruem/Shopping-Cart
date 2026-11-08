// Gives an account the admin role: it can manage every product and order in the Seller Hub. Run from the repository root:
//   npm run make-admin -- you@example.com
import { neon } from '@neondatabase/serverless';

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email.includes('@')) throw new Error('Usage: npm run make-admin -- you@example.com');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set. Run: npx vercel env pull .env.local');
const sql = neon(process.env.DATABASE_URL);
const rows = await sql.query("UPDATE users SET role = 'admin' WHERE email = $1 RETURNING id, name", [email]);
console.log(rows.length ? `${rows[0].name} (${email}) is now an admin. Log out and back in to open the Seller Hub.` : `No account uses ${email}. Sign up on the store first.`);
