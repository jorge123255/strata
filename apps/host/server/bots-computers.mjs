/** Explicit CUA computer lifecycle and short-lived human control, separate from model APIs. */
import { randomBytes } from 'node:crypto';
const fault = (status, message) => Object.assign(new Error(message), { status });
const target = bot => JSON.stringify([bot.id, bot.execution.kind, bot.execution.host || '', bot.execution.user || '', bot.execution.port ?? null]);
export function createBotComputers({ profile, cua, remoteSSH, busy, stopOwned, prepareOwned, checkClean = () => {}, clearUncertain = () => {}, markOwned = () => {}, markUncertain = () => {}, now = () => Date.now(), leaseMs = 30_000 }) {
  const leases = new Map(), operations = new Map();
  let closed = false;
  function current(bot) {
    const key = target(bot), lease = leases.get(key);
    if (lease && lease.expiresAt <= now() && !operations.has(key)) { leases.delete(key); return null; }
    return lease ?? null;
  }
  function requireComputer(id, chatId) {
    if (closed) throw fault(503, 'Bot computer controls are closed.');
    const bot = profile(id, chatId);
    if (bot.computerMode !== 'cua') throw fault(409, 'Choose an isolated CUA computer in this bot’s profile.');
    return bot;
  }
  async function invoke(bot, operation, input = {}, signal) {
    try {
      if (bot.execution.kind === 'ssh') {
        if (!remoteSSH?.cua) throw fault(503, 'The SSH CUA worker is unavailable. Prepare it on the Mac.');
        return await remoteSSH.cua(bot.execution, operation, { bot, ...input }, { signal });
      }
      if (bot.execution.kind !== 'local' || !cua?.[operation]) throw fault(503, 'Prepare CUA on this computer before using it.');
      return await cua[operation]({ bot, ...input, signal });
    } catch (error) {
      if (error.cleanupUnconfirmed || error.code === 'cua_cleanup_unconfirmed' || error.code === 'ssh_cleanup_unconfirmed') markUncertain(bot);
      throw error;
    }
  }
  function stateContext(bot, value, owner) {
    const lease = current(bot);
    const { frame, ...safe } = value;
    return { ...safe, ...(frame ? { width: frame.width, height: frame.height, image: { mimeType: frame.mimeType, data: frame.data } } : {}), computerName: bot.execution.name || (bot.execution.kind === 'local' ? 'This Mac · CUA' : `${bot.execution.host} · CUA`),
      control: { active: !!lease, owned: !!lease && lease.owner === owner, ...(lease ? { expiresAt: lease.expiresAt } : {}) } };
  }
  function exclusive(bot, operation) {
    const key = target(bot);
    if (operations.has(key)) throw fault(409, 'This computer is completing another control action.');
    const promise = Promise.resolve().then(operation); operations.set(key, promise);
    return promise.finally(() => { if (operations.get(key) === promise) operations.delete(key); });
  }
  function checkRun(bot) {
    if (bot.computerMode !== 'cua') return;
    if (current(bot) || operations.has(target(bot))) throw fault(409, 'A person has control of this bot’s CUA computer. Release control before starting another turn.');
  }
  return {
    checkRun,
    checkRemove(bot) {
      for (const [key, lease] of leases) if (lease.expiresAt <= now() && !operations.has(key)) leases.delete(key);
      if ([...leases.keys(), ...operations.keys()].some(key => JSON.parse(key)[0] === bot.id)) throw fault(409, 'Release control and finish this computer action before removing or moving the bot profile.');
    },
    async prepare(id, { chatId, signal } = {}) {
      const bot = requireComputer(id, chatId);
      return exclusive(bot, async () => {
        if (busy(bot) || current(bot)) throw fault(409, 'Finish work and release control before preparing this computer.');
        if (!prepareOwned) throw fault(503, 'CUA preparation is unavailable on this computer.');
        const result = await prepareOwned(bot, { signal });
        if (result.available !== true) throw fault(409, result.detail || 'CUA is not ready on this account. Choose another execution computer.');
        return result;
      });
    },
    async state(id, { chatId, owner = 'mac', signal } = {}) {
      const bot = requireComputer(id, chatId);
      return stateContext(bot, await invoke(bot, 'state', {}, signal), owner);
    },
    async start(id, { chatId, owner = 'mac', signal } = {}) {
      const bot = requireComputer(id, chatId);
      return exclusive(bot, async () => {
        if (current(bot)) throw fault(409, 'Release control before starting this computer.');
        if (busy(bot)) throw fault(409, 'Wait for this bot turn to finish, or take over its computer.');
        checkClean(bot);
        if ((await invoke(bot, 'state', {}, signal)).cleanupConfirmed === false) throw fault(409, 'CUA cleanup is unconfirmed. Stop this isolated computer before starting it again.');
        markOwned(bot);
        const value = await invoke(bot, 'start', {}, signal);
        return stateContext(bot, value, owner);
      });
    },
    async stop(id, { chatId, owner = 'mac', signal } = {}) {
      const bot = requireComputer(id, chatId);
      return exclusive(bot, async () => {
        try { await stopOwned(bot); } catch (error) { if (!error.cleanupUnconfirmed && !['ssh_cleanup_unconfirmed','cua_cleanup_unconfirmed'].includes(error.code) && error.status !== 409) throw error; }
        const value = await invoke(bot, 'stop', {}, signal);
        if (!value.stopped || value.cleanupConfirmed !== true) throw fault(503, 'The isolated computer did not confirm that it stopped.');
        leases.delete(target(bot)); clearUncertain(bot);
        return stateContext(bot, value, owner);
      });
    },
    async takeover(id, { chatId, owner = 'mac', signal } = {}) {
      const bot = requireComputer(id, chatId);
      return exclusive(bot, async () => {
        await stopOwned(bot);
        signal?.throwIfAborted();
        checkClean(bot);
        if (busy(bot)) throw fault(409, 'The bot has not confirmed that it stopped. Control was not granted.');
        // Readiness is read-only. Starting a missing computer is a separate explicit action.
        const value = await invoke(bot, 'state', {}, signal);
        if (value.cleanupConfirmed === false) throw fault(409, 'CUA cleanup is unconfirmed. Stop this isolated computer before taking over.');
        if (!value.available || !(value.image || value.frame)) throw fault(409, value.detail || 'Start this CUA computer before taking over.');
        markOwned(bot);
        const lease = { token: randomBytes(32).toString('hex'), owner, expiresAt: now() + leaseMs };
        leases.set(target(bot), lease);
        return { ...stateContext(bot, value, owner), leaseToken: lease.token, expiresAt: lease.expiresAt };
      });
    },
    async control(id, input, { owner = 'mac', signal } = {}) {
      const bot = requireComputer(id, input?.chatId);
      return exclusive(bot, async () => {
        checkClean(bot);
        const lease = current(bot);
        if (!lease || lease.expiresAt <= now() || lease.owner !== owner || lease.token !== input?.leaseToken) throw fault(403, 'Take over this computer again before sending input.');
        if (busy(bot)) throw fault(409, 'The bot is still using this computer. Control was not sent.');
        const { action } = input;
        if (!['click', 'type', 'key'].includes(action)) throw fault(400, 'Choose a click, text entry or key.');
        if (action === 'click' && (!Number.isInteger(input.x) || !Number.isInteger(input.y) || input.x < 0 || input.y < 0 || input.x > 32768 || input.y > 32768)) throw fault(400, 'Choose a valid point inside the computer image.');
        if (action === 'type' && (typeof input.text !== 'string' || !input.text || input.text.length > 4000 || input.text.includes('\0'))) throw fault(400, 'Enter up to 4,000 characters.');
        if (action === 'key' && (typeof input.key !== 'string' || !input.key || input.key.length > 80 || /[\x00-\x1f]/.test(input.key))) throw fault(400, 'Choose a supported key or shortcut.');
        lease.expiresAt = now() + leaseMs;
        const value = await invoke(bot, 'control', { action, ...(action === 'click' ? { x: input.x, y: input.y } : action === 'type' ? { text: input.text } : { key: input.key }) }, signal);
        return { ...stateContext(bot, value, owner), expiresAt: lease.expiresAt };
      });
    },
    release(id, input, { owner = 'mac' } = {}) {
      const bot = requireComputer(id, input?.chatId), lease = current(bot), key = target(bot);
      if (!lease || lease.owner !== owner || lease.token !== input?.leaseToken) throw fault(403, 'This control lease is unavailable.');
      if (operations.has(key)) throw fault(409, 'Wait for the current input action to finish before releasing control.');
      leases.delete(key); return { released: true };
    },
    async close() { closed = true; leases.clear(); await Promise.allSettled([...operations.values()]); },
  };
}
