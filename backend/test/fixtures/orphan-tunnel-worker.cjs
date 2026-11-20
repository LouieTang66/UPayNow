'use strict';
// No network: a detached sleeper models an owned connector surviving its worker.
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
process.send({ type: 'connector', pid: child.pid, processGroup: true });
process.send({ type: 'ready', origin: 'https://example-test.trycloudflare.com', expiresAt: Date.now() + 300000 });
process.on('message', message => { if (message?.type === 'stop') { child.kill('SIGKILL'); process.exit(0); } });
process.once('disconnect', () => { child.kill('SIGKILL'); process.exit(0); });
