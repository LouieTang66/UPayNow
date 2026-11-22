'use strict';

// Read-only counters. Never select the order body, merchant config, raw RPC
// errors, or callback destination into the status response or alert stream.
const INSTANCE = 'instance'; // Reserved ID for a failed registry-wide observation.
const LIMITS = Object.freeze({ scanStaleMs: 60_000, scanLagBlocks: 20, callbackLateMs: 120_000,
  callbackBacklog: 25, startupGraceMs: 60_000, pollMs: 15_000 });
const MESSAGES = Object.freeze({
  DEPLOYMENT_UNAVAILABLE: 'Check deployment startup and its state directory.',
  SCAN_ERROR: 'Check chain RPC and scan status; reconcile before intervening.',
  SCAN_STALE: 'Check the scan worker and RPC availability.',
  SCAN_BEHIND: 'Check whether the scan cursor is catching up to the observed chain head.',
  NATIVE_CALLBACK_BACKLOG: 'Check native callback delivery and the merchant endpoint.',
  NATIVE_CALLBACK_FAILED: 'Check native callback failures and merchant fulfillment before retrying.',
  EPAY_CALLBACK_BACKLOG: 'Check New API callback delivery and readiness.',
  EPAY_CALLBACK_FAILED: 'Compare on-chain receipt and New API credit before manual handling.',
  EPAY_RECONCILE: 'Reconcile the on-chain receipt against the New API ledger; do not blindly resend.',
  OBSERVATION_UNAVAILABLE: 'Check monitor access to local state and database health.',
});
const NATIVE = `SELECT
  COUNT(*) FILTER (WHERE state='PENDING') AS pending,
  COUNT(*) FILTER (WHERE state='FAILED') AS failed,
  COUNT(*) FILTER (WHERE state='PENDING' AND (
    json_extract(body, '$.queuedAt') <= ? OR (
      json_extract(body, '$.nextAttempt') BETWEEN 1 AND ?
    ) OR (? AND json_type(body, '$.queuedAt') IS NULL
      AND COALESCE(json_extract(body, '$.nextAttempt'), 0) = 0)
  )) AS overdue
  FROM notifications WHERE state IN ('PENDING','FAILED')`;
const EPAY = `SELECT
  COUNT(*) FILTER (WHERE state='PENDING') AS pending,
  COUNT(*) FILTER (WHERE state='FAILED') AS failed,
  COUNT(*) FILTER (WHERE state='RECONCILE') AS reconcile,
  COUNT(*) FILTER (WHERE state='PENDING' AND (
    json_extract(body, '$.queuedAt') <= ? OR next_attempt BETWEEN 1 AND ?
    OR (? AND json_type(body, '$.queuedAt') IS NULL AND next_attempt = 0)
  )) AS overdue
  FROM epay_orders WHERE state IN ('PENDING','FAILED','RECONCILE')`;
const prepared = new WeakMap();
function statements(store) {
  if (!prepared.has(store)) prepared.set(store, [store.db.prepare(NATIVE), store.db.prepare(EPAY)]);
  return prepared.get(store);
}
function integerOrNull(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min ? value : null;
}
function inspect(id, engine, now, startupAt, epay) {
  if (!engine?.merchant || !engine?.store) return { id, available: false, issues: ['DEPLOYMENT_UNAVAILABLE'] };
  try {
    const { merchant, store } = engine;
    const configured = !!merchant.chain;
    const last = integerOrNull(store.get('lastSync'), 1);
    const cursor = integerOrNull(store.get('cursor'), -1);
    const head = integerOrNull(store.get('lastHead'));
    const ageMs = configured && last !== null ? Math.max(0, now - last) : null;
    const behindBlocks = configured && cursor !== null && head !== null ? Math.max(0, head - cursor) : null;
    const hasError = configured && Boolean(store.get('syncError'));
    const issues = [];
    if (hasError) issues.push('SCAN_ERROR');
    if (configured && now - startupAt >= LIMITS.startupGraceMs) {
      if (ageMs === null || ageMs >= LIMITS.scanStaleMs) issues.push('SCAN_STALE');
      if (behindBlocks !== null && behindBlocks >= LIMITS.scanLagBlocks) issues.push('SCAN_BEHIND');
    }
    const [nativeQuery, epayQuery] = statements(store);
    const cutoff = now - LIMITS.callbackLateMs;
    // Existing unattempted 0.2.0 rows did not record queue time. Give them
    // one backlog window after boot before treating them as overdue.
    const legacyWindow = Number(startupAt <= cutoff);
    const native = { ...nativeQuery.get(cutoff, cutoff, legacyWindow) };
    const compat = epayQuery.get(cutoff, cutoff, legacyWindow);
    if (native.overdue || native.pending >= LIMITS.callbackBacklog) issues.push('NATIVE_CALLBACK_BACKLOG');
    if (native.failed) issues.push('NATIVE_CALLBACK_FAILED');
    if (compat.overdue || compat.pending >= LIMITS.callbackBacklog) issues.push('EPAY_CALLBACK_BACKLOG');
    if (compat.failed) issues.push('EPAY_CALLBACK_FAILED');
    if (compat.reconcile) issues.push('EPAY_RECONCILE');
    return { id, available: true, scan: { configured, lastCaughtUpAgeMs: ageMs, behindBlocks, hasError },
      callbacks: { native, epay: { enabled: epay?.engine === engine, ...compat } }, issues };
  } catch {
    return { id, available: false, issues: ['OBSERVATION_UNAVAILABLE'] };
  }
}
function createOpsMonitor({ engines, epay = () => null, clock = Date.now, emit }) {
  const startupAt = clock(), active = new Map();
  let timer;
  function status() {
    const now = clock();
    let samples;
    try {
      const adapter = epay();
      samples = Array.from(engines(), ([id, engine]) => (
        id === 'legacy' || typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
          ? inspect(id, engine, now, startupAt, adapter)
          : { id: 'invalid-registry-entry', available: false, issues: ['DEPLOYMENT_UNAVAILABLE'] }
      ));
    } catch {
      samples = [{ id: INSTANCE, available: false, issues: ['OBSERVATION_UNAVAILABLE'] }];
    }
    return { ok: samples.every(x => !x.issues.length),
      configured: samples.some(x => x.scan?.configured), deployments: samples };
  }
  function tryEmit(record) {
    try { emit(record); return true; } catch { return false; }
  }
  function tick() {
    if (!emit) return;
    const next = new Map(), unobserved = new Set();
    for (const entry of status().deployments) {
      if (!entry.available) unobserved.add(entry.id);
      for (const code of entry.issues) {
        next.set(entry.id + ':' + code, { deploymentId: entry.id, code, action: MESSAGES[code] });
      }
    }
    for (const [key, info] of next) {
      if (!active.has(key) && tryEmit({ event: 'upay.ops.alert', ...info })) active.set(key, info);
    }
    // An unreadable deployment (or inventory) provides no evidence of
    // recovery. A readable inventory can still retire a removed deployment.
    if (unobserved.has(INSTANCE)) return;
    for (const [key, info] of active) {
      if (!next.has(key) && !unobserved.has(info.deploymentId)
        && tryEmit({ event: 'upay.ops.clear', deploymentId: info.deploymentId, code: info.code })) active.delete(key);
    }
  }
  return { status, tick, start() {
    if (!emit || timer) return;
    tick();
    timer = setInterval(tick, LIMITS.pollMs);
    timer.unref();
  }, stop() { clearInterval(timer); timer = undefined; } };
}
module.exports = { createOpsMonitor, LIMITS };
