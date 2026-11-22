'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readKey, stableFile, posixOnly, privateDirectory, outsideState, writeFileExclusive, fsyncDir, requireCondition,
  validSegment, MAGIC, NONCE_BYTES, TAG_BYTES, MAX_DATA, MAX_ARCHIVE, MAX_ENTRIES } = require('./ops-backup.cjs');

function readArchive(archive, key) {
  const { data } = stableFile(path.resolve(archive), MAX_ARCHIVE);
  const headerSize = MAGIC.length + NONCE_BYTES;
  requireCondition(data.length > headerSize + TAG_BYTES && data.subarray(0, MAGIC.length).equals(MAGIC),
    'Not a supported UPayNow backup archive.');
  const secret = readKey(key);
  let candidate;
  let plain;
  try {
    const nonce = data.subarray(MAGIC.length, headerSize);
    const cipher = crypto.createDecipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(data.subarray(0, headerSize));
    cipher.setAuthTag(data.subarray(-TAG_BYTES));
    candidate = cipher.update(data.subarray(headerSize, -TAG_BYTES));
    const last = cipher.final(); // Do not parse or write anything until authentication succeeds.
    plain = Buffer.concat([candidate, last]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('Backup could not be authenticated and decoded. Check the key and archive.');
  } finally {
    secret.fill(0);
    candidate?.fill(0);
    plain?.fill(0);
  }
}
function validateEntries(body) {
  requireCondition(body && body.format === 1 && Array.isArray(body.entries) && body.entries.length <= MAX_ENTRIES,
    'Unsupported archive manifest.');
  const inventory = new Map();
  let total = 0;
  for (const entry of body.entries) {
    requireCondition(entry && typeof entry.path === 'string', 'Invalid archive entry.');
    const parts = entry.path.split('/');
    requireCondition(parts.length <= 32 && parts.every(validSegment) && !inventory.has(entry.path),
      'Duplicate or unsafe archive path.');
    if (parts.length > 1) {
      const parent = inventory.get(parts.slice(0, -1).join('/'));
      requireCondition(parent?.kind === 'directory', 'Archive parent is missing or not a directory.');
    }
    requireCondition(entry.kind === 'file' || entry.kind === 'directory', 'Invalid archive entry kind.');
    if (entry.kind === 'file') {
      requireCondition(typeof entry.executable === 'boolean' && typeof entry.data === 'string' &&
        entry.data.length <= Math.ceil((MAX_DATA - total) / 3) * 4,
      'Archive data exceeds limits or is not a regular file.');
      const buffer = Buffer.from(entry.data, 'base64');
      try {
        total += buffer.length;
        requireCondition(total <= MAX_DATA && buffer.toString('base64') === entry.data, 'Invalid archive data encoding.');
      } finally { buffer.fill(0); }
    }
    inventory.set(entry.path, entry);
  }
  for (const name of ['merchant.sqlite', 'auth.json', 'webhook.secret']) {
    requireCondition(inventory.get(name)?.kind === 'file', 'Archive does not contain complete UPayNow state.');
  }
  return inventory;
}
function checkSqlite(dir, inventory) {
  const keyPattern = /^[A-Za-z0-9_-]{43}$/;
  let auth;
  try { auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')); }
  catch { throw new Error('Restored authentication state is not valid JSON.'); }
  const record = auth?.password;
  requireCondition(auth?.version === 1 && typeof auth.recoveryKey === 'string' && keyPattern.test(auth.recoveryKey) &&
    typeof auth.apiKey === 'string' && keyPattern.test(auth.apiKey) && auth.apiKey !== auth.recoveryKey &&
    (record === null || record?.algorithm === 'scrypt' && record.N === 32768 && record.r === 8 && record.p === 1 &&
      typeof record.salt === 'string' && /^[a-f0-9]{32}$/.test(record.salt) &&
      typeof record.hash === 'string' && /^[a-f0-9]{64}$/.test(record.hash)),
  'Restored authentication state is incomplete.');
  let count = 0;
  for (const [name, entry] of inventory) {
    if (entry.kind !== 'file' || path.basename(name) !== 'merchant.sqlite') continue;
    const db = new DatabaseSync(path.join(dir, name), { readOnly: true, allowExtension: false });
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
      const rows = db.prepare('PRAGMA quick_check').all();
      requireCondition(rows.length === 1 && rows[0].quick_check === 'ok', 'A restored SQLite database failed its quick check.');
      db.prepare('SELECT value FROM settings LIMIT 0').all();
      if (name === 'merchant.sqlite') {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('deployments');
        let registry = [];
        if (row) {
          try { registry = JSON.parse(row.value); } catch { throw new Error('Restored deployment registry is not valid JSON.'); }
        }
        requireCondition(Array.isArray(registry), 'Restored deployment registry is invalid.');
        const ids = new Set();
        for (const deployment of registry) {
          const id = deployment?.id;
          requireCondition(typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) &&
            !ids.has(id) && inventory.get(`deployments/${id}/merchant.sqlite`)?.kind === 'file',
          'A registered deployment has no corresponding backed-up database, or the registry is invalid.');
          ids.add(id);
        }
      }
      count++;
    } finally { db.close(); }
  }
  return count;
}
function restore({ archive, key, destinationParent, verifyOnly = false }) {
  posixOnly();
  const parent = privateDirectory(destinationParent);
  outsideState(parent);
  const inventory = validateEntries(readArchive(archive, key));
  // A random private child is always newly reserved; there is no overwrite or
  // replace-in-place mode. This procedure never loads the application.
  const dest = fs.mkdtempSync(path.join(parent, 'upaynow-restore-'));
  let keep = false;
  try {
    for (const [name, entry] of inventory) {
      const parts = name.split('/');
      const item = path.join(dest, ...parts);
      if (entry.kind === 'directory') fs.mkdirSync(item, { mode: 0o700 });
      else {
        const data = Buffer.from(entry.data, 'base64');
        try {
          writeFileExclusive(item, data, entry.executable ? 0o700 : 0o600);
        } finally { data.fill(0); }
      }
    }
    // Re-read the actual extracted bytes before SQLite can regenerate WAL shared memory.
    for (const [name, entry] of inventory) {
      if (entry.kind !== 'file') continue;
      const f = stableFile(path.join(dest, name), MAX_DATA);
      try {
        requireCondition(f.data.toString('base64') === entry.data, 'Extracted state did not match the authenticated backup.');
      } finally { f.data.fill(0); }
    }
    const databases = checkSqlite(dest, inventory);
    if (!verifyOnly) {
      for (const [name, entry] of Array.from(inventory).reverse()) {
        if (entry.kind === 'directory') fsyncDir(path.join(dest, name));
      }
      fsyncDir(dest);
      fsyncDir(parent);
      keep = true;
    }
    return { databases, entries: inventory.size, ...(keep ? { directory: dest } : {}) };
  } finally {
    if (!keep) fs.rmSync(dest, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    requireCondition(args.length === 4 && ['verify', 'extract'].includes(args[0]),
      'Usage: node scripts/ops-restore.cjs verify|extract ARCHIVE KEY_FILE PRIVATE_ISOLATION_DIRECTORY');
    const result = restore({ archive: args[1], key: args[2], destinationParent: args[3], verifyOnly: args[0] === 'verify' });
    process.stdout.write(`Verified ${result.databases} SQLite database(s) and ${result.entries} state entries offline.\n`);
    if (result.directory) process.stdout.write(`Restored to a new directory: ${result.directory}\nDo not point a running instance at this copy.\n`);
  } catch (err) {
    process.stderr.write('Restore failed: ' + err.message + '\n'); process.exitCode = 1;
  }
}
module.exports = { restore };
