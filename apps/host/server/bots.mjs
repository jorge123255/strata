/** Bot profiles and run ownership. Model serving connections are deliberately independent. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { json, error, readBody } from './util.mjs';
import { isLocalCompanionRequest } from './companion-routes.mjs';
import { botModelDestination } from './bots-models.mjs';
import { createBotComputers } from './bots-computers.mjs';
import { createBotWork } from './bots-work.mjs';

const fault = (status, message) => Object.assign(new Error(message), { status });
const ids = new Set(['claude', 'codex', 'grok', 'kimi', 'ollama', 'configured']);
export const BOT_AVATARS = ['🤖', '🧑‍💻', '🦊', '🧠', '🚀', '🛠️', '🌿', '✨'];
export const executionKey = value => value?.kind === 'local' ? 'local' : `ssh_${createHash('sha256').update(JSON.stringify([value?.host, value?.user || '', value?.port ?? null])).digest('hex').slice(0, 32)}`;
export function normalizeBotExecution(supplied = { kind: 'local' }) {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || !['local', 'ssh', 'sandbox'].includes(supplied.kind)) throw fault(400, 'Choose a valid execution computer.');
  const name = supplied.name ? cleanText(supplied.name, 120, 'computer name') : undefined;
  if (supplied.kind === 'ssh') {
    const host = cleanText(supplied.host ?? '', 253, 'SSH host', true), user = cleanText(supplied.user ?? '', 128, 'SSH user');
    if (!/^[A-Za-z0-9:][A-Za-z0-9._:-]*$/.test(host) || user && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/.test(user)) throw fault(400, 'Enter the SSH host and optional user separately.');
    if (supplied.port !== undefined && (!Number.isInteger(supplied.port) || supplied.port < 1 || supplied.port > 65535)) throw fault(400, 'Enter a valid SSH port.');
    return { kind: 'ssh', host, ...(user ? { user } : {}), ...(supplied.port !== undefined ? { port: supplied.port } : {}), ...(name ? { name } : {}) };
  }
  return { kind: supplied.kind, ...(name ? { name } : {}), ...(supplied.kind === 'sandbox' && supplied.host ? { host: cleanText(supplied.host, 200, 'sandbox target') } : {}) };
}
const cuaResource = bot => `cua:${bot.id}:${executionKey(bot.execution)}`;
export function executionLabel(execution) {
  return execution.name || (execution.kind === 'local' ? 'This Mac' : execution.kind === 'sandbox' ? 'Sandbox' : `${execution.user ? `${execution.user}@` : ''}${execution.host}${execution.port ? `:${execution.port}` : ''}`);
}
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

export function createBots({ directory, runtime, tools, conversations = () => null, defaultWorkspace = () => homedir(), notify = () => {}, now = () => new Date().toISOString(), remoteSSH, modelProviders, modelRequest, cuaTools }) {
  const file = join(directory, 'bots.json'), profiles = new Map(), checkpoints = new Map(), chatProfiles = new Map(), active = new Map(), targets = new Map(), computerLeases = new Map(), uncertainTargets = new Map(), ownedComputers = new Set();
  const owned = id => conversations()?.botId(id) ?? null;
  function save() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, bots: [...profiles.values()], checkpoints: [...checkpoints.entries()], chatProfiles: [...chatProfiles.entries()], targets: [...targets.entries()], uncertainTargets: [...uncertainTargets.entries()], ownedComputers: [...ownedComputers] }), { mode: 0o600 });
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
    for (const [id, reason] of saved.uncertainTargets ?? []) if (typeof id === 'string' && typeof reason === 'string') uncertainTargets.set(id, reason.slice(0, 2000));
    for (const id of saved.ownedComputers ?? []) if (typeof id === 'string' && id.startsWith('cua:')) ownedComputers.add(id);
    for (const [id, profile] of saved.chatProfiles ?? []) if (typeof id === 'string' && profile && ids.has(profile.provider)) chatProfiles.set(id, profile);
  }
  for (const [id, value] of (() => { try { return JSON.parse(readFileSync(file, 'utf8')).targets ?? []; } catch { return []; } })()) {
    try { const execution = normalizeBotExecution(value.execution); if (execution.kind === 'ssh' && id === executionKey(execution)) targets.set(id, { execution, ...(value.status ? { status: value.status } : {}) }); } catch {}
  }
  function modelRows() {
    return (modelProviders?.list().connections ?? []).flatMap(connection => connection.models.map(model => ({ id: `bm_${createHash('sha256').update(JSON.stringify([connection.id, model.id])).digest('hex').slice(0, 32)}`, connectionId: connection.id, connectionName: connection.name, model: model.id, name: model.name || model.id, available: true, detail: 'Uses this saved model API. Tool support is checked when a turn runs.' })));
  }
  function computerRows() {
    const computers = new Map([['local', { id: 'local', name: 'This Mac', kind: 'local', available: true, detail: 'Runs tools and native provider accounts on this Mac.', execution: { kind: 'local' } }]]);
    const add = (execution, name) => {
      if (execution.kind !== 'ssh') return;
      const id = executionKey(execution), status = targets.get(id)?.status;
      computers.set(id, { id, name: name || computers.get(id)?.name || executionLabel(execution), kind: 'ssh', available: !uncertainTargets.has(id) && status?.available === true && status?.prepared === true, detail: uncertainTargets.get(id) || status?.detail || 'Check and prepare this SSH computer on the Mac before starting work.', execution: { ...copy(execution), name: name || computers.get(id)?.name || executionLabel(execution) }, ...(status?.providers ? { providers: copy(status.providers) } : {}) });
    };
    for (const connection of modelProviders?.list().connections ?? []) if (connection.modelManagement?.transport === 'ssh') add(normalizeBotExecution({ kind: 'ssh', ...connection.modelManagement }), connection.name);
    for (const value of targets.values()) add(value.execution);
    for (const bot of profiles.values()) add(bot.execution);
    return [...computers.values()];
  }
  async function computerAction(input, prepare = false, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['execution', 'computerId'].includes(key))) throw fault(400, 'Choose a saved or custom SSH computer.');
    const execution = input.computerId ? computerRows().find(c => c.id === input.computerId)?.execution : normalizeBotExecution(input.execution);
    if (!execution) throw fault(404, 'This execution computer is no longer configured.');
    if (execution.kind === 'local') return { available: true, prepared: true, detail: 'This Mac is ready.', providers: await runtime.providers() };
    if (execution.kind !== 'ssh' || !remoteSSH) throw fault(409, 'This execution adapter is unavailable.');
    const id = executionKey(execution);
    if (prepare && [...active.values()].some(run => run.target === id)) throw fault(409, 'Wait for work on this computer to finish before preparing its worker.');
    const status = await (prepare ? remoteSSH.prepare(execution, options) : remoteSSH.probe(execution, options));
    if (status.available === true && status.prepared === true && status.activeRuns === 0) uncertainTargets.delete(id);
    targets.set(id, { execution, status }); save(); notify('bots', { computer: id });
    return status;
  }
  const work = createBotWork({ directory, requireBot, chats: conversations, createConversation, notify });
  const hasOwnedComputer = id => [...ownedComputers, ...uncertainTargets.keys()].some(key => key.startsWith(`cua:${id}:`));
  const markOwned = bot => { ownedComputers.add(cuaResource(bot)); save(); };
  const computer = createBotComputers({ cua: cuaTools, remoteSSH, profile: (id, chatId) => { const bot = requireBot(id); if (!chatId) return copy(bot); const snapshot = chatProfiles.get(chatId); if (!snapshot || snapshot.id !== id) throw fault(404, 'This computer does not belong to that conversation.'); return copy(snapshot); },
    busy: bot => [...active.values()].some(run => run.botId === bot.id && run.target === executionKey(bot.execution)),
    prepareOwned: (bot, options) => prepareCUA({ execution: bot.execution }, options),
    checkClean: bot => { if (uncertainTargets.has(cuaResource(bot))) throw fault(409, 'CUA cleanup is unconfirmed. Stop this isolated computer from its Computer view before continuing.'); if (uncertainTargets.has(executionKey(bot.execution))) throw fault(409, uncertainTargets.get(executionKey(bot.execution))); },
    markOwned,
    clearUncertain: bot => { uncertainTargets.delete(cuaResource(bot)); ownedComputers.delete(cuaResource(bot)); save(); },
    markUncertain: bot => { uncertainTargets.set(cuaResource(bot), 'CUA cleanup could not be confirmed. Stop this isolated computer from its Computer view before continuing.'); save(); },
    stopOwned: async bot => { for (const [chatId, run] of [...active.entries()]) if (run.botId === bot.id && run.target === executionKey(bot.execution)) await stop(chatId); if (uncertainTargets.has(executionKey(bot.execution))) throw fault(409, 'Remote cleanup is unconfirmed. Check this computer on the Mac before taking over.'); } });
  async function prepareCUA(input, options) {
    const execution = input?.computerId ? computerRows().find(c => c.id === input.computerId)?.execution : normalizeBotExecution(input?.execution);
    if (!execution) throw fault(404, 'This execution computer is no longer configured.');
    if ([...active.values()].some(run => run.target === executionKey(execution))) throw fault(409, 'Wait for work on this computer to finish before preparing CUA.');
    if (execution.kind === 'ssh' && remoteSSH?.cua) { await remoteSSH.prepare(execution, options); return remoteSSH.cua(execution, 'prepare', {}, options); }
    if (execution.kind === 'local' && cuaTools) return cuaTools.prepare(options);
    throw fault(503, 'CUA preparation is unavailable on this computer.');
  }
  function requireBot(id) {
    const bot = profiles.get(id);
    if (!bot) throw fault(404, 'This bot profile was removed. Its conversations are still in your history.');
    return bot;
  }
  function publicBot(bot) {
    const { providerSettings, modelDestination, ...safe } = copy(bot);
    return { ...safe, avatar: BOT_AVATARS.includes(bot.avatar) ? bot.avatar : '🤖', ...(providerSettings ? { providerSettings: { ...(providerSettings.baseURL ? { baseURL: providerSettings.baseURL } : {}), apiKeySet: !!providerSettings.apiKey } } : {}),
      conversations: (conversations()?.list().conversations ?? []).filter(chat => chat.preferences?.botId === bot.id).map(chat => chat.id),
      active: [...active.values()].some(run => run.botId === bot.id) };
  }
  function validate(input, old = {}) {
    const name = cleanText(input.name ?? old.name ?? '', 80, 'bot name', true);
    const provider = input.provider ?? old.provider;
    if (!ids.has(provider)) throw fault(400, 'Choose a native provider or a configured model.');
    const capabilities = input.capabilities ?? old.capabilities ?? 'both';
    if (!['code', 'computer', 'both'].includes(capabilities)) throw fault(400, 'Choose coding, computer control or both.');
    const policy = input.policy ?? old.policy ?? 'manual';
    if (!['manual', 'plan', 'bypass'].includes(policy)) throw fault(400, 'Choose a valid permission mode.');
    const computerMode = input.computerMode ?? old.computerMode ?? 'host';
    if (!['host', 'cua'].includes(computerMode)) throw fault(400, 'Choose this computer or an isolated CUA computer.');
    const execution = normalizeBotExecution(input.execution ?? old.execution ?? { kind: 'local' });
    const rawWorkspace = cleanText(input.workspace ?? old.workspace ?? defaultWorkspace(), 4000, 'workspace folder', true);
    const workspace = execution.kind === 'local' ? resolve(rawWorkspace.replace(/^~(?=\/|$)/, homedir())) : rawWorkspace;
    if (computerMode === 'cua' && workspace !== '/workspace') throw fault(400, 'The isolated CUA computer uses /workspace. Choose that folder for this bot.');
    if (!isAbsolute(execution.kind === 'local' ? rawWorkspace.replace(/^~(?=\/|$)/, homedir()) : rawWorkspace)) throw fault(400, 'Choose the full path to the bot’s workspace on its execution computer.');
    if (execution.kind === 'local' && computerMode !== 'cua') {
      try { if (!statSync(workspace).isDirectory()) throw new Error(); }
      catch { throw fault(400, 'Choose an existing workspace folder on this computer.'); }
    }
    const avatarConfig = input.avatarConfig ?? old.avatarConfig;
    if (avatarConfig !== undefined && (!avatarConfig || typeof avatarConfig !== 'object' || Array.isArray(avatarConfig) || Object.keys(avatarConfig).some(key => !['kind','color','eyes','ears'].includes(key)) || !['cloud','violet','orange','sky','graphite','slate'].includes(avatarConfig.color) || !['star','round','happy','calm','plus','delight'].includes(avatarConfig.eyes) || !['scalloped','round','small'].includes(avatarConfig.ears) || Object.hasOwn(avatarConfig, 'kind') && !['koala','fox','cat','robot'].includes(avatarConfig.kind))) throw fault(400, 'Choose a valid bot character, color, eyes and ears.');
    const avatar = input.avatar ?? old.avatar ?? '🤖';
    if (!BOT_AVATARS.includes(avatar)) throw fault(400, 'Choose one of the bot avatars.');
    let modelSource, modelDestination, modelLabel;
    if (provider === 'configured') {
      const source = input.modelSource ?? (old.provider === 'configured' ? old.modelSource : null);
      if (!source || typeof source.connectionId !== 'string' || typeof source.model !== 'string') throw fault(400, 'Choose a model from your configured Models.');
      let selected;
      try { selected = modelProviders.resolve({ connectionId: source.connectionId, modelId: source.model }); } catch { throw fault(409, 'This model is no longer configured. Choose another model from Models.'); }
      modelSource = { connectionId: selected.connection.id, model: selected.model.id };
      modelDestination = botModelDestination(selected.connection);
      modelLabel = `${selected.connection.name} · ${selected.model.name || selected.model.id}`;
    }
    const providerSettings = provider === old.provider ? { ...old.providerSettings } : {};
    if (input.providerSettings !== undefined) {
      const settings = input.providerSettings;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw fault(400, 'Provider settings are invalid.');
      if (settings.baseURL !== undefined) providerSettings.baseURL = endpoint(settings.baseURL);
      if (settings.clearKey === true) delete providerSettings.apiKey;
      if (settings.apiKey !== undefined && settings.apiKey !== '') providerSettings.apiKey = cleanText(settings.apiKey, 8192, 'provider API key', true);
    }
    return { name, avatar, ...(avatarConfig ? { avatarConfig: copy(avatarConfig) } : {}), paused: old.paused === true, computerMode, provider, capabilities, policy, execution, workspace, ...(modelSource ? { modelSource, modelDestination, modelLabel } : {}),
      instructions: cleanText(input.instructions ?? old.instructions ?? '', 32000, 'bot instructions'),
      model: modelSource?.model ?? cleanText(input.model ?? old.model ?? '', 250, 'model name'), ...(Object.keys(providerSettings).length ? { providerSettings } : {}) };
  }
  function create(input) {
    const at = now(), bot = { id: `bot_${randomUUID()}`, ...validate(input), createdAt: at, updatedAt: at };
    profiles.set(bot.id, bot); save(); notify('bots', { changed: bot.id }); return { bot: publicBot(bot) };
  }
  function update(id, input) {
    const old = requireBot(id);
    if ([...active.values()].some(run => run.botId === id)) throw fault(409, 'Stop this bot’s active conversations before changing its profile.');
    const bot = { id, ...validate(input, old), createdAt: old.createdAt, updatedAt: now() };
    if (executionKey(bot.execution) !== executionKey(old.execution) || bot.computerMode !== old.computerMode) {
      computer.checkRemove(old);
      if (hasOwnedComputer(id)) throw fault(409, 'Stop this bot’s isolated computer before changing its execution computer or isolation mode.');
    }
    if (input.providerSettings?.clearKey === true) for (const snapshot of chatProfiles.values()) if (snapshot.id === id && snapshot.providerSettings) delete snapshot.providerSettings.apiKey;
    profiles.set(id, bot); save(); notify('bots', { changed: id }); return { bot: publicBot(bot) };
  }
  function remove(id) {
    const bot = requireBot(id);
    if ([...active.values()].some(run => run.botId === id)) throw fault(409, 'Stop this bot’s active conversations before removing its profile.');
    computer.checkRemove(bot);
    if (hasOwnedComputer(id)) throw fault(409, 'Stop this bot’s isolated computer from its Computer view before removing the profile. Its files and history will be retained.');
    work.removed?.(id); profiles.delete(id); save(); notify('bots', { deleted: id }); return { deleted: id };
  }
  async function pause(id, input) {
    const old = requireBot(id);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.paused !== 'boolean') throw fault(400, 'Choose whether to pause this bot.');
    // Revoke new turns first, including sends to chats that retain an older profile.
    profiles.set(id, { ...old, paused: input.paused, updatedAt: now() }); save(); notify('bots', { changed: id });
    if (input.paused) {
      const results = await Promise.allSettled([...active.entries()].filter(([, run]) => run.botId === id).map(([chatId]) => stop(chatId)));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
    return { bot: publicBot(requireBot(id)) };
  }
  async function list() {
    const providers = (await runtime.providers()).map(provider => ({ ...provider, available: provider.available ?? provider.ready ?? false,
      detail: provider.detail ?? [provider.transport, provider.version, provider.auth?.help].filter(Boolean).join(' · ') }));
    providers.push({ id: 'configured', name: 'Configured Models', available: modelRows().length > 0, detail: 'Choose a saved model API or a currently serving local model from Models.' });
    const computers = computerRows();
    return { bots: [...profiles.values()].map(bot => {
      const provider = providers.find(p => p.id === bot.provider), computer = computers.find(c => c.id === executionKey(bot.execution));
      const ownKey = bot.provider === 'ollama' && !!bot.providerSettings?.apiKey;
      const configured = bot.provider === 'configured' && modelRows().some(row => row.connectionId === bot.modelSource?.connectionId && row.model === bot.modelSource?.model);
      const remoteProvider = computer?.providers?.find(p => p.id === bot.provider);
      const available = bot.execution.kind === 'local' ? (bot.provider === 'configured' ? configured : !!provider?.available || ownKey) : bot.execution.kind === 'ssh' && computer?.available === true && (configured || !!(remoteProvider?.available ?? remoteProvider?.ready));
      return { ...publicBot(bot), available,
        detail: bot.execution.kind !== 'local' ? computer?.detail ?? 'Prepare this execution computer first.' : configured ? bot.modelLabel : ownKey ? 'Ollama Cloud API key configured. Model access is checked when a turn runs.' : provider?.detail ?? 'Provider setup is required.' };
    }), providers, computers, models: modelRows() };
  }
  function validateSelection(selection) {
    if (!selection?.botId) return;
    const current = requireBot(selection.botId), bot = chatProfiles.get(selection.chatId) ?? current;
    if (current.paused) throw fault(409, 'This bot is paused. Resume it before starting another turn.');
    computer.checkRun(bot);
    if (bot.computerMode === 'cua' && uncertainTargets.has(cuaResource(bot))) throw fault(409, 'CUA command cleanup is unconfirmed. Stop this isolated computer from its Computer view before continuing.');
    if (uncertainTargets.has(executionKey(bot.execution))) throw fault(409, uncertainTargets.get(executionKey(bot.execution)));
    if (bot.execution.kind === 'sandbox') throw fault(409, 'This bot’s sandbox execution adapter is not configured.');
    if (bot.execution.kind === 'ssh' && !remoteSSH) throw fault(409, 'This bot’s SSH execution adapter is not configured.');
    if (bot.provider === 'configured') {
      let selected; try { selected = modelProviders.resolve({ connectionId: bot.modelSource?.connectionId, modelId: bot.modelSource?.model }); } catch { throw fault(409, 'This bot’s configured model is no longer available. Choose a model and start a new chat.'); }
      if (bot.modelDestination && bot.modelDestination !== botModelDestination(selected.connection)) throw fault(409, 'This model connection changed its address. Edit the bot and start a new chat.');
    }
  }
  function createConversation(id, selection = {}) {
    const current = requireBot(id);
    if (current.paused) throw fault(409, 'This bot is paused. Resume it before starting a new chat.');
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['computerId', 'modelId', 'execution', 'workspace'].includes(key)) || selection.computerId && selection.execution) throw fault(400, 'Choose a computer, model and workspace for the new bot chat.');
    const patch = {};
    if (selection.computerId !== undefined) {
      const computer = computerRows().find(c => c.id === selection.computerId);
      if (!computer) throw fault(404, 'This execution computer is no longer configured.');
      patch.execution = computer.execution;
    } else if (selection.execution !== undefined) patch.execution = selection.execution;
    if (selection.workspace !== undefined) patch.workspace = selection.workspace;
    if (selection.modelId !== undefined) {
      const model = modelRows().find(m => m.id === selection.modelId);
      if (!model) throw fault(404, 'This configured model is no longer available.');
      patch.provider = 'configured'; patch.modelSource = { connectionId: model.connectionId, model: model.model };
    }
    const bot = { ...current, ...validate(patch, current) };
    if (uncertainTargets.has(executionKey(bot.execution))) throw fault(409, uncertainTargets.get(executionKey(bot.execution)));
    if (bot.execution.kind === 'sandbox' || bot.execution.kind === 'ssh' && !remoteSSH) throw fault(409, 'This execution adapter is not configured.');
    const result = conversations().createForBot({ ...bot, computerLabel: executionLabel(bot.execution), modelLabel: bot.modelLabel || `${bot.provider} · ${bot.model || 'Provider default'}` });
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
    if (run.cleanupFailure) throw run.cleanupFailure;
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
    const target = executionKey(bot.execution);
    if (bot.execution.kind === 'ssh' && bot.capabilities !== 'code' && computerLeases.has(target)) throw fault(409, 'Another bot conversation is using this computer. Wait for it to finish.');
    const owner = { botId: bot.id, target, controller, pending: new Map(), ended: new Promise(resolve => { ended = resolve; }) };
    active.set(session.id, owner);
    if (bot.execution.kind === 'ssh' && bot.capabilities !== 'code') computerLeases.set(target, session.id);
    let terminal = null;
    const emit = frame => {
      if (active.get(session.id) !== owner) return;
      if (frame.type === 'done' || frame.type === 'error') { terminal = frame; return; }
      if (bot.computerMode === 'cua' && frame.type === 'agent-tool' && frame.tool?.state === 'running') markOwned(bot);
      work.record(bot.id, frame);
      onFrame(frame);
    };
    const fingerprint = createHash('sha256').update(JSON.stringify([bot.id, bot.provider, bot.model, bot.workspace, bot.instructions, bot.policy, bot.capabilities, bot.providerSettings?.baseURL, bot.execution, bot.modelSource, bot.modelDestination, bot.computerMode])).digest('hex');
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
      await runtime.run({ bot: { ...bot, instructions: [bot.instructions, work.instructions(bot.id)].filter(Boolean).join('\n\n') }, sessionId: session.id, message, history: session.messages, signal: combined, onFrame: emit, requestPermission,
        modelRequest: (payload, botOrSignal, signal) => {
          const transportSignal = signal ?? (botOrSignal && typeof botOrSignal.addEventListener === 'function' && typeof botOrSignal.aborted === 'boolean' ? botOrSignal : null);
          if (active.get(session.id) !== owner || combined.aborted || bot.provider !== 'configured') throw fault(409, 'This bot turn has ended or has no configured model.');
          if (typeof modelRequest !== 'function') throw fault(503, 'Configured model inference is unavailable.');
          return modelRequest({ ...payload, tools: tools.definitions(bot).filter(tool => Array.isArray(payload?.tools) && payload.tools.some(requested => requested?.name === tool.name)), system: [bot.instructions, work.instructions(bot.id)].filter(Boolean).join('\n\n') || 'You are a Strata bot. Use the provided tools for coding and computer tasks.' }, bot, transportSignal ? AbortSignal.any([combined, transportSignal]) : combined, emit);
        },
        tools: tools.definitions(bot), executeTool: (name, args, toolCallId) => {
          if (active.get(session.id) !== owner || combined.aborted) throw fault(409, 'This bot turn has ended.');
          return tools.execute({ bot, chatId: session.id, name, args, toolCallId, signal: combined, onFrame: emit, requestPermission });
        },
        checkpoint: oldCheckpoint?.fingerprint === fingerprint ? oldCheckpoint.value : null,
        onCheckpoint: value => { if (active.get(session.id) === owner) { checkpoints.set(session.id, { fingerprint, value }); save(); } } });
    } catch (failure) {
      if (failure.code === 'ssh_cleanup_unconfirmed' || failure.cleanupUnconfirmed) { uncertainTargets.set(failure.code === 'cua_cleanup_unconfirmed' || failure.cleanupUnconfirmed && failure.code !== 'ssh_cleanup_unconfirmed' ? cuaResource(bot) : target, 'Remote cleanup could not be confirmed. Use Check SSH computer on the Mac before starting another turn.'); save(); owner.cleanupFailure = failure; terminal = { type: 'error', message: failure.message }; throw failure; }
      if (combined.aborted) terminal = { type: 'done', cancelled: true };
      else throw failure;
    } finally {
      controller.abort(); // Revoke tool authority before awaiting asynchronous cleanup.
      for (const request of [...owner.pending.values()]) request.resolve(false);
      try { await tools.finish?.(session.id); }
      catch (failure) { owner.cleanupFailure = Object.assign(failure, { status: 503 }); uncertainTargets.set(bot.computerMode === 'cua' ? cuaResource(bot) : target, 'Bot cleanup could not be confirmed. Check this computer on the Mac before continuing.'); save(); terminal = { type: 'error', message: failure.message }; }
      if (active.get(session.id) === owner) active.delete(session.id);
      if (computerLeases.get(target) === session.id) computerLeases.delete(target);
      if (terminal) onFrame(terminal);
      ended();
    }
  }
  return { list, create, update, remove, pause, createConversation, computer, work, prepareCUA, checkComputer: (input, options) => computerAction(input, false, options), prepareComputer: (input, options) => computerAction(input, true, options), validateSelection, run, pending, approve, stop,
    hasProfiles: () => profiles.size > 0, isBotConversation: id => !!owned(id), workspace: id => chatProfiles.get(id)?.execution?.kind === 'local' ? chatProfiles.get(id).workspace : null, isRemoteConversation: id => !!chatProfiles.get(id) && (chatProfiles.get(id).execution?.kind !== 'local' || chatProfiles.get(id).computerMode === 'cua'), activeCount: () => active.size,
    async close() { work.close(); await computer.close(); for (const run of active.values()) run.controller.abort(); await Promise.allSettled([...active.values()].map(run => run.ended)); await tools.close?.(); await runtime.close?.(); } };
}

export function createBotRoutes({ bots, port }) {
  return async (req, res, url) => {
    res.removeHeader('access-control-allow-origin'); res.setHeader('cache-control', 'no-store');
    if (!isLocalCompanionRequest(req, typeof port === 'function' ? port() : port)) return error(res, 403, 'Open Bots in Strata on this computer.');
    try {
      if (url.pathname === '/api/bots' && req.method === 'GET') return json(res, 200, await bots.list());
      if (url.pathname === '/api/bots' && req.method === 'POST') return json(res, 201, bots.create(await readBody(req)));
      if (/^\/api\/bots\/computers\/(check|prepare|prepare-cua)$/.test(url.pathname) && req.method === 'POST') {
        const body = await readBody(req), controller = new AbortController();
        const abort = () => controller.abort(); res.once('close', abort);
        try { const operation = url.pathname.endsWith('/prepare-cua') ? bots.prepareCUA : url.pathname.endsWith('/prepare') ? bots.prepareComputer : bots.checkComputer; return json(res, 200, await operation(body, { signal: controller.signal })); }
        finally { res.off('close', abort); }
      }
      const workRoute = /^\/api\/bots\/(bot_[a-f0-9-]+)\/(work(?:\/(file))?|routines(?:\/([A-Za-z0-9-]{1,100})(?:\/(run))?)?)$/.exec(url.pathname);
      if (workRoute) {
        const id = workRoute[1];
        if (workRoute[2] === 'work' && req.method === 'GET') return json(res, 200, bots.work.list(id));
        if (workRoute[2] === 'work' && req.method === 'PATCH') return json(res, 200, bots.work.update(id, await readBody(req)));
        if (workRoute[3] === 'file' && req.method === 'GET') return json(res, 200, bots.work.getFile(id, url.searchParams.get('path')));
        if (workRoute[3] === 'file' && req.method === 'PUT') return json(res, 200, bots.work.putFile(id, await readBody(req)));
        if (workRoute[2] === 'routines' && req.method === 'POST') return json(res, 201, bots.work.putRoutine(id, await readBody(req)));
        if (workRoute[4] && !workRoute[5] && req.method === 'PATCH') return json(res, 200, bots.work.putRoutine(id, await readBody(req), workRoute[4]));
        if (workRoute[4] && !workRoute[5] && req.method === 'DELETE') return json(res, 200, bots.work.removeRoutine(id, workRoute[4]));
        if (workRoute[5] && req.method === 'POST') return json(res, 200, bots.work.runRoutine(id, workRoute[4]));
        return error(res, 405, 'This bot work action is unavailable.');
      }
      const control = /^\/api\/bots\/(bot_[a-f0-9-]+)\/computer(?:\/(prepare|start|stop|takeover|control|release))?$/.exec(url.pathname);
      if (control) {
        if (req.method !== (control[2] ? 'POST' : 'GET')) return error(res, 405, 'This computer action is unavailable.');
        const input = control[2] ? await readBody(req) : { ...(url.searchParams.has('chatId') ? { chatId: url.searchParams.get('chatId') } : {}) };
        const allowed = control[2] === 'control' ? ['chatId','leaseToken','action','x','y','text','key'] : control[2] === 'release' ? ['chatId','leaseToken'] : ['chatId'];
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw fault(400, 'Choose a supported computer action.');
        const device = req.headers['x-strata-companion-device'];
        if (device && (typeof device !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(device))) throw fault(403, 'Invalid paired-device control owner.');
        const controller = new AbortController(), abort = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', abort);
        const options = { owner: device ? `phone:${device}` : 'mac', signal: controller.signal };
        try { const method = control[2] ?? 'state'; return json(res, 200, await (['control','release'].includes(method) ? bots.computer[method](control[1], input, options) : bots.computer[method](control[1], { ...input, ...options }))); }
        finally { res.off('close', abort); }
      }
      const match = /^\/api\/bots\/(bot_[a-f0-9-]+)(?:\/(conversations|pause))?$/.exec(url.pathname);
      if (!match) return error(res, 404, 'Unknown bot action.');
      if (!match[2] && req.method === 'PATCH') return json(res, 200, bots.update(match[1], await readBody(req)));
      if (!match[2] && req.method === 'DELETE') return json(res, 200, bots.remove(match[1]));
      if (match[2] === 'conversations' && req.method === 'POST') return json(res, 201, bots.createConversation(match[1], await readBody(req)));
      if (match[2] === 'pause' && req.method === 'POST') return json(res, 200, await bots.pause(match[1], await readBody(req)));
      return error(res, 405, 'This bot action is unavailable.');
    } catch (failure) { return error(res, failure.status ?? 500, failure.message ?? 'The bot request failed.'); }
  };
}
