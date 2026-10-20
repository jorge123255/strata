/** Bot profiles and run ownership. Model serving connections are deliberately independent. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { json, error, readBody } from './util.mjs';
import { isLocalCompanionRequest } from './companion-routes.mjs';

const fault = (status, message) => Object.assign(new Error(message), { status });
const ids = new Set(['claude', 'codex', 'grok', 'kimi', 'ollama']);
const copy = value => structuredClone(value);
const cleanText = (value, max, name, required = false) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || required && !value.trim()) throw fault(400, `Enter a valid ${name}.`);
  return value.trim();
};
function endpoint(value) {
  if (!value) return undefined;
  let url;
  try { url = new URL(value); } catch { throw fault(400, 'Enter a valid provider API address.'); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw fault(400, 'Use HTTPS for a provider API, or HTTP on this computer’s loopback address.');
  return url.href.replace(/\/$/, '');
}

export function createBots({ directory, runtime, tools, conversations = () => null, defaultWorkspace = () => homedir(), notify = () => {}, now = () => new Date().toISOString() }) {
  const file = join(directory, 'bots.json'), profiles = new Map(), checkpoints = new Map(), chatProfiles = new Map(), active = new Map();
  const owned = id => conversations()?.botId(id) ?? null;
  function save() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, bots: [...profiles.values()], checkpoints: [...checkpoints.entries()], chatProfiles: [...chatProfiles.entries()] }), { mode: 0o600 });
      chmodSync(tmp, 0o600); renameSync(tmp, file);
    } finally { try { unlinkSync(tmp); } catch {} }
  }
  if (existsSync(file)) {
    let saved;
    try { saved = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw fault(503, 'Saved bots could not be read. Their files have been left unchanged.'); }
    if (saved.version !== 1 || !Array.isArray(saved.bots)) throw fault(503, 'This bot catalog format is unavailable. Its file has been left unchanged.');
    for (const bot of saved.bots) {
      if (!bot || !/^bot_[a-f0-9-]+$/.test(bot.id) || !ids.has(bot.provider)) throw fault(503, 'A saved bot is invalid. Its file has been left unchanged.');
      profiles.set(bot.id, bot);
    }
    for (const [id, checkpoint] of saved.checkpoints ?? []) if (typeof id === 'string' && checkpoint && typeof checkpoint === 'object') checkpoints.set(id, checkpoint);
    for (const [id, profile] of saved.chatProfiles ?? []) if (typeof id === 'string' && profile && ids.has(profile.provider)) chatProfiles.set(id, profile);
  }
  function requireBot(id) {
    const bot = profiles.get(id);
    if (!bot) throw fault(404, 'This bot profile was removed. Its conversations are still in your history.');
    return bot;
  }
  function publicBot(bot) {
    const { providerSettings, ...safe } = copy(bot);
    return { ...safe, ...(providerSettings ? { providerSettings: { ...(providerSettings.baseURL ? { baseURL: providerSettings.baseURL } : {}), apiKeySet: !!providerSettings.apiKey } } : {}),
      conversations: (conversations()?.list().conversations ?? []).filter(chat => chat.preferences?.botId === bot.id).map(chat => chat.id),
      active: [...active.values()].some(run => run.botId === bot.id) };
  }
  function validate(input, old = {}) {
    const name = cleanText(input.name ?? old.name ?? '', 80, 'bot name', true);
    const provider = input.provider ?? old.provider;
    if (!ids.has(provider)) throw fault(400, 'Choose Claude Code, Codex, Grok, Kimi or Ollama Cloud.');
    const capabilities = input.capabilities ?? old.capabilities ?? 'both';
    if (!['code', 'computer', 'both'].includes(capabilities)) throw fault(400, 'Choose coding, computer control or both.');
    const policy = input.policy ?? old.policy ?? 'manual';
    if (!['manual', 'plan', 'bypass'].includes(policy)) throw fault(400, 'Choose a valid permission mode.');
    const supplied = input.execution ?? old.execution ?? { kind: 'local' };
    if (!['local', 'ssh', 'sandbox'].includes(supplied.kind)) throw fault(400, 'Choose a valid execution computer.');
    let execution = { kind: supplied.kind };
    if (supplied.kind === 'ssh') {
      const host = cleanText(supplied.host ?? '', 253, 'SSH host', true), user = cleanText(supplied.user ?? '', 64, 'SSH user');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(host) || user && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)) throw fault(400, 'Enter the SSH host and optional user separately.');
      const port = supplied.port ?? 22;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw fault(400, 'Enter a valid SSH port.');
      execution = { kind: 'ssh', host, user, port };
    } else if (supplied.kind === 'sandbox' && (supplied.host || supplied.target)) execution.host = cleanText(supplied.host ?? supplied.target, 200, 'sandbox target');
    const rawWorkspace = cleanText(input.workspace ?? old.workspace ?? defaultWorkspace(), 4000, 'workspace folder', true).replace(/^~(?=\/|$)/, homedir());
    if (!isAbsolute(rawWorkspace)) throw fault(400, 'Choose the full path to the bot’s workspace.');
    const workspace = resolve(rawWorkspace);
    if (execution.kind === 'local') {
      try { if (!statSync(workspace).isDirectory()) throw new Error(); }
      catch { throw fault(400, 'Choose an existing workspace folder on this computer.'); }
    }
    const providerSettings = provider === old.provider ? { ...old.providerSettings } : {};
    if (input.providerSettings !== undefined) {
      const settings = input.providerSettings;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw fault(400, 'Provider settings are invalid.');
      if (settings.baseURL !== undefined) providerSettings.baseURL = endpoint(settings.baseURL);
      if (settings.clearKey === true) delete providerSettings.apiKey;
      if (settings.apiKey !== undefined && settings.apiKey !== '') providerSettings.apiKey = cleanText(settings.apiKey, 8192, 'provider API key', true);
    }
    return { name, provider, capabilities, policy, execution, workspace,
      instructions: cleanText(input.instructions ?? old.instructions ?? '', 32000, 'bot instructions'),
      model: cleanText(input.model ?? old.model ?? '', 250, 'model name'), ...(Object.keys(providerSettings).length ? { providerSettings } : {}) };
  }
  function create(input) {
    const at = now(), bot = { id: `bot_${randomUUID()}`, ...validate(input), createdAt: at, updatedAt: at };
    profiles.set(bot.id, bot); save(); notify('bots', { changed: bot.id }); return { bot: publicBot(bot) };
  }
  function update(id, input) {
    const old = requireBot(id);
    if ([...active.values()].some(run => run.botId === id)) throw fault(409, 'Stop this bot’s active conversations before changing its profile.');
    const bot = { id, ...validate(input, old), createdAt: old.createdAt, updatedAt: now() };
    if (input.providerSettings?.clearKey === true) for (const snapshot of chatProfiles.values()) if (snapshot.id === id && snapshot.providerSettings) delete snapshot.providerSettings.apiKey;
    profiles.set(id, bot); save(); notify('bots', { changed: id }); return { bot: publicBot(bot) };
  }
  function remove(id) {
    requireBot(id);
    if ([...active.values()].some(run => run.botId === id)) throw fault(409, 'Stop this bot’s active conversations before removing its profile.');
    profiles.delete(id); save(); notify('bots', { deleted: id }); return { deleted: id };
  }
  async function list() {
    const providers = (await runtime.providers()).map(provider => ({ ...provider, available: provider.available ?? provider.ready ?? false,
      detail: provider.detail ?? [provider.transport, provider.version, provider.auth?.help].filter(Boolean).join(' · ') }));
    return { bots: [...profiles.values()].map(bot => {
      const provider = providers.find(p => p.id === bot.provider);
      const ownKey = bot.provider === 'ollama' && !!bot.providerSettings?.apiKey;
      return { ...publicBot(bot), available: bot.execution.kind === 'local' && (!!provider?.available || ownKey),
        detail: bot.execution.kind !== 'local' ? 'This execution adapter is not configured.' : ownKey ? 'Ollama Cloud API key configured. Model access is checked when a turn runs.' : provider?.detail ?? 'Provider setup is required.' };
    }), providers, computers: [
      { id: 'local', name: 'This computer', kind: 'local', available: true, detail: 'Coding tools use the chosen folder. Computer tools use this computer’s browser and supported desktop controls.' },
      { id: 'ssh', name: 'Remote computer · SSH', kind: 'ssh', available: false, detail: 'Saved for later setup. Running native bot providers over SSH is not configured yet. Model-serving APIs remain separate.' },
      { id: 'sandbox', name: 'Dedicated sandbox', kind: 'sandbox', available: false, detail: 'A CUA execution adapter must be installed and configured before this target can run.' },
    ] };
  }
  function validateSelection(selection) {
    if (!selection?.botId) return;
    const current = requireBot(selection.botId);
    const bot = chatProfiles.get(selection.chatId) ?? current;
    if (bot.execution.kind !== 'local') throw fault(409, bot.execution.kind === 'ssh' ? 'This bot’s SSH execution adapter is not configured. Choose This computer, or finish remote execution setup.' : 'This bot’s sandbox execution adapter is not configured. Choose This computer, or finish sandbox setup.');
  }
  function createConversation(id) {
    const bot = requireBot(id);
    validateSelection({ botId: id });
    const result = conversations().createForBot(bot);
    chatProfiles.set(result.conversation.id, copy(bot)); save();
    return result;
  }
  function pending(chatId) {
    return [...(active.get(chatId)?.pending.values() ?? [])].map(({ resolve: done, ...value }) => copy(value));
  }
  async function approve({ chatId, callId, decision }) {
    const run = active.get(chatId), request = run?.pending.get(callId);
    if (!request) throw fault(409, 'This bot is no longer waiting for that approval.');
    run.pending.delete(callId); request.resolve(decision === 'approve');
  }
  async function stop(chatId) {
    const run = active.get(chatId);
    if (!run) return { stopped: false, pending: false };
    run.controller.abort();
    await run.ended;
    return { stopped: true };
  }
  async function run({ session, message, signal, onFrame }) {
    const current = requireBot(session.preferences?.botId);
    const bot = copy(chatProfiles.get(session.id) ?? current);
    validateSelection({ botId: bot.id, chatId: session.id });
    if (active.has(session.id)) throw fault(409, 'This bot conversation is already running.');
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let ended;
    const owner = { botId: bot.id, controller, pending: new Map(), ended: new Promise(resolve => { ended = resolve; }) };
    active.set(session.id, owner);
    let terminal = null;
    const emit = frame => {
      if (active.get(session.id) !== owner) return;
      if (frame.type === 'done' || frame.type === 'error') { terminal = frame; return; }
      onFrame(frame);
    };
    const fingerprint = createHash('sha256').update(JSON.stringify([bot.id, bot.provider, bot.model, bot.workspace, bot.instructions, bot.policy, bot.capabilities, bot.providerSettings?.baseURL])).digest('hex');
    const oldCheckpoint = checkpoints.get(session.id);
    const requestPermission = async ({ id, name, args = {}, reason = 'Allow this bot action?' }) => {
      if (combined.aborted || bot.policy === 'plan') return false;
      if (bot.policy === 'bypass') return true;
      const callId = typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(id) ? id : `bt_${createHash('sha256').update(String(id ?? randomUUID())).digest('hex').slice(0, 32)}`;
      if (owner.pending.has(callId)) throw fault(409, 'This tool request is already waiting.');
      emit({ type: 'agent-tool', tool: { id: callId, name: name ?? 'Bot action', args, preview: reason, effect: reason, scope: 'connected', state: 'proposed' } });
      return new Promise(resolve => {
        const abort = () => finish(false);
        const finish = allowed => {
          combined.removeEventListener('abort', abort); owner.pending.delete(callId);
          emit({ type: 'agent-tool', tool: { id: callId, name: name ?? 'Bot action', args, preview: reason, effect: reason, scope: 'connected', state: allowed ? 'running' : 'denied' } });
          resolve(allowed);
        };
        owner.pending.set(callId, { callId, tool: name, reason, args, at: Date.now(), resolve: finish });
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) abort();
      });
    };
    try {
      emit({ type: 'start', agent: true, model: bot.model || bot.provider });
      await runtime.run({ bot, sessionId: session.id, message, history: session.messages, signal: combined, onFrame: emit, requestPermission,
        tools: tools.definitions(bot), executeTool: (name, args, toolCallId) => {
          if (active.get(session.id) !== owner || combined.aborted) throw fault(409, 'This bot turn has ended.');
          return tools.execute({ bot, chatId: session.id, name, args, toolCallId, signal: combined, onFrame: emit, requestPermission });
        },
        checkpoint: oldCheckpoint?.fingerprint === fingerprint ? oldCheckpoint.value : null,
        onCheckpoint: value => { if (active.get(session.id) === owner) { checkpoints.set(session.id, { fingerprint, value }); save(); } } });
    } catch (failure) {
      if (combined.aborted) terminal = { type: 'done', cancelled: true };
      else throw failure;
    } finally {
      controller.abort(); // Revoke tool authority before awaiting asynchronous cleanup.
      for (const request of [...owner.pending.values()]) request.resolve(false);
      await tools.finish?.(session.id);
      if (active.get(session.id) === owner) active.delete(session.id);
      if (terminal) onFrame(terminal);
      ended();
    }
  }
  return { list, create, update, remove, createConversation, validateSelection, run, pending, approve, stop,
    hasProfiles: () => profiles.size > 0, isBotConversation: id => !!owned(id), workspace: id => chatProfiles.get(id)?.workspace ?? null, activeCount: () => active.size,
    async close() { for (const run of active.values()) run.controller.abort(); await Promise.allSettled([...active.values()].map(run => run.ended)); await tools.close?.(); await runtime.close?.(); } };
}

export function createBotRoutes({ bots, port }) {
  return async (req, res, url) => {
    res.removeHeader('access-control-allow-origin'); res.setHeader('cache-control', 'no-store');
    if (!isLocalCompanionRequest(req, typeof port === 'function' ? port() : port)) return error(res, 403, 'Open Bots in Strata on this computer.');
    try {
      if (url.pathname === '/api/bots' && req.method === 'GET') return json(res, 200, await bots.list());
      if (url.pathname === '/api/bots' && req.method === 'POST') return json(res, 201, bots.create(await readBody(req)));
      const match = /^\/api\/bots\/(bot_[a-f0-9-]+)(?:\/(conversations))?$/.exec(url.pathname);
      if (!match) return error(res, 404, 'Unknown bot action.');
      if (!match[2] && req.method === 'PATCH') return json(res, 200, bots.update(match[1], await readBody(req)));
      if (!match[2] && req.method === 'DELETE') return json(res, 200, bots.remove(match[1]));
      if (match[2] === 'conversations' && req.method === 'POST') return json(res, 201, bots.createConversation(match[1]));
      return error(res, 405, 'This bot action is unavailable.');
    } catch (failure) { return error(res, failure.status ?? 500, failure.message ?? 'The bot request failed.'); }
  };
}
