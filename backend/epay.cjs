'use strict';
const crypto = require('node:crypto');
const { Webhooks } = require('./webhooks.cjs');
const { AppError, requireValue, address, ethers } = require('./chain.cjs');

const FIELD_NAMES = new Set(['pid', 'type', 'out_trade_no', 'name', 'money', 'notify_url', 'return_url', 'device', 'sign', 'sign_type']);
const TRADE_NO = /^[a-zA-Z0-9_-]{1,80}$/;
const MONEY = /^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/;
const SOURCE_PREFIX = 'epay:new-api:';
const MAX_FORM = 8192;
const MAX_ATTEMPTS = 8;
const CHAIN_REVERSAL = 'CHAIN_REVERSAL';
const FINAL_CALLBACK_OUTCOME_UNKNOWN = 'FINAL_CALLBACK_OUTCOME_UNKNOWN';

function reconcileCallback(q) {
  q.state = 'RECONCILE';
  q.reconcileReason = FINAL_CALLBACK_OUTCOME_UNKNOWN;
  q.callbackOutcomeUnknown = true;
}

function endpoint(value) {
  let u;
  try { u = new URL(value); } catch {}
  requireValue(u?.protocol === 'https:' && !u.username && !u.password && !u.hash
    && typeof value === 'string' && value.length <= 1024 && !/[&\s]/.test(value), 'INVALID_EPAY_URL');
  return u.href;
}

function environment(env) {
  if (!env.UPAY_EPAY_ENABLED || env.UPAY_EPAY_ENABLED === '0') return null;
  requireValue(env.UPAY_EPAY_ENABLED === '1', 'INVALID_EPAY_ENABLED');
  requireValue(env.UPAY_EPAY_TOKEN_PER_FIAT === undefined, 'EPAY_EXCHANGE_RATE_UNSUPPORTED');
  return {
    pid: env.UPAY_EPAY_PID, key: env.UPAY_EPAY_KEY, type: env.UPAY_EPAY_TYPE ?? 'usdt',
    deploymentId: env.UPAY_EPAY_DEPLOYMENT_ID ?? 'legacy', token: env.UPAY_EPAY_TOKEN,
    priceCurrency: env.UPAY_EPAY_PRICE_CURRENCY, notifyUrl: env.UPAY_EPAY_NOTIFY_URL, returnUrl: env.UPAY_EPAY_RETURN_URL,
  };
}

function canonical(fields) {
  return Object.keys(fields).filter(k => k !== 'sign' && k !== 'sign_type' && fields[k] !== '')
    .sort().map(k => {
      requireValue(k && !/[&=]/.test(k) && typeof fields[k] === 'string' && !fields[k].includes('&'), 'INVALID_EPAY_SIGNING_FIELDS');
      return k + '=' + fields[k];
    }).join('&');
}

function signature(fields, key) {
  // Protocol compatibility only: do not reuse this legacy MD5 construction elsewhere.
  return crypto.createHash('md5').update(canonical(fields), 'utf8').update(key, 'utf8').digest('hex');
}

function parseForm(text) {
  requireValue(Buffer.byteLength(text) <= MAX_FORM, 'EPAY_FORM_TOO_LARGE', 413);
  const fields = Object.create(null);
  for (const pair of text.split('&')) {
    try {
      const i = pair.indexOf('=');
      requireValue(i > 0, 'INVALID_EPAY_FORM');
      const k = decodeURIComponent(pair.slice(0, i).replaceAll('+', ' '));
      const v = decodeURIComponent(pair.slice(i + 1).replaceAll('+', ' '));
      requireValue(FIELD_NAMES.has(k) && !Object.hasOwn(fields, k) && v.length <= 1024
        && !/[&\u0000-\u001f\u007f]/.test(v), 'INVALID_EPAY_FORM');
      fields[k] = v;
    } catch { throw new AppError('INVALID_EPAY_FORM'); }
  }
  return fields;
}

async function submissionForm(request, url) {
  if (request.method === 'GET') return parseForm(url.search.slice(1));
  requireValue(request.method === 'POST', 'EPAY_METHOD_NOT_ALLOWED', 405);
  requireValue(!url.search, 'INVALID_EPAY_FORM');
  requireValue(request.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded',
    'EPAY_FORM_REQUIRED', 415);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    requireValue(bytes <= MAX_FORM, 'EPAY_FORM_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new AppError('INVALID_EPAY_FORM'); }
  return parseForm(text);
}

function usdtUnits(money, decimals) {
  requireValue(typeof money === 'string' && MONEY.test(money) && money !== '0.00', 'INVALID_EPAY_PURCHASE');
  requireValue(Number.isInteger(decimals) && decimals >= 2 && decimals <= 36, 'INVALID_EPAY_TOKEN_DECIMALS');
  const units = ethers.parseUnits(money, decimals);
  requireValue(units <= ethers.MaxUint256, 'INVALID_EPAY_AMOUNT');
  return units;
}

function recordNativePayment(store, order) {
  if (!order.reference.startsWith(SOURCE_PREFIX)) return;
  const q = store.epayReference(order.reference);
  if (!q || q.orderId !== order.id) return;
  if (order.paid) {
    if (['WAITING', 'SUPPRESSED'].includes(q.state)) {
      q.generation = order.generation;
      q.state = 'PENDING';
      q.queuedAt = Date.now();
      q.attempts = 0;
      q.preflightFailures = 0;
      delete q.lastError;
      q.nextAttempt = 0;
    } else return;
  } else {
    if (q.state === 'RECONCILE' && q.reconcileReason === FINAL_CALLBACK_OUTCOME_UNKNOWN) {
      // Keep the callback uncertainty evidence but invalidate any previous
      // review of it: the confirmed chain payment has now also reversed.
      q.reconcileReason = CHAIN_REVERSAL;
    } else {
      if (!['PENDING', 'FAILED', 'DELIVERED'].includes(q.state)) return;
      q.state = q.attempts === 0 ? 'SUPPRESSED' : 'RECONCILE';
      if (q.state === 'RECONCILE') q.reconcileReason = CHAIN_REVERSAL;
    }
    q.reversedAt = Date.now();
  }
  store.saveEpay(q);
}

function view(q) {
  // No secrets, destinations, payer identifiers or native checkout bearer token.
  const { pid, outTradeNo, tradeNo, orderId, money, type, amount, priceCurrency, token, state,
    generation, attempts, preflightFailures, lastError, nextAttempt, reversedAt, deliveredAt, createdAt } = q;
  const reconcileReason = q.reconcileReason || (state === 'RECONCILE' && reversedAt ? CHAIN_REVERSAL : undefined);
  return { pid, outTradeNo, tradeNo, orderId, money, type, amount, priceCurrency, token, state,
    generation, attempts, preflightFailures, lastError, nextAttempt, reversedAt, deliveredAt, createdAt,
    ...(reconcileReason ? { reconcileReason } : {}),
    ...(q.callbackOutcomeUnknown ? { callbackOutcomeUnknown: true } : {}) };
}

class Epay {
  constructor(rootStore, engine, settings, publicOrigin, dependencies = {}) {
    requireValue(engine?.store && engine?.merchant, 'EPAY_DEPLOYMENT_UNAVAILABLE', 503);
    requireValue(publicOrigin?.protocol === 'https:', 'EPAY_PUBLIC_HTTPS_REQUIRED');
    const { pid, key, type = 'usdt', deploymentId = 'legacy', priceCurrency } = settings;
    requireValue(typeof pid === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(pid), 'INVALID_EPAY_PID');
    requireValue(typeof key === 'string' && /^[\x21-\x7e]{32,128}$/.test(key), 'INVALID_EPAY_KEY');
    requireValue(type === 'usdt', 'INVALID_EPAY_TYPE');
    requireValue(settings.rate === undefined, 'EPAY_EXCHANGE_RATE_UNSUPPORTED');
    requireValue(priceCurrency === 'USDT', 'EPAY_USDT_PRICE_REQUIRED');
    requireValue(crypto.getHashes().includes('md5'), 'EPAY_MD5_UNAVAILABLE');
    const token = address(settings.token);
    const notifyUrl = endpoint(settings.notifyUrl), returnUrl = endpoint(settings.returnUrl);
    const notifyTarget = new URL(notifyUrl);
    requireValue(!notifyTarget.search, 'EPAY_NOTIFY_QUERY_NOT_ALLOWED');
    const merchantIdentity = engine.merchant.requireChain().config;
    const tokenConfig = merchantIdentity.tokens.find(t => t.address === token);
    requireValue(tokenConfig, 'EPAY_TOKEN_NOT_CONFIGURED');
    usdtUnits('0.01', tokenConfig.decimals);
    const binding = { pid, type, token, priceCurrency, deploymentId, chainId: merchantIdentity.chainId, factory: merchantIdentity.factory,
      notifyUrl, returnUrl, publicOrigin: publicOrigin.origin };
    // Changing destination/deployment/PID must not redirect old work or reuse an external order ID in another DB.
    const previous = rootStore.get('epay.binding');
    requireValue(!previous || JSON.stringify(previous) === JSON.stringify(binding), 'EPAY_BINDING_MISMATCH', 409);
    if (!previous) rootStore.set('epay.binding', binding);
    this.binding = binding;
    this.key = key;
    this.engine = engine;
    this.store = engine.store;
    this.transport = new Webhooks(engine.store, { hosts: [notifyTarget.hostname], lookup: dependencies.lookup });
    this.running = null;
    this.closing = false;
  }

  async submit(fields) {
    const { pid, type, token, notifyUrl, returnUrl, publicOrigin } = this.binding;
    requireValue(fields.sign_type === 'MD5' && /^[a-f0-9]{32}$/.test(fields.sign || '')
      && crypto.timingSafeEqual(Buffer.from(fields.sign), Buffer.from(signature(fields, this.key)))
      && fields.pid === pid, 'EPAY_SIGNATURE_INVALID', 401);
    requireValue(fields.type === type && TRADE_NO.test(fields.out_trade_no || '')
      && typeof fields.name === 'string' && fields.name.length > 0 && fields.name.length <= 120
      && MONEY.test(fields.money || '') && fields.money !== '0.00'
      && ['pc', 'mobile', undefined].includes(fields.device), 'INVALID_EPAY_PURCHASE');
    requireValue(fields.notify_url === notifyUrl && fields.return_url === returnUrl, 'EPAY_DESTINATION_MISMATCH', 403);
    const reference = SOURCE_PREFIX + pid + ':' + fields.out_trade_no;
    let q = this.store.epayReference(reference);
    if (q) {
      requireValue(q.name === fields.name && q.money === fields.money, 'EPAY_ORDER_CONFLICT', 409);
    } else {
      // Native API references historically accept arbitrary strings; never claim a preexisting native order.
      requireValue(!this.store.reference(reference), 'EPAY_REFERENCE_CONFLICT', 409);
      const metadata = this.engine.merchant.requireChain().config.tokens.find(t => t.address === token);
      requireValue(metadata, 'EPAY_TOKEN_NOT_CONFIGURED', 409);
      usdtUnits(fields.money, metadata.decimals);
      const amount = fields.money;
      q = { reference, pid, type, token, money: fields.money, name: fields.name, outTradeNo: fields.out_trade_no,
        tradeNo: crypto.randomBytes(16).toString('hex'), amount, priceCurrency: this.binding.priceCurrency, createdAt: Date.now(),
        state: 'WAITING', attempts: 0, preflightFailures: 0, nextAttempt: 0 };
      // First transaction freezes quote before any RPC await. Native order linkage is transactional too.
      this.store.saveEpay(q);
    }
    const order = await this.engine.merchant.create({ reference, amount: q.amount, token: q.token }, { epay: true });
    return publicOrigin + '/pay/' + order.publicToken;
  }

  order(outTradeNo) {
    requireValue(typeof outTradeNo === 'string' && TRADE_NO.test(outTradeNo), 'INVALID_EPAY_ORDER');
    const q = this.store.epayReference(SOURCE_PREFIX + this.binding.pid + ':' + outTradeNo);
    requireValue(q, 'EPAY_ORDER_NOT_FOUND', 404);
    return view(q);
  }

  reconciliations() { return this.store.epayReconcile().map(view); }

  returnFor(order) {
    if (!order?.paid || !order.reference.startsWith(SOURCE_PREFIX)) return null;
    const q = this.store.epayReference(order.reference);
    if (q?.orderId !== order.id || q.state !== 'DELIVERED' || !this.eligible(q)) return null;
    return this.binding.returnUrl;
  }

  eligible(q) {
    const o = this.store.order(q.orderId);
    const head = this.store.get('lastHead');
    return !this.closing && !this.engine.merchant.busy && !this.store.get('syncError')
      && Number.isSafeInteger(head) && this.store.get('cursor', -1) >= head
      && Date.now() - this.store.get('lastSync', 0) < 60000
      && o?.paid && o.generation === q.generation;
  }

  tick() {
    if (this.closing) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    for (const candidate of this.store.dueEpay(Date.now(), MAX_ATTEMPTS)) {
      if (this.closing) break;
      // Reread after earlier deliveries in this batch have awaited the network.
      const q = this.store.epayReference(candidate.reference);
      if (q?.state !== 'PENDING' || q.generation !== candidate.generation) continue;
      if (q.attempts >= MAX_ATTEMPTS) {
        // A PENDING row at the cap means dispatch was reserved but the result
        // was never durably recorded. Never assume the gateway did not credit.
        reconcileCallback(q);
        this.store.saveEpay(q);
        continue;
      }
      if (!this.eligible(q)) continue;
      const fields = { pid: q.pid, type: q.type, name: q.name, money: q.money, trade_no: q.tradeNo,
        out_trade_no: q.outTradeNo, trade_status: 'TRADE_SUCCESS' };
      fields.sign = signature(fields, this.key); fields.sign_type = 'MD5';
      const payload = new URLSearchParams(fields).toString();
      let sent = false, ok = false, rejected = false;
      try {
        ok = await this.transport.send({ url: this.binding.notifyUrl }, {
          method: 'POST', payload, accept: (code, text) => {
            const successStatus = code >= 200 && code < 300;
            rejected = successStatus && text === 'fail';
            return successStatus && text === 'success';
          },
          beforeSend: () => {
            const latest = this.store.epayReference(q.reference);
            if (latest?.state !== 'PENDING' || latest.generation !== q.generation
              || latest.attempts >= MAX_ATTEMPTS || !this.eligible(latest)) return false;
            // Old pending rows may not contain attempt outcomes. Conservatively
            // retain that uncertainty, as well as any interrupted prior send.
            if (latest.attempts > 0 && latest.callbackAttemptInFlight !== false) latest.callbackOutcomeUnknown = true;
            latest.callbackAttemptInFlight = true;
            latest.attempts++;
            latest.preflightFailures = 0;
            latest.nextAttempt = Date.now() + Math.min(3600000, 1000 * 2 ** latest.attempts);
            this.store.saveEpay(latest);
            sent = true;
            return true;
          },
        });
      } catch {}
      const latest = this.store.epayReference(q.reference);
      if (latest?.state !== 'PENDING' || latest.generation !== q.generation) continue;
      if (ok && sent) {
        latest.callbackAttemptInFlight = false;
        latest.state = 'DELIVERED';
        latest.deliveredAt = Date.now();
        // The gateway has now acknowledged this stable order reference.
        delete latest.callbackOutcomeUnknown;
        delete latest.lastError;
      } else if (sent) {
        latest.callbackAttemptInFlight = false;
        latest.lastError = 'EPAY_CALLBACK_NOT_ACKNOWLEDGED';
        if (!rejected) latest.callbackOutcomeUnknown = true;
        if (latest.attempts >= MAX_ATTEMPTS) {
          if (latest.callbackOutcomeUnknown) reconcileCallback(latest);
          else latest.state = 'FAILED';
        }
      } else if (latest.attempts >= MAX_ATTEMPTS) {
        reconcileCallback(latest);
      } else if (!this.closing && this.eligible(latest)) {
        latest.lastError = 'EPAY_CALLBACK_PREFLIGHT_FAILED';
        latest.preflightFailures = (latest.preflightFailures || 0) + 1;
        latest.nextAttempt = Date.now() + Math.min(3600000, 5000 * 2 ** latest.preflightFailures);
        if (latest.preflightFailures >= MAX_ATTEMPTS) {
          if (latest.callbackOutcomeUnknown || latest.attempts > 0 && latest.callbackAttemptInFlight !== false) reconcileCallback(latest);
          else latest.state = 'FAILED';
        }
      } else continue;
      this.store.saveEpay(latest);
    }
  }

  async close() {
    this.closing = true;
    await this.transport.close();
    await this.running;
  }
}

module.exports = { Epay, environment, submissionForm, parseForm, signature, usdtUnits, recordNativePayment, SOURCE_PREFIX };
