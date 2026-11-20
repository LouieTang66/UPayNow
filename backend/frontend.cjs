'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./chain.cjs');
const DIST = path.join(__dirname, '..', 'frontend-v2', 'dist');
const ASSETS = {
  admin: new Set(['admin.js', 'checkout.js', 'base.css', 'app.css', 'public.css']),
  deploy: new Set(['deploy.js', 'base.css', 'public.css']),
  collect: new Set(['collect.js', 'base.css', 'public.css'])
};

// Static presentation only. Call after the existing Host/tunnel checks; this
// never proxies API calls, changes authentication, or enables preview fixtures.
function serveFrontend(request, response, route, surface = 'admin') {
  if (request.method !== 'GET') return false;
  if (route === '/v2/mode.json') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ mode: 'live' }));
    return true;
  }
  let file;
  const asset = route.match(/^\/v2\/assets\/([a-z-]+(?:\.js(?:\.LEGAL\.txt)?|\.css))$/)?.[1];
  const owner = asset?.replace(/\.LEGAL\.txt$/, '');
  if (asset && ASSETS[surface]?.has(owner)) file = 'assets/' + asset;
  if (surface === 'admin') {
    if (route === '/v2/' || route === '/v2/index.html' || route === '/') file = 'index.html';
    if (/^\/(?:v2\/)?pay\/[A-Za-z0-9_-]{32}$/.test(route)) file = 'checkout.html';
  } else if (surface === 'deploy') {
    if (/^\/(?:v2\/)?d\/[a-f0-9-]{36}$/.test(route)) file = 'deploy.html';
  } else if (surface === 'collect') {
    if (/^\/(?:v2\/)?c\/[a-f0-9-]{36}$/.test(route)) file = 'collect.html';
  }
  if (!file) return false;
  if (!fs.existsSync(path.join(DIST, file))) throw new AppError('FRONTEND_BUILD_REQUIRED', 503);
  const type = file.endsWith('.LEGAL.txt') ? 'text/plain' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
  response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(fs.readFileSync(path.join(DIST, file)));
  return true;
}
module.exports = { serveFrontend };
