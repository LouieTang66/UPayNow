import { keccak256, Interface, getCreate2Address, id } from 'ethers';

const SINGLETON = '0xce0042B868300000d44A59004Da54A005ffdcf9f';
const ROOT_SALT = id('upaynow:deterministic-deployer:v2');

export const deterministic = job => (job?.scheme || job?.summary?.scheme || 'legacy-v1') === 'deterministic-v2';
export const bootstrap = job => deterministic(job) && (job.stage || job.summary?.stage) === 'bootstrap';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function assertDeploymentSender(job, from) {
  if (deterministic(job) && !same(from, job.summary?.payout)) throw new Error('同地址部署必须由固定收款 payout 钱包签名；不能签名的收款地址不支持此模式。');
}
// An RPC alone does not establish support. Only the server's canonical bytecode
// verification may authorize a stage; missing/incompatible roots fail closed.
export function deterministicStage(preview) {
  if (preview?.scheme !== 'deterministic-v2' || preview.singletonReady !== true || typeof preview.deployerReady !== 'boolean' || ![preview.singleton, preview.deployer, preview.factory, preview.payout].every(a => /^0x[0-9a-f]{40}$/i.test(a || '')))
    throw new Error('该网络尚未开放：官方 EIP-2470 入口缺失或代码不符，请联系运营方。');
  if (!preview.deployerReady) throw new Error('该网络尚未开放：公共入口未就绪，请联系运营方完成部署。客户端只能部署商户合约。');
  return 'merchant';
}
export function validateDeploymentTransaction(tx, expected, job, intent) {
  const s = job.summary || {};
  const modern = deterministic(job);
  const allowed = new Set(['from', 'data', 'value', 'chainId', 'gas', ...(modern ? ['to'] : [])]);
  if (!tx || Object.keys(tx).some(k => !allowed.has(k)) || Number(tx.chainId) !== Number(s.chainId) || Number(tx.chainId) !== expected.chainId
      || !same(tx.from, expected.address) || BigInt(tx.value ?? -1) !== 0n || !/^0x(?:[a-f0-9]{2})+$/i.test(tx.data || '') || !/^0x[0-9a-f]+$/i.test(tx.gas || ''))
    throw new Error('部署交易网络、账户、金额或字段与审核范围不符，已阻止发送。');
  assertDeploymentSender(job, expected.address);
  if (!modern) return;
  if (!['bootstrap', 'merchant'].includes(job.stage || s.stage)) throw new Error('确定性部署阶段无效。');
  const target = bootstrap(job) ? SINGLETON : s.deployer;
  if (!/^0x[0-9a-f]{40}$/i.test(target || '') || !same(tx.to, target)) throw new Error('确定性部署目标与认证入口不符。');
  // begin.transaction is the server's persisted intent. If separately exposed,
  // compare it too; independently bind its calldata to the reviewed configuration.
  if (intent && (!same(intent.to, target) || !same(intent.from, tx.from) || Number(intent.chainId) !== Number(tx.chainId)
      || BigInt(intent.value ?? -1) !== 0n || !same(intent.data, tx.data))) throw new Error('确定性部署交易与后台持久 intent 不符。');
  if (bootstrap(job)) {
    const abi = new Interface(['function deploy(bytes initCode,bytes32 salt) returns(address)']);
    const [initCode, salt] = abi.decodeFunctionData('deploy', tx.data);
    if (!same(salt, ROOT_SALT) || !same(getCreate2Address(SINGLETON, salt, keccak256(initCode)), s.deployer)
        || !same(abi.encodeFunctionData('deploy', [initCode, salt]), tx.data)) throw new Error('公共入口代码、salt 或预期地址与审核摘要不符。');
  } else {
    const abi = new Interface(['function deploy(address payout,address[] tokens) returns(address)']);
    if (!Array.isArray(s.tokens) || !same(abi.encodeFunctionData('deploy', [s.payout, s.tokens.map(t => t.address || t)]), tx.data))
      throw new Error('商户部署数据与收款钱包、币种摘要不符。');
  }
  if (s.calldataHash && !same(keccak256(tx.data), s.calldataHash)) throw new Error('部署数据与审核摘要不符。');
}
