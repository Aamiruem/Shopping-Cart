// Makes an account the store admin on the live (Neon) database, creating the account first if it doesn't exist yet,
// and optionally records its mobile number. The admin signs in at /admin/login (the admin portal: CRM and Seller Hub),
// not at the customer /login. Run from the repository root:
//   npm run make-admin -- you@example.com [9876543210]
// An existing account keeps its password. For a new account the script asks for one (hidden), or reads ADMIN_PASSWORD.
import bcrypt from 'bcryptjs';
import { neon } from '@neondatabase/serverless';
import { createInterface } from 'node:readline';

const email = String(process.argv[2] || '').trim().toLowerCase();
const phone = String(process.argv[3] || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Usage: npm run make-admin -- you@example.com [mobile]');
if (phone && !/^[6-9]\d{9}$/.test(phone)) throw new Error('The mobile number must be 10 digits starting with 6, 7, 8 or 9');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set. Run: npx vercel env pull .env.local');
const sql = neon(process.env.DATABASE_URL);

// Same rules as store sign-up (api/_auth.mjs)
function passwordError(password) {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (Buffer.byteLength(password) > 72) return 'Password must be at most 72 characters';
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return 'Password must contain at least one letter and one number';
  return null;
}

// Reads a line without echoing it
function ask(question, hidden = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : s.replace(/[^\r\n]/g, '*'));
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), hidden && process.stdout.write('\n'), resolve(answer))));
}

const [existing] = await sql.query('SELECT id FROM users WHERE email = $1', [email]);
if (!existing) {
  console.log(`No account uses ${email} yet, so a new admin account will be created.`);
  const name = (process.env.ADMIN_NAME || (await ask('Name (Store Admin): ')).trim() || 'Store Admin').slice(0, 100);
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Choose a password: ', true);
    if ((await ask('Type it again: ', true)) !== password) throw new Error('The two passwords do not match. Nothing was changed.');
  }
  const error = passwordError(password);
  if (error) throw new Error(`${error}. Nothing was changed.`);
  await sql.query('INSERT INTO users (name, email, password_hash, email_verified) VALUES ($1, $2, $3, TRUE)', [name, email, await bcrypt.hash(password, 10)]);
}

const rows = await sql.query(
  `UPDATE users SET role = 'admin', disabled_at = NULL,
          phone = COALESCE($2::varchar, phone),
          phone_verified = CASE WHEN $2::varchar IS NULL OR phone IS NOT DISTINCT FROM $2::varchar THEN phone_verified ELSE FALSE END
    WHERE email = $1 RETURNING id, name, phone`,
  [email, phone || null],
);
console.log(
  `${rows[0].name} (${email}) is now the store admin${rows[0].phone ? `, mobile ${rows[0].phone}` : ''}. ` +
    `Sign in at /admin/login with ${existing ? "this account's existing" : 'the new'} password.`,
);
