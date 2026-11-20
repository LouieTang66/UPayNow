'use strict';
const { Store } = require('./store.cjs');
const { Merchant } = require('./merchant.cjs');
const { WalletCollection } = require('./wallet-collection.cjs');
const { Handoff } = require('./handoff.cjs');
const { Webhooks } = require('./webhooks.cjs');
const { AppError } = require('./chain.cjs');

async function createEngine(dir, options = {}) {
  const store = new Store(dir);
  let merchant, handoff, hooks, timer, closing = false, worker = Promise.resolve(), delivery = Promise.resolve();
  try {
    hooks = new Webhooks(store, { hosts: options.webhookHosts || (process.env.UPAY_WEBHOOK_HOSTS || '').split(',').filter(Boolean), allowLocal: !!options.allowLocalWebhook });
    const validateWebhook = url => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new AppError('WEBHOOK_DNS_TIMEOUT', 504)), 10000);
      hooks.target(url).then(resolve, reject).finally(() => clearTimeout(deadline));
    });
    merchant = new Merchant(store, { externalWallet: true, multiChain: !!options.multiChain, validateWebhook });
    const wallet = new WalletCollection(merchant, options.walletConnectDefaults);
    if (options.handoffPort !== undefined) {
      handoff = new Handoff(merchant, wallet, { origin: options.handoffOrigin, quick: options.handoffQuick });
      await handoff.listen(Number(options.handoffPort));
    }
    const deliver = () => {
      if (closing || hooks.running) return delivery;
      delivery = hooks.tick().catch(error => store.set('webhookError', error.code || 'WEBHOOK_DELIVERY_FAILED'));
      return delivery;
    };
    const tick = () => {
      if (closing || !merchant.chain || merchant.busy) return;
      worker = merchant.scan().then(state => {
        if (state.cursor >= store.get('lastHead', Infinity)) void deliver();
      }).catch(error => store.set('scanWorkerError', error.code || 'CHAIN_RPC_ERROR'));
    };
    if ((options.pollMs ?? 5000) > 0) timer = setInterval(tick, options.pollMs ?? 5000);
    return { store, merchant, wallet, handoff, hooks, deliver,
      close: async () => {
        if (closing) return; closing = true; clearInterval(timer);
        await hooks.close(); await Promise.all([worker, delivery]);
        await handoff?.close(); merchant.close(); store.close();
      } };
  } catch (error) {
    clearInterval(timer); await hooks?.close(); await handoff?.close(); merchant?.close(); store.close(); throw error;
  }
}
module.exports = { createEngine };
