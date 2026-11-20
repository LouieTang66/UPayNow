'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { Auth } = require('../auth.cjs');
const { start } = require('../server.cjs');
const PASSWORD = 'Daily test password 123';
const NEXT = 'Next daily password 456';
const randomKey = () => crypto.randomBytes(32).toString('base64url');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-auth-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-auth-test-'));
  const startOptions = { dir, port: 0, pollMs: 0, ...options };
  let app = await start(startOptions);
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  async function request(route, input, extra = {}) {
    const headers = { ...(input === undefined ? {} : { Origin: app.url, 'Content-Type': 'application/json' }), ...extra };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    return new Promise((resolve, reject) => {
      const request = http.request(app.url + route, { method: input === undefined ? 'GET' : 'POST', headers }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          try { resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()), cookie: response.headers['set-cookie']?.[0] }); }
          catch (error) { reject(error); }
        });
      });
      request.on('error', reject); request.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  const setup = () => request('/api/auth/reset', { recoveryKey: state().recoveryKey, newPassword: PASSWORD });
  async function login(password = PASSWORD) {
    const result = await request('/api/login', { password }); assert.equal(result.status, 200);
    assert.match(result.cookie, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800/);
    return result.cookie.split(';')[0];
  }
  return { dir, get app() { return app; }, state, request, setup, login,
    restart: async () => { await app.close(); app = await start(startOptions); } };
}
function error(result, status, code) { assert.equal(result.status, status); assert.equal(result.value.error, code); }
async function initialized(t) {
  const auth = new Auth(temporary(t));
  await auth.change({ recoveryKey: auth.state.recoveryKey, newPassword: PASSWORD }, undefined, true);
  return auth;
}
function gateDerive(auth) {
  const original = auth.derive.bind(auth); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); let first = true;
  auth.derive = async (...args) => {
    const output = await original(...args);
    if (first) { first = false; entered(); await gate; }
    return output;
  };
  return { ready, release };
}

test('fresh secure initialization: no password, no first-visitor takeover, independent keys, protected storage', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/auth/status')).value, { passwordSet: false, passwordMinLength: 12 });
  assert.ok(f.state().apiKey !== f.state().recoveryKey);
  assert.equal(fs.statSync(path.join(f.dir, 'auth.json')).mode & 0o777, 0o600);
  error(await f.request('/api/login', { password: PASSWORD }), 409, 'PASSWORD_NOT_SET');
  error(await f.request('/api/auth/reset', { newPassword: PASSWORD }), 401, 'INVALID_RECOVERY_KEY');
  error(await f.request('/api/auth/reset', { recoveryKey: randomKey(), newPassword: PASSWORD }), 401, 'INVALID_RECOVERY_KEY');
  const result = await f.setup(); assert.equal(result.status, 200); assert.equal(result.value.ok, true);
  assert.match(result.cookie, /Max-Age=0/);
  assert.equal((await f.request('/api/auth/status')).value.passwordSet, true);
  error(await f.request('/api/status'), 401, 'UNAUTHORIZED');
});

test('password hash and independent keys survive restart without plaintext or persisted sessions', async t => {
  const f = await fixture(t); await f.setup();
  const text = fs.readFileSync(path.join(f.dir, 'auth.json'), 'utf8');
  assert.equal(text.includes(PASSWORD), false); assert.equal(f.state().password.algorithm, 'scrypt');
  const cookie = await f.login(), before = f.state();
  await f.restart(); await f.login();
  assert.deepEqual(f.state(), before);
  error(await f.request('/api/status', undefined, { Cookie: cookie }), 401, 'UNAUTHORIZED');
});

test('password/API/recovery segregation; cookie-only management and password reauthentication', async t => {
  const f = await fixture(t); await f.setup(); const cookie = await f.login();
  const { recoveryKey, apiKey } = f.state();
  for (const key of [recoveryKey, apiKey]) error(await f.request('/api/login', { password: key }), 401, 'UNAUTHORIZED');
  error(await f.request('/api/status', undefined, { Authorization: 'Bearer ' + recoveryKey }), 401, 'UNAUTHORIZED');
  error(await f.request('/api/status', undefined, { Authorization: 'Bearer ' + PASSWORD }), 401, 'UNAUTHORIZED');
  assert.equal((await f.request('/api/status', undefined, { Authorization: 'Bearer ' + apiKey })).status, 200);
  for (const route of ['/api/auth/reset', '/api/auth/password', '/api/auth/recovery-key', '/api/auth/api-key']) {
    error(await f.request(route, { password: PASSWORD }, { Cookie: cookie, Authorization: 'Bearer ' + apiKey }), 401, 'SESSION_REQUIRED');
  }
  error(await f.request('/api/auth/api-key', { password: PASSWORD }), 401, 'SESSION_REQUIRED');
  error(await f.request('/api/auth/recovery-key', { password: 'wrong password test' }, { Cookie: cookie }), 401, 'UNAUTHORIZED');
  const r = await f.request('/api/auth/recovery-key', { password: PASSWORD }, { Cookie: cookie });
  assert.equal(r.status, 200); assert.ok(r.value.recoveryKey === recoveryKey);
  const a = await f.request('/api/auth/api-key', { password: PASSWORD }, { Cookie: cookie });
  assert.equal(a.status, 200); assert.ok(a.value.apiKey === apiKey);
});

test('reset rotates recovery, preserves API, revokes every session and does not log in', async t => {
  const f = await fixture(t); await f.setup();
  const c1 = await f.login(), c2 = await f.login(), before = f.state();
  const result = await f.request('/api/auth/reset', { recoveryKey: before.recoveryKey, newPassword: NEXT });
  assert.equal(result.status, 200); assert.match(result.cookie, /Max-Age=0/);
  assert.ok(result.value.recoveryKey !== before.recoveryKey);
  assert.ok(f.state().apiKey === before.apiKey);
  assert.ok(f.state().password.salt !== before.password.salt);
  for (const cookie of [c1, c2]) error(await f.request('/api/status', undefined, { Cookie: cookie }), 401, 'UNAUTHORIZED');
  error(await f.request('/api/login', { password: PASSWORD }), 401, 'UNAUTHORIZED');
  error(await f.request('/api/auth/reset', { recoveryKey: before.recoveryKey, newPassword: PASSWORD }), 401, 'INVALID_RECOVERY_KEY');
  await f.login(NEXT);
  assert.equal((await f.request('/api/status', undefined, { Authorization: 'Bearer ' + before.apiKey })).status, 200);
});

test('password change requires current password, revokes all sessions, preserves both keys', async t => {
  const f = await fixture(t); await f.setup();
  const c1 = await f.login(), c2 = await f.login(), before = f.state();
  error(await f.request('/api/auth/password', { currentPassword: NEXT, newPassword: NEXT }, { Cookie: c1 }), 401, 'UNAUTHORIZED');
  const result = await f.request('/api/auth/password', { currentPassword: PASSWORD, newPassword: NEXT }, { Cookie: c1 });
  assert.equal(result.status, 200); assert.deepEqual(result.value, { ok: true }); assert.match(result.cookie, /Max-Age=0/);
  assert.ok(before.recoveryKey === f.state().recoveryKey && before.apiKey === f.state().apiKey);
  for (const cookie of [c1, c2]) error(await f.request('/api/status', undefined, { Cookie: cookie }), 401, 'UNAUTHORIZED');
  await f.login(NEXT);
});

test('Origin, JSON, Host, public pay and mobile-management isolation remain enforced', async t => {
  const f = await fixture(t, { handoffPort: 0, handoffQuick: false, handoffOrigin: 'https://phone.example.test' });
  for (const Origin of [undefined, 'null', 'https://evil.example']) {
    error(await f.request('/api/auth/reset', { recoveryKey: f.state().recoveryKey, newPassword: PASSWORD }, { Origin }), 403, 'ORIGIN_REQUIRED');
    error(await f.request('/api/login', { password: PASSWORD }, { Origin }), 403, 'ORIGIN_REQUIRED');
  }
  error(await f.request('/api/auth/reset', {}, { 'Content-Type': 'text/plain' }), 415, 'JSON_REQUIRED');
  error(await f.request('/api/auth/status', undefined, { Host: 'evil.example' }), 403, 'INVALID_HOST');
  error(await f.request('/api/pay/' + 'a'.repeat(32)), 404, 'NOT_FOUND');
  const response = await fetch('http://127.0.0.1:' + f.app.handoff.server.address().port + '/api/auth/status');
  assert.notEqual(response.status, 200);
  await f.setup(); const cookie = await f.login();
  error(await f.request('/api/auth/password', { currentPassword: PASSWORD, newPassword: NEXT }, { Cookie: cookie, Origin: 'https://evil.example' }), 403, 'ORIGIN_REQUIRED');
  error(await f.request('/api/auth/api-key', { password: PASSWORD }, { Cookie: cookie, Origin: undefined }), 403, 'ORIGIN_REQUIRED');
});

test('HTTPS public Origin emits Secure on login and clearing cookies', async t => {
  const f = await fixture(t, { publicOrigin: 'https://merchant.example.test' });
  const headers = { Host: 'merchant.example.test', Origin: 'https://merchant.example.test' };
  const result = await f.request('/api/auth/reset', { recoveryKey: f.state().recoveryKey, newPassword: PASSWORD }, headers);
  assert.equal(result.status, 200); assert.match(result.cookie, /; Secure$/);
  const login = await f.request('/api/login', { password: PASSWORD }, headers);
  assert.equal(login.status, 200); assert.match(login.cookie, /; Secure$/);
});

test('password policy preserves spaces; rejects whitespace, size and credential passwords', async t => {
  const auth = new Auth(temporary(t));
  for (const value of ['', 'short', ' '.repeat(12), 'a'.repeat(129), null]) {
    await assert.rejects(auth.change({ recoveryKey: auth.state.recoveryKey, newPassword: value }, undefined, true), { code: 'INVALID_PASSWORD' });
  }
  for (const value of [auth.state.recoveryKey, auth.state.apiKey]) {
    await assert.rejects(auth.change({ recoveryKey: auth.state.recoveryKey, newPassword: value }, undefined, true), { code: 'PASSWORD_IS_CREDENTIAL' });
  }
  const password = '  exact spaces password  ';
  await auth.change({ recoveryKey: auth.state.recoveryKey, newPassword: password }, undefined, true);
  await auth.login(password);
  await assert.rejects(auth.login(password.trim()), { code: 'UNAUTHORIZED' });
});

test('pre-verification shared rate limit cannot be bypassed with correct passwords or recovery keys', async t => {
  const f = await fixture(t); await f.setup();
  for (let i = 0; i < 9; i++) error(await f.request('/api/login', { password: NEXT }), 401, 'UNAUTHORIZED');
  error(await f.request('/api/login', { password: PASSWORD }), 429, 'AUTH_RATE_LIMIT');
  error(await f.request('/api/auth/reset', { recoveryKey: f.state().recoveryKey, newPassword: NEXT }), 429, 'AUTH_RATE_LIMIT');
  const auth = new Auth(temporary(t));
  for (let i = 0; i < 1024; i++) auth.rate('address-' + i);
  assert.throws(() => auth.rate('new-address'), { code: 'AUTH_RATE_LIMIT' });
  assert.equal(auth.attempts.size, 1024);
});

test('reauthentication uses the same bounded limit, including successful requests', async t => {
  const f = await fixture(t); await f.setup(); const cookie = await f.login();
  for (let i = 0; i < 8; i++) error(await f.request('/api/auth/api-key', { password: NEXT }, { Cookie: cookie }), 401, 'UNAUTHORIZED');
  error(await f.request('/api/auth/api-key', { password: PASSWORD }, { Cookie: cookie }), 429, 'AUTH_RATE_LIMIT');
  error(await f.request('/api/auth/password', { currentPassword: PASSWORD, newPassword: NEXT }, { Cookie: cookie }), 429, 'AUTH_RATE_LIMIT');
});

test('malformed or incomplete existing state fails closed, retaining file and releasing engine lock', async t => {
  for (const content of ['', '{}', '{broken', JSON.stringify({ version: 1, password: null })]) {
    const dir = temporary(t), file = path.join(dir, 'auth.json'); fs.writeFileSync(file, content);
    await assert.rejects(start({ dir, port: 0, pollMs: 0 }), { code: 'AUTH_STATE_INVALID' });
    assert.ok(fs.readFileSync(file, 'utf8') === content);
    assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), false);
  }
});

test('persistence failure leaves old password, key, sessions and generation intact', async t => {
  const auth = await initialized(t), cookie = await auth.login(PASSWORD);
  const state = auth.state, generation = auth.generation, file = auth.file;
  const blocked = path.join(path.dirname(file), 'blocked'); fs.mkdirSync(blocked);
  auth.file = blocked;
  await assert.rejects(auth.change({ recoveryKey: state.recoveryKey, newPassword: NEXT }, undefined, true), { code: 'AUTH_STORAGE_ERROR' });
  await assert.rejects(auth.change({ currentPassword: PASSWORD, newPassword: NEXT }, cookie), { code: 'AUTH_STORAGE_ERROR' });
  auth.file = file;
  assert.ok(auth.state === state); assert.equal(auth.generation, generation); assert.equal(auth.session(cookie), true);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).recoveryKey === state.recoveryKey);
  await auth.login(PASSWORD);
  await assert.rejects(auth.login(NEXT), { code: 'UNAUTHORIZED' });
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')), false);
});

test('reset cancels in-flight old-password login by generation', async t => {
  const auth = await initialized(t), gate = gateDerive(auth);
  const login = auth.login(PASSWORD); const rejected = assert.rejects(login, { code: 'AUTH_CHANGED' });
  await gate.ready;
  await auth.change({ recoveryKey: auth.state.recoveryKey, newPassword: NEXT }, undefined, true);
  gate.release(); await rejected; assert.equal(auth.sessions.size, 0);
});

test('reset cancels in-flight secret reveal and logout cancels reauthentication', async t => {
  const auth = await initialized(t), cookie = await auth.login(PASSWORD), gate = gateDerive(auth);
  const reveal = auth.reveal('apiKey', PASSWORD, cookie); const rejected = assert.rejects(reveal, { code: 'AUTH_CHANGED' });
  await gate.ready; await auth.change({ recoveryKey: auth.state.recoveryKey, newPassword: NEXT }, undefined, true);
  gate.release(); await rejected;
  const token = await auth.login(NEXT), nextGate = gateDerive(auth);
  const nextReveal = auth.reveal('recoveryKey', NEXT, token); const cancelled = assert.rejects(nextReveal, { code: 'SESSION_REQUIRED' });
  await nextGate.ready; auth.sessions.delete(token); nextGate.release(); await cancelled;
});

test('password mutations are mutually exclusive and logout cancels pending change', async t => {
  const auth = await initialized(t), token = await auth.login(PASSWORD), gate = gateDerive(auth), state = auth.state;
  const pending = auth.change({ currentPassword: PASSWORD, newPassword: NEXT }, token);
  const cancelled = assert.rejects(pending, { code: 'SESSION_REQUIRED' });
  await gate.ready;
  await assert.rejects(auth.change({ recoveryKey: auth.state.recoveryKey, newPassword: NEXT }, undefined, true), { code: 'AUTH_BUSY' });
  auth.sessions.delete(token); gate.release(); await cancelled; assert.ok(auth.state === state);
});

test('scrypt concurrency is bounded and expired/bounded sessions do not accumulate', async t => {
  const auth = await initialized(t);
  const a = auth.derive(PASSWORD, Buffer.alloc(16)), b = auth.derive(PASSWORD, Buffer.alloc(16));
  await assert.rejects(auth.derive(PASSWORD, Buffer.alloc(16)), { code: 'AUTH_BUSY' });
  await Promise.all([a, b]); assert.equal(auth.active, 0);
  auth.sessions.set('expired', Date.now() - 1); assert.equal(auth.session('expired'), false);
  for (let i = 0; i < 130; i++) auth.sessions.set('s-' + i, Date.now() + 100000);
  await auth.login(PASSWORD); assert.equal(auth.sessions.size, 128); assert.equal(auth.sessions.has('expired'), false);
});

test('successful logins never clear the pre-verification rate limit', async t => {
  const f = await fixture(t); await f.setup();
  for (let i = 0; i < 9; i++) await f.login();
  error(await f.request('/api/login', { password: PASSWORD }), 429, 'AUTH_RATE_LIMIT');
});
