'use strict';
// IPC-only lifecycle fixture: no network listener or cloudflared process.
process.on('message', message => {
  if (message?.type === 'stop') process.exit(0);
});
process.once('disconnect', () => process.exit(0));
process.send({ type: 'ready', origin: 'https://example-test.trycloudflare.com', expiresAt: Date.now() + 300000 });
