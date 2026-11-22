'use strict';
const http = require('node:http');
const path = require('node:path');
const QRCode = require('qrcode');
const { serveFrontend } = require('./frontend.cjs');
const { createEngine } = require('./engine.cjs');
const { createOpsMonitor } = require('./ops-monitor.cjs');
const { publicJob } = require('./job-view.cjs');
const { AppError, requireValue } = require('./chain.cjs');
const { Auth } = require('./auth.cjs');
const { Epay, environment: epayEnvironment, submissionForm } = require('./epay.cjs');
const epayOperations = require('./epay-operations.cjs');
async function start(options = {}) {
  const dir = path.resolve(options.dir || process.env.UPAY_DATA_DIR || path.join(__dirname, 'state'));
  requireValue(options.localTestNoLogin !== true, 'NO_LOGIN_MODE_REMOVED');
  const publicURL = options.publicOrigin || process.env.UPAY_PUBLIC_ORIGIN;
  const publicOrigin = publicURL ? new URL(publicURL) : null;
  requireValue(!publicOrigin || publicOrigin.protocol === 'https:' && publicOrigin.pathname === '/' && !publicOrigin.search && !publicOrigin.hash && !publicOrigin.username && !publicOrigin.password, 'INVALID_PUBLIC_ORIGIN');
  const handoffPort = options.handoffPort ?? process.env.UPAY_HANDOFF_PORT;
  const engineOptions = { ...options, handoffPort, handoffOrigin: options.handoffOrigin || process.env.UPAY_HANDOFF_ORIGIN,
    handoffQuick: options.handoffQuick ?? process.env.UPAY_HANDOFF_MODE === 'quick' };
  const root = await createEngine(dir, engineOptions);
  const { store, merchant, wallet, handoff, hooks } = root;
  let auth, epay, deployments, deploymentService, deploymentHandoff, deploymentTimer, deploymentRefresh = Promise.resolve(), refreshingDeployments = false;
  try {
    auth = new Auth(dir);
    if (options.multiChain) {
      const { Deployments } = require('./deployments.cjs');
      const { DeploymentService } = require('./deployment-service.cjs');
      const { DeploymentHandoff } = require('./deployment-handoff.cjs');
      deployments = new Deployments(root, {
        createEngine: childDir => createEngine(childDir, { ...engineOptions, multiChain: true, walletConnectDefaults: store,
          handoffPort: handoffPort === undefined ? undefined : 0 }) });
      await deployments.load();
      if (handoff) handoff.options.resolveHandoff = id => deployments.findHandoff(id);
      deploymentService = new DeploymentService(store, { register: config => deployments.register(config), networks: options.deploymentNetworks });
      deploymentHandoff = new DeploymentHandoff(deploymentService, store, { origin: options.deploymentOrigin || process.env.UPAY_DEPLOYMENT_ORIGIN,
        quick: options.deploymentQuick ?? !Boolean(options.deploymentOrigin || process.env.UPAY_DEPLOYMENT_ORIGIN) });
      await deploymentHandoff.listen(options.deploymentPort ?? Number(process.env.UPAY_DEPLOYMENT_PORT || 0));
      deploymentTimer = setInterval(() => {
        if (refreshingDeployments) return;
        refreshingDeployments = true;
        deploymentRefresh = (async () => {
          for (const job of deploymentService.list()) if (job.candidateHash && job.state !== 'MINED') await deploymentService.refresh(job.id).catch(() => {});
        })().finally(() => { refreshingDeployments = false; });
      }, options.pollMs > 0 ? options.pollMs : 5000);
    }
    const epaySettings = options.epay === undefined ? epayEnvironment(process.env) : options.epay;
    if (epaySettings) {
      requireValue(deployments || !epaySettings.deploymentId || epaySettings.deploymentId === 'legacy', 'EPAY_DEPLOYMENT_UNAVAILABLE', 503);
      const selected = deployments ? deployments.get(epaySettings.deploymentId || 'legacy') : root;
      epay = new Epay(store, selected, epaySettings, publicOrigin);
      selected.attachEpay(epay);
    }
  } catch (error) { clearInterval(deploymentTimer); await deploymentHandoff?.close(); await deployments?.close(); await root.close(); throw error; }

  const ops = createOpsMonitor({
    engines: () => deployments ? deployments.entries : [['legacy', root]],
    epay: () => epay,
    emit: options.opsEmit,
  });
  const send = (response, code, body, headers = {}) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  async function body(request) {
    requireValue(request.headers['content-type']?.split(';')[0] === 'application/json', 'JSON_REQUIRED', 415);
    const chunks = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length; requireValue(bytes <= 65536, 'BODY_TOO_LARGE', 413); chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { const value = JSON.parse(text); requireValue(value && !Array.isArray(value) && typeof value === 'object', 'JSON_OBJECT_REQUIRED'); return value; }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError('INVALID_JSON'); }
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self' wss://relay.walletconnect.com wss://relay.walletconnect.org https://relay.walletconnect.com https://relay.walletconnect.org https://rpc.walletconnect.org https://rpc.walletconnect.com https://verify.walletconnect.com https://verify.walletconnect.org https://pulse.walletconnect.com https://pulse.walletconnect.org; frame-src https://verify.walletconnect.com https://verify.walletconnect.org; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = request.headers.host, port = server.address().port;
      requireValue([`127.0.0.1:${port}`, `localhost:${port}`, publicOrigin?.host].includes(host), 'INVALID_HOST', 403);
      const origin = host === publicOrigin?.host ? publicOrigin.origin : 'http://' + host;
      const url = new URL(request.url, origin), route = url.pathname;
      const isPost = request.method === 'POST', isGet = request.method === 'GET';
      if (isGet && route === '/health') return send(response, 200, { ok: true, version: 'merchant-v1', configured: merchant.status().configured });
      if (epay && route === '/epay/submit.php') {
        requireValue(origin === publicOrigin.origin, 'EPAY_PUBLIC_HOST_REQUIRED', 403);
        const location = await epay.submit(await submissionForm(request, url));
        return send(response, 303, '', { Location: location });
      }
      const cookie = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('upay_session='))?.slice(13);
      const cookieHeader = (token = '') => ({ 'Set-Cookie': `upay_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 28800 : 0}${origin.startsWith('https:') ? '; Secure' : ''}` });
      if (route === '/api/ops/status') {
        requireValue(isGet, 'NOT_FOUND', 404);
        requireValue(!request.headers.authorization && auth.session(cookie), 'SESSION_REQUIRED', 401);
        const status = ops.status();
        return send(response, status.ok ? 200 : 503, status);
      }
      if (isGet && route === '/api/auth/status') return send(response, 200, auth.status());
      if (isPost && (route === '/api/login' || route.startsWith('/api/auth/'))) {
        requireValue(!request.headers.authorization, 'SESSION_REQUIRED', 401);
        requireValue(request.headers.origin === origin, 'ORIGIN_REQUIRED', 403);
        const publicAuth = route === '/api/login' || route === '/api/auth/reset';
        if (!publicAuth) requireValue(auth.session(cookie), 'SESSION_REQUIRED', 401);
        requireValue(['/api/login', '/api/auth/reset', '/api/auth/password', '/api/auth/recovery-key', '/api/auth/api-key'].includes(route), 'NOT_FOUND', 404);
        auth.rate(request.socket.remoteAddress);
        const input = await body(request);
        if (route === '/api/login') {
          const token = await auth.login(input.password);
          return send(response, 200, { ok: true }, cookieHeader(token));
        }
        if (route === '/api/auth/reset' || route === '/api/auth/password') {
          const result = await auth.change(input, cookie, route === '/api/auth/reset');
          return send(response, 200, result, cookieHeader());
        }
        return send(response, 200, await auth.reveal(route === '/api/auth/api-key' ? 'apiKey' : 'recoveryKey', input.password, cookie));
      }
      if (route.startsWith('/api/auth/')) throw new AppError('SESSION_REQUIRED', 401);
      const publicMatch = route.match(/^\/api\/pay\/([A-Za-z0-9_-]{32})(\/qr)?$/);
      if (isGet && publicMatch) {
        const found = deployments ? deployments.findPublic(publicMatch[1]) : { engine: root, order: store.publicOrder(publicMatch[1]) };
        const order = found?.order; requireValue(order, 'NOT_FOUND', 404);
        if (publicMatch[2]) {
          const uri = `ethereum:${order.token}@${order.chainId}/transfer?address=${order.address}&uint256=${order.expectedUnits}`;
          return send(response, 200, await QRCode.toString(uri, { type: 'svg', margin: 2, width: 240 }), { 'Content-Type': 'image/svg+xml' });
        }
        const view = found.engine.merchant.detail(order, true);
        const epayReturnUrl = epay?.engine === found.engine ? epay.returnFor(order) : null;
        return send(response, 200, epayReturnUrl ? { ...view, epayReturnUrl } : view);
      }
      if (route.startsWith('/api/')) {
        const bearer = request.headers.authorization?.startsWith('Bearer ') && auth.bearer(request.headers.authorization.slice(7));
        requireValue(bearer || auth.session(cookie), 'UNAUTHORIZED', 401);
        if (!isGet && !bearer) requireValue(request.headers.origin === origin, 'ORIGIN_REQUIRED', 403);
        if (isGet && route === '/api/epay/orders') {
          requireValue(epay, 'NOT_FOUND', 404);
          requireValue(url.searchParams.size === 1, 'INVALID_EPAY_ORDER');
          if (url.searchParams.get('state') === 'RECONCILE') return send(response, 200, epay.reconciliations());
          return send(response, 200, epay.order(url.searchParams.get('out_trade_no')));
        }
        if (route === '/api/epay/operations' || route === '/api/epay/operations/reviews') {
          requireValue(epay && request.headers['x-upay-deployment'] === epay.binding.deploymentId,
            'EPAY_OPERATIONS_UNAVAILABLE', 404);
          if (isGet && route === '/api/epay/operations') return send(response, 200, epayOperations.queue(epay, url.searchParams));
          if (isGet && route === '/api/epay/operations/reviews') return send(response, 200, epayOperations.history(epay, url.searchParams));
          if (isPost && route === '/api/epay/operations/reviews') {
            requireValue(url.searchParams.size === 0, 'INVALID_EPAY_OPERATIONS_REQUEST');
            return send(response, 201, epayOperations.record(epay, await body(request), bearer ? 'API_CREDENTIAL' : 'ADMIN_SESSION'));
          }
        }
        if (route.startsWith('/api/deployment')) {
          requireValue(deployments, 'MULTICHAIN_NOT_ENABLED', 409);
          if (isGet && route === '/api/deployment-networks') return send(response, 200, deploymentService.networks);
          if (isGet && route === '/api/deployments') return send(response, 200, deployments.list());
          if (isPost && route === '/api/deployments/import') { const entry = await deployments.import(await body(request)); return send(response, 201, deployments.list().deployments.find(d => d.id === entry.id)); }
          const nameRoute = route.match(/^\/api\/deployments\/(legacy|[a-f0-9-]{36})\/name$/i);
          if (isPost && nameRoute) return send(response, 200, await deployments.rename(nameRoute[1], await body(request)));
          if (isGet && route === '/api/deployment-jobs') return send(response, 200, await deploymentService.list());
          if (isPost && route === '/api/deployment-jobs') return send(response, 201, await deploymentService.create(await body(request)));
          if (isPost && route === '/api/deployment-tunnel/close') { await body(request); return send(response, 200, await deploymentHandoff.closeTunnel()); }
          const jobRoute = route.match(/^\/api\/deployment-jobs\/([a-f0-9-]{36})(?:\/(begin|attach|refresh|cancel|handoff))?$/);
          if (jobRoute && isGet && !jobRoute[2]) return send(response, 200, await deploymentService.get(jobRoute[1]));
          if (jobRoute && isPost && jobRoute[2]) {
            const input = await body(request);
            return send(response, 200, jobRoute[2] === 'handoff' ? await deploymentHandoff.create(jobRoute[1]) : await deploymentService[jobRoute[2]](jobRoute[1], input));
          }
          throw new AppError('NOT_FOUND', 404);
        }
        if (isPost && route === '/api/deterministic/preview') {
          requireValue(deployments, 'MULTICHAIN_NOT_ENABLED', 409);
          return send(response, 200, await deploymentService.preview(await body(request)));
        }
        if (isPost && ['/api/crosschain-recovery/preview', '/api/crosschain-recovery/prepare'].includes(route)) {
          requireValue(deployments, 'MULTICHAIN_NOT_ENABLED', 409);
          const { CrosschainRecovery } = require('./crosschain-recovery.cjs');
          const action = route.endsWith('/prepare') ? 'prepare' : 'preview';
          return send(response, action === 'prepare' ? 201 : 200, await new CrosschainRecovery(deployments)[action](await body(request)));
        }
        const selectedId = request.headers['x-upay-deployment'] || url.searchParams.get('deploymentId') || 'legacy';
        requireValue(deployments || selectedId === 'legacy', 'DEPLOYMENT_NOT_FOUND', 404);
        const selected = deployments ? deployments.get(selectedId) : root;
        requireValue(selected.merchant, 'DEPLOYMENT_UNAVAILABLE', 503);
        const { merchant, store, wallet, handoff, deliver } = selected;
        if (isGet && route === '/api/status') return send(response, 200, { ...merchant.status(), deploymentId: selectedId, authMode: 'PASSWORD' });
        if (isPost && route === '/api/logout') {
          auth.sessions.delete(cookie); return send(response, 200, { ok: true }, cookieHeader());
        }
        if (isPost && route === '/api/config') {
          const input = await body(request);
          requireValue(!deployments || !merchant.chain, 'USE_ADD_DEPLOYMENT', 409);
          return send(response, 200, await merchant.configure(input));
        }
        if (isGet && route === '/api/orders') return send(response, 200, store.orders().map(o => merchant.detail(o)));
        if (isPost && route === '/api/orders') {
          const input = await body(request);
          requireValue(!input.deploymentId || !request.headers['x-upay-deployment'] || input.deploymentId === selectedId, 'DEPLOYMENT_SCOPE_MISMATCH', 409);
          requireValue(deployments || !input.deploymentId || input.deploymentId === 'legacy', 'DEPLOYMENT_NOT_FOUND', 404);
          const target = input.deploymentId ? deployments?.get(input.deploymentId) || root : selected;
          return send(response, 201, { ...target.merchant.detail(await target.merchant.create(input)), deploymentId: input.deploymentId || selectedId });
        }
        const acceptLate = route.match(/^\/api\/orders\/([a-f0-9-]{36})\/accept-late-payment$/);
        if (isPost && acceptLate) {
          const input = await body(request);
          requireValue(Object.keys(input).length === 0, 'ACCEPT_LATE_PAYMENT_BODY_MUST_BE_EMPTY');
          const order = await merchant.acceptLatePayment(acceptLate[1]);
          void deliver();
          return send(response, 200, { ...merchant.detail(order), deploymentId: selectedId });
        }
        const detail = route.match(/^\/api\/orders\/([a-f0-9-]{36})$/);
        if (isGet && detail) { const order = store.order(detail[1]); requireValue(order, 'ORDER_NOT_FOUND', 404); return send(response, 200, merchant.detail(order)); }
        if (isPost && route === '/api/scan') {
          await body(request); const status = await merchant.scan();
          if (status.cursor >= store.get('lastHead', Infinity)) void deliver();
          return send(response, 200, status);
        }
        if (isPost && route === '/api/collect-all/preview') {
          await body(request); return send(response, 200, await merchant.previewPaid());
        }
        if (isPost && route === '/api/collect-all') return send(response, 202, await merchant.collectPaid(await body(request)));
        if (isPost && route === '/api/collect') return send(response, 202, await merchant.collect(await body(request)));
        if (isGet && route === '/api/handoffs/config') return send(response, 200, handoff?.config() || { enabled: false });
        if (isPost && route === '/api/handoffs/tunnel/close') { await body(request); requireValue(handoff?.tunnel, 'HANDOFF_NOT_ENABLED', 409); return send(response, 200, await handoff.tunnel.close('MANUAL')); }
        if (isPost && route === '/api/handoffs') { requireValue(handoff, 'HANDOFF_NOT_ENABLED', 409); return send(response, 201, await handoff.create(await body(request))); }
        const handoffRoute = route.match(/^\/api\/handoffs\/([a-f0-9-]{36})(\/revoke)?$/);
        if (handoffRoute && (isGet && !handoffRoute[2] || isPost && handoffRoute[2])) {
          requireValue(handoff, 'HANDOFF_NOT_ENABLED', 409);
          if (isPost) { await body(request); return send(response, 200, await handoff.revoke(handoffRoute[1])); }
          return send(response, 200, handoff.view(handoff.record(handoffRoute[1])));
        }
        if (isGet && route === '/api/wallet/config') return send(response, 200, wallet.config());
        if (isPost && route === '/api/wallet/config') return send(response, 200, wallet.saveConfig(await body(request)));
        if (isPost && route === '/api/wallet/prepare') return send(response, 201, await wallet.prepare(await body(request)));
        const walletJob = route.match(/^\/api\/wallet\/jobs\/([a-f0-9-]{36})\/(begin|attach|refresh|cancel|resolve)$/);
        if (isPost && walletJob) {
          const input = await body(request), id = walletJob[1], action = walletJob[2];
          return send(response, 200, await wallet[action](id, input));
        }
        if (isGet && route === '/api/jobs') return send(response, 200, store.jobs().map(publicJob));
        const reconcile = route.match(/^\/api\/jobs\/([a-f0-9-]{36})\/reconcile$/);
        if (isPost && reconcile) return send(response, 200, await merchant.reconcile(reconcile[1], (await body(request)).transactionHash));
        if (isGet && route === '/api/notifications') return send(response, 200, store.notifications());
        const retry = route.match(/^\/api\/notifications\/(.+)\/retry$/);
        if (isPost && retry) {
          await body(request); const n = store.notifications().find(x => x.id === decodeURIComponent(retry[1])); requireValue(n, 'NOT_FOUND', 404);
          requireValue(['PENDING', 'FAILED'].includes(n.state), 'NOTIFICATION_NOT_RETRYABLE', 409);
          n.state = 'PENDING'; n.attempts = 0; n.nextAttempt = 0; n.queuedAt = Date.now(); store.notify(n); return send(response, 200, { ok: true });
        }
        throw new AppError('NOT_FOUND', 404);
      }
      if (serveFrontend(request, response, route)) return;
      throw new AppError('NOT_FOUND', 404);
    } catch (error) {
      // Do not return ethers errors, RPC credentials, calldata or signing configuration.
      const known = error instanceof AppError;
      send(response, known ? error.status : 502, { error: known ? error.code : 'UPSTREAM_OR_STORAGE_ERROR' });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? Number(process.env.UPAY_PORT || 8790), '127.0.0.1', resolve); });
  } catch (error) { clearInterval(deploymentTimer); await deploymentHandoff?.close(); await deployments?.close(); await root.close(); throw error; }
  ops.start();
  return { server, merchant, hooks, store, handoff, epay, deployments, deploymentService, deploymentHandoff, url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      ops.stop();
      clearInterval(deploymentTimer);
      await new Promise(resolve => server.close(resolve));
      await deploymentRefresh;
      await deploymentHandoff?.close(); await deployments?.close(); await root.close();
    } };
}
if (require.main === module) start({ multiChain: true,
  opsEmit: record => console.error(JSON.stringify(record)),
  handoffPort: Number(process.env.UPAY_HANDOFF_PORT || 8791), handoffQuick: !process.env.UPAY_HANDOFF_ORIGIN,
  deploymentPort: Number(process.env.UPAY_DEPLOYMENT_PORT || 8792) }).then(app => {
  console.log('upaynow merchant backend: ' + app.url);
  console.log('Password setup/reset requires the recovery key in ' + path.join(app.store.dir, 'auth.json') + ' (protected local file; never printed).');
  console.log('Use /api/auth/reset to set a password, then /api/login. API credentials are independent and require cookie login plus password reauthentication to reveal.');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (!stopping) { stopping = true; await app.close(); process.exit(0); } });
}).catch(error => { console.error('Startup failed: ' + (error.code || 'CHECK_DATA_DIRECTORY_AND_PORT')); process.exitCode = 1; });
module.exports = { start };
