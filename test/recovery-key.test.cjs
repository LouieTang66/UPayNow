'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/recovery-key.cjs');
const key = 'fixture-recovery-key-not-a-real-secret';
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-recovery-tool-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const write = (dir, value) => fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(value), { mode: 0o600 });
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('local recovery tool returns only recovery value, without writes or credential mixing', () => fixture(dir => {
  write(dir, { version: 1, recoveryKey: key, apiKey: 'fake-api-credential', password: { salt: 'fake', hash: 'fake-hash' } });
  const before = fs.readFileSync(path.join(dir, 'auth.json'));
  const r = run([dir]);
  assert.equal(r.status, 0); assert.equal(r.stdout, key + '\n'); assert.equal(r.stderr, '');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'auth.json')), before);
}));

test('local recovery tool supports explicit data-directory environment', () => fixture(dir => {
  write(dir, { version: 1, recoveryKey: key });
  const r = run([], { UPAY_DATA_DIR: dir });
  assert.equal(r.status, 0); assert.equal(r.stdout, key + '\n');
}));

test('local recovery tool fails without creating credentials when state is missing', () => fixture(dir => {
  const r = run([dir]); assert.equal(r.status, 1); assert.equal(r.stdout, '');
  assert.match(r.stderr, /RECOVERY_KEY_UNAVAILABLE/); assert.deepEqual(fs.readdirSync(dir), []);
}));

test('local recovery tool fails closed on corrupt or invalid state without printing data', () => fixture(dir => {
  for (const value of [{ version: 2, recoveryKey: key }, { version: 1, recoveryKey: 3 }, { version: 1, recoveryKey: ' ' }, { version: 1, recoveryKey: '' }]) {
    write(dir, value); const r = run([dir]); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert(!r.stderr.includes(key));
  }
  fs.writeFileSync(path.join(dir, 'auth.json'), '{fake-secret-corrupt');
  const r = run([dir]); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert(!r.stderr.includes('fake-secret-corrupt'));
}));

test('local recovery tool rejects invalid arguments without reading real default state', () => {
  for (const args of [['one', 'two'], ['--unknown']]) {
    const r = run(args); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /Usage:/);
  }
});

test('macOS copy is explicitly requested, never prints the key, and uses no real clipboard', { skip: process.platform !== 'darwin' }, () => fixture(dir => {
  write(dir, { version: 1, recoveryKey: key });
  const bin = path.join(dir, 'bin'), output = path.join(dir, 'mock-clipboard'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pbcopy'), '#!' + process.execPath + '\nrequire("node:fs").writeFileSync(process.env.UPAY_TEST_CLIPBOARD,require("node:fs").readFileSync(0));\n', { mode: 0o700 });
  const r = run(['--copy', dir], { PATH: bin + path.delimiter + process.env.PATH, UPAY_TEST_CLIPBOARD: output });
  assert.equal(r.status, 0); assert.equal(fs.readFileSync(output, 'utf8'), key); assert(!r.stdout.includes(key)); assert.match(r.stdout, /未显示明文/);
}));
