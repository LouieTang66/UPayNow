'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAGIC = Buffer.from('UPAYBAK1');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_DATA = 64 * 1024 * 1024;
const MAX_ARCHIVE = 2 * MAX_DATA;
const MAX_ENTRIES = 10000;
const ROOT_DB = 'merchant.sqlite';
const LOCK_NAME = 'owner.lock';

function requireCondition(value, message) {
  if (!value) throw new Error(message);
}
function posixOnly() {
  requireCondition(process.platform !== 'win32' && fs.constants.O_NOFOLLOW !== undefined,
    'This tool requires a POSIX filesystem with private permissions and exclusive creation.');
}
function inside(parent, name) {
  const rel = path.relative(parent, name);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
function outsideState(dir) {
  // Reject obvious live/state ancestry even if the server is currently offline.
  for (let p = dir; ; p = path.dirname(p)) {
    for (const marker of [ROOT_DB, LOCK_NAME, 'auth.json']) {
      requireCondition(!fs.existsSync(path.join(p, marker)), 'Use a directory outside all UPayNow state trees.');
    }
    if (path.dirname(p) === p) return;
  }
}
function canonicalDirectory(name) {
  const dir = path.resolve(name);
  requireCondition(fs.realpathSync(dir) === dir && fs.lstatSync(dir).isDirectory(),
    'Supply a real directory without symlinks in its path.');
  return dir;
}
function privateDirectory(name) {
  const dir = canonicalDirectory(name);
  const stat = fs.statSync(dir);
  requireCondition((stat.mode & 0o077) === 0 && stat.uid === process.getuid(),
    'Use a directory owned by the operator and inaccessible to other users (chmod 700).');
  return dir;
}
function stableFile(name, limit, check = () => {}) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const a = fs.fstatSync(fd, { bigint: true });
    requireCondition(a.isFile() && a.nlink === 1n && a.size <= BigInt(limit),
      'Expected a regular, singly-linked file within the backup size limit.');
    check(a);
    const data = Buffer.alloc(Number(a.size));
    let offset = 0;
    while (offset < data.length) {
      const n = fs.readSync(fd, data, offset, data.length - offset, null);
      requireCondition(n > 0, 'A file changed during backup; stop every writer and retry.');
      offset += n;
    }
    const b = fs.fstatSync(fd, { bigint: true });
    const c = fs.lstatSync(name, { bigint: true });
    requireCondition([b, c].every(s => s.ino === a.ino && s.dev === a.dev && s.size === a.size &&
      s.mtimeNs === a.mtimeNs && s.ctimeNs === a.ctimeNs && s.nlink === a.nlink),
    'A file changed during backup; stop every writer and retry.');
    return { data, executable: (a.mode & 0o100n) !== 0n };
  } finally { fs.closeSync(fd); }
}
function readKey(name) {
  const result = stableFile(path.resolve(name), 32, stat => {
    requireCondition((stat.mode & 0o077n) === 0n && stat.uid === BigInt(process.getuid()),
      'The key file must be owned by the operator and have mode 600 or 400.');
  }).data;
  requireCondition(result.length === 32, 'Key must be exactly 32 raw random bytes.');
  return result;
}
function writeFileExclusive(name, data, mode = 0o600) {
  const fd = fs.openSync(name, 'wx', mode);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function generateKey(name) {
  posixOnly();
  const file = path.resolve(name);
  const dir = privateDirectory(path.dirname(file));
  outsideState(dir);
  const key = crypto.randomBytes(32);
  try { writeFileExclusive(file, key); fsyncDir(dir); } finally { key.fill(0); }
}
function ownershipArtifact(name) {
  return name === LOCK_NAME || name === 'owner.guard' || name.startsWith('.owner-');
}
function validSegment(name) {
  // Restrict separators and Windows aliases even though the CLI is POSIX only.
  return name && name !== '.' && name !== '..' && !ownershipArtifact(name) &&
    !/[\\/:\u0000-\u001f\u007f]/u.test(name) && !/[. ]$/u.test(name) && Buffer.byteLength(name) < 256;
}
function backup({ state, archive, key, offline }) {
  posixOnly();
  requireCondition(offline === true, 'Stop the service and all other writers before using --offline.');
  const root = canonicalDirectory(state);
  for (const marker of [ROOT_DB, 'auth.json', 'webhook.secret']) {
    requireCondition(fs.lstatSync(path.join(root, marker), { throwIfNoEntry: false })?.isFile(),
      'This is not a complete UPayNow state directory.');
  }
  const out = path.resolve(archive);
  const parent = privateDirectory(path.dirname(out));
  const keyPath = fs.realpathSync(path.resolve(key));
  requireCondition(!inside(root, parent) && !inside(root, keyPath), 'Backup and key must be outside the state directory.');
  outsideState(parent);
  requireCondition(!fs.lstatSync(out, { throwIfNoEntry: false }), 'Backup destination already exists.');
  const secret = readKey(key);
  const releases = [];
  let staging;
  try {
    const { acquireStateOwnership } = require('../backend/state-ownership.cjs');
    const stateOwners = new Set();
    function hold(dir) {
      releases.push(acquireStateOwnership(dir, { requireGuard: true, recoverStale: false }));
      stateOwners.add(dir);
    }
    hold(root);
    const deployments = path.join(root, 'deployments');
    if (fs.existsSync(deployments)) {
      requireCondition(fs.lstatSync(deployments).isDirectory(), 'The deployments directory must not be a symlink.');
      for (const entry of fs.readdirSync(deployments, { withFileTypes: true })) {
        if (entry.isDirectory()) hold(path.join(deployments, entry.name));
      }
    }
    let bytes = 0;
    const entries = [];
    function walk(dir, parts = []) {
      const before = fs.statSync(dir, { bigint: true });
      for (const entry of fs.readdirSync(dir, { withFileTypes: true, encoding: 'buffer' })
        .sort((a, b) => Buffer.compare(a.name, b.name))) {
        const name = entry.name.toString('utf8');
        requireCondition(Buffer.from(name).equals(entry.name), 'Non-UTF-8 state filenames are not supported.');
        const full = path.join(dir, name);
        if (stateOwners.has(dir) && ownershipArtifact(name)) continue;
        requireCondition(validSegment(name) && entries.length < MAX_ENTRIES && parts.length < 32,
          'Unsafe path or state tree is too large.');
        const rel = [...parts, name];
        requireCondition(entry.isDirectory() || entry.isFile(), 'State must not contain symlinks, sockets, or other special entries.');
        if (entry.isDirectory()) {
          entries.push({ path: rel.join('/'), kind: 'directory' });
          walk(full, rel);
        } else {
          const { data, executable } = stableFile(full, MAX_DATA - bytes);
          bytes += data.length;
          entries.push({ path: rel.join('/'), kind: 'file', executable, data: data.toString('base64') });
          data.fill(0);
        }
      }
      const after = fs.lstatSync(dir, { bigint: true });
      requireCondition(after.isDirectory() && after.ino === before.ino && after.dev === before.dev &&
        after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs,
      'A state directory changed during backup; stop every writer and retry.');
    }
    walk(root);
    for (const required of [ROOT_DB, 'auth.json', 'webhook.secret']) {
      requireCondition(entries.some(entry => entry.path === required && entry.kind === 'file'),
        'This is not a complete UPayNow state directory.');
    }
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const header = Buffer.concat([MAGIC, nonce]);
    const cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(header);
    const plain = Buffer.from(JSON.stringify({ format: 1, createdAt: new Date().toISOString(), entries }), 'utf8');
    try {
      requireCondition(plain.length <= MAX_ARCHIVE - header.length - TAG_BYTES, 'Archive is too large.');
      const payload = Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      staging = fs.mkdtempSync(path.join(parent, '.upay-backup-'));
      const tmp = path.join(staging, 'encrypted');
      writeFileExclusive(tmp, payload);
      fs.linkSync(tmp, out); // Atomic publication; refuses existing file or symlink.
      fsyncDir(parent);
    } finally { plain.fill(0); }
  } finally {
    secret.fill(0);
    try { if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
    finally {
      const errors = [];
      for (const release of releases.reverse()) {
        try { release(); } catch (err) { errors.push(err); }
      }
      if (errors.length) throw new AggregateError(errors, 'Backup lock cleanup failed; inspect state before restarting.');
    }
  }
}
function usage() {
  return 'Usage:\n  node scripts/ops-backup.cjs keygen KEY_FILE\n  node scripts/ops-backup.cjs create --offline STATE_DIR ARCHIVE KEY_FILE';
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === 'keygen') {
      generateKey(args[1]);
      process.stdout.write('Created a private backup key file. Keep it separately from the archives.\n');
    } else if (args.length === 5 && args[0] === 'create' && args[1] === '--offline') {
      backup({ state: args[2], archive: args[3], key: args[4], offline: true });
      process.stdout.write('Encrypted offline backup written. Run a restore verification before relying on it.\n');
    } else { throw new Error(usage()); }
  } catch (err) {
    process.stderr.write('Backup failed: ' + err.message + '\n'); process.exitCode = 1;
  }
}
module.exports = { backup, generateKey, readKey, stableFile, posixOnly, privateDirectory, outsideState, writeFileExclusive,
  fsyncDir, requireCondition, validSegment, MAGIC, NONCE_BYTES, TAG_BYTES, MAX_DATA, MAX_ARCHIVE, MAX_ENTRIES };
