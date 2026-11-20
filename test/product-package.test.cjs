'use strict';
// Development-only guard: the user package must not contain local chain fixtures or instance data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('product metadata is consistent and personal launchers are absent', () => {
  const pkg = require('../package.json'), lock = require('../package-lock.json');
  assert.equal(pkg.name, 'upaynow-product');
  assert.equal(pkg.name, lock.name);
  assert.equal(pkg.name, lock.packages[''].name);
  assert.equal(pkg.version, lock.version);
  assert.equal(pkg.version, lock.packages[''].version);
  assert.equal(pkg.private, true);
  for (const command of ['backend:testnet', 'prebackend:testnet', 'backend:chain', 'backend:local', 'backend:pay', 'preview:frontend']) {
    assert.equal(pkg.scripts[command], undefined, command);
  }
  for (const file of ['backend/bsc-testnet.json', 'backend/testnet-start.cjs', 'backend/local-setup.cjs', 'backend/local-pay.cjs', 'backend/dev-chain.cjs', 'backend/local-tools.cjs', 'frontend-v2/src/shared/demo.js', 'frontend-v2/scripts/preview.mjs']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});

test('runtime keeps selectable testnets but excludes personal presets and private-key signing switches', () => {
  for (const file of fs.readdirSync(path.join(root, 'backend')).filter(name => name.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(root, 'backend', file), 'utf8');
    assert.doesNotMatch(source, /本地开发链|UPAY_TESTNET_ONLY|UPAY_ENABLE_TESTNET_SEND|UPAY_GAS_PRIVATE_KEY/, file);
    if (file !== 'deployment-networks.cjs') assert.doesNotMatch(source, /BSC 测试网|Sepolia|tBNB/, file);
    assert.doesNotMatch(source, /require\(['"]\.\/local-tools\.cjs['"]\)/, file);
  }
});

test('user package contains production source, not development fixtures, secrets or generated state', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--silent'], { cwd: root, encoding: 'utf8' });
  const [pkg] = JSON.parse(output), files = pkg.files.map(file => file.path);
  for (const file of files) {
    assert.doesNotMatch(file, /(?:^|\/)(?:test|tests|fixtures|node_modules|verification[^/]*|screenshots|state|data)(?:\/|$)/, file);
    assert.doesNotMatch(file, /\.(?:secret|sqlite(?:-\w+)?|pem|key|log|map)$/, file);
  }
  for (const file of ['ops-public-deployer/server.cjs', 'ops-public-deployer/phone.cjs', 'ops-public-deployer/phone.js', 'ops-public-deployer/phone.html', 'backend/server.cjs', 'backend/merchant.cjs', 'backend/deployment-service.cjs', 'frontend-v2/pages/index.html', 'frontend-v2/src/admin/main.js', 'contracts/src/ForwarderFactory.sol', 'contracts/src/ForwarderImpl.sol', 'scripts/compile.cjs', 'README.md', '.env.example']) {
    assert(files.includes(file), file);
  }
});
