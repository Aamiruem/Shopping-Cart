// Run with: npm test (from frontend/, after `npm ci` in the repository root). Covers the account routes in api/_auth.mjs
// against an in-memory store; the SQL itself is exercised on a real database after each deploy.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createToken, handleAuth, isAuthRoute } from '../../api/_auth.mjs';

const GOOD = { name: 'Asha Rao', email: 'Asha@Example.com ', password: 'secret123' };

function memoryStore() {
  const users = new Map();
  const hits = new Map();
  return {
    users,
    hits,
    findByEmail: async (email) => [...users.values()].find((u) => u.email === email) ?? null,
    findById: async (id) => users.get(id) ?? null,
    async create({ name, email, phone, passwordHash }) {
      if ([...users.values()].some((u) => u.email === email)) return null;
      const user = { id: users.size + 1, name, email, phone, password_hash: passwordHash, role: 'customer', email_verified: false, google_id: null, created_at: 'now' };
      users.set(user.id, user);
      return user;
    },
    touchLogin: async () => {},
    async updateProfile(id, changes) {
      if (!users.has(id)) return null;
      return Object.assign(users.get(id), changes);
    },
    updatePassword: async (id, hash) => Object.assign(users.get(id), { password_hash: hash }),
    storeName: async () => 'My Store',
    async hit(key) {
      hits.set(key, (hits.get(key) ?? 0) + 1);
      return { hits: hits.get(key), retryAfter: 900 };
    },
  };
}

let store;
const domainError = async () => null;
const call = (method, rest, body, extra = {}) => handleAuth({ method, rest, body, ip: '1.2.3.4', ...extra }, { store, domainError });
const bearer = (token) => ({ authorization: `Bearer ${token}` });

beforeEach(() => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  store = memoryStore();
});

test('signup creates a customer, signs in and never returns the password hash', async () => {
  const { status, body } = await call('POST', 'register', { ...GOOD, role: 'admin' });
  assert.equal(status, 201);
  assert.equal(body.user.email, 'asha@example.com');
  assert.equal(body.user.role, 'customer'); // the request can't choose its own role
  assert.equal(body.user.emailVerified, false);
  assert.ok(!JSON.stringify(body).includes(store.users.get(1).password_hash));
  assert.notEqual(store.users.get(1).password_hash, GOOD.password);
});

test('the same email cannot sign up twice, whatever its case', async () => {
  await call('POST', 'register', GOOD);
  const { status } = await call('POST', 'register', { ...GOOD, email: 'ASHA@example.com' });
  assert.equal(status, 409);
});

test('signup rejects bad input', async () => {
  const cases = [{ name: 'A' }, { email: 'nope' }, { email: undefined }, { phone: '12345' }, { password: 'short1' }, { password: 'lettersonly' }, { password: `a1${'x'.repeat(80)}` }, { password: 12345678 }];
  for (const change of cases) {
    const { status, body } = await call('POST', 'register', { ...GOOD, ...change });
    assert.equal(status, 400, JSON.stringify(change));
    assert.ok(body.error);
  }
});

test('login works only with the right password, and both failures look the same', async () => {
  await call('POST', 'register', GOOD);
  assert.equal((await call('POST', 'login', { email: 'asha@example.com', password: GOOD.password })).status, 200);
  const wrong = await call('POST', 'login', { email: 'asha@example.com', password: 'wrongpass1' });
  const unknown = await call('POST', 'login', { email: 'nobody@example.com', password: 'wrongpass1' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('login accepts a hash in the Python backend format', async () => {
  const python = `$2b$${(await bcrypt.hash('secret123', 10)).slice(4)}`;
  await store.create({ name: 'Old User', email: 'old@example.com', phone: null, passwordHash: python });
  assert.equal((await call('POST', 'login', { email: 'old@example.com', password: 'secret123' })).status, 200);
});

test('tokens have the backend format', async () => {
  const { body } = await call('POST', 'register', GOOD);
  const payload = jwt.verify(body.token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  assert.deepEqual([payload.id, payload.email, payload.role], [1, 'asha@example.com', 'customer']);
  assert.equal(payload.exp - payload.iat, 7 * 24 * 60 * 60);
});

test('me needs a valid token', async () => {
  const { body } = await call('POST', 'register', GOOD);
  const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"id":1}').toString('base64url')}.`;
  assert.equal((await call('GET', 'me')).status, 401);
  assert.equal((await call('GET', 'me', null, bearer('garbage'))).status, 401);
  assert.equal((await call('GET', 'me', null, bearer(unsigned))).status, 401);
  assert.equal((await call('GET', 'me', null, bearer(jwt.sign({ id: 1 }, 'y'.repeat(40))))).status, 401); // forged
  assert.equal((await call('GET', 'me', null, bearer(jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: -10 })))).status, 401); // expired
  const me = await call('GET', 'me', null, bearer(body.token));
  assert.equal(me.status, 200);
  assert.equal(me.body.name, 'Asha Rao');
});

test('without a strong JWT_SECRET accounts refuse to work instead of using a default', async () => {
  for (const secret of [undefined, 'dev-secret']) {
    if (secret) process.env.JWT_SECRET = secret;
    else delete process.env.JWT_SECRET;
    assert.equal((await call('POST', 'register', GOOD)).status, 503);
    assert.equal((await call('GET', 'me', null, bearer('anything'))).status, 503);
  }
});

test('profile update changes only the signed-in account', async () => {
  const first = await call('POST', 'register', GOOD);
  await call('POST', 'register', { ...GOOD, email: 'other@example.com' });
  const { status, body } = await call('PUT', 'me', { name: 'Asha R', phone: '9876543210', id: 2, role: 'admin' }, bearer(first.body.token));
  assert.equal(status, 200);
  assert.equal(body.id, 1);
  assert.equal(body.role, 'customer');
  assert.equal(store.users.get(2).name, 'Asha Rao');
  assert.equal((await call('PUT', 'me', { name: 'Asha', phone: '123' }, bearer(first.body.token))).status, 400);
});

test('password change needs the current password', async () => {
  const { body } = await call('POST', 'register', GOOD);
  const auth = bearer(body.token);
  assert.equal((await call('PUT', 'password', { currentPassword: 'wrong1234', newPassword: 'newsecret1' }, auth)).status, 400);
  assert.equal((await call('PUT', 'password', { currentPassword: GOOD.password, newPassword: 'newsecret1' }, auth)).status, 200);
  assert.equal((await call('POST', 'login', { email: 'asha@example.com', password: GOOD.password })).status, 401);
  assert.equal((await call('POST', 'login', { email: 'asha@example.com', password: 'newsecret1' })).status, 200);
});

test('repeated login attempts are stopped, by address and by account', async () => {
  await call('POST', 'register', GOOD);
  const attempt = (ip) => handleAuth({ method: 'POST', rest: 'login', body: { email: 'asha@example.com', password: 'wrongpass1' }, ip }, { store, domainError });
  for (let i = 0; i < 10; i += 1) assert.equal((await attempt(`10.0.0.${i}`)).status, 401);
  const blocked = await attempt('10.0.1.1'); // a new address still can't keep guessing this account
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['Retry-After'], '900');
  assert.ok([...store.hits.keys()].every((key) => /^[0-9a-f]{64}$/.test(key))); // no raw IP or email stored
});

test('a database failure gives a clean error, not the details', async () => {
  store.findByEmail = async () => {
    throw new Error('connection to postgres://user:pw@host failed');
  };
  const { status, body } = await call('POST', 'login', { email: 'asha@example.com', password: 'secret123' });
  assert.equal(status, 500);
  assert.ok(!JSON.stringify(body).includes('postgres'));
});

test('routes that need email or SMS are not served here', () => {
  for (const [method, rest] of [['POST', 'otp'], ['POST', 'register/verify'], ['POST', 'google'], ['GET', 'register'], ['DELETE', 'me'], ['GET', 'constructor']]) {
    assert.equal(isAuthRoute(method, rest), false);
  }
  assert.equal(isAuthRoute('POST', 'login'), true);
  assert.ok(createToken({ id: 1, email: 'a@b.co', role: 'customer' }));
});
