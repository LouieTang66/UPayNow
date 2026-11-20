'use strict';
// Isolated public-root operations only. No merchant state, keys or signing.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { Store } = require('../backend/store.cjs');
const { ManagedTunnel } = require('../backend/managed-tunnel.cjs');
const { AppError, requireValue: check } = require('../backend/chain.cjs');
const ops = require('./service.cjs');
const KEY = 'publicOpsPhoneJobs';
const digest = s => crypto.createHash('sha256').update(String(s)).digest();
const UUID = /^[a-f0-9-]{36}$/;
const dataDir = options => options.dir || process.env.UPAY_OPS_DATA_DIR || path.join(os.homedir(), 'HermesData', 'upaynow-public-ops');
function fields(input, allowed) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'JSON_OBJECT_REQUIRED');
  check(Object.keys(input).every(k => allowed.includes(k)), 'OPS_SCOPE_OVERRIDE', 403);
}
class OpsPhone {
  constructor(options = {}) {
    this.options = options;
    this.database = new Store(dataDir(options));
    this.queue = Promise.resolve();
    this.currentId = Object.values(this.records()).sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
    this.store = { handoff: id => this.record(id), job: id => this.record(id),
      saveHandoff: r => this.save(r), saveJob: r => this.save(r), transaction: fn => this.database.transaction(fn) };
    if (options.origin) {
      const u = new URL(options.origin);
      check(u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password, 'PHONE_HTTPS_REQUIRED');
      this.origin = u.origin;
    }
    if (options.quick !== false) this.tunnel = new ManagedTunnel(this, { ...(typeof options.quick === 'object' ? options.quick : {}), waitForResultAck: true });
  }
  records() { return this.database.get(KEY, {}); }
  record(id) { return this.records()[id]; }
  save(r) { const all = this.records(); all[r.id] = r; this.database.set(KEY, all); return r; }
  exclusive(fn) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  view(r) {
    check(r, 'OPS_PHONE_NOT_FOUND', 404);
    const p = r.preview;
    return { id: r.id, state: r.state, ready: r.state === 'MINED', chainId: p.chainId,
      singleton: p.singleton, deployer: p.deployer, creationCodeHash: p.creationCodeHash, runtimeCodeHash: p.runtimeCodeHash,
      hash: r.hash || null, from: r.from || null, requestRevision: r.requestRevision || 0,
      expiresAt: r.expiresAt, closedAt: r.closedAt || null, transaction: r.state === 'UNKNOWN' ? r.transaction || null : null };
  }
  authorize(id, token, action = 'read') {
    const r = this.record(id); check(r, 'OPS_PHONE_NOT_FOUND', 404);
    check(crypto.timingSafeEqual(digest(token), Buffer.from(r.tokenHash, 'hex')), 'INVALID_OPS_PHONE_TOKEN', 401);
    this.tunnel?.requireActive(r);
    const recovery = ['read', 'attach', 'verify', 'ack'].includes(action) && ['UNKNOWN', 'MINED'].includes(r.state);
    check((!r.closedAt && Date.now() < r.expiresAt) || recovery, 'OPS_PHONE_EXPIRED', 410);
    return r;
  }
  async create(input) {
    fields(input, ['chainId', 'rpcUrl']);
    return this.exclusive(async () => {
      const preview = await ops.preview(input);
      const existing = Object.values(this.records()).filter(r => r.preview.chainId === preview.chainId);
      if (preview.ready) {
        for (const r of existing.filter(r => r.state !== 'MINED')) { r.state = 'MINED'; r.outcome = 'SUCCESS'; this.save(r); }
        throw new AppError('OPS_ALREADY_READY', 409);
      }
      check(!existing.some(r => r.state === 'UNKNOWN'), 'OPS_SEND_UNRESOLVED', 409);
      if (this.tunnel) check(['CLOSED', 'FAILED'].includes(this.tunnel.status().state), 'TUNNEL_BUSY', 409);
      else check(this.origin && new URL(this.origin).protocol === 'https:', 'PHONE_HTTPS_REQUIRED', 409);
      if (!this.server?.listening) await this.listen(0);
      const token = crypto.randomBytes(32).toString('base64url'), id = crypto.randomUUID();
      const r = { id, jobId: id, preview, config: { chainId: preview.chainId, rpcUrl: preview.rpcUrl },
        state: 'READY', tokenHash: digest(token).toString('hex'), createdAt: Date.now(), expiresAt: Date.now() + 300000, requestRevision: 0 };
      // Revoke old unused tickets; do not cancel or erase UNKNOWN records.
      for (const old of existing.filter(x => x.state === 'READY' && !x.closedAt)) { old.closedAt = Date.now(); this.save(old); }
      this.save(r); this.currentId = id;
      try {
        if (this.tunnel) { const s = await this.tunnel.open(id); r.tunnelSessionId = s.id; r.expiresAt = s.expiresAt; this.save(r); }
        const url = `${this.origin}/o/${id}#${token}`;
        return { id, url, expiresAt: r.expiresAt, qrSvg: await QRCode.toString(url, { type: 'svg', width: 300, margin: 2 }), view: this.view(r) };
      } catch (e) { r.closedAt = Date.now(); this.save(r); await this.tunnel?.close('START_FAILED'); throw e; }
    });
  }
  async refresh(r) {
    const p = await ops.preview(r.config);
    if (p.ready) { r = this.record(r.id); r.state = 'MINED'; r.outcome = 'SUCCESS'; r.verifiedAt = Date.now(); this.save(r); }
    return this.view(this.record(r.id));
  }
  async action(id, token, action, input) {
    const allowed = { begin: ['from'], attach: ['transactionHash', 'requestRevision'], reject: ['requestRevision'], verify: [], ack: [] };
    check(Object.hasOwn(allowed, action), 'NOT_FOUND', 404); fields(input, allowed[action]);
    return this.exclusive(async () => {
      let r = this.authorize(id, token, action);
      if (action === 'verify') return this.refresh(r);
      if (action === 'ack') {
        check(r.state === 'MINED', 'OPS_RESULT_NOT_FINAL', 409);
        r.resultAcknowledgedAt ||= Date.now(); this.save(r); return this.view(r);
      }
      if (action === 'begin') {
        check(r.state === 'READY', 'OPS_SEND_UNRESOLVED', 409);
        check(/^0x[0-9a-f]{40}$/i.test(input.from || ''), 'INVALID_SENDER');
        const prepared = await ops.prepare({ ...r.config, from: input.from });
        r = this.authorize(id, token, action); check(r.state === 'READY', 'OPS_SEND_UNRESOLVED', 409);
        if (prepared.ready) { r.state = 'MINED'; r.outcome = 'SUCCESS'; this.save(r); return this.view(r); }
        check(prepared.transaction, 'OPS_TRANSACTION_UNAVAILABLE', 409);
        r.from = prepared.transaction.from; r.transaction = prepared.transaction; r.requestRevision++;
        r.state = 'UNKNOWN'; r.startedAt = Date.now(); this.save(r); return this.view(r);
      }
      check(Number.isSafeInteger(input.requestRevision) && input.requestRevision > 0 && input.requestRevision <= r.requestRevision, 'INVALID_WALLET_REQUEST_REVISION', 409);
      if (action === 'reject') {
        check(r.state === 'UNKNOWN' && !r.hash && input.requestRevision === r.requestRevision, 'OPS_SEND_UNRESOLVED', 409);
        r.state = 'READY'; r.transaction = null; r.lastRejectionAt = Date.now(); this.save(r); return this.view(r);
      }
      check(/^0x[0-9a-f]{64}$/i.test(input.transactionHash || ''), 'INVALID_TRANSACTION_HASH');
      check(['UNKNOWN', 'MINED'].includes(r.state), 'OPS_NOT_STARTED', 409);
      const hash = input.transactionHash.toLowerCase();
      check(!r.hash || r.hash === hash, 'TRANSACTION_HASH_ALREADY_ATTACHED', 409);
      r.hash = hash; this.save(r); return this.refresh(r);
    });
  }
  async closeSession() {
    const id = this.currentId;
    if (this.tunnel) await this.tunnel.close('MANUAL');
    if (!id) return { closed: true };
    const r = this.record(id); if (r && !r.closedAt) { r.closedAt = Date.now(); this.save(r); }
    return this.view(this.record(id));
  }
  async listen(port = 0) {
    this.server = http.createServer(async (req, res) => {
      const send = (status, body, type = 'application/json; charset=utf-8') => {
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      try {
        this.tunnel?.requireActive();
        const local = `127.0.0.1:${this.server.address().port}`, host = req.headers.host;
        check([local, this.origin && new URL(this.origin).host].includes(host), 'INVALID_HOST', 403);
        const route = new URL(req.url, 'http://' + host).pathname;
        if (req.method === 'GET' && (route === '/phone.js' || /^\/o\/[a-f0-9-]{36}$/.test(route)))
          return send(200, fs.readFileSync(path.join(__dirname, route === '/phone.js' ? 'phone.js' : 'phone.html'), 'utf8'), route === '/phone.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
        const match = route.match(/^\/api\/ops\/([a-f0-9-]{36})(?:\/(begin|attach|reject|verify|ack))?$/);
        check(match && UUID.test(match[1]), 'NOT_FOUND', 404);
        const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
        if (req.method === 'GET' && !match[2]) return send(200, this.view(this.authorize(match[1], token)));
        check(req.method === 'POST' && match[2], 'NOT_FOUND', 404);
        check(req.headers.origin === this.origin, 'ORIGIN_REQUIRED', 403);
        check(req.headers['content-type']?.split(';')[0] === 'application/json', 'JSON_REQUIRED', 415);
        let body = ''; for await (const chunk of req) { body += chunk; check(Buffer.byteLength(body) <= 4096, 'BODY_TOO_LARGE', 413); }
        let input; try { input = JSON.parse(body); } catch { throw new AppError('INVALID_JSON'); }
        return send(200, await this.action(match[1], token, match[2], input));
      } catch (e) { send(e instanceof AppError ? e.status : 502, { error: e instanceof AppError ? e.code : 'OPS_RPC_OR_INPUT_ERROR' }); }
    });
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve); });
    this.localOrigin = `http://127.0.0.1:${this.server.address().port}`;
  }
  async close() {
    await this.queue.catch(() => {}); await this.tunnel?.shutdown();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
    this.database.close();
  }
}
module.exports = { OpsPhone, dataDir };
