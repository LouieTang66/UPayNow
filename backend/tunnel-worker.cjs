'use strict';
// Separate watchdog: a blocked/crashed backend must not leave its public tunnel running.
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const target = process.argv[2], binary = process.argv[3] || 'cloudflared';
const DURATION_MS = 300000;
let child, buffer = '', origin, connected = false, ready = false, stopping = false, wallDeadline, monoDeadline;
let startup, deadline, monitor, force;
function notify(value) { if (process.connected) process.send(value, () => {}); }
function stop(reason, error) {
  if (stopping) return;
  stopping = true; clearTimeout(startup); clearTimeout(deadline); clearInterval(monitor);
  notify({ type: 'stopped', reason, error });
  if (!child || child.exitCode !== null || child.signalCode !== null) { process.exitCode = 0; if (process.connected) process.disconnect(); return; }
  child.kill('SIGTERM');
  force = setTimeout(() => child.kill('SIGKILL'), 1000);
}
function observe(chunk) {
  if (stopping) return;
  buffer = (buffer + chunk.toString('utf8')).slice(-32768);
  origin ||= buffer.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/i)?.[0].toLowerCase();
  connected ||= buffer.includes('Registered tunnel connection');
  if (origin && connected && !ready) {
    ready = true; clearTimeout(startup);
    wallDeadline = Date.now() + DURATION_MS; monoDeadline = performance.now() + DURATION_MS;
    notify({ type: 'ready', origin, expiresAt: wallDeadline });
    deadline = setTimeout(() => stop('TIMEOUT'), DURATION_MS);
    // Wall-clock check also expires a session immediately after a long system sleep.
    monitor = setInterval(() => { if (Date.now() >= wallDeadline || performance.now() >= monoDeadline) stop('TIMEOUT'); }, 250);
  }
}
process.once('disconnect', () => stop('BACKEND_DISCONNECTED'));
process.on('message', message => { if (message?.type === 'stop') stop(message.reason || 'MANUAL'); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop('SHUTDOWN'));
try {
  const url = new URL(target);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw Error('INVALID_TARGET');
  startup = setTimeout(() => stop('START_FAILED', 'TUNNEL_START_TIMEOUT'), 45000);
  child = spawn(binary, ['tunnel', '--config', process.platform === 'win32' ? 'NUL' : '/dev/null', '--no-autoupdate',
    '--url', url.origin, '--protocol', 'http2', '--loglevel', 'info', '--output', 'json', '--grace-period', '1s'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  if (Number.isSafeInteger(child.pid)) notify({ type: 'connector', pid: child.pid, processGroup: process.platform !== 'win32' });
  child.stdout.on('data', observe); child.stderr.on('data', observe);
  child.once('error', error => stop('START_FAILED', error.code === 'ENOENT' ? 'CLOUDFLARED_NOT_FOUND' : 'TUNNEL_START_FAILED'));
  child.once('close', () => { clearTimeout(force); if (!stopping) stop(ready ? 'CONNECTION_CLOSED' : 'START_FAILED', ready ? undefined : 'TUNNEL_START_FAILED'); process.exitCode = 0; if (process.connected) process.disconnect(); });
} catch { stop('START_FAILED', 'TUNNEL_START_FAILED'); }
