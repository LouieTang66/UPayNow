// Shared helpers for the three public pages (checkout, phone deploy, phone collect).
import { h, trustedSvg } from '../shared/dom.js';
import brandLogo from '../../brand/upaynow-b-coin.svg';
import { installLanguageSupport, languageButton } from '../shared/i18n.js';
installLanguageSupport();
import { ApiError } from '../shared/api.js';

export { ApiError };

export function header(title, right) {
  return h('div', { class: 'pub-head' }, h('div', { class: 'who' }, h('span', { class: 'mark', role: 'img', 'aria-label': 'UPayNow Logo' }, trustedSvg(brandLogo)), h('span', null, title)), h('div', { class: 'pub-head-actions' }, right || null, languageButton()));
}

// Capability links: /v2/d/<id>#<token>. The fragment never reaches servers or
// logs. We move it into sessionStorage (this tab only, cleared when the tab is
// closed) and strip it from the address bar, so a reload or an OS-suspended
// wallet webview can resume (F9) while screenshots/history no longer show it.
// The backend still enforces expiry, revocation and tunnel-session binding.
export function capability(kind, id) {
  const key = `upay.cap.${kind}.${id}`;
  const fromHash = location.hash.slice(1);
  const valid = value => /^[A-Za-z0-9_-]{43}$/.test(value || '');
  if (location.hash) {
    // Never fall back to an older capability when a new, malformed link is supplied.
    history.replaceState(null, '', location.pathname + location.search);
    try { sessionStorage.removeItem(key); if (valid(fromHash)) sessionStorage.setItem(key, fromHash); } catch {}
    return valid(fromHash) ? fromHash : '';
  }
  try { const saved = sessionStorage.getItem(key); return valid(saved) ? saved : ''; } catch { return ''; }
}
export function forgetCapability(kind, id) { try { sessionStorage.removeItem(`upay.cap.${kind}.${id}`); } catch {} }

// Durable per-attempt local record (hash, rejection, begin in flight). It is
// evidence for recovery, never permission to resend.
export function localRecord(kind, id) {
  const key = `upay.rec.${kind}.${id}`;
  let memory = null;
  return {
    get() { try { return memory || JSON.parse(localStorage.getItem(key) || 'null'); } catch { return memory; } },
    set(value, required = false) {
      memory = { ...value, at: Date.now() };
      try { localStorage.setItem(key, JSON.stringify(memory)); return true; }
      catch { if (required) throw new Error('浏览器无法保存本地记录，已停止，未调用钱包。'); return false; }
    },
    clear() { memory = null; try { localStorage.removeItem(key); } catch {} },
  };
}

export async function capFetch(path, token, body) {
  let response;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new ApiError('NETWORK_ERROR', 0); }
  let value = null;
  try { value = await response.json(); } catch {}
  if (!response.ok) throw new ApiError(value?.error || 'HTTP_' + response.status, response.status);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('INVALID_API_RESPONSE', 0);
  return value;
}

// A lost/502 response may follow persistence: only explicit pre-transition refusals qualify.
export const beginRefused = e => e.status >= 400 && e.status < 500 && ['BUSY_RETRY_LATER', 'DEPLOYMENT_BUSY', 'MISSING_CHECKPOINT', 'CHAIN_ID_MISMATCH', 'INVALID_SENDER'].includes(e.code);

export const CLOSED_CODES = ['TUNNEL_CLOSED', 'TUNNEL_EXPIRED', 'DEPLOYMENT_TICKET_EXPIRED', 'HANDOFF_EXPIRED', 'HANDOFF_REVOKED'];
