'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../backend/store.cjs');
const { Auth } = require('../backend/auth.cjs');
const { backup, generateKey, MAGIC, NONCE_BYTES } = require('../scripts/ops-backup.cjs');
const { restore } = require('../scripts/ops-restore.cjs');

const childId = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'upay-backup-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const make = name => { const p = path.join(base, name); fs.mkdirSync(p, { mode: 0o700 }); return p; };
  const state = make('test-source'), extracts = make('test-restore');
  const archive = path.join(make('test-vault'), 'test.encrypted');
  const key = path.join(make('test-key-store'), 'test.key');
  generateKey(key);
  const root = new Store(state);
  const childPath = path.join(state, 'deployments', childId);
  const child = new Store(childPath);
  const auth = new Auth(state);
  root.secret('webhook');
  child.secret('webhook');
  root.set('deployments', [{ id: childId, config: {} }]);
  root.set('fixture', 'NOT REAL CUSTOMER DATA');
  child.set('checkpoint', 197);
  child.saveOrder({ id: 'o1', reference: 'ref-test', publicToken: 'fixture-token', example: true });
  child.close();
  root.close();
  return { state, extracts, archive, key, base, childPath, credentials: auth.state };
}
const makeBackup = f => backup({ ...f, offline: true });
const verify = (f, override = {}) => restore({ ...f, destinationParent: f.extracts, verifyOnly: true, ...override });

test('backup and verify full isolated source, then restore to a new directory without overwriting', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.state, 'extra'), { mode: 0o700 });
  fs.writeFileSync(path.join(f.state, 'extra', 'component'), 'EXAMPLE FILE', { mode: 0o700 });
  makeBackup(f);
  const ciphertext = fs.readFileSync(f.archive);
  assert.equal(ciphertext.includes(Buffer.from(f.credentials.recoveryKey)), false);
  assert.equal(ciphertext.includes(Buffer.from('NOT REAL CUSTOMER DATA')), false);
  assert.equal(fs.statSync(f.archive).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.key).mode & 0o777, 0o600);
  assert.throws(() => makeBackup(f), /already exists/);
  assert.deepEqual(fs.readFileSync(f.archive), ciphertext);
  assert.equal(verify(f).databases, 2);
  assert.deepEqual(fs.readdirSync(f.extracts), []);
  const result = verify(f, { verifyOnly: false });
  const second = verify(f, { verifyOnly: false });
  assert.notEqual(result.directory, second.directory);
  assert.equal(path.dirname(result.directory), f.extracts);
  assert.equal(fs.statSync(result.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(result.directory, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(result.directory, 'extra', 'component')).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(result.directory, 'owner.lock')), false);
  assert.equal(fs.existsSync(path.join(result.directory, 'owner.guard')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.directory, 'auth.json'), 'utf8')), f.credentials);
  const fdb = new DatabaseSync(path.join(result.directory, 'deployments', childId, 'merchant.sqlite'), { readOnly: true });
  t.after(() => fdb.close());
  assert.equal(fdb.prepare('SELECT reference FROM orders').get().reference, 'ref-test');
});

test('wrong key, tamper, inside source and insecure destinations are rejected without extracting', t => {
  const f = fixture(t);
  makeBackup(f);
  const ciphertext = fs.readFileSync(f.archive);
  const wrong = path.join(path.dirname(f.key), 'wrong.key');
  generateKey(wrong);
  assert.throws(() => verify(f, { key: wrong }), /authenticated/);
  const changed = path.join(path.dirname(f.archive), 'tampered.encrypted');
  ciphertext[MAGIC.length + NONCE_BYTES] ^= 1;
  fs.writeFileSync(changed, ciphertext, { mode: 0o600 });
  assert.throws(() => verify(f, { archive: changed }), /authenticated/);
  assert.throws(() => verify(f, { destinationParent: f.state }), /outside all/);
  fs.chmodSync(f.extracts, 0o755);
  assert.throws(() => verify(f), /chmod 700/);
  assert.deepEqual(fs.readdirSync(f.extracts), []);
});

test('requires explicit offline mode, refuses active and legacy ownership, and never removes foreign locks', t => {
  const f = fixture(t);
  assert.throws(() => backup(f), /offline/);
  const rootStore = new Store(f.state);
  try {
    assert.throws(() => makeBackup(f), /STATE_DIRECTORY_LOCKED|locked/i);
    assert.equal(fs.existsSync(path.join(f.state, 'owner.lock')), true);
  } finally { rootStore.close(); }
  const lock = path.join(f.childPath, 'owner.lock');
  const old = JSON.stringify({ pid: process.pid, nonce: 'unverifiable' });
  fs.writeFileSync(lock, old, { mode: 0o600, flag: 'wx' });
  assert.throws(() => makeBackup(f), /STATE_DIRECTORY_LOCKED|locked/i);
  assert.equal(fs.existsSync(path.join(f.state, 'owner.lock')), false);
  assert.equal(fs.readFileSync(lock, 'utf8'), old);
  assert.equal(fs.existsSync(f.archive), false);
});

test('authenticated restore still rejects invalid SQLite and missing deployment, then discards its scratch state', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.childPath, 'merchant.sqlite'));
  makeBackup(f);
  assert.throws(() => verify(f), /corresponding backed-up database/);
  assert.deepEqual(fs.readdirSync(f.extracts), []);
  const another = path.join(path.dirname(f.archive), 'with-broken-db.encrypted');
  fs.writeFileSync(path.join(f.childPath, 'merchant.sqlite'), 'not sqlite', { mode: 0o600 });
  backup({ ...f, archive: another, offline: true });
  assert.throws(() => verify(f, { archive: another }), /database|SQLITE/);
  assert.deepEqual(fs.readdirSync(f.extracts), []);
});

test('refuses symlinks and never writes an archive to a pre-existing symlink', t => {
  const f = fixture(t);
  const link = path.join(f.state, 'test.link');
  fs.symlinkSync(f.key, link);
  assert.throws(() => makeBackup(f), /symlinks/);
  assert.equal(fs.existsSync(f.archive), false);
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(f.base, 'not-created'), f.archive);
  assert.throws(() => makeBackup(f), /EEXIST|already exists/);
  assert.equal(fs.lstatSync(f.archive).isSymbolicLink(), true);
});

test('preserves unapplied SQLite WAL records in restore output', t => {
  const f = fixture(t);
  // Take a fixture snapshot while the database is idle but open in this test.
  // Move the copies back only after closing the only writer.
  const files = ['merchant.sqlite', 'merchant.sqlite-wal', 'merchant.sqlite-shm'];
  const source = new DatabaseSync(path.join(f.childPath, files[0]));
  source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO settings VALUES ('wal_fixture','42');");
  let fixtureContents;
  try { fixtureContents = files.map(name => fs.readFileSync(path.join(f.childPath, name))); }
  finally { source.close(); }
  for (let i = 0; i < files.length; i++) {
    fs.writeFileSync(path.join(f.childPath, files[i]), fixtureContents[i], { mode: 0o600 });
  }
  makeBackup(f);
  const result = verify(f, { verifyOnly: false });
  const db = new DatabaseSync(path.join(result.directory, 'deployments', childId, files[0]), { readOnly: true });
  try { assert.equal(db.prepare("SELECT value FROM settings WHERE key='wal_fixture'").get().value, '42'); }
  finally { db.close(); }
});

test('rejects unsafe archive paths even with valid authenticated encryption', t => {
  const f = fixture(t);
  const crypto = require('node:crypto');
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const header = Buffer.concat([MAGIC, nonce]);
  const cipher = crypto.createCipheriv('aes-256-gcm', fs.readFileSync(f.key), nonce);
  cipher.setAAD(header);
  const plain = JSON.stringify({ format: 1, entries: [{ path: '../escaped', kind: 'file', executable: false, data: '' }] });
  fs.writeFileSync(f.archive, Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]), { mode: 0o600 });
  assert.throws(() => verify(f), /unsafe archive path/);
  assert.deepEqual(fs.readdirSync(f.extracts), []);
  assert.equal(fs.existsSync(path.join(f.base, 'escaped')), false);
});
