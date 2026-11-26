// Authenticator-app MFA (TOTP, RFC 6238: 6 digits, 30-second steps, SHA-1) for admin-portal accounts. Works with
// Google Authenticator, Microsoft Authenticator, Authy and the like. The shared secret is stored encrypted
// (AES-256-GCM, key from MFA_ENCRYPTION_KEY or JWT_SECRET) and each time step can be used once.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function fromBase32(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretBase32, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', fromBase32(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}
export const currentStep = (now = Date.now()) => Math.floor(now / 30_000);

/** The matching time step (one step either side allows for clock drift), or null */
export function matchStep(secretBase32, code, now = Date.now()) {
  const given = String(code ?? '').trim();
  if (!/^\d{6}$/.test(given)) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (timingSafeEqual(Buffer.from(totp(secretBase32, s)), Buffer.from(given))) return s;
  }
  return null;
}

export const newSecret = () => base32(randomBytes(20));
export const otpauthUrl = (secret, account, issuer = 'Arvixa Admin') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

const key = (env = process.env) => createHash('sha256').update(`mfa:${env.MFA_ENCRYPTION_KEY || env.JWT_SECRET || ''}`).digest();
export function seal(plain, env = process.env) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(env), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}
export function unseal(sealed, env = process.env) {
  if (!sealed) return null;
  try {
    const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key(env), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Checks an admin's code against their enabled secret and records the step, so the same code can't be used twice.
 * Returns true / false.
 */
export async function verifyUserCode(db, user, code) {
  const secret = unseal(user.mfa_secret);
  if (!secret) return false;
  const step = matchStep(secret, code);
  if (step === null) return false;
  const [used] = await db('UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2) RETURNING id', [user.id, step]);
  return Boolean(used);
}
