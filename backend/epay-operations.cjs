'use strict';
const crypto = require('node:crypto');
const { requireValue } = require('./chain.cjs');
const { SOURCE_PREFIX } = require('./epay.cjs');

const STATES = new Set(['PENDING', 'FAILED', 'RECONCILE']);
const EXCEPTIONS = new Set(['FAILED', 'RECONCILE']);
const CHAIN = new Set(['CONFIRMED', 'NOT_CANONICAL', 'UNVERIFIED']);
const NEW_API = new Set(['CREDITED', 'PENDING', 'NO_EXACT_MATCH', 'UNVERIFIED']);
const TRADE_NO = /^[a-zA-Z0-9_-]{1,80}$/;
const INVALID = 'INVALID_EPAY_OPERATIONS_REQUEST';

function options(params, key) {
  const allowed = new Set([key, 'before', 'limit']);
  for (const name of params.keys()) requireValue(allowed.has(name) && params.getAll(name).length === 1, INVALID);
  const bounded = (name, fallback, max) => {
    const value = params.get(name);
    if (value === null) return fallback;
    const count = Number(value);
    requireValue(/^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(count) && count <= max, INVALID);
    return count;
  };
  return { before: bounded('before', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), limit: bounded('limit', 25, 100) };
}
function reconcileReason(q) {
  // Earlier snapshots only carry reversedAt. A reason installed by a later
  // delivery transition is only considered current when it is on this row.
  return q.reconcileReason || (q.state === 'RECONCILE' && q.reversedAt ? 'CHAIN_REVERSAL' : null);
}
function snapshot(q, native) {
  return { state: q.state, reason: reconcileReason(q), generation: q.generation ?? null, attempts: q.attempts ?? 0,
    preflightFailures: q.preflightFailures ?? 0, reversedAt: q.reversedAt ?? null, deliveredAt: q.deliveredAt ?? null,
    lastError: q.lastError ?? null, nativeStateVersion: native?.stateVersion ?? null,
    nativeGeneration: native?.generation ?? null, nativePaid: native?.paid ?? null };
}
function revision(q, evidence) {
  return crypto.createHash('sha256').update(JSON.stringify({ reference: q.reference, orderId: q.orderId, evidence })).digest('hex');
}
function orderReference(epay, outTradeNo) {
  requireValue(typeof outTradeNo === 'string' && TRADE_NO.test(outTradeNo), INVALID);
  return SOURCE_PREFIX + epay.binding.pid + ':' + outTradeNo;
}
function paginate(rows, limit, map) {
  const page = rows.slice(0, limit);
  return { items: page.map(map), nextBefore: rows.length > limit ? page.at(-1).cursor : null };
}
function queue(epay, params) {
  const { before, limit } = options(params, 'state');
  const state = params.get('state');
  requireValue(STATES.has(state), INVALID);
  const prefix = SOURCE_PREFIX + epay.binding.pid + ':';
  return paginate(epay.store.epayOperationRows(state, prefix, before, limit + 1), limit, ({ order, review }) => {
    const evidence = snapshot(order, order.orderId ? epay.store.order(order.orderId) : null);
    const rev = revision(order, evidence);
    const { outTradeNo, orderId, tradeNo, amount, priceCurrency, createdAt } = order;
    return { outTradeNo, orderId, tradeNo, amount, priceCurrency, createdAt, revision: rev,
      ...evidence, review, reviewCurrent: Boolean(review && review.revision === rev) };
  });
}
function history(epay, params) {
  const { before, limit } = options(params, 'out_trade_no');
  const ref = orderReference(epay, params.get('out_trade_no'));
  requireValue(epay.store.epayReference(ref), 'EPAY_ORDER_NOT_FOUND', 404);
  return paginate(epay.store.epayOperatorReviews(ref, before, limit + 1), limit, row => row.review);
}
function record(epay, body, authorization) {
  const keys = ['outTradeNo', 'revision', 'chain', 'newApi'];
  requireValue(Object.keys(body).length === keys.length && keys.every(k => Object.hasOwn(body, k))
    && typeof body.revision === 'string' && /^[0-9a-f]{64}$/.test(body.revision)
    && CHAIN.has(body.chain) && NEW_API.has(body.newApi), INVALID);
  const ref = orderReference(epay, body.outTradeNo);
  return epay.store.transaction(() => {
    const order = epay.store.epayReference(ref);
    requireValue(order, 'EPAY_ORDER_NOT_FOUND', 404);
    const evidence = snapshot(order, order.orderId ? epay.store.order(order.orderId) : null);
    requireValue(EXCEPTIONS.has(order.state) && body.revision === revision(order, evidence), 'EPAY_REVIEW_STALE', 409);
    const review = { revision: body.revision, recordedAt: Date.now(), authorization, ...evidence,
      chain: body.chain, newApi: body.newApi };
    epay.store.saveEpayOperatorReview(ref, review);
    return review;
  });
}
module.exports = { queue, history, record };
