const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { pool } = require('../config/postgres');
const { jwtSecret, jwtExpiresIn, googleClientId } = require('../config/env');
const v = require('../utils/validation');

const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null;

function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret, { expiresIn: jwtExpiresIn });
}

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  emailVerified: u.email_verified,
  hasPassword: Boolean(u.password_hash),
  googleLinked: Boolean(u.google_id),
  createdAt: u.created_at,
});

const session = (user) => ({ token: sign(user), user: publicUser(user) });

async function findUser(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0];
}

// GET /api/auth/config - tells the frontend which sign-in options are enabled
exports.config = (req, res) => res.json({ googleClientId: googleClientId || null });

// POST /api/auth/register  { name, email, password, phone? }
exports.register = async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = v.normalizeEmail(req.body.email);
  const phone = req.body.phone ? String(req.body.phone).trim() : null;
  const { password } = req.body;

  const error = v.nameError(name) || v.emailError(email) || v.phoneError(phone) || v.passwordError(password)
    || (await v.emailDomainError(email));
  if (error) return res.status(400).json({ error });

  const exists = await pool.query('SELECT google_id FROM users WHERE email = $1', [email]);
  if (exists.rowCount) {
    return res.status(409).json({
      error: exists.rows[0].google_id
        ? 'This email is registered with Google. Please use “Continue with Google”.'
        : 'An account with this email already exists. Please log in.',
    });
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    'INSERT INTO users (name, email, phone, password_hash, last_login) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
    [name, email, phone, hash]
  );
  res.status(201).json(session(rows[0]));
};

// POST /api/auth/login  { email, password }
exports.login = async (req, res) => {
  const email = v.normalizeEmail(req.body.email);
  if (v.emailError(email) || !req.body.password) return res.status(400).json({ error: 'Please enter your email and password' });

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (user && !user.password_hash) {
    return res.status(400).json({ error: 'This account uses Google sign-in. Please use “Continue with Google”.' });
  }
  if (!user || !(await bcrypt.compare(String(req.body.password), user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
  res.json(session(user));
};

// POST /api/auth/google  { credential } - ID token from Google Identity Services
exports.google = async (req, res) => {
  if (!googleClient) return res.status(501).json({ error: 'Google sign-in is not configured on the server' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: String(req.body.credential || ''), audience: googleClientId });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
  if (!payload.email || !payload.email_verified) {
    return res.status(401).json({ error: 'Your Google account email is not verified' });
  }

  const email = v.normalizeEmail(payload.email);
  const { rows } = await pool.query('SELECT * FROM users WHERE google_id = $1 OR email = $2 ORDER BY google_id NULLS LAST LIMIT 1', [payload.sub, email]);

  let user = rows[0];
  if (user) {
    // Existing account (password or Google): link it to this Google identity; Google has verified the email
    ({ rows: [user] } = await pool.query(
      'UPDATE users SET google_id = $1, email_verified = TRUE, last_login = NOW() WHERE id = $2 RETURNING *',
      [payload.sub, user.id]
    ));
  } else {
    ({ rows: [user] } = await pool.query(
      `INSERT INTO users (name, email, google_id, email_verified, last_login) VALUES ($1, $2, $3, TRUE, NOW()) RETURNING *`,
      [payload.name || email.split('@')[0], email, payload.sub]
    ));
  }
  res.status(rows[0] ? 200 : 201).json(session(user));
};

// GET /api/auth/me
exports.me = async (req, res) => {
  const user = await findUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(user));
};

// PUT /api/auth/me  { name, phone }
exports.updateProfile = async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = req.body.phone ? String(req.body.phone).trim() : null;
  const error = v.nameError(name) || v.phoneError(phone);
  if (error) return res.status(400).json({ error });

  const { rows } = await pool.query('UPDATE users SET name = $1, phone = $2 WHERE id = $3 RETURNING *', [name, phone, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(rows[0]));
};

// PUT /api/auth/password  { currentPassword, newPassword }
// Google-only accounts have no current password and may set one directly.
exports.changePassword = async (req, res) => {
  const { currentPassword = '', newPassword } = req.body;
  const error = v.passwordError(newPassword);
  if (error) return res.status(400).json({ error });

  const user = await findUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.password_hash && !(await bcrypt.compare(String(currentPassword), user.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const { rows } = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *', [await bcrypt.hash(newPassword, 10), user.id]);
  res.json(publicUser(rows[0]));
};
