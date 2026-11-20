// Formatting helpers. Amounts stay as decimal strings from the backend; any
// arithmetic uses BigInt minimum units. Different tokens / chains are never summed.

export const CHAINS = {
  1: { name: 'Ethereum', native: 'ETH' },
  56: { name: 'BNB Smart Chain', native: 'BNB' },
  137: { name: 'Polygon', native: 'POL' },
  8453: { name: 'Base', native: 'ETH' },
  42161: { name: 'Arbitrum One', native: 'ETH' },
};

export function chainName(chainId, fallback) {
  return fallback && !/^Chain \d+$/.test(fallback) ? fallback : CHAINS[Number(chainId)]?.name || (chainId ? `Chain ${chainId}` : '未配置');
}

export function shortAddr(value, head = 6, tail = 4) {
  if (!value || typeof value !== 'string') return '—';
  return value.length <= head + tail + 2 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function units(amount, decimals) {
  const [whole, fraction = ''] = String(amount ?? '0').split('.');
  return BigInt((whole || '0') + fraction.padEnd(decimals, '0').slice(0, decimals));
}

export function fromUnits(value, decimals) {
  const negative = value < 0n, v = negative ? -value : value, scale = 10n ** BigInt(decimals);
  const fraction = (v % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + (v / scale).toString() + (fraction ? '.' + fraction : '');
}

// Thousands separators for display only; keeps the full precision string.
export function amount(value) {
  if (value === undefined || value === null || value === '') return '—';
  const [whole, fraction] = String(value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

const pad = n => String(n).padStart(2, '0');
export function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relative(value, now = Date.now()) {
  if (!value) return '—';
  const diff = Math.round((now - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(diff)) return '—';
  const future = diff < 0, s = Math.abs(diff);
  const text = s < 45 ? '刚刚' : s < 3600 ? `${Math.round(s / 60)} 分钟` : s < 86400 ? `${Math.round(s / 3600)} 小时` : `${Math.round(s / 86400)} 天`;
  return text === '刚刚' ? text : future ? `${text}后` : `${text}前`;
}

export function countdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const s = Math.ceil(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
