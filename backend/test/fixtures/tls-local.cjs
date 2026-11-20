'use strict';
// Development-only CA generation. Never imported by the production Chain adapter.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
function trustCA(file) {
  if (typeof tls.setDefaultCACertificates !== 'function') throw new Error('LOCAL_TLS_REQUIRES_NODE_22_19');
  const pem = fs.readFileSync(file, 'utf8');
  tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), pem])]);
}
function createLocalTLS() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upaynow-tls-'));
  fs.chmodSync(dir, 0o700);
  const file = name => path.join(dir, name);
  const run = args => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  try {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=upaynow local CA ' + path.basename(dir)]);
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
    fs.writeFileSync(file('san.cnf'), 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\n');
    run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'san.cnf']);
    for (const name of ['ca.key', 'server.key']) fs.chmodSync(file(name), 0o600);
    return { caFile: file('ca.pem'), key: fs.readFileSync(file('server.key')), cert: fs.readFileSync(file('server.pem')),
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
}
module.exports = { createLocalTLS, trustCA };
