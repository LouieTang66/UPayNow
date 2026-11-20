// Durable, single-dispatch adapter. No timers, automatic send retries or backend signer.
export function createAttempt({ client, route, scope, from, sender, save = () => {}, remove = () => {} }) {
  let started = false;
  return async () => {
    if (started) throw new Error('本次交易已经开始，请恢复原交易，不要重发。');
    started = true;
    // Save the identity BEFORE begin: a lost response must remain uncertain.
    save({ route, scope, phase: 'BEGIN_UNKNOWN' });
    let begun;
    for (let retry = 0; ; retry++) {
      try { begun = await client.post(route + '/begin', { from }, scope); break; }
      catch (error) {
        if (error.status !== 409 || error.code !== 'BUSY_RETRY_LATER') throw error;
        if (retry < 3) { await new Promise(resolve => setTimeout(resolve, 150 * (retry + 1))); continue; }
        // Only a definite pre-transition BUSY plus successful readback may clear
        // this browser's uncertainty marker. Generic response loss never does.
        try {
          const value = await client.get(route.startsWith('wallet/') ? 'jobs' : route, scope);
          const job = Array.isArray(value) ? value.find(j => route.endsWith('/' + j.id)) : value;
          if (job?.state === (route.startsWith('wallet/') ? 'PREPARED' : 'READY')) remove();
        } catch {}
        throw error;
      }
    }
    if (begun?.job?.state !== 'UNKNOWN' || !begun.transaction) throw new Error('后台没有返回持久 UNKNOWN 交易，已阻止发送。');
    const send = await sender(begun.transaction, begun);
    let hash;
    try { hash = await send(); }
    catch (error) {
      if (Number(error.code) === 4001) {
        save({ route, scope, phase: 'REJECTION_PENDING' });
        await client.post(route + '/cancel', { rejected: true }, scope);
        remove();
      }
      throw error;
    }
    if (!/^0x[a-f0-9]{64}$/i.test(hash || '')) throw new Error('钱包未返回有效哈希；请查找原交易，不能重发。');
    // If browser storage fails, still attach immediately; never lose a returned
    // hash just because local persistence is unavailable.
    try { save({ route, scope, phase: 'HASH_PENDING', hash }); } catch {}
    const job = await client.post(route + '/attach', { transactionHash: hash }, scope);
    remove();
    return job;
  };
}
const KEY = 'upay.v2.wallet-recovery';
export function readRecovery() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
export function recoveryStore(key) {
  return {
    save(value) { const all = readRecovery(); all[key] = value; localStorage.setItem(KEY, JSON.stringify(all)); },
    remove() { const all = readRecovery(); delete all[key]; try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {} },
  };
}
