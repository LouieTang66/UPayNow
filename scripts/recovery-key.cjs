'use strict';
// Explicit local-owner operation only. Never called during server startup.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2), copy = args.includes('--copy');
const dirs = args.filter(a => a !== '--copy');
if (dirs.length > 1 || dirs.some(a => a.startsWith('--'))) {
  console.error('Usage: npm run recovery-key -- [--copy] [DATA_DIRECTORY]');
  process.exitCode = 1;
} else {
  try {
    const dir = path.resolve(dirs[0] || process.env.UPAY_DATA_DIR || path.join(__dirname, '../backend/state'));
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    if (state.version !== 1 || typeof state.recoveryKey !== 'string' || !state.recoveryKey || state.recoveryKey.length > 512 || /\s/.test(state.recoveryKey)) throw new Error('INVALID_AUTH_FILE');
    if (copy) {
      const command = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip.exe' : null;
      if (!command) throw new Error('COPY_NOT_SUPPORTED');
      const result = spawnSync(command, [], { input: state.recoveryKey, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] });
      if (result.status !== 0) throw new Error('COPY_FAILED');
      console.log('恢复密钥已复制到剪贴板（未显示明文）。粘贴后请妥善保存，并及时清理剪贴板。');
    } else process.stdout.write(state.recoveryKey + '\n');
  } catch (error) {
    const code = ['COPY_NOT_SUPPORTED', 'COPY_FAILED'].includes(error.message) ? error.message : 'RECOVERY_KEY_UNAVAILABLE';
    console.error(code + ': 请确认已启动新版服务、数据目录正确，且当前账户可读取认证文件。不要删除认证文件来恢复。');
    process.exitCode = 1;
  }
}
