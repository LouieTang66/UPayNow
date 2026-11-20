'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { execFile } = require('node:child_process');
const { AppError } = require('./chain.cjs');
const VERSION = '2026.3.0';
// Digests from Cloudflare's official GitHub release expanded_assets/2026.3.0.
const ASSETS = Object.freeze(Object.fromEntries([
  ['linux-x64', 'cloudflared-linux-amd64', '4a9e50e6d6d798e90fcd01933151a90bf7edd99a0a55c28ad18f2e16263a5c30'],
  ['linux-arm64', 'cloudflared-linux-arm64', '0755ba4cbab59980e6148367fcf53a8f3ec85a97deefd63c2420cf7850769bee'],
  ['linux-arm', 'cloudflared-linux-arm', 'ca16ed5253373846f7d366d591669d0e868e0724e35599abad2c8b2bc2340cfa'],
  ['linux-ia32', 'cloudflared-linux-386', '7d59f6ef7b4c255edd88187c74d2b4ecd895b6f5c4aca2cae0c4411eacebcbbd'],
  ['darwin-x64', 'cloudflared-darwin-amd64.tgz', '0f30140c4a5e213d22f951ef4c964cac5fb6a5f061ba6eba5ea932999f7c0394'],
  ['darwin-arm64', 'cloudflared-darwin-arm64.tgz', '2aae4f69b0fc1c671b8353b4f594cbd902cd1e360c8eed2b8cad4602cb1546fb'],
  ['win32-x64', 'cloudflared-windows-amd64.exe', '59b12880b24af581cf5b1013db601c7d843b9b097e9c78aa5957c7f39f741885'],
  ['win32-ia32', 'cloudflared-windows-386.exe', 'e00a9e9fed12f8a8f5703539c4662750dd5472d35c16dcbbdc5869f3fe5e238b']
].map(([key, name, sha256]) => [key, Object.freeze({ name, sha256 })])));
const MAX_BYTES = 80 * 1024 * 1024, TIMEOUT_MS = 120000;
const pending = new Map();
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const failure = code => new AppError(code, 502);
function executable(binary) {
  return new Promise(resolve => execFile(binary, ['--version'], { timeout: 5000, maxBuffer: 65536, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USERPROFILE|TMPDIR|TMP|TEMP|SystemRoot|WINDIR)$/i.test(key))) },
  (error, stdout) => resolve(!error && /cloudflared version\s/i.test(stdout))));
}
function allowedURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
    || (url.hostname === 'github.com' && !url.pathname.startsWith(`/cloudflare/cloudflared/releases/download/${VERSION}/`))) {
    throw failure('CLOUDFLARED_DOWNLOAD_FAILED');
  }
  return url;
}
// One overall deadline, bounded body and redirects; no shell, proxy credentials, or non-official hosts.
async function download(url, { signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, TIMEOUT_MS);
  const visit = (value, redirects = 0) => new Promise((resolve, reject) => {
    let request;
    try {
      request = https.get(allowedURL(value), { signal: controller.signal, headers: { 'User-Agent': 'UPayNow-component-loader', 'Accept-Encoding': 'identity' } }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (!response.headers.location || redirects >= 4) return reject(failure('CLOUDFLARED_DOWNLOAD_FAILED'));
          try { resolve(visit(new URL(response.headers.location, value).href, redirects + 1)); } catch (e) { reject(e); }
          return;
        }
        const length = response.headers['content-length'];
        if (response.statusCode !== 200 || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))) {
          response.destroy(); reject(failure('CLOUDFLARED_DOWNLOAD_FAILED')); return;
        }
        let size = 0; const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BYTES) response.destroy(failure('CLOUDFLARED_DOWNLOAD_FAILED'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          if (!size || (length !== undefined && size !== Number(length))) reject(failure('CLOUDFLARED_DOWNLOAD_FAILED'));
          else resolve(Buffer.concat(chunks));
        });
      });
      request.once('error', reject);
    } catch (e) { reject(e); }
  });
  try { return await visit(url); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function unpack(data, name) {
  if (!name.endsWith('.tgz')) return data;
  // Extract only the regular cloudflared file in memory, never tar paths/symlinks on disk.
  const tar = gunzipSync(data, { maxOutputLength: 100 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const filename = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    if (!filename) break;
    const rawSize = header.subarray(124, 136).toString().replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(rawSize)) break;
    const size = parseInt(rawSize, 8), start = offset + 512;
    if (start + size > tar.length) break;
    if (['cloudflared', './cloudflared'].includes(filename) && [0, 48].includes(header[156]) && size) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw failure('CLOUDFLARED_INTEGRITY_FAILED');
}
async function atomic(file, data, mode) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, data, { flag: 'wx', mode }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
async function prepare(dir, asset, options) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const archive = path.join(dir, `${VERSION}-${asset.name}`);
  const binary = asset.name.endsWith('.tgz') ? `${archive}.bin` : archive;
  let data;
  try {
    const stat = await fs.lstat(archive);
    if (stat.isFile() && stat.size <= MAX_BYTES) data = await fs.readFile(archive);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!data || digest(data) !== asset.sha256) {
    await fs.rm(archive, { force: true });
    if (binary !== archive) await fs.rm(binary, { force: true });
    data = await (options.download || download)(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset.name}`, { signal: options.signal });
    if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_BYTES || digest(data) !== asset.sha256) throw failure('CLOUDFLARED_INTEGRITY_FAILED');
    const extracted = unpack(data, asset.name);
    if (options.signal?.aborted) throw failure('TUNNEL_CLOSED');
    await atomic(archive, data, binary === archive ? 0o700 : 0o600);
    if (binary !== archive) await atomic(binary, extracted, 0o700);
  } else if (binary !== archive) {
    const extracted = unpack(data, asset.name);
    let valid = false;
    try { const stat = await fs.lstat(binary); valid = stat.isFile() && stat.size === extracted.length && digest(await fs.readFile(binary)) === digest(extracted); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!valid) { await fs.rm(binary, { force: true }); await atomic(binary, extracted, 0o700); }
  }
  await fs.chmod(binary, 0o700);
  return binary;
}
async function ensureCloudflared(options = {}) {
  const probe = options.executable || executable;
  const explicit = options.binary || process.env.UPAY_CLOUDFLARED;
  if (explicit) {
    if (await probe(explicit)) return explicit;
    throw failure('CLOUDFLARED_NOT_FOUND'); // Never silently override an explicit operator choice.
  }
  if (await probe('cloudflared')) return 'cloudflared';
  const platform = options.platform || process.platform, arch = options.arch || process.arch;
  const asset = (options.assets || ASSETS)[`${platform}-${arch}`];
  if (!asset) throw failure('CLOUDFLARED_UNSUPPORTED_PLATFORM');
  if (!options.dir) throw failure('CLOUDFLARED_CACHE_FAILED');
  const dir = path.resolve(options.dir, 'components', 'cloudflared');
  const key = `${dir}/${VERSION}-${asset.name}`;
  if (!pending.has(key)) {
    const task = prepare(dir, asset, options).catch(error => {
      if (error instanceof AppError) throw error;
      if (options.signal?.aborted) throw failure('TUNNEL_CLOSED');
      throw failure(error.code && /^(EACCES|EPERM|ENOSPC|EROFS)$/.test(error.code) ? 'CLOUDFLARED_CACHE_FAILED' : 'CLOUDFLARED_DOWNLOAD_FAILED');
    }).finally(() => pending.delete(key));
    pending.set(key, task);
  }
  return pending.get(key);
}
module.exports = { ensureCloudflared, VERSION, ASSETS, download, allowedURL, unpack };
