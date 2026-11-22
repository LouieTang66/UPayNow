'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const LOCAL_FILESYSTEMS = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994]); // ext, XFS, Btrfs, tmpfs
const FLOCK = ['/usr/bin/flock', '/bin/flock'];
const LOCK_VERSION = 2;
const MAX_RECORD_BYTES = 1024;
const { O_RDONLY, O_RDWR, O_CREAT, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;

function fault(code, details) {
  return Object.assign(new Error(`${code}: ${details}`), { code });
}
const locked = reason => fault('STATE_DIRECTORY_LOCKED', reason);
const unavailable = () => fault('STATE_GUARD_UNAVAILABLE', 'the state guard requires Linux, a supported local filesystem, util-linux flock and visible /proc identity');

function startTicks(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  // The process name can include spaces and parentheses. Field 22 is the
  // kernel start time in clock ticks, with field 3 just after the final ')'.
  const end = stat.lastIndexOf(')');
  const ticks = end < 0 ? null : stat.slice(end + 2).split(' ')[19];
  if (!/^\d+$/.test(ticks ?? '')) throw unavailable();
  return ticks;
}
function processIdentity() {
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const pidNamespace = fs.readlinkSync('/proc/self/ns/pid');
  // A /proc mounted for a different PID namespace cannot safely interpret
  // process.pid, even if it exposes /proc/self/ns/pid.
  if (fs.readlinkSync('/proc/self') !== String(process.pid)) throw unavailable();
  if (!/^[0-9a-f-]{36}$/.test(bootId) || !/^pid:\[\d+\]$/.test(pidNamespace)) throw unavailable();
  return { version: LOCK_VERSION, bootId, pidNamespace, pid: process.pid, startTicks: startTicks(process.pid) };
}
function facility(dir) {
  if (process.platform !== 'linux' || !LOCAL_FILESYSTEMS.has(fs.statfsSync(dir).type >>> 0)) return null;
  const flock = FLOCK.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; }
    catch { return false; }
  });
  if (!flock) return null;
  try { return { flock, identity: processIdentity() }; }
  catch { return null; } // no automatic reclamation when identity is not available
}
function sameFile(info, other) { return info.dev === other.dev && info.ino === other.ino; }

function guardFile(dir, flock) {
  const file = path.join(dir, 'owner.guard');
  const fd = fs.openSync(file, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    // Never replace or delete the guard file: flock protects the inode, not its name.
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || !sameFile(info, fs.lstatSync(file))) throw locked('invalid or replaced owner.guard');
    // flock(2) is held on the open file description, including our original
    // fd after this child exits. The kernel releases it on process exit.
    const result = spawnSync(flock, ['--nonblock', '--conflict-exit-code', '75', '3'],
      { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 3000 });
    if (result.status === 75) throw locked('the state guard is held by another process');
    if (result.error || result.status !== 0) throw unavailable();
    if (!sameFile(info, fs.lstatSync(file))) throw locked('owner.guard changed during acquisition');
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readOwner(file) {
  const identity = fs.lstatSync(file);
  if (!identity.isFile() || identity.nlink > 2 || identity.size > MAX_RECORD_BYTES) {
    throw locked('invalid owner.lock; stop all writers and review the state directory');
  }
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || !sameFile(info, identity)) throw locked('owner.lock changed during inspection');
    const data = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const size = fs.readSync(fd, data, 0, data.length, 0);
    if (size > MAX_RECORD_BYTES) throw locked('owner.lock exceeded the metadata limit');
    return { info, text: data.subarray(0, size).toString('utf8') };
  } finally { fs.closeSync(fd); }
}

function definitivelyStale(prior, current) {
  if (!prior || prior.version !== LOCK_VERSION || prior.bootId !== current.bootId || prior.pidNamespace !== current.pidNamespace
    || !Number.isSafeInteger(prior.pid) || prior.pid < 1 || prior.pid > 0x7fffffff || typeof prior.startTicks !== 'string'
    || !/^\d{1,25}$/.test(prior.startTicks) || typeof prior.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(prior.nonce)) return false;
  try { return startTicks(prior.pid) !== prior.startTicks; }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') return false;
    // A hidden /proc entry is not evidence of death; verify no visible process
    // exists under this PID before trying to reclaim.
    try { process.kill(prior.pid, 0); return false; }
    catch (probe) { return probe.code === 'ESRCH'; }
  }
}

// Maintains the legacy atomic owner.lock exclusion (0.2.0 writers know only
// owner.lock), plus a stable Linux guard to serialize new readers/reclaimers.
function acquireStateOwnership(dir, { requireGuard = false, recoverStale = true } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = fs.realpathSync(dir);
  const file = path.join(base, 'owner.lock');
  const support = facility(base);
  if (requireGuard && !support) throw unavailable();
  const nonce = randomBytes(16).toString('hex');
  const owner = JSON.stringify({ ...(support?.identity ?? { pid: process.pid }), nonce });
  const guard = support ? guardFile(base, support.flock) : null;
  try {
    // Rename cannot provide O_EXCL semantics; link the fully written record so
    // SIGKILL never exposes a half-written owner.lock to either version.
    // Legacy fallback uses the original create-once protocol and never reclaims.
    if (guard === null) {
      try { fs.writeFileSync(file, owner, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code === 'EEXIST') throw locked('owner.lock exists; automatic recovery is unavailable here'); throw error; }
    } else {
      const temp = path.join(base, '.owner-' + nonce);
      const metadata = fs.openSync(temp, 'wx', 0o600);
      try {
        try { fs.writeFileSync(metadata, owner); }
        finally { fs.closeSync(metadata); }
        try { fs.linkSync(temp, file); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!recoverStale) throw locked('owner.lock exists; stop and verify the application before proceeding');
          const before = readOwner(file);
          let prior;
          try { prior = JSON.parse(before.text); } catch {}
          if (!definitivelyStale(prior, support.identity)) {
            throw locked('cannot safely establish that owner.lock is stale; stop all writers and inspect it manually');
          }
          if (before.info.nlink === 2) {
            // A process killed immediately after publishing the hard-link may
            // still have its private source name. Reject arbitrary aliases.
            const source = path.join(base, '.owner-' + prior.nonce);
            if (!sameFile(before.info, fs.lstatSync(source))) throw locked('owner.lock has an unexpected hard link');
            fs.unlinkSync(source);
          }
          if (!sameFile(before.info, fs.lstatSync(file))) throw locked('owner.lock changed during inspection');
          fs.unlinkSync(file);
          try { fs.linkSync(temp, file); }
          catch (replacement) {
            if (replacement.code === 'EEXIST') throw locked('another writer acquired owner.lock during recovery');
            throw replacement;
          }
        }
      } finally {
        try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  } catch (error) {
    if (guard !== null) fs.closeSync(guard);
    throw error;
  }

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      if (readOwner(file).text === owner) fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { if (guard !== null) fs.closeSync(guard); }
  };
}

module.exports = { acquireStateOwnership };
