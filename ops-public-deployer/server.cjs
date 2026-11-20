'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { AppError, requireValue: check } = require('../backend/chain.cjs');
const service = require('./service.cjs');
const { OpsPhone, dataDir } = require('./phone.cjs');
async function start(port = 8807, options = {}) {
  let phone;
  const ensurePhone = () => (phone ||= new OpsPhone(options.phone || {}));
  const server = http.createServer(async (req, res) => {
    const reply = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'" }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
    try {
      const origin = 'http://127.0.0.1:' + server.address().port;
      check(req.headers.host === new URL(origin).host, 'INVALID_HOST', 403);
      if (req.method === 'GET' && ['/', '/app.js'].includes(req.url)) return reply(200, fs.readFileSync(path.join(__dirname, req.url === '/' ? 'index.html' : 'app.js')), req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript');
      check(req.method === 'POST' && ['/api/preview', '/api/prepare', '/api/verify', '/api/phone', '/api/phone/status', '/api/phone/close'].includes(req.url), 'NOT_FOUND', 404);
      check(req.headers.origin === origin, 'ORIGIN_REQUIRED', 403);
      let body = ''; for await (const chunk of req) { body += chunk; check(Buffer.byteLength(body) <= 4096, 'BODY_TOO_LARGE', 413); }
      let input; try { input = JSON.parse(body); } catch { throw new AppError('INVALID_JSON'); }
      check(input && typeof input === 'object' && !Array.isArray(input), 'JSON_OBJECT_REQUIRED');
      if (req.url === '/api/phone') return reply(200, await ensurePhone().create(input));
      if (req.url === '/api/phone/status') {
        check(Object.keys(input).length === 1 && typeof input.id === 'string', 'OPS_SCOPE_OVERRIDE', 403);
        check(phone, 'OPS_PHONE_NOT_FOUND', 404); return reply(200, phone.view(phone.record(input.id)));
      }
      if (req.url === '/api/phone/close') {
        check(Object.keys(input).length === 0, 'OPS_SCOPE_OVERRIDE', 403);
        return reply(200, phone ? await phone.closeSession() : { closed: true });
      }
      const result = await service[req.url === '/api/prepare' ? 'prepare' : 'preview'](input);
      if (req.url === '/api/prepare' && result.transaction && !phone && fs.existsSync(path.join(dataDir(options.phone || {}), 'merchant.sqlite'))) ensurePhone();
      if (req.url === '/api/prepare' && result.transaction && phone)
        check(!Object.values(phone.records()).some(r => r.preview.chainId === result.chainId && r.state === 'UNKNOWN'), 'OPS_SEND_UNRESOLVED', 409);
      return reply(200, result);
    } catch (e) { reply(e instanceof AppError ? e.status : 502, { error: e instanceof AppError ? e.code : 'OPS_RPC_OR_INPUT_ERROR' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, get phone() { return phone; }, url: 'http://127.0.0.1:' + server.address().port,
    close: async () => { const stopped = new Promise(r => server.close(r)); await phone?.close(); await stopped; } };
}
if (require.main === module) start(Number(process.env.PORT || 8807)).then(app => {
  console.log('Ops public deployer: ' + app.url);
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; try { await app.close(); process.exitCode = 0; } catch { process.exitCode = 1; } };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { start };
