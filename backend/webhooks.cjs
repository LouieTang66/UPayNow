'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const { requireValue } = require('./chain.cjs');
function publicIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0)
      || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
  }
  // Accept global-unicast IPv6 only; exclude private/link-local/mapped/transition space.
  return /^[23][0-9a-f]{0,3}:/i.test(ip) && !/^200[12]:|^2001:db8:/i.test(ip);
}
class Webhooks {
  constructor(store, { hosts = [], allowLocal = false, timeoutMs = 10000, lookup = dns.lookup } = {}) {
    requireValue(Number.isFinite(timeoutMs) && timeoutMs > 0, 'INVALID_WEBHOOK_TIMEOUT');
    this.store = store; this.hosts = hosts; this.allowLocal = allowLocal;
    this.timeoutMs = timeoutMs; this.lookup = lookup;
    this.secret = store.secret('webhook'); this.running = false;
    this.closing = false; this.tickPromise = null; this.active = new Set();
  }
  async target(value) {
    const url = new URL(value);
    requireValue(!url.username && !url.password && !url.hash, 'INVALID_WEBHOOK_URL');
    const local = this.allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    requireValue(local || url.protocol === 'https:' && this.hosts.includes(url.hostname), 'WEBHOOK_HOST_NOT_ALLOWED');
    const records = await this.lookup(url.hostname, { all: true, verbatim: true });
    requireValue(records.length > 0 && (local || records.every(r => publicIP(r.address))), 'WEBHOOK_PRIVATE_ADDRESS_DENIED');
    return { url, ip: records[0] };
  }
  send(n) {
    if (this.closing) return Promise.reject(new Error('WEBHOOK_CLOSED'));
    return new Promise((resolve, reject) => {
      let request, response, settled = false;
      const finish = (error, ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); this.active.delete(abort);
        // Settle independently of socket/DNS callbacks, which may never arrive.
        if (error) { response?.destroy(); request?.destroy(error); reject(error); }
        else resolve(ok);
      };
      const abort = () => finish(new Error('WEBHOOK_CLOSED'));
      const timer = setTimeout(() => finish(new Error('WEBHOOK_TIMEOUT')), this.timeoutMs);
      this.active.add(abort);
      // Both fulfillment and rejection are handled even after timeout/close.
      Promise.resolve().then(() => this.target(n.url)).then(({ url, ip }) => {
        if (settled || this.closing) return;
        const payload = JSON.stringify(n.payload), timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = crypto.createHmac('sha256', this.secret).update(timestamp + '.' + payload).digest('hex');
        const transport = url.protocol === 'https:' ? https : http;
        request = transport.request(url, { method: 'POST', autoSelectFamily: false,
          lookup: (_hostname, _options, callback) => callback(null, ip.address, ip.family),
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
            'X-Upaynow-Event': n.id, 'X-Upaynow-Timestamp': timestamp, 'X-Upaynow-Signature': signature } }, incoming => {
          response = incoming;
          if (settled) { response.destroy(); return; }
          let bytes = 0;
          response.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) finish(new Error('RESPONSE_TOO_LARGE')); });
          response.on('end', () => finish(null, response.statusCode >= 200 && response.statusCode < 300));
          response.on('error', error => finish(error));
          response.on('aborted', () => finish(new Error('RESPONSE_ABORTED')));
        });
        request.on('error', error => finish(error)); request.end(payload);
      }).catch(error => finish(error));
    });
  }
  abortAll() {
    this.closing = true;
    for (const abort of this.active) abort();
    return this.tickPromise || Promise.resolve();
  }
  close() { return this.abortAll(); }
  stale(n) {
    const order = this.store.order(n.orderId);
    if (!order) return true;
    // stateVersion also changes on partial/confirming/expiry transitions. Equality
    // would incorrectly discard a still-valid reversal within the same generation.
    return order.generation !== n.payload.paymentGeneration
      || n.payload.stateVersion > order.stateVersion
      || (n.payload.type === 'payment.paid' ? !order.paid
        : n.payload.type === 'payment.reversed' && order.paid);
  }
  tick() {
    if (this.closing) return this.tickPromise || Promise.resolve();
    if (this.tickPromise) return this.tickPromise;
    this.running = true;
    this.tickPromise = Promise.resolve().then(() => this.runTick()).finally(() => {
      this.running = false; this.tickPromise = null;
    });
    return this.tickPromise;
  }
  async runTick() {
    const seen = new Set();
    for (const n of this.store.notifications()) {
      if (this.closing) break;
      if (n.state !== 'PENDING' || seen.has(n.orderId)) continue;
      if (this.stale(n)) {
        n.state = 'CANCELLED'; this.store.notify(n); continue;
      }
      seen.add(n.orderId);
      if (n.nextAttempt > Date.now()) continue;
      n.attempts++;
      // Persist the attempt first. Retrying after a crash uses the SAME event ID/body.
      n.nextAttempt = Date.now() + Math.min(3600000, 1000 * 2 ** n.attempts);
      this.store.notify(n);
      let ok = false;
      try { ok = await this.send(n); } catch {}
      if (this.stale(n)) n.state = 'CANCELLED';
      else if (ok) n.state = 'DELIVERED';
      else if (!this.closing && n.attempts >= 8) n.state = 'FAILED';
      this.store.notify(n);
    }
  }
}
module.exports = { Webhooks, publicIP };
