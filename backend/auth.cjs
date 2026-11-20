'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { AppError, requireValue } = require('./chain.cjs');
const scrypt = promisify(crypto.scrypt);
const PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const random = () => crypto.randomBytes(32).toString('base64url');
const equal = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const keyValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
class Auth {
  constructor(dir) {
    this.file = path.join(dir, 'auth.json');
    this.generation = 0; this.active = 0; this.changing = false;
    this.sessions = new Map(); this.attempts = new Map();
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw new AppError('AUTH_STORAGE_ERROR', 503); }
    if (text !== undefined) {
      try {
        const state = JSON.parse(text), p = state.password;
        requireValue(state.version === 1 && keyValid(state.recoveryKey) && keyValid(state.apiKey) && state.apiKey !== state.recoveryKey &&
          (p === null || p && p.algorithm === 'scrypt' && p.N === PARAMS.N && p.r === PARAMS.r && p.p === PARAMS.p && /^[a-f0-9]{32}$/.test(p.salt) && /^[a-f0-9]{64}$/.test(p.hash)), 'AUTH_STATE_INVALID', 503);
        fs.chmodSync(this.file, 0o600); this.state = state;
      } catch { throw new AppError('AUTH_STATE_INVALID', 503); }
    } else {
      const recoveryKey = random();
      let apiKey; do { apiKey = random(); } while (apiKey === recoveryKey);
      this.persist({ version: 1, password: null, recoveryKey, apiKey });
    }
  }
  // Only publish memory after the complete protected file has been replaced.
  persist(state) {
    const temporary = this.file + '.' + random() + '.tmp'; let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
    } catch {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
      throw new AppError('AUTH_STORAGE_ERROR', 503);
    }
    this.state = state;
  }
  status() { return { passwordSet: this.state.password !== null, passwordMinLength: 12 }; }
  rate(key) {
    const now = Date.now();
    for (const [address, rate] of this.attempts) if (rate.until <= now) this.attempts.delete(address);
    let rate = this.attempts.get(key);
    if (!rate) {
      requireValue(this.attempts.size < 1024, 'AUTH_RATE_LIMIT', 429);
      rate = { count: 0, until: now + 300000 }; this.attempts.set(key, rate);
    }
    requireValue(++rate.count <= 10, 'AUTH_RATE_LIMIT', 429);
  }
  async derive(password, salt) {
    requireValue(this.active < 2, 'AUTH_BUSY', 503); this.active++;
    try { return await scrypt(password, salt, 32, PARAMS); }
    finally { this.active--; }
  }
  validatePassword(value) {
    requireValue(typeof value === 'string' && value.length >= 12 && value.length <= 128 && /\S/u.test(value), 'INVALID_PASSWORD', 400);
    requireValue(!equal(value, this.state.recoveryKey) && !equal(value, this.state.apiKey), 'PASSWORD_IS_CREDENTIAL', 400);
  }
  async verify(value, generation) {
    requireValue(this.state.password, 'PASSWORD_NOT_SET', 409);
    requireValue(typeof value === 'string' && value.length >= 12 && value.length <= 128 && !equal(value, this.state.recoveryKey) && !equal(value, this.state.apiKey), 'UNAUTHORIZED', 401);
    const record = this.state.password;
    const hash = await this.derive(value, Buffer.from(record.salt, 'hex'));
    requireValue(generation === this.generation, 'AUTH_CHANGED', 409);
    requireValue(crypto.timingSafeEqual(hash, Buffer.from(record.hash, 'hex')), 'UNAUTHORIZED', 401);
  }
  session(token) { return typeof token === 'string' && this.sessions.get(token) > Date.now(); }
  bearer(value) { return typeof value === 'string' && equal(value, this.state.apiKey); }
  async login(password) {
    const generation = this.generation; await this.verify(password, generation);
    requireValue(generation === this.generation, 'AUTH_CHANGED', 409);
    const now = Date.now();
    for (const [token, expires] of this.sessions) if (expires <= now) this.sessions.delete(token);
    while (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value);
    const token = random(); this.sessions.set(token, now + 8 * 3600000); return token;
  }
  async reveal(kind, password, token) {
    const generation = this.generation;
    requireValue(this.session(token), 'SESSION_REQUIRED', 401);
    await this.verify(password, generation);
    requireValue(this.session(token), 'SESSION_REQUIRED', 401);
    return { [kind]: this.state[kind] };
  }
  async change(input, token, reset = false) {
    requireValue(!this.changing, 'AUTH_BUSY', 503); this.changing = true;
    try {
      const generation = this.generation;
      if (reset) requireValue(typeof input.recoveryKey === 'string' && input.recoveryKey.length <= 512 && equal(input.recoveryKey, this.state.recoveryKey), 'INVALID_RECOVERY_KEY', 401);
      else {
        requireValue(this.session(token), 'SESSION_REQUIRED', 401);
        await this.verify(input.currentPassword, generation);
        requireValue(this.session(token), 'SESSION_REQUIRED', 401);
      }
      this.validatePassword(input.newPassword);
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = (await this.derive(input.newPassword, Buffer.from(salt, 'hex'))).toString('hex');
      requireValue(generation === this.generation, 'AUTH_CHANGED', 409);
      if (!reset) requireValue(this.session(token), 'SESSION_REQUIRED', 401);
      let recoveryKey = this.state.recoveryKey;
      if (reset) do { recoveryKey = random(); } while (recoveryKey === this.state.recoveryKey || recoveryKey === this.state.apiKey || equal(recoveryKey, input.newPassword));
      this.persist({ ...this.state, password: { algorithm: 'scrypt', N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, salt, hash }, recoveryKey });
      this.generation++; this.sessions.clear();
      return reset ? { ok: true, recoveryKey } : { ok: true };
    } finally { this.changing = false; }
  }
}
module.exports = { Auth };
