'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { AppError, requireValue } = require('./chain.cjs');
const { ensureCloudflared } = require('./cloudflared.cjs');
const DURATION_MS = 300000;
class ManagedTunnel {
  constructor(handoff, options = {}) {
    this.handoff = handoff; this.store = handoff.store; this.options = options;
    this.now = options.now || Date.now; this.mono = options.mono || (() => performance.now());
    this.session = { state: 'CLOSED', expiresAt: null, reason: 'NOT_STARTED' };
    this.monitor = setInterval(() => this.tick(), 250); this.monitor.unref();
  }
  status(record) {
    const s = this.session;
    if (record && s.handoffId !== record.id) return { state: 'CLOSED', handoffId: record.id, expiresAt: record.expiresAt, reason: record.closeReason || 'SESSION_CLOSED' };
    return { state: s.state, handoffId: s.handoffId, expiresAt: s.expiresAt, reason: s.reason, error: s.error };
  }
  live() { const s = this.session; return s.state === 'RUNNING' && this.now() < s.expiresAt && this.mono() < s.monoDeadline; }
  requireActive(record) {
    const s = this.session;
    if (s.state === 'RUNNING' && !this.live()) { void this.close('TIMEOUT'); throw new AppError('TUNNEL_EXPIRED', 410); }
    requireValue(this.live(), 'TUNNEL_CLOSED', 410);
    if (record) requireValue(s.handoffId === record.id && s.id === record.tunnelSessionId, 'TUNNEL_CLOSED', 410);
  }
  finishRecord(reason) {
    const id = this.session.handoffId, r = id && this.store.handoff(id);
    if (!r || r.closedAt) return;
    this.store.transaction(() => {
      r.closedAt = this.now(); r.closeReason = reason; this.store.saveHandoff(r);
      const j = r.jobId && this.store.job(r.jobId);
      // UNKNOWN is never a cancellation. Only a transaction not yet handed to a wallet is releasable.
      if (j?.state === 'PREPARED') { j.state = 'CANCELLED'; j.error = 'TUNNEL_CLOSED_BEFORE_SEND'; this.store.saveJob(j); }
    });
  }
  tick() {
    const s = this.session;
    if (s.state !== 'RUNNING') return;
    if (!this.live()) return void this.close('TIMEOUT');
    const r = this.store.handoff(s.handoffId), j = r?.jobId && this.store.job(r.jobId);
    // Deployment phones must receive/render the terminal result before early shutdown.
    // The hard deadline above still applies even if the phone never acknowledges.
    if (this.options.waitForResultAck && ['MINED', 'CANCELLED', 'REPLACED', 'ABANDONED'].includes(j?.state) && !r?.resultAcknowledgedAt) return;
    if (j?.state === 'MINED') void this.close(j.outcome === 'SUCCESS' ? 'COMPLETED' : j.outcome || 'TRANSACTION_FINISHED');
    else if (j?.state === 'CANCELLED' && !(this.options.keepRejectedOpen && j.error === 'USER_REJECTED')) void this.close('REJECTED');
    else if (['REPLACED', 'ABANDONED'].includes(j?.state)) void this.close(j.state);
    else if (r?.state === 'EMPTY') void this.close('EMPTY');
  }
  async open(handoffId) {
    requireValue(!this.stopped && ['CLOSED', 'FAILED'].includes(this.session.state) && !this.worker && !this.preparing, 'TUNNEL_BUSY', 409);
    const session = { id: crypto.randomUUID(), handoffId, state: 'STARTING', expiresAt: null };
    this.session = session;
    let binary = this.options.binary || process.env.UPAY_CLOUDFLARED || 'cloudflared';
    // Custom workers are test/integration seams and must never trigger a network install.
    if (!this.options.workerPath || this.options.ensureCloudflared) {
      this.preparationAbort = new AbortController();
      const preparing = (this.options.ensureCloudflared || ensureCloudflared)({
        dir: this.store.dir || this.handoff.database?.dir, binary: this.options.binary, signal: this.preparationAbort.signal
      });
      this.preparing = preparing;
      try { binary = await preparing; }
      catch (error) {
        if (session.state === 'STARTING') {
          session.state = 'FAILED'; session.reason = 'START_FAILED'; session.error = error.code || 'CLOUDFLARED_DOWNLOAD_FAILED';
        }
        throw new AppError(session.state === 'CLOSING' ? 'TUNNEL_CLOSED' : session.error, 502);
      } finally { if (this.preparing === preparing) { this.preparing = null; this.preparationAbort = null; } }
      // A close/shutdown while preparing must never fork after the download completes.
      requireValue(this.session === session && session.state === 'STARTING' && !this.stopped, 'TUNNEL_CLOSED', 502);
    }
    const target = `http://127.0.0.1:${this.handoff.server.address().port}`;
    let worker;
    try {
      worker = fork(this.options.workerPath || path.join(__dirname, 'tunnel-worker.cjs'), [target, binary],
        { silent: true, execArgv: [], env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USERPROFILE|TMPDIR|TMP|TEMP|SystemRoot|WINDIR|SSL_CERT_FILE|SSL_CERT_DIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key))) });
    } catch { session.state = 'FAILED'; throw new AppError('TUNNEL_START_FAILED', 502); }
    this.worker = worker;
    // Do not relay raw connector logs or inherit any administrator credential on stdout.
    worker.stdout?.resume(); worker.stderr?.resume();
    this.ended = new Promise(resolve => worker.once('exit', resolve));
    return new Promise((resolve, reject) => {
      let settled = false, connector;
      const killConnector = () => {
        if (!connector) return;
        try {
          if (connector.processGroup) process.kill(-connector.pid, 'SIGKILL');
          else process.kill(connector.pid, 'SIGKILL');
        } catch (error) { if (error.code !== 'ESRCH') session.error = 'CONNECTOR_CLEANUP_FAILED'; }
        connector = null;
      };
      const fail = code => { if (!settled) { settled = true; reject(new AppError(code || 'TUNNEL_START_FAILED', 502)); } };
      const guard = setTimeout(() => { fail('TUNNEL_START_TIMEOUT'); void this.close('START_FAILED'); }, 50000);
      worker.on('message', message => {
        if (this.session !== session) return;
        if (message?.type === 'connector' && session.state === 'STARTING' && !connector
          && Number.isSafeInteger(message.pid) && message.pid > 1) {
          connector = { pid: message.pid, processGroup: message.processGroup === true };
        } else if (message?.type === 'ready' && session.state === 'STARTING') {
          if (!/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(message.origin || '')
            || !Number.isFinite(message.expiresAt) || message.expiresAt <= this.now() || message.expiresAt > this.now() + DURATION_MS + 1000) {
            fail('TUNNEL_START_FAILED'); void this.close('START_FAILED'); return;
          }
          session.expiresAt = Math.min(message.expiresAt, this.now() + DURATION_MS);
          session.monoDeadline = this.mono() + Math.min(DURATION_MS, session.expiresAt - this.now());
          session.state = 'RUNNING'; this.handoff.origin = message.origin;
          clearTimeout(guard); settled = true; resolve({ id: session.id, origin: message.origin, expiresAt: session.expiresAt });
        } else if (message?.type === 'stopped') {
          session.state = 'CLOSING'; session.reason ||= message.reason; session.error = message.error;
          try { this.finishRecord(session.reason); } catch { session.error = 'TUNNEL_STORAGE_ERROR'; }
          fail(message.error || 'TUNNEL_CLOSED');
        }
      });
      worker.once('error', () => { fail('TUNNEL_START_FAILED'); void this.close('START_FAILED'); });
      worker.once('exit', () => {
        killConnector();
        clearTimeout(guard); if (this.worker === worker) this.worker = null;
        if (this.session === session) {
          session.reason ||= session.state === 'STARTING' ? 'START_FAILED' : 'CONNECTION_CLOSED';
          session.state = session.error ? 'FAILED' : 'CLOSED';
          try { this.finishRecord(session.reason); } catch { session.error = 'TUNNEL_STORAGE_ERROR'; session.state = 'FAILED'; }
          this.handoff.origin = this.handoff.localOrigin;
        }
        fail(session.error || 'TUNNEL_START_FAILED');
      });
    });
  }
  async close(reason = 'MANUAL') {
    const s = this.session;
    if (this.preparing) {
      const preparing = this.preparing;
      s.state = 'CLOSING'; s.reason ||= reason;
      this.preparationAbort?.abort();
      try { this.finishRecord(s.reason); } catch { s.error = 'TUNNEL_STORAGE_ERROR'; }
      await preparing.catch(() => {});
      if (this.session === s) {
        s.state = s.error ? 'FAILED' : 'CLOSED';
        this.handoff.origin = this.handoff.localOrigin;
      }
      return this.status();
    }
    if (!this.worker) return this.status();
    s.state = 'CLOSING'; s.reason ||= reason;
    try { this.finishRecord(s.reason); } catch { s.error = 'TUNNEL_STORAGE_ERROR'; }
    const worker = this.worker;
    if (worker.connected) worker.send({ type: 'stop', reason: s.reason }, () => {});
    else worker.kill('SIGTERM');
    await this.ended;
    return this.status();
  }
  async shutdown() { this.stopped = true; clearInterval(this.monitor); await this.close('BACKEND_SHUTDOWN'); }
}
module.exports = { ManagedTunnel, DURATION_MS };
