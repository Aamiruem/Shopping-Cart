const dns = require('dns').promises;

// Keep these rules in sync with frontend/src/utils/validation.js
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[6-9]\d{9}$/; // Indian 10-digit mobile number
const PASSWORD_MIN = 8;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

function emailError(email) {
  if (!email) return 'Please enter your email address';
  if (email.length > 254 || !EMAIL_RE.test(email) || email.includes('..')) return 'Please enter a valid email address';
  return null;
}

// Rejects domains that cannot receive mail (typos like "gmail.con").
// If DNS itself is unavailable we let the address through rather than block signups.
async function emailDomainError(email) {
  const domain = email.split('@')[1];
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 3000)),
    ]);
    return records.length ? null : `“${domain}” can’t receive email. Please check the address.`;
  } catch (err) {
    if (['ENOTFOUND', 'ENODATA', 'ESERVFAIL'].includes(err.code)) return `“${domain}” can’t receive email. Please check the address.`;
    return null;
  }
}

function phoneError(phone) {
  if (!phone) return null; // optional
  return PHONE_RE.test(phone) ? null : 'Please enter a valid 10-digit mobile number starting with 6, 7, 8 or 9';
}

function passwordError(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > 72) return 'Password must be at most 72 characters'; // bcrypt limit
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return 'Password must contain at least one letter and one number';
  return null;
}

function nameError(name) {
  if (name.length < 2) return 'Please enter your full name';
  if (name.length > 100) return 'Name is too long';
  return null;
}

module.exports = { EMAIL_RE, PHONE_RE, normalizeEmail, emailError, emailDomainError, phoneError, passwordError, nameError };
