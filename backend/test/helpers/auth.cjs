'use strict';
// Test-only credentials. Call only with an isolated fixture's temporary directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PASSWORD = 'fixture-password-123';
const readAuth = dir => JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
const apiKey = dir => {
  const state = readAuth(dir);
  assert.equal(state.version, 1);
  assert.equal(typeof state.apiKey, 'string');
  assert.notEqual(state.apiKey, state.recoveryKey);
  return state.apiKey;
};
async function initializePassword(app, dir) {
  const before = readAuth(dir);
  assert.equal(before.password, null, 'initialize only a fresh fixture, not an existing password');
  const response = await fetch(app.url + '/api/auth/reset', {
    method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recoveryKey: before.recoveryKey, newPassword: PASSWORD })
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.ok, true);
  const after = readAuth(dir);
  assert.equal(result.recoveryKey, after.recoveryKey);
  assert.notEqual(after.recoveryKey, before.recoveryKey);
  assert.equal(after.apiKey, before.apiKey);
  assert.ok(after.password && typeof after.password === 'object');
  assert.ok(!response.headers.get('set-cookie') || /Max-Age=0/.test(response.headers.get('set-cookie')), 'reset must not issue a session');
  return PASSWORD;
}
module.exports = { PASSWORD, readAuth, apiKey, initializePassword };
