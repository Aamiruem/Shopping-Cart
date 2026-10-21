const crypto = require('crypto');
const { pool } = require('../config/postgres');
const { jwtSecret, otpTtlMinutes } = require('../config/env');

const MAX_ATTEMPTS = 5;
const RESEND_AFTER_SECONDS = 30;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Codes are stored as an HMAC, never in plain text
const hash = (code) => crypto.createHmac('sha256', jwtSecret).update(String(code)).digest('hex');

// Creates a 6-digit payment code for the user and returns it (the caller emails it)
async function createPaymentOtp(userId) {
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM NOW() - created_at) AS age FROM payment_otps
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (rows[0] && Number(rows[0].age) < RESEND_AFTER_SECONDS) {
    throw httpError(429, `Please wait ${Math.ceil(RESEND_AFTER_SECONDS - rows[0].age)} seconds before requesting a new code`);
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  // A new code replaces any earlier unused one
  await pool.query('UPDATE payment_otps SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await pool.query(
    `INSERT INTO payment_otps (user_id, code_hash, expires_at) VALUES ($1, $2, NOW() + make_interval(mins => $3))`,
    [userId, hash(code), otpTtlMinutes]
  );
  return code;
}

// Checks the user's latest code; consumes it on success. Throws a 400 with a helpful message otherwise.
async function verifyPaymentOtp(userId, code) {
  if (!/^\d{6}$/.test(String(code || ''))) throw httpError(400, 'Please enter the 6-digit code sent to your email');

  const { rows } = await pool.query(
    `SELECT * FROM payment_otps WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const otp = rows[0];
  if (!otp) throw httpError(400, 'No active code. Please request a new one.');
  if (new Date(otp.expires_at) < new Date()) throw httpError(400, 'This code has expired. Please request a new one.');
  if (otp.attempts >= MAX_ATTEMPTS) throw httpError(400, 'Too many wrong attempts. Please request a new code.');

  const matches = crypto.timingSafeEqual(Buffer.from(otp.code_hash), Buffer.from(hash(code)));
  if (!matches) {
    await pool.query('UPDATE payment_otps SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
    const left = MAX_ATTEMPTS - otp.attempts - 1;
    throw httpError(400, left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please request a new code.');
  }
  await pool.query('UPDATE payment_otps SET used_at = NOW() WHERE id = $1', [otp.id]);
}

module.exports = { createPaymentOtp, verifyPaymentOtp, httpError };
