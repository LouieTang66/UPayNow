// Data layer. Only endpoints that exist in backend/server.cjs are used.
// - Admin auth: HttpOnly session cookie from POST /api/login (same origin).
//   No credential is stored by this frontend.
// - Every deployment-scoped call carries an explicit X-Upay-Deployment header;
//   global routes (deployments, deployment-jobs, login) never do.

export class ApiError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

const GLOBAL = /^(auth(\/|$)|login|logout|deployments(\/|$)|deployment-networks(\/|$)|deployment-jobs(\/|$)|deployment-tunnel(\/|$)|deterministic(\/|$)|crosschain-recovery(\/|$))/;

export async function detectMode() {
  return 'live';
}

export function liveClient() {
  async function call(method, route, { body, deploymentId, timeoutMs } = {}) {
    const scoped = !GLOBAL.test(route);
    if (scoped && !deploymentId) throw new ApiError('DEPLOYMENT_REQUIRED');
    const controller = new AbortController();
    const phone = route === 'handoffs' || /^deployment-jobs\/[^/]+\/handoff$/.test(route);
    const slow = route === 'deployment-jobs' || method === 'POST' && route === 'collect-all/preview';
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? (phone ? 180000 : slow ? 60000 : 15000));
    try {
      const response = await fetch('/api/' + route, {
        method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(scoped ? { 'X-Upay-Deployment': deploymentId } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let value;
      try { value = await response.json(); }
      catch {
        throw new ApiError(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'INVALID_API_RESPONSE', response.status);
      }
      if (!response.ok) throw new ApiError(value?.error || 'HTTP_' + response.status, response.status);
      if (value === null || typeof value !== 'object') throw new ApiError('INVALID_API_RESPONSE', response.status);
      return value;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', 0);
    } finally { clearTimeout(timer); }
  }
  return {
    mode: 'live',
    get: (route, opts) => call('GET', route, opts),
    post: (route, body = {}, opts = {}) => call('POST', route, { ...opts, body }),
  };
}

// Monotonic request tickets: a slower, older response must never overwrite a
// newer one (F4/F5/F7). `scope` lets callers invalidate everything when the
// selected deployment changes.
export function sequencer() {
  const counters = new Map();
  let epoch = 0;
  return {
    reset() { epoch++; counters.clear(); },
    async run(key, task) {
      const ticket = (counters.get(key) || 0) + 1, myEpoch = epoch;
      counters.set(key, ticket);
      const current = () => myEpoch === epoch && counters.get(key) === ticket;
      let result;
      try { result = await task(); }
      catch (error) { if (!current()) return { stale: true }; throw error; } // stale errors are dropped too
      if (!current()) return { stale: true };
      return { stale: false, value: result };
    },
  };
}
