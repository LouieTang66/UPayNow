'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { serveFrontend } = require('./frontend.cjs');
const { ManagedTunnel } = require('./managed-tunnel.cjs');
const { review } = require('./job-view.cjs');
const { AppError, requireValue, ethers } = require('./chain.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const IN_FLIGHT = ['UNKNOWN', 'SUBMITTED', 'MINED'];
class Handoff {
  constructor(merchant, wallet, options = {}) {
    this.merchant = merchant; this.wallet = wallet; this.store = merchant.store;
    this.options = options;
    if (options.quick) this.tunnel = new ManagedTunnel(this, { ...(typeof options.quick === 'object' ? options.quick : {}), keepRejectedOpen: true });
    if (options.origin) {
      const url = new URL(options.origin);
      requireValue(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
        && (url.protocol === 'https:' || url.protocol === 'http:' && LOOPBACK.includes(url.hostname)), 'INVALID_HANDOFF_ORIGIN');
      this.origin = url.origin;
    }
  }
  config() { return { enabled: !!this.server?.listening, origin: this.origin, mode: this.tunnel ? 'quick' : 'fixed',
    ...(this.tunnel ? { maxDurationSeconds: 300, tunnel: this.tunnel.status() } : {}),
    phoneReachable: (!this.tunnel || this.tunnel.live()) && !!this.origin && new URL(this.origin).protocol === 'https:' && !LOOPBACK.includes(new URL(this.origin).hostname) }; }
  chain() {
    return this.wallet.chain();
  }
  record(id) { const r = this.store.handoff(id); requireValue(r, 'HANDOFF_NOT_FOUND', 404); return r; }
  scope(record) {
    const c = this.chain().config;
    requireValue(c.chainId === record.chainId && c.factory === record.factory && c.payout === record.payout, 'HANDOFF_SCOPE_CHANGED', 409);
  }
  authorize(id, token, action = 'read') {
    const r = this.record(id), candidate = hash(typeof token === 'string' ? token : '');
    requireValue(crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(r.tokenHash, 'hex')), 'INVALID_HANDOFF_TOKEN', 401);
    this.scope(r);
    if (this.tunnel) this.tunnel.requireActive(r);
    else requireValue(!r.tunnelSessionId, 'TUNNEL_CLOSED', 410);
    const job = r.jobId && this.store.job(r.jobId);
    const recovering = ['read', 'attach', 'reject'].includes(action) && job && IN_FLIGHT.includes(job.state);
    requireValue(!r.revokedAt || recovering, 'HANDOFF_REVOKED', 410);
    requireValue(Date.now() < r.expiresAt || recovering, 'HANDOFF_EXPIRED', 410);
    return r;
  }
  jobView(job) {
    if (!job) return null;
    const { id, state, from, txHash, candidateHash, error, outcome, expiresAt, events, walletRequestRevision } = job;
    return { id, state, from, txHash, candidateHash, error, outcome, expiresAt, events, walletRequestRevision };
  }
  view(r) {
    const job = r.jobId && this.store.job(r.jobId), c = this.chain().config;
    return { verifiedDeployment: this.merchant.options.multiChain === true, chainName: c.name || 'Chain ' + c.chainId,
      nativeSymbol: c.nativeSymbol || (Number(c.chainId) === 56 ? 'BNB' : 'ETH'), rpcUrl: c.rpcUrl, id: r.id, chainId: r.chainId, factory: r.factory, payout: r.payout, expiresAt: r.expiresAt,
      state: job ? job.state : r.revokedAt ? 'REVOKED' : Date.now() >= r.expiresAt ? 'EXPIRED' : r.state,
      entries: r.entries, job: this.jobView(job), revoked: !!r.revokedAt,
      ...(this.tunnel ? { tunnel: this.tunnel.status(r) } : {}) };
  }
  async create(body) {
    requireValue(!this.creating, 'TUNNEL_BUSY', 409);
    this.creating = true;
    let result;
    try {
      if (this.tunnel) requireValue(['CLOSED', 'FAILED'].includes(this.tunnel.status().state), 'TUNNEL_BUSY', 409);
      result = await this.createLocal(body);
      if (!this.tunnel) return result;
      const session = await this.tunnel.open(result.id), r = this.record(result.id);
      this.scope(r); this.tunnel.requireActive();
      r.tunnelSessionId = session.id; r.expiresAt = session.expiresAt; this.store.saveHandoff(r);
      const url = session.origin + '/c/' + r.id + new URL(result.url).hash;
      return { ...this.view(r), url, phoneReachable: true, qrSvg: await QRCode.toString(url, { type: 'svg', width: 300, margin: 2 }) };
    } catch (error) {
      if (result && this.tunnel) {
        await this.tunnel.close('START_FAILED');
        const r = this.record(result.id); r.revokedAt = Date.now(); this.store.saveHandoff(r);
      }
      throw error;
    } finally { this.creating = false; }
  }
  async createLocal(body) {
    requireValue(this.server?.listening, 'HANDOFF_NOT_ENABLED', 409);
    this.chain();
    requireValue(['paid', 'manual'].includes(body.mode), 'INVALID_COLLECTION_MODE');
    requireValue(Array.isArray(body.orderIds) && body.orderIds.length && body.orderIds.every(id => typeof id === 'string'), 'ORDER_IDS_REQUIRED');
    requireValue(new Set(body.orderIds).size === body.orderIds.length, 'DUPLICATE_ORDER_IDS');
    requireValue(body.mode !== 'paid' || body.token === undefined && body.wrongToken === undefined, 'PAID_COLLECTION_TOKEN_OVERRIDE_FORBIDDEN');
    requireValue(body.wrongToken === undefined || body.confirmWrongToken === true, 'WRONG_TOKEN_CONFIRMATION_REQUIRED');
    await this.merchant.scan();
    const r = await this.merchant.exclusive(async () => {
      const chain = this.chain(), c = chain.config;
      requireValue(!this.store.jobs().some(j => ['PREPARED', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN'].includes(j.state)), 'TRANSACTION_RECONCILIATION_REQUIRED', 409);
      const paid = body.mode === 'paid' ? await this.merchant.paidPlan(body.orderIds) : null;
      const ids = paid ? paid.entries.map(o => o.id) : body.orderIds;
      requireValue(ids.length, 'NO_COLLECTABLE_ORDERS', 409);
      const { pairs } = await chain.encodeCollection(ids, this.store.orders(), body.wrongToken, body.token);
      const entries = [];
      for (let i = 0; i < ids.length; i++) {
        const o = this.store.order(ids[i]), token = pairs[i].token;
        const native = token === ethers.ZeroAddress, meta = c.tokens.find(t => t.address === token);
        const balance = native ? await chain.provider.getBalance(o.address) : await chain.balance(token, o.address, 'latest');
        entries.push({ reference: o.reference, address: o.address, token, symbol: native ? (c.nativeSymbol || (Number(c.chainId) === 56 ? 'BNB' : 'ETH')) : meta?.symbol || '未列代币（原始单位）',
          expectedAmount: o.expectedAmount, balance: ethers.formatUnits(balance, native ? 18 : meta?.decimals ?? 0) });
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const record = { id: crypto.randomUUID(), tokenHash: hash(token), state: 'READY', createdAt: Date.now(), expiresAt: Date.now() + 600000,
        chainId: c.chainId, factory: c.factory, payout: c.payout, entries, jobId: null,
        intent: { mode: body.mode, orderIds: ids, ...(body.token === undefined ? {} : { token: body.token }),
          ...(body.wrongToken === undefined ? {} : { wrongToken: body.wrongToken, confirmWrongToken: true }) } };
      this.store.saveHandoff(record);
      return { ...this.view(record), url: `${this.origin}/c/${record.id}#${token}`, phoneReachable: this.config().phoneReachable };
    });
    return { ...r, qrSvg: await QRCode.toString(r.url, { type: 'svg', width: 300, margin: 2 }) };
  }
  async prepare(id, token, body) {
    requireValue(Object.keys(body).every(k => k === 'from'), 'HANDOFF_SCOPE_OVERRIDE', 403);
    const r = this.authorize(id, token, 'prepare');
    requireValue(r.state === 'READY', 'HANDOFF_USED', 409);
    if (r.jobId) {
      const job = this.store.job(r.jobId);
      requireValue(job?.state === 'PREPARED' && job.from.toLowerCase() === String(body.from).toLowerCase(), 'HANDOFF_USED', 409);
      return { job: this.jobView(job), summary: review(job) };
    }
    const result = await this.wallet.prepare({ ...r.intent, from: body.from }, job => {
      const fresh = this.authorize(id, token, 'prepare');
      requireValue(!fresh.jobId && fresh.state === 'READY', 'HANDOFF_USED', 409);
      fresh.jobId = job.id; job.handoffId = id; this.store.saveHandoff(fresh);
    });
    if (!result.job) { const fresh = this.record(id); fresh.state = 'EMPTY'; this.store.saveHandoff(fresh); }
    return { job: this.jobView(result.job), summary: result.summary };
  }
  async action(id, token, action, body) {
    requireValue(['begin', 'retry', 'attach', 'reject'].includes(action), 'NOT_FOUND', 404);
    requireValue(Object.keys(body).every(k => action === 'attach' && k === 'transactionHash'
      || ['attach', 'reject'].includes(action) && k === 'requestRevision'), 'HANDOFF_SCOPE_OVERRIDE', 403);
    const r = this.authorize(id, token, action), job = r.jobId && this.store.job(r.jobId);
    requireValue(job?.handoffId === id, 'HANDOFF_JOB_NOT_READY', 409);
    if (action === 'begin') {
      const result = await this.wallet.begin(job.id, () => this.authorize(id, token, 'begin'));
      return { job: this.jobView(result.job), transaction: result.transaction };
    }
    if (action === 'retry') {
      const result = await this.wallet.retry(job.id, () => this.authorize(id, token, 'retry'));
      return { job: this.jobView(result.job), transaction: result.transaction };
    }
    const result = action === 'attach' ? await this.wallet.attach(job.id, body) : await this.wallet.cancel(job.id, { rejected: true }, current => {
      requireValue(!(current.walletRequestRevision || 0) || body.requestRevision === current.walletRequestRevision, 'STALE_WALLET_REQUEST', 409);
    });
    return this.jobView(result);
  }
  async revoke(id) {
    const result = await this.merchant.exclusive(async () => {
      const r = this.record(id), job = r.jobId && this.store.job(r.jobId);
      this.store.transaction(() => {
        r.revokedAt = Date.now(); this.store.saveHandoff(r);
        if (job?.state === 'PREPARED') { job.state = 'CANCELLED'; job.error = 'HANDOFF_REVOKED'; this.store.saveJob(job); }
      });
      return this.view(r);
    });
    if (this.tunnel?.status().handoffId === id) await this.tunnel.close('REVOKED');
    return { ...result, ...(this.tunnel ? { tunnel: this.tunnel.status(this.record(id)) } : {}) };
  }
  async listen(port) {
    this.server = http.createServer(async (request, response) => {
      const send = (code, value, type = 'application/json; charset=utf-8') => {
        response.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
      };
      response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      try {
        const requestedPath = new URL(request.url, 'http://localhost').pathname;
        const requestedId = requestedPath.match(/^\/(?:v2\/c\/|c\/|api\/handoffs\/)([a-f0-9-]{36})(?:\/|$)/)?.[1];
        const target = requestedId && this.options.resolveHandoff ? this.options.resolveHandoff(requestedId) : this;
        if (target.tunnel) target.tunnel.requireActive();
        const localHost = `127.0.0.1:${this.server.address().port}`, host = request.headers.host;
        requireValue([localHost, `localhost:${this.server.address().port}`, new URL(target.origin).host].includes(host), 'INVALID_HOST', 403);
        const url = new URL(request.url, 'http://' + host), route = url.pathname;
        requireValue(['GET', 'POST'].includes(request.method), 'METHOD_NOT_ALLOWED', 405);
        if (serveFrontend(request, response, route, 'collect')) return;
        const match = route.match(/^\/api\/handoffs\/([a-f0-9-]{36})(?:\/(prepare|begin|retry|attach|reject))?$/);
        requireValue(match, 'NOT_FOUND', 404);
        const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
        if (request.method === 'GET' && !match[2]) return send(200, target.view(target.authorize(match[1], token)));
        requireValue(request.method === 'POST' && match[2], 'NOT_FOUND', 404);
        requireValue(request.headers.origin === target.origin, 'ORIGIN_REQUIRED', 403);
        requireValue(request.headers['content-type']?.split(';')[0] === 'application/json', 'JSON_REQUIRED', 415);
        // Authenticate before reading a potentially slow body. Do not accept cookies or administrator credentials.
        target.authorize(match[1], token, match[2]);
        let bytes = 0; const chunks = [];
        for await (const chunk of request) { bytes += chunk.length; requireValue(bytes <= 4096, 'BODY_TOO_LARGE', 413); chunks.push(chunk); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('INVALID_JSON'); }
        requireValue(body && !Array.isArray(body) && typeof body === 'object', 'JSON_OBJECT_REQUIRED');
        return send(200, match[2] === 'prepare' ? await target.prepare(match[1], token, body) : await target.action(match[1], token, match[2], body));
      } catch (error) { send(error instanceof AppError ? error.status : 502, { error: error instanceof AppError ? error.code : 'UPSTREAM_OR_STORAGE_ERROR' }); }
    });
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
    this.server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve); });
    this.localOrigin = `http://127.0.0.1:${this.server.address().port}`;
    this.origin ||= this.localOrigin;
  }
  async close() { await this.tunnel?.shutdown(); if (this.server?.listening) await new Promise(resolve => this.server.close(resolve)); }
}
module.exports = { Handoff };
