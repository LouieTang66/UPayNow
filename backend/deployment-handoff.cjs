'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { serveFrontend } = require('./frontend.cjs');
const { ManagedTunnel } = require('./managed-tunnel.cjs');
const { AppError, requireValue } = require('./chain.cjs');
const KEY = 'deploymentPhoneTickets';
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
class DeploymentHandoff {
  constructor(service, database, options = {}) {
    this.service = service; this.database = database; this.options = options;
    // Reuse the owned 300-second tunnel/watchdog, but keep deployment records out of collection tables.
    this.store = {
      handoff: id => database.get(KEY, {})[id],
      saveHandoff: record => { const all = database.get(KEY, {}); all[record.id] = record; database.set(KEY, all); },
      job: id => service.record(id), saveJob: job => service.save(job),
      transaction: fn => database.transaction(fn)
    };
    if (options.origin) {
      const u = new URL(options.origin);
      requireValue(u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password, 'INVALID_DEPLOYMENT_ORIGIN');
      this.origin = u.origin;
    }
    if (options.quick) this.tunnel = new ManagedTunnel(this, { ...(typeof options.quick === 'object' ? options.quick : {}), waitForResultAck: true });
  }
  authorize(id, token, action = 'read') {
    const r = this.store.handoff(id);
    requireValue(r, 'DEPLOYMENT_TICKET_NOT_FOUND', 404);
    requireValue(crypto.timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(r.tokenHash, 'hex')), 'INVALID_DEPLOYMENT_TOKEN', 401);
    if (this.tunnel) this.tunnel.requireActive(r);
    const j = this.service.record(id);
    const recovery = ['read', 'attach', 'reject'].includes(action) && ['UNKNOWN', 'SUBMITTED', 'MINED'].includes(j.state);
    requireValue((!r.closedAt && Date.now() < r.expiresAt) || recovery, 'DEPLOYMENT_TICKET_EXPIRED', 410);
    return r;
  }
  async create(id) {
    requireValue(this.server?.listening, 'DEPLOYMENT_PHONE_NOT_ENABLED', 409);
    requireValue(this.service.record(id).state === 'READY', 'DEPLOYMENT_ALREADY_STARTED', 409);
    requireValue(!this.creating, 'TUNNEL_BUSY', 409);
    if (this.tunnel) requireValue(['CLOSED', 'FAILED'].includes(this.tunnel.status().state), 'TUNNEL_BUSY', 409);
    else requireValue(this.origin && new URL(this.origin).protocol === 'https:' && !LOOPBACK.includes(new URL(this.origin).hostname), 'PHONE_HTTPS_REQUIRED', 409);
    this.creating = true;
    const token = crypto.randomBytes(32).toString('base64url');
    const r = { id, jobId: id, tokenHash: hash(token), state: 'READY', createdAt: Date.now(), expiresAt: Date.now() + 600000 };
    this.store.saveHandoff(r);
    try {
      if (this.tunnel) {
        const session = await this.tunnel.open(id);
        r.tunnelSessionId = session.id; r.expiresAt = session.expiresAt;
        this.store.saveHandoff(r);
      }
      const url = `${this.origin}/d/${id}#${token}`;
      return { id, url, expiresAt: r.expiresAt, phoneReachable: true,
        qrSvg: await QRCode.toString(url, { type: 'svg', width: 300, margin: 2 }),
        ...(this.tunnel ? { tunnel: this.tunnel.status(r) } : {}) };
    } catch (error) {
      await this.tunnel?.close('START_FAILED');
      r.closedAt = Date.now(); r.closeReason = 'START_FAILED'; this.store.saveHandoff(r); throw error;
    } finally { this.creating = false; }
  }
  async closeTunnel() {
    if (this.tunnel) return this.tunnel.close('MANUAL');
    for (const r of Object.values(this.database.get(KEY, {}))) if (!r.closedAt) { r.closedAt = Date.now(); this.store.saveHandoff(r); }
    return { state: 'CLOSED', reason: 'MANUAL' };
  }
  async listen(port = 0) {
    this.server = http.createServer(async (request, response) => {
      const send = (code, value, type = 'application/json; charset=utf-8') => {
        response.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
      };
      response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      try {
        if (this.tunnel) this.tunnel.requireActive();
        const host = request.headers.host, localHost = `127.0.0.1:${this.server.address().port}`;
        requireValue([localHost, `localhost:${this.server.address().port}`, this.origin && new URL(this.origin).host].includes(host), 'INVALID_HOST', 403);
        const route = new URL(request.url, 'http://' + host).pathname;
        if (serveFrontend(request, response, route, 'deploy')) return;
        const match = route.match(/^\/api\/deploy\/([a-f0-9-]{36})(?:\/(begin|retry|attach|reject|ack))?$/);
        requireValue(match, 'NOT_FOUND', 404);
        const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
        if (request.method === 'GET' && !match[2]) { const ticket = this.authorize(match[1], token); return send(200, { ...await this.service.get(match[1]), expiresAt: ticket.expiresAt }); }
        requireValue(request.method === 'POST' && match[2], 'NOT_FOUND', 404);
        requireValue(request.headers.origin === this.origin, 'ORIGIN_REQUIRED', 403);
        const ticket = this.authorize(match[1], token, match[2]);
        requireValue(request.headers['content-type']?.split(';')[0] === 'application/json', 'JSON_REQUIRED', 415);
        let bytes = 0; const chunks = [];
        for await (const c of request) { bytes += c.length; requireValue(bytes <= 4096, 'BODY_TOO_LARGE', 413); chunks.push(c); }
        let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('INVALID_JSON'); }
        requireValue(input && typeof input === 'object' && !Array.isArray(input), 'JSON_OBJECT_REQUIRED');
        const allowed = match[2] === 'begin' ? ['from'] : match[2] === 'attach' ? ['transactionHash', 'requestRevision'] : match[2] === 'reject' ? ['requestRevision'] : [];
        requireValue(Object.keys(input).every(k => allowed.includes(k)), 'DEPLOYMENT_SCOPE_OVERRIDE', 403);
        if (match[2] === 'ack') {
          const result = this.service.record(match[1]);
          requireValue(['MINED', 'CANCELLED'].includes(result.state), 'DEPLOYMENT_RESULT_NOT_FINAL', 409);
          // A scoped phone acknowledges only a persisted terminal result, never an UNKNOWN send.
          ticket.resultAcknowledgedAt ||= Date.now();
          this.store.saveHandoff(ticket);
          return send(200, { ok: true });
        }
        const authorize = () => this.authorize(match[1], token, match[2]);
        const result = match[2] === 'reject' ? await this.service.cancel(match[1], { rejected: true, ...input }, authorize) : await this.service[match[2]](match[1], input, authorize);
        return send(200, { ...result, expiresAt: ticket.expiresAt });
      } catch (error) { send(error instanceof AppError ? error.status : 502, { error: error instanceof AppError ? error.code : 'UPSTREAM_OR_STORAGE_ERROR' }); }
    });
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
    this.server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(Number(port), '127.0.0.1', resolve); });
    this.localOrigin = `http://127.0.0.1:${this.server.address().port}`; this.origin ||= this.localOrigin;
  }
  async close() { await this.tunnel?.shutdown(); if (this.server?.listening) await new Promise(resolve => this.server.close(resolve)); }
}
module.exports = { DeploymentHandoff };
