// Presentation-only localization: update text/labels in place, never re-render
// forms, change values, reload, fetch, or call a wallet when language changes.
import adminPages from './locales/admin-pages.en.json';
import shared from './locales/admin-shared.en.json';
import publicPages from './locales/public.en.json';
import epayOperations from './locales/epay-operations.en.json';

export const LANGUAGE_KEY = 'upay.language';
const extras = {
  'UPayNow 商户后台': 'UPayNow Merchant Console',
  'UPayNow 收银台': 'UPayNow Checkout',
  'UPayNow 手机归集': 'UPayNow Mobile Sweep',
  'UPayNow 手机部署': 'UPayNow Mobile Deployment',
  '正在加载…': 'Loading…',
  '确认部署收款合约': 'Confirm Payment Contract Deployment',
  '付款 · UPayNow': 'Pay · UPayNow',
  '确认资金归集': 'Confirm Asset Sweep',
  '选择 {0}': 'Select {0}',
  '复制 {0}': 'Copy {0}',
  'BSC Testnet（测试网）{0}': 'BSC Testnet (Testnet){0}',
  'Ethereum Sepolia（测试网）{0}': 'Ethereum Sepolia (Testnet){0}',
};
const messages = new Map(Object.entries({ ...epayOperations, ...adminPages, ...shared, ...publicPages, ...extras }));
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const recursiveSlots = new Map([
  ['复制 {0}', [0]], ['已同步 · {0}', [0]], ['{0}前', [0]], ['{0}后', [0]], ['更新于 {0}', [0]],
  ['预期 Factory：{0}。签名钱包必须为 {1}。{2}', [2]],
  ['{0} · {1} 笔订单', [0]], ['{0} · 发起于 {1}（{2}）', [0, 2]], ['失败（{0}），资金仍在订单地址', [0]],
]);
const patterns = [...messages].filter(([key]) => /\{\d+\}/.test(key)).map(([source, target]) => {
  const indices = []; let previous = 0, regex = '^';
  for (const match of source.matchAll(/\{(\d+)\}/g)) {
    regex += escape(source.slice(previous, match.index)) + '([\\s\\S]*?)';
    indices.push(Number(match[1])); previous = match.index + match[0].length;
  }
  regex += escape(source.slice(previous)) + '$';
  return { source, regex: new RegExp(regex), target, indices, recursive: recursiveSlots.get(source) || [], weight: source.replace(/\{\d+\}/g, '').length };
}).sort((a, b) => b.weight - a.weight);
let language = 'zh';
try { if (globalThis.localStorage?.getItem(LANGUAGE_KEY) === 'en') language = 'en'; } catch {}
const sourceText = new WeakMap(), sourceAttributes = new WeakMap(), literalNodes = new WeakSet();
const buttons = new Set();
const attributes = ['placeholder', 'title', 'aria-label', 'aria-description', 'alt'];
const excluded = 'script,style,textarea,input,pre,code,svg,.ref,.copy .value,td.num,.amounts .v,.amount-hero .v,.entry .top,.token-chip,[translate="no"],[data-i18n-skip]';
let installed = false, observer;

export const getLanguage = () => language;
export function literalText(value) {
  const node = document.createTextNode(String(value ?? '—')); literalNodes.add(node); return node;
}
export function translate(source, depth = 0) {
  const text = String(source ?? '');
  if (language !== 'en' || !/[\u4e00-\u9fff]/.test(text)) return text;
  const exact = messages.get(text);
  if (exact !== undefined) return exact;
  // Bound source text, not arbitrary HTML; interpolation remains plain text.
  if (depth > 3 || text.length > 16000) return text;
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    if (!match) continue;
    if ((pattern.source === '{0}前' || pattern.source === '{0}后') && !/^\d+\s+(分钟|小时|天)$/.test(match[1])) continue;
    const values = new Map(pattern.indices.map((index, i) => [index, match[i + 1]]));
    return pattern.target.replace(/\{(\d+)\}/g, (_, index) => {
      const value = values.get(Number(index)) ?? '';
      return pattern.recursive.includes(Number(index)) ? translate(value, depth + 1) : value;
    });
  }
  return text;
}
function skipped(element) { return !!element?.closest?.(excluded); }
function updateText(node) {
  if (literalNodes.has(node) || !node.parentElement || skipped(node.parentElement)) return;
  const current = node.nodeValue;
  let record = sourceText.get(node);
  if (!record || (current !== record.rendered && current !== record.source)) record = { source: current };
  const output = translate(record.source);
  record.rendered = output; sourceText.set(node, record);
  if (current !== output) node.nodeValue = output;
}
function updateAttributes(element) {
  if (!element.getAttribute || element.closest?.('.ref,.copy .value,td.num,.amounts .v,.amount-hero .v,.entry .top,.token-chip,[translate="no"],[data-i18n-skip]')) return;
  let records = sourceAttributes.get(element);
  if (!records) { records = new Map(); sourceAttributes.set(element, records); }
  for (const key of attributes) {
    const current = element.getAttribute(key);
    if (current === null) { records.delete(key); continue; }
    let record = records.get(key);
    if (!record || (current !== record.rendered && current !== record.source)) record = { source: current };
    const output = translate(record.source); record.rendered = output; records.set(key, record);
    if (current !== output) element.setAttribute(key, output);
  }
}
export function localize(root) {
  if (!root) return;
  if (root.nodeType === 3) { updateText(root); return; }
  if (root.nodeType === 1) updateAttributes(root);
  if (root.querySelectorAll) for (const element of root.querySelectorAll('*')) updateAttributes(element);
  const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc?.createTreeWalker) return;
  const walker = doc.createTreeWalker(root, 4);
  while (walker.nextNode()) updateText(walker.currentNode);
}
function updateButtons() {
  for (const button of buttons) {
    button.textContent = language === 'en' ? '中文' : 'EN';
    button.setAttribute('aria-label', language === 'en' ? 'Switch to Chinese' : '切换为英文');
    button.setAttribute('title', language === 'en' ? 'Switch to Chinese' : '切换为英文');
    button.setAttribute('aria-pressed', String(language === 'en'));
  }
}
export function setLanguage(value, persist = true) {
  if (value !== 'zh' && value !== 'en') return;
  language = value;
  if (persist) try { globalThis.localStorage?.setItem(LANGUAGE_KEY, value); } catch {}
  if (typeof document !== 'undefined') {
    if (document.documentElement) document.documentElement.lang = value === 'en' ? 'en' : 'zh-CN';
    localize(document.head); localize(document.body);
  }
  updateButtons();
}
export function installLanguageSupport() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const ready = () => {
    if (typeof MutationObserver !== 'undefined' && document.body) {
      observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'characterData') updateText(record.target);
          else if (record.type === 'attributes') updateAttributes(record.target);
          else for (const node of record.addedNodes) localize(node);
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });
    }
    setLanguage(language, false);
  };
  if (document.readyState === 'loading' && document.addEventListener) document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('storage', event => {
    if (event.key === LANGUAGE_KEY && (event.newValue === 'zh' || event.newValue === 'en' || event.newValue === null)) setLanguage(event.newValue || 'zh', false);
  });
}
export function languageButton() {
  installLanguageSupport();
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn small language-toggle';
  button.setAttribute('data-i18n-skip', '');
  button.addEventListener('click', () => setLanguage(language === 'en' ? 'zh' : 'en'));
  for (const old of buttons) if (!old.isConnected) buttons.delete(old);
  buttons.add(button); updateButtons();
  return button;
}
