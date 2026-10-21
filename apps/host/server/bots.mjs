/** Bot profiles and run ownership. Model serving connections are deliberately independent. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, posix } from 'node:path';
import { json, error, readBody } from './util.mjs';
import { isLocalCompanionRequest } from './companion-routes.mjs';
import { botModelDestination } from './bots-models.mjs';
import { createBotComputers } from './bots-computers.mjs';
import { createBotWork } from './bots-work.mjs';
import { createBotTeams } from './bots-team.mjs';
import { botSupervisionSnapshot } from './bots-supervision.mjs';
import { createBotHostFolderTools, botHostFolderAuthority } from './bots-host-folder.mjs';

const fault = (status, message) => Object.assign(new Error(message), { status });
const ids = new Set(['claude', 'codex', 'grok', 'kimi', 'ollama', 'devin', 'configured']);
export const BOT_AVATARS = ['🤖', '🧑‍💻', '🦊', '🧠', '🚀', '🛠️', '🌿', '✨'];
export const BOT_AVATAR_SHAPES = Object.freeze(['orb', 'pebble', 'tile', 'diamond', 'spark', 'hexagon']);
export function normalizeBotAvatar(value, previous) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['kind', 'color', 'eyes', 'ears', 'shape'].includes(key))
    || !['cloud', 'violet', 'orange', 'sky', 'graphite', 'slate'].includes(value.color) || !['star', 'round', 'happy', 'calm', 'plus', 'delight'].includes(value.eyes) || !['scalloped', 'round', 'small'].includes(value.ears)
    || Object.hasOwn(value, 'kind') && !['koala', 'fox', 'cat', 'robot'].includes(value.kind)
    || Object.hasOwn(value, 'shape') && ![...BOT_AVATAR_SHAPES, 'classic'].includes(value.shape)
    || BOT_AVATAR_SHAPES.includes(value.shape) && value.kind !== undefined && value.kind !== 'koala') throw fault(400, 'Choose a valid bot character, color, eyes and ears.');
  const result = structuredClone(value);
  // Old paired clients cannot encode shape. Preserve it for edits to the same
  // fallback character; new clients explicitly choose classic to clear it.
  if (!Object.hasOwn(value, 'shape') && (value.kind ?? 'koala') === 'koala' && (previous?.kind ?? 'koala') === 'koala' && BOT_AVATAR_SHAPES.includes(previous?.shape)) result.shape = previous.shape;
  if (result.shape === 'classic') delete result.shape;
  return result;
}
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
const guestWorkspace = raw => { if (typeof raw !== 'string' || raw.length > 4000 || raw.includes('\0') || !raw.startsWith('/workspace') || (raw !== '/workspace' && !raw.startsWith('/workspace/')) || raw.split('/').some(part => part === '..' || part === '.') || posix.normalize(raw) !== raw) throw fault(400, 'Use /workspace or a contained subfolder inside the isolated CUA computer.'); return raw; };
const cuaResource = bot => `cua:${bot.computerOwnerId ?? bot.id}:${executionKey(bot.execution)}`;
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

export function createBots({ directory, runtime, tools, conversations = () => null, defaultWorkspace = () => homedir(), notify = () => {}, now = () => new Date().toISOString(), remoteSSH, modelProviders, modelRequest, cuaTools, skills, mcp, python = 'python3' }) {
  const file = join(directory, 'bots.json'), profiles = new Map(), checkpoints = new Map(), chatProfiles = new Map(), active = new Map(), targets = new Map(), uncertainTargets = new Map(), ownedComputers = new Set();
  const owned = id => conversations()?.botId(id) ?? null;
  const folderKeys = ['hostFolder', 'hostFolderBinding', 'hostFolderRevision', 'hostFolderOwnerId', 'hostFolderRemoteIdentity'];
  const folderSnapshot = bot => Object.fromEntries(folderKeys.filter(key => Object.hasOwn(bot, key)).map(key => [key, copy(bot[key])]));
  const hostFolders = createBotHostFolderTools({ python, remoteSSH, currentGrant: snapshot => {
    const owner = profiles.get(snapshot.hostFolderOwnerId ?? snapshot.computerOwnerId ?? snapshot.id);
    return owner?.computerMode === 'cua' ? botHostFolderAuthority(owner) : null;
  } });
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
  function teamComputerRows() {
    const rows = computerRows().map(row => ({ id: `host:${row.id}`, name: row.name, label: row.kind === 'local' ? 'Direct access to this Mac' : 'Direct access to the saved SSH computer', computerMode: 'host', workspace: row.kind === 'local' ? defaultWorkspace() : '', available: true, detail: row.kind === 'local' ? 'Uses this Mac’s folders directly.' : 'Uses folders on this SSH computer. Preparation is checked when work starts.' }));
    for (const bot of profiles.values()) if (bot.computerMode === 'cua' && ['local', 'ssh'].includes(bot.execution.kind)) rows.push({ id: `cua:${bot.id}`, memberId: bot.id, name: `${bot.name}’s computer`, label: `${executionLabel(bot.execution)} · Isolated CUA desktop`, computerMode: 'cua', workspace: bot.workspace || '/workspace', available: true, detail: 'All team members use this exact isolated guest. Mac folders are not mounted into it.' });
    return rows;
  }
  function resolveTeamExecution(selection, members) {
    if (typeof selection.computerId !== 'string' || selection.computerId.length > 160 || typeof selection.workspace !== 'string') throw fault(400, 'Choose a shared team computer and its working folder.');
    let execution, computerMode, computerOwnerId;
    if (selection.computerId.startsWith('host:')) {
      const row = computerRows().find(row => `host:${row.id}` === selection.computerId);
      if (!row) throw fault(409, 'This saved team computer is unavailable. Choose another computer.');
      execution = row.execution; computerMode = 'host';
    } else if (selection.computerId.startsWith('cua:')) {
      computerOwnerId = selection.computerId.slice(4);
      if (!members.includes(computerOwnerId)) throw fault(400, 'Keep the shared isolated computer’s owner in this team, or choose another computer.');
      const anchor = requireBot(computerOwnerId);
      if (anchor.computerMode !== 'cua') throw fault(409, 'This team’s isolated computer changed. Choose its computer again.');
      execution = anchor.execution; computerMode = 'cua';
    } else throw fault(400, 'Choose a saved team computer.');
    const raw = cleanText(selection.workspace, 4000, 'team working folder', true);
    const workspace = computerMode === 'cua' ? guestWorkspace(raw) : execution.kind === 'local' ? resolve(raw.replace(/^~(?=\/|$)/, homedir())) : raw;
    if (!isAbsolute(computerMode === 'cua' ? workspace : execution.kind === 'local' ? raw.replace(/^~(?=\/|$)/, homedir()) : raw)) throw fault(400, 'Enter the full working-folder path on the selected team computer.');
    if (execution.kind === 'local' && computerMode === 'host') { try { if (!statSync(workspace).isDirectory()) throw new Error(); } catch { throw fault(400, 'Choose an existing working folder on this Mac.'); } }
    return { execution: copy(execution), computerMode, workspace, sharedComputer: true, ...(computerOwnerId ? { computerOwnerId, ...folderSnapshot(requireBot(computerOwnerId)) } : {}) };
  }
  function resourceBusy(bot, chatId) {
    // An isolated guest has one shared desktop and must be reserved for the
    // turn. Host code, files and separate browsers do not own the host desktop;
    // native computer tools acquire that narrower lease only when used.
    if (bot.computerMode !== 'cua') return false;
    const resource = cuaResource(bot);
    if ([...active.entries()].some(([id, run]) => id !== chatId && !run.conversationOnly && run.resource === resource)) return true;
    // send() reserves a conversation before its provider microtask begins. Include
    // that durable turn reservation so one scheduler tick cannot dispatch two
    // members into the same guest and turn the second assignment into an error.
    return [...chatProfiles.entries()].some(([id, other]) => id !== chatId && other.computerMode === 'cua' && conversations()?.isRunning?.(id) && !['routing', 'conversation', 'bid'].includes(other.teamContext?.channelMode) && cuaResource(other) === resource);
  }
  function chatBusy(id) {
    const bot = chatProfiles.get(id); if (!bot || ['routing', 'conversation', 'bid'].includes(bot.teamContext?.channelMode)) return false;
    if (resourceBusy(bot, id)) return true;
    try { computer.checkRun(bot); } catch (error) { if (error.status === 409) return true; throw error; }
    return false;
  }
  async function computerAction(input, prepare = false, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['execution', 'computerId'].includes(key))) throw fault(400, 'Choose a saved or custom SSH computer.');
    const execution = input.computerId ? computerRows().find(c => c.id === input.computerId)?.execution : normalizeBotExecution(input.execution);
    if (!execution) throw fault(404, 'This execution computer is no longer configured.');
    if (execution.kind === 'local') {
      hostFolders.recover(execution, { available: true, prepared: true });
      if (uncertainTargets.has('local')) throw fault(503, 'Local tool cleanup remains unconfirmed. Inspect the failed conversation and its owned processes before starting more work; checking provider availability cannot clear it.');
      return { available: true, prepared: true, detail: 'This Mac is ready.', providers: await runtime.providers() };
    }
    if (execution.kind !== 'ssh' || !remoteSSH) throw fault(409, 'This execution adapter is unavailable.');
    const id = executionKey(execution);
    if (prepare && [...active.values()].some(run => run.target === id)) throw fault(409, 'Wait for work on this computer to finish before preparing its worker.');
    const status = await (prepare ? remoteSSH.prepare(execution, options) : remoteSSH.probe(execution, options));
    if (status.available === true && status.prepared === true && status.activeRuns === 0) { hostFolders.recover(execution, status); uncertainTargets.delete(id); }
    targets.set(id, { execution, status }); save(); notify('bots', { computer: id });
    return status;
  }
  const work = createBotWork({ directory, requireBot, chats: conversations, createConversation, notify });
  const team = createBotTeams({ directory, requireBot, conversations, createConversation: (id, teamContext) => createConversation(id, {}, teamContext), discardConversation: id => { conversations().remove(id); chatProfiles.delete(id); checkpoints.delete(id); save(); }, notify,
    usesComputer: (source, target) => { const bot = typeof source === 'string' ? chatProfiles.get(source) : source; return bot?.computerMode === 'cua' && cuaResource(bot) === cuaResource(target); }, teamComputers: teamComputerRows, resolveExecution: resolveTeamExecution, isChatBusy: chatBusy, isBotBusy: id => [...active.values()].some(run => run.botId === id), stopDirect: id => stop(id, { team: false }) });
  const hasOwnedComputer = id => [...ownedComputers, ...uncertainTargets.keys()].some(key => key.startsWith(`cua:${id}:`));
  const markOwned = bot => { ownedComputers.add(cuaResource(bot)); save(); };
  const computer = createBotComputers({ cua: cuaTools, remoteSSH, profile: (id, chatId) => { const bot = requireBot(id); if (!chatId) return copy(bot); const snapshot = chatProfiles.get(chatId); if (!snapshot || snapshot.id !== id) throw fault(404, 'This computer does not belong to that conversation.'); return copy(snapshot); },
    busy: bot => [...active.values()].some(run => run.resource === cuaResource(bot) && !run.conversationOnly),
    prepareOwned: (bot, options) => prepareCUA({ execution: bot.execution }, options),
    checkClean: bot => { if (uncertainTargets.has(cuaResource(bot))) throw fault(409, 'CUA cleanup is unconfirmed. Stop this isolated computer from its Computer view before continuing.'); if (uncertainTargets.has(executionKey(bot.execution))) throw fault(409, uncertainTargets.get(executionKey(bot.execution))); },
    markOwned,
    clearUncertain: bot => { uncertainTargets.delete(cuaResource(bot)); ownedComputers.delete(cuaResource(bot)); save(); },
    markUncertain: bot => { uncertainTargets.set(cuaResource(bot), 'CUA cleanup could not be confirmed. Stop this isolated computer from its Computer view before continuing.'); save(); },
    stopOwned: async bot => { await team.stopForComputer(bot); for (const [chatId, run] of [...active.entries()]) if (run.resource === cuaResource(bot) && !run.conversationOnly) await stop(chatId); if (uncertainTargets.has(executionKey(bot.execution))) throw fault(409, 'Remote cleanup is unconfirmed. Check this computer on the Mac before taking over.'); } });
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
    const { providerSettings, modelDestination, extensionSnapshots, computerOwnerId, sharedComputer, hostFolderBinding, hostFolderRevision, hostFolderOwnerId, hostFolderRemoteIdentity, ...safe } = copy(bot);
    return { ...safe, avatar: BOT_AVATARS.includes(bot.avatar) ? bot.avatar : '🤖', ...(providerSettings ? { providerSettings: { ...(providerSettings.baseURL ? { baseURL: providerSettings.baseURL } : {}), apiKeySet: !!providerSettings.apiKey } } : {}),
      conversations: (conversations()?.list().conversations ?? []).filter(chat => chat.preferences?.botId === bot.id).map(chat => chat.id),
      active: [...active.values()].some(run => run.botId === bot.id) };
  }
  function validate(input, old = {}) {
    if (folderKeys.some(key => Object.hasOwn(input, key))) throw fault(400, 'Use Shared host folder settings to grant or remove folder access.');
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
    if (computerMode === 'cua') guestWorkspace(rawWorkspace);
    if (!isAbsolute(execution.kind === 'local' ? rawWorkspace.replace(/^~(?=\/|$)/, homedir()) : rawWorkspace)) throw fault(400, 'Choose the full path to the bot’s workspace on its execution computer.');
    if (execution.kind === 'local' && computerMode !== 'cua') {
      try { if (!statSync(workspace).isDirectory()) throw new Error(); }
      catch { throw fault(400, 'Choose an existing workspace folder on this computer.'); }
    }
    const suppliedAvatar = input.avatarConfig ?? old.avatarConfig;
    const avatarConfig = suppliedAvatar === undefined ? undefined : normalizeBotAvatar(suppliedAvatar, old.avatarConfig);
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
    const effort = input.effort ?? (provider === old.provider ? old.effort : '') ?? '';
    if (typeof effort !== 'string' || effort && !/^[a-z][a-z0-9_-]{0,31}$/.test(effort)) throw fault(400, 'Choose an effort supported by this model.');
    if (input.providerSettings !== undefined) {
      const settings = input.providerSettings;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw fault(400, 'Provider settings are invalid.');
      if (settings.baseURL !== undefined) providerSettings.baseURL = endpoint(settings.baseURL);
      if (settings.clearKey === true) delete providerSettings.apiKey;
      if (settings.apiKey !== undefined && settings.apiKey !== '') providerSettings.apiKey = cleanText(settings.apiKey, 8192, 'provider API key', true);
    }
    return { name, avatar, ...(avatarConfig ? { avatarConfig: copy(avatarConfig) } : {}), paused: old.paused === true, computerMode, provider, capabilities, policy, execution, workspace, ...(computerMode === 'cua' && executionKey(execution) === executionKey(old.execution) ? folderSnapshot(old) : {}), ...(modelSource ? { modelSource, modelDestination, modelLabel } : {}),
      instructions: cleanText(input.instructions ?? old.instructions ?? '', 32000, 'bot instructions'),
      model: modelSource?.model ?? cleanText(input.model ?? old.model ?? '', 250, 'model name'), effort, ...(Object.keys(providerSettings).length ? { providerSettings } : {}) };
  }
  function create(input) {
    const at = now(), bot = { id: `bot_${randomUUID()}`, ...validate(input), createdAt: at, updatedAt: at };
    profiles.set(bot.id, bot); save(); notify('bots', { changed: bot.id }); return { bot: publicBot(bot) };
  }
  function nextUpdatedAt(old) {
    const value = now();
    return Date.parse(value) <= Date.parse(old.updatedAt) ? new Date(Date.parse(old.updatedAt) + 1).toISOString() : value;
  }
  async function setHostFolder(id, input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'hostFolder') || input.hostFolder === undefined || !Object.hasOwn(input, 'expectedUpdatedAt')) throw fault(400, 'Choose a folder and refresh the bot before saving.');
    const old = requireBot(id);
    const check = () => {
      if (requireBot(id) !== old || input.expectedUpdatedAt !== old.updatedAt) throw fault(409, 'This bot changed. Refresh its settings before saving.');
      if (old.computerMode !== 'cua') throw fault(409, 'Choose an isolated bot before sharing a host folder.');
      if (input.hostFolder !== null && (team.botInActiveRun(id) || [...chatProfiles].some(([chatId, bot]) => (bot.hostFolderOwnerId ?? bot.computerOwnerId ?? bot.id) === id && (active.has(chatId) || conversations()?.isRunning?.(chatId))))) throw fault(409, 'Finish this computer’s bot and team work before changing its folder grant. Removing access remains available.');
      options.signal?.throwIfAborted();
    };
    check();
    const validated = await hostFolders.validate(input.hostFolder, { execution: old.execution, ...(old.hostFolderRemoteIdentity ? { expectedIdentity: old.hostFolderRemoteIdentity } : {}), signal: options.signal });
    check();
    const bot = { ...old, hostFolderRevision: randomUUID(), updatedAt: nextUpdatedAt(old) };
    for (const key of folderKeys.filter(key => key !== 'hostFolderRevision')) delete bot[key];
    if (validated) Object.assign(bot, { hostFolder: { path: validated.path, access: validated.access }, hostFolderBinding: validated.binding, hostFolderOwnerId: id, ...(validated.remoteIdentity ? { hostFolderRemoteIdentity: validated.remoteIdentity } : {}) });
    profiles.set(id, bot);
    try { save(); } catch (error) { profiles.set(id, old); throw error; }
    try { await hostFolders.revoke(id); }
    catch (failure) { uncertainTargets.set(executionKey(old.execution), 'Host folder cleanup could not be confirmed. Check this execution computer before starting new work.'); save(); throw failure; }
    notify('bots', { changed: id });
    return { ...await list(), bot: publicBot(bot) };
  }
  function update(id, input) {
    const old = requireBot(id);
    if (team.botInActiveRun(id)) throw fault(409, 'Stop this bot’s team work before changing its profile.');
    if ([...active.values()].some(run => run.botId === id)) throw fault(409, 'Stop this bot’s active conversations before changing its profile.');
    const bot = { id, ...validate(input, old), createdAt: old.createdAt, updatedAt: nextUpdatedAt(old) };
    if (executionKey(bot.execution) !== executionKey(old.execution) || bot.computerMode !== old.computerMode) {
      computer.checkRemove(old);
      if (hasOwnedComputer(id)) throw fault(409, 'Stop this bot’s isolated computer before changing its execution computer or isolation mode.');
    }
    if (input.providerSettings?.clearKey === true) for (const snapshot of chatProfiles.values()) if (snapshot.id === id && snapshot.providerSettings) delete snapshot.providerSettings.apiKey;
    profiles.set(id, bot); save(); notify('bots', { changed: id }); return { bot: publicBot(bot) };
  }
  function remove(id) {
    const bot = requireBot(id);
    if (team.sharedAnchor(id)) throw fault(409, 'Choose another shared computer for this team before removing its computer owner.');
    if (team.botInActiveRun(id)) throw fault(409, 'Stop this bot’s team work before removing its profile.');
    if ([...active.values()].some(run => run.botId === id)) throw fault(409, 'Stop this bot’s active conversations before removing its profile.');
    computer.checkRemove(bot);
    if (hasOwnedComputer(id)) throw fault(409, 'Stop this bot’s isolated computer from its Computer view before removing the profile. Its files and history will be retained.');
    work.removed?.(id); profiles.delete(id); save(); notify('bots', { deleted: id }); return { deleted: id };
  }
  async function pause(id, input) {
    const old = requireBot(id);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.paused !== 'boolean') throw fault(400, 'Choose whether to pause this bot.');
    // Revoke new turns first, including sends to chats that retain an older profile.
    profiles.set(id, { ...old, paused: input.paused, updatedAt: nextUpdatedAt(old) }); save(); notify('bots', { changed: id });
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
    return { lifecycleSupported: true, hostFolderSupported: true, avatarShapes: [...BOT_AVATAR_SHAPES], defaultWorkspace: defaultWorkspace(), bots: [...profiles.values()].map(bot => {
      const provider = providers.find(p => p.id === bot.provider), computer = computers.find(c => c.id === executionKey(bot.execution));
      const ownKey = bot.provider === 'ollama' && !!bot.providerSettings?.apiKey;
      const configured = bot.provider === 'configured' && modelRows().some(row => row.connectionId === bot.modelSource?.connectionId && row.model === bot.modelSource?.model);
      const remoteProvider = computer?.providers?.find(p => p.id === bot.provider);
      const available = bot.execution.kind === 'local' ? (bot.provider === 'configured' ? configured : !!provider?.available || ownKey) : bot.execution.kind === 'ssh' && computer?.available === true && (configured || !!(remoteProvider?.available ?? remoteProvider?.ready));
      return { ...publicBot(bot), computerId: executionKey(bot.execution), available,
        detail: bot.execution.kind !== 'local' ? computer?.detail ?? 'Prepare this execution computer first.' : configured ? bot.modelLabel : ownKey ? 'Ollama Cloud API key configured. Model access is checked when a turn runs.' : provider?.detail ?? 'Provider setup is required.' };
    }), providers, computers, models: modelRows() };
  }
  // Paired clients can edit public profiles using saved inventory identities only.
  // This never prepares a worker, starts a computer, opens a chat or changes serving.
  async function saveProfile(input, id) {
    const keys = ['name', 'provider', 'model', 'modelId', 'computerId', 'workspace', 'instructions', 'capabilities', 'policy', 'computerMode', 'effort', 'avatar', 'avatarConfig', ...(id ? ['expectedUpdatedAt'] : [])];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw fault(400, 'Choose only the displayed bot settings.');
    for (const [key, value] of Object.entries(input)) if (value === null || value === undefined) throw fault(400, 'Choose supported bot settings.');
    for (const key of ['name', 'model', 'workspace', 'instructions', 'effort']) if (Object.hasOwn(input, key) && typeof input[key] !== 'string') throw fault(400, 'Enter supported bot settings.');
    if (input.workspace !== undefined && (!input.workspace.startsWith('/') || /[\u0000-\u001f]/.test(input.workspace))) throw fault(400, 'Enter the full workspace folder path on the selected computer.');
    const old = id ? requireBot(id) : null;
    const checkVersion = () => {
      if (id && (typeof input.expectedUpdatedAt !== 'string' || input.expectedUpdatedAt !== requireBot(id).updatedAt)) throw fault(409, 'This bot changed. Refresh its settings before saving.');
    };
    checkVersion();
    if (!id && (!Object.hasOwn(input, 'name') || !ids.has(input.provider) || typeof input.computerId !== 'string')) throw fault(400, 'Choose a name, provider and saved execution computer.');
    if (input.computerId !== undefined && (typeof input.computerId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(input.computerId))) throw fault(400, 'Choose a saved execution computer.');
    if (input.modelId !== undefined && (typeof input.modelId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(input.modelId))) throw fault(400, 'Choose a configured model.');
    const provider = input.provider ?? old?.provider;
    if (!ids.has(provider) || input.modelId !== undefined && provider !== 'configured') throw fault(400, 'Choose a configured model only with Configured Models.');
    const inventory = await list();
    checkVersion();
    const computerId = input.computerId ?? executionKey(old.execution);
    const computer = inventory.computers.find(row => row.id === computerId);
    if (!computer) throw fault(409, 'This execution computer is no longer configured.');
    const patch = Object.fromEntries(Object.entries(input).filter(([key]) => !['modelId', 'computerId', 'expectedUpdatedAt'].includes(key)));
    patch.execution = computer.execution;
    if (provider !== old?.provider && input.model === undefined) patch.model = '';
    if (provider === 'configured') {
      const model = input.modelId !== undefined ? inventory.models.find(row => row.id === input.modelId) : old?.provider === provider ? inventory.models.find(row => row.connectionId === old.modelSource?.connectionId && row.model === old.modelSource?.model) : null;
      if (!model || !model.available) throw fault(409, 'Choose an available model from your configured Models.');
      if (input.model !== undefined && input.model !== model.model) throw fault(400, 'Choose the saved model rather than a different model name.');
      patch.modelSource = { connectionId: model.connectionId, model: model.model };
      if (patch.effort) throw fault(400, 'Use Provider default effort for a configured model.');
    }
    // A saved profile may be prepared before its provider signs in or its saved
    // computer comes online. Availability is shown and checked when work starts.
    // update() checks active direct/team work again after all asynchronous reads.
    const result = id ? update(id, patch) : create(patch);
    return { ...await list(), bot: { ...result.bot, computerId } };
  }
  function validateSelection(selection) {
    if (!selection?.botId) return;
    const current = requireBot(selection.botId), bot = chatProfiles.get(selection.chatId) ?? current;
    if (current.paused) throw fault(409, 'This bot is paused. Resume it before starting another turn.');
    const conversationOnly = ['routing', 'conversation', 'bid'].includes(bot.teamContext?.channelMode);
    if (!conversationOnly) { computer.checkRun(bot); if (resourceBusy(bot, selection.chatId)) throw fault(409, 'Another teammate is using this shared computer. Wait for it to finish.'); }
    if (!conversationOnly && bot.computerMode === 'cua' && uncertainTargets.has(cuaResource(bot))) throw fault(409, 'CUA command cleanup is unconfirmed. Stop this isolated computer from its Computer view before continuing.');
    if (uncertainTargets.has(executionKey(bot.execution))) throw fault(409, uncertainTargets.get(executionKey(bot.execution)));
    if (bot.execution.kind === 'sandbox') throw fault(409, 'This bot’s sandbox execution adapter is not configured.');
    if (bot.execution.kind === 'ssh' && !remoteSSH) throw fault(409, 'This bot’s SSH execution adapter is not configured.');
    if (bot.provider === 'configured') {
      let selected; try { selected = modelProviders.resolve({ connectionId: bot.modelSource?.connectionId, modelId: bot.modelSource?.model }); } catch { throw fault(409, 'This bot’s configured model is no longer available. Choose a model and start a new chat.'); }
      if (bot.modelDestination && bot.modelDestination !== botModelDestination(selected.connection)) throw fault(409, 'This model connection changed its address. Edit the bot and start a new chat.');
    }
  }
  function createConversation(id, selection = {}, teamContext) {
    const current = requireBot(id);
    if (current.paused) throw fault(409, 'This bot is paused. Resume it before starting a new chat.');
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['computerId', 'modelId', 'execution', 'workspace', 'effort', 'policy'].includes(key)) || selection.computerId && selection.execution) throw fault(400, 'Choose a computer, model and workspace for the new bot chat.');
    const patch = {};
    if (selection.computerId !== undefined) {
      const computer = computerRows().find(c => c.id === selection.computerId);
      if (!computer) throw fault(404, 'This execution computer is no longer configured.');
      patch.execution = computer.execution;
    } else if (selection.execution !== undefined) patch.execution = selection.execution;
    if (selection.workspace !== undefined) patch.workspace = selection.workspace;
    if (selection.effort !== undefined) patch.effort = selection.effort;
    if (selection.policy !== undefined) {
      if (!['manual', 'plan', 'bypass'].includes(selection.policy)) throw fault(400, 'Choose Ask, Plan or Bypass approvals.');
      patch.policy = selection.policy;
    }
    if (selection.modelId !== undefined) {
      const model = modelRows().find(m => m.id === selection.modelId);
      if (!model) throw fault(404, 'This configured model is no longer available.');
      patch.provider = 'configured'; patch.modelSource = { connectionId: model.connectionId, model: model.model };
    }
    const shared = teamContext ? team.executionForRun(teamContext.teamRunId) : undefined;
    if (shared) Object.assign(patch, { execution: shared.execution, computerMode: shared.computerMode, workspace: shared.workspace });
    const bot = { id: current.id, createdAt: current.createdAt, updatedAt: current.updatedAt, ...validate(patch, current) };
    if (shared) { for (const key of folderKeys) delete bot[key]; Object.assign(bot, copy(shared)); }
    if (teamContext) bot.teamContext = copy(teamContext);
    // Extension assignments and selected instructions are immutable for this chat.
    // Secrets never belong in these snapshots or in the public conversation preferences.
    if (skills || mcp) bot.extensionSnapshots = { ...(skills ? { skills: copy(skills.snapshot(bot)) } : {}), ...(mcp ? { mcp: copy(mcp.snapshot(bot)) } : {}) };
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
  async function stop(chatId, options = {}) {
    if (options.team !== false) { const result = await team.stopForChat(chatId); if (result) { if (result.run.state === 'cleanup_pending') throw fault(503, result.run.detail); return { stopped: true }; } }
    const run = active.get(chatId);
    if (!run) {
      const results = await Promise.allSettled([skills, mcp, hostFolders].filter(Boolean).map(extension => Promise.resolve().then(() => extension.finish?.(chatId))));
      const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
      return { stopped: false, pending: false };
    }
    run.controller.abort();
    await run.ended;
    if (run.cleanupFailure) throw run.cleanupFailure;
    return { stopped: true };
  }
  async function run(input) {
    const admission = team.pendingStart(input.session.id);
    try { return await runOwned(input); }
    catch (error) {
      // A scheduler job can fail selection/resource checks before begin binds
      // its turn. Only the exact still-pending job may be settled here.
      try { team.rejectPendingStart(input.session.id, admission, error); } catch {}
      throw error;
    }
  }
  async function runOwned({ session, message, signal, onFrame }) {
    const current = requireBot(session.preferences?.botId);
    const bot = copy(chatProfiles.get(session.id) ?? current);
    validateSelection({ botId: bot.id, chatId: session.id });
    const roomMode = team.modeForChat(session.id, bot);
    // This internal frozen flag comes only from the team scheduler, never a profile/client patch.
    const conversationOnly = ['routing', 'conversation', 'bid'].includes(roomMode);
    if (conversationOnly) bot.teamConversationOnly = true;
    if (active.has(session.id)) throw fault(409, 'This bot conversation is already running.');
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let ended;
    const target = executionKey(bot.execution);
    if (!conversationOnly && resourceBusy(bot, session.id)) throw fault(409, 'Another teammate is using this shared computer. Wait for it to finish.');
    const owner = { botId: bot.id, target, resource: bot.computerMode === 'cua' ? cuaResource(bot) : `host:${target}`, sharedComputer: bot.sharedComputer === true, conversationOnly, controller, pending: new Map(), ended: new Promise(resolve => { ended = resolve; }) };
    active.set(session.id, owner);
    let terminal = null;
    const emit = frame => {
      if (active.get(session.id) !== owner) return;
      if (frame.type === 'done' || frame.type === 'error') { terminal = frame; return; }
      if (bot.computerMode === 'cua' && frame.type === 'agent-tool' && frame.tool?.state === 'running') markOwned(bot);
      work.record(bot.id, frame);
      onFrame(frame);
    };
    const fingerprint = createHash('sha256').update(JSON.stringify([bot.id, bot.provider, bot.model, bot.effort, bot.workspace, bot.instructions, bot.policy, bot.capabilities, bot.providerSettings?.baseURL, bot.execution, bot.modelSource, bot.modelDestination, bot.computerMode, bot.extensionSnapshots, folderSnapshot(bot), ...(bot.sharedComputer ? [{ computerOwnerId: bot.computerOwnerId, sharedComputer: true }] : [])])).digest('hex');
    const oldCheckpoint = checkpoints.get(session.id);
    const requestPolicyPermission = async ({ id, name, args = {}, reason = 'Allow this bot action?' }) => {
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
    const turnId = `turn_${randomUUID()}`;
    const assertLive = () => { combined.throwIfAborted(); if (active.get(session.id) !== owner || !team.isLive(turnId)) throw fault(409, 'This bot turn has ended.'); };
    const requestPermission = request => conversationOnly ? Promise.resolve(false) : requestPolicyPermission(request);
    const context = { bot, chatId: session.id, turnId, signal: combined, requestPermission, requestTeamPermission: requestPolicyPermission, roomMode, assertLive, onFrame: emit };
    const extensions = (conversationOnly ? [team] : [team, skills, mcp, hostFolders]).filter(Boolean);
    const localTools = conversationOnly ? [] : tools.definitions(bot);
    let hostTools;
    try {
      hostTools = extensions.flatMap(extension => extension.tools(bot, context));
      if (new Set(hostTools.map(tool => tool.name)).size !== hostTools.length || hostTools.some(tool => localTools.some(local => local.name === tool.name))) throw fault(503, 'Bot tool names overlap.');
    } catch (error) { controller.abort(); active.delete(session.id); ended(); throw error; }
    const hostNames = new Set(hostTools.map(tool => tool.name)), calls = new Map();
    const executeHostTool = (name, args = {}, toolCallId) => {
      assertLive();
      if (!hostNames.has(name)) throw fault(403, 'This host tool was not assigned to this bot turn.');
      const id = typeof toolCallId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(toolCallId) ? toolCallId : `ext_${randomUUID()}`;
      const digest = createHash('sha256').update(JSON.stringify([name, args])).digest('hex'), old = calls.get(id);
      if (old) { if (old.digest !== digest) throw fault(409, 'This tool identity already belongs to a different action.'); return old.promise; }
      const extension = extensions.find(value => value.owns(name));
      const promise = (async () => {
        emit({ type: 'agent-tool', tool: { id, name, args, state: 'running', preview: name, effect: 'Uses a Strata bot integration.', scope: 'connected' } });
        try {
          const result = await extension.execute(name, args, { ...context, toolCallId: id }); assertLive();
          const value = result?.content ? result : { content: [{ type: 'text', text: JSON.stringify(result) }] };
          emit({ type: 'agent-tool', tool: { id, name, args, state: value.isError ? 'error' : 'done', result: value.content.filter(part => part.type === 'text').map(part => part.text).join('\n') } });
          return value;
        } catch (error) { if (!combined.aborted) emit({ type: 'agent-tool', tool: { id, name, args, state: 'error', result: String(error.message).slice(0, 2000) } }); throw error; }
      })();
      calls.set(id, { digest, promise }); return promise;
    };
    let runFailure;
    try {
      team.begin(context);
      const folderInstructions = hostFolders.tools(bot).length ? `An explicit ${bot.hostFolder.access === 'read' ? 'read-only' : 'read/write'} host-folder share is available at ${JSON.stringify(bot.hostFolder.path)}. Use host_list_files, host_read_file${bot.hostFolder.access === 'read-write' && bot.policy !== 'plan' ? ' and host_write_file' : ''} with paths relative to that folder. Normal file, command and browser tools stay inside the isolated computer. This share is file access, not a mounted folder or host shell.` : '';
      const instructions = (conversationOnly ? [team.instructions(context)] : [bot.instructions, work.instructions(bot.id), bot.extensionSnapshots?.skills?.instructions, bot.extensionSnapshots?.mcp?.instructions, team.instructions(context), folderInstructions]).filter(Boolean).join('\n\n');
      const runtimeBot = { ...bot, instructions };
      if (conversationOnly) delete runtimeBot.extensionSnapshots;
      emit({ type: 'start', agent: true, model: bot.model || bot.provider });
      await runtime.run({ bot: runtimeBot, sessionId: session.id, message, history: session.messages, signal: combined, onFrame: emit, requestPermission, hostTools, executeHostTool,
        modelRequest: (payload, botOrSignal, signal) => {
          const transportSignal = signal ?? (botOrSignal && typeof botOrSignal.addEventListener === 'function' && typeof botOrSignal.aborted === 'boolean' ? botOrSignal : null);
          if (active.get(session.id) !== owner || combined.aborted || bot.provider !== 'configured') throw fault(409, 'This bot turn has ended or has no configured model.');
          if (typeof modelRequest !== 'function') throw fault(503, 'Configured model inference is unavailable.');
          return modelRequest({ ...payload, tools: [...localTools, ...hostTools].filter(tool => Array.isArray(payload?.tools) && payload.tools.some(requested => requested?.name === tool.name)), system: instructions || 'You are a Strata bot. Use the provided tools for coding and computer tasks.' }, bot, transportSignal ? AbortSignal.any([combined, transportSignal]) : combined, emit);
        },
        tools: [...localTools, ...hostTools], executeTool: (name, args, toolCallId) => {
          if (active.get(session.id) !== owner || combined.aborted) throw fault(409, 'This bot turn has ended.');
          if (hostNames.has(name)) return executeHostTool(name, args, toolCallId);
          if (conversationOnly) throw fault(403, 'This team conversation turn cannot execute computer, file, browser or external tools.');
          return tools.execute({ bot, chatId: session.id, name, args, toolCallId, signal: combined, onFrame: emit, requestPermission });
        },
        checkpoint: !conversationOnly && oldCheckpoint?.fingerprint === fingerprint ? oldCheckpoint.value : null,
        onCheckpoint: value => { if (!conversationOnly && active.get(session.id) === owner) { checkpoints.set(session.id, { fingerprint, value }); save(); } } });
    } catch (failure) {
      runFailure = failure;
      if (failure.code === 'ssh_cleanup_unconfirmed' || failure.cleanupUnconfirmed) { uncertainTargets.set(failure.code === 'cua_cleanup_unconfirmed' || failure.cleanupUnconfirmed && failure.code !== 'ssh_cleanup_unconfirmed' ? cuaResource(bot) : target, 'Remote cleanup could not be confirmed. Use Check SSH computer on the Mac before starting another turn.'); save(); owner.cleanupFailure = failure; terminal = { type: 'error', message: failure.message }; throw failure; }
      if (combined.aborted) terminal = { type: 'done', cancelled: true };
      else throw failure;
    } finally {
      const cancelledBeforeCleanup = combined.aborted;
      try {
        controller.abort(); // Revoke tool authority before awaiting every owned cleanup.
        for (const request of [...owner.pending.values()]) { try { request.resolve(false); } catch (failure) { owner.cleanupFailure ??= failure; } }
        const cleanups = [tools, ...extensions];
        const results = await Promise.allSettled(cleanups.map(extension => Promise.resolve().then(() => extension.finish?.(session.id))));
        for (const [index, result] of results.entries()) {
          if (result.status !== 'rejected') continue;
          const failure = result.reason;
          owner.cleanupFailure = Object.assign(failure, { status: 503 });
          const resource = index === 0 && bot.computerMode === 'cua' ? cuaResource(bot) : target;
          if (index === 0 || failure.code === 'ssh_cleanup_unconfirmed' || failure.cleanupUnconfirmed) {
            uncertainTargets.set(resource, 'Bot tool cleanup could not be confirmed. Check this execution computer before starting new work.');
            try { save(); } catch { owner.cleanupFailure = fault(503, 'Bot cleanup failed and its recovery state could not be saved. Inspect the failed conversation before continuing.'); }
          }
          terminal = { type: 'error', message: owner.cleanupFailure.message ?? 'External bot integration cleanup could not be confirmed.' };
        }
        if (active.get(session.id) === owner) active.delete(session.id);
        if (terminal) onFrame(terminal);
        team.end(context, { cancelled: cancelledBeforeCleanup, error: owner.cleanupFailure?.message ?? (runFailure && !cancelledBeforeCleanup ? runFailure.message : undefined), ...(typeof terminal?.publicReply === 'string' ? { publicReply: terminal.publicReply } : {}) });
      } finally { if (active.get(session.id) === owner) active.delete(session.id); ended(); }
    }
  }
  return { list, create, update, saveProfile, setHostFolder, remove, pause, createConversation, computer, work, team, hasBot: id => profiles.has(id), hasTeam: id => team.hasTeam(id), teamConnectorAccess: (teamId, botId, teamRunId) => team.connectorAccess(teamId, botId, teamRunId), providerModels: id => runtime.models?.(id) ?? Promise.resolve({ provider: id, models: [], detail: 'This provider has no verified effort catalog. Use Provider default.' }), prepareCUA, checkComputer: (input, options) => computerAction(input, false, options), prepareComputer: (input, options) => computerAction(input, true, options), validateSelection, run, pending, approve, stop,
    supervision: () => botSupervisionSnapshot({ bots: [...profiles.values()], conversations: conversations()?.supervisionSources?.() ?? [], pendingCount: id => active.get(id)?.pending.size ?? 0, now: Date.parse(now()) }),
    supervisionProfiles: () => [...profiles.values()].map(({ id, name, avatarConfig }) => ({ id, name, ...(avatarConfig ? { avatarConfig: copy(avatarConfig) } : {}) })),
    notificationApprovals: () => [...active].flatMap(([chatId, run]) => [...run.pending.keys()].map(id => ({ chatId, id, botId: run.botId }))),
    hasProfiles: () => profiles.size > 0, isBotConversation: id => !!owned(id), workspace: id => chatProfiles.get(id)?.execution?.kind === 'local' ? chatProfiles.get(id).workspace : null, isRemoteConversation: id => !!chatProfiles.get(id) && (chatProfiles.get(id).execution?.kind !== 'local' || chatProfiles.get(id).computerMode === 'cua'), activeCount: () => active.size + team.activeCount(),
    async close() {
      const failures = [];
      try { work.close(); } catch (failure) { failures.push(failure); }
      try { await team.close(); } catch (failure) { failures.push(failure); }
      try { await computer.close(); } catch (failure) { failures.push(failure); }
      for (const run of active.values()) run.controller.abort();
      await Promise.allSettled([...active.values()].map(run => run.ended));
      const results = await Promise.allSettled([hostFolders, tools, runtime].map(owner => Promise.resolve().then(() => owner.close?.())));
      failures.push(...results.filter(result => result.status === 'rejected').map(result => result.reason));
      if (failures.length) throw failures[0];
    } };
}

export function createBotRoutes({ bots, port }) {
  return async (req, res, url) => {
    res.removeHeader('access-control-allow-origin'); res.setHeader('cache-control', 'no-store');
    if (!isLocalCompanionRequest(req, typeof port === 'function' ? port() : port)) return error(res, 403, 'Open Bots in Strata on this computer.');
    try {
      if (url.pathname === '/api/bots' && req.method === 'GET') return json(res, 200, await bots.list());
      if (url.pathname === '/api/bots' && req.method === 'POST') return json(res, 201, bots.create(await readBody(req)));
      if (url.pathname === '/api/bots/profile' && req.method === 'POST') return json(res, 201, await bots.saveProfile(await readBody(req)));
      const folder = /^\/api\/bots\/(bot_[a-f0-9-]+)\/host-folder$/.exec(url.pathname);
      if (folder) {
        if (req.method !== 'PUT' || [...url.searchParams].length) throw fault(405, 'This folder action is unavailable.');
        const input = await readBody(req), controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', abort);
        try { return json(res, 200, await bots.setHostFolder(folder[1], input, { signal: controller.signal })); }
        finally { res.off('close', abort); }
      }
      const profile = /^\/api\/bots\/(bot_[a-f0-9-]+)\/profile$/.exec(url.pathname);
      if (profile && req.method === 'PATCH') return json(res, 200, await bots.saveProfile(await readBody(req), profile[1]));
      if (url.pathname === '/api/bots/provider-models' && req.method === 'GET') return json(res, 200, await bots.providerModels(url.searchParams.get('provider')));
      if (url.pathname === '/api/bots/activity' && req.method === 'GET') return json(res, 200, bots.team.activity());
      if (url.pathname === '/api/bots/supervision') {
        if (req.method !== 'GET') return error(res, 405, 'Supervision is read-only.');
        if ([...url.searchParams].length || req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) return error(res, 400, 'Supervision reads take no settings.');
        return json(res, 200, bots.supervision());
      }
      if (url.pathname === '/api/bots/teams') {
        if (req.method === 'GET') return json(res, 200, bots.team.list());
        if (req.method === 'POST') return json(res, 201, bots.team.create(await readBody(req)));
        return error(res, 405, 'This team action is unavailable.');
      }
      const channelRoute = /^\/api\/bots\/teams\/(team_[a-f0-9-]+)\/(channel|messages)$/.exec(url.pathname);
      if (channelRoute) {
        const [, teamId, action] = channelRoute;
        if (action === 'messages' && req.method === 'POST') {
          if ([...url.searchParams].length) throw fault(400, 'Send team message settings in the request body.');
          return json(res, 201, bots.team.message(teamId, await readBody(req)));
        }
        if (action === 'channel' && req.method === 'GET') {
          if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) throw fault(400, 'Team channel reads take no request body.');
          const options = {};
          for (const [key, value] of url.searchParams) {
            if (!['after', 'before'].includes(key) || Object.hasOwn(options, key) || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw fault(400, 'Choose one valid team channel cursor.');
            options[key] = Number(value);
          }
          if (Object.keys(options).length > 1) throw fault(400, 'Choose either earlier or newer team channel messages.');
          return json(res, 200, bots.team.channel(teamId, options));
        }
        return error(res, 405, 'This team channel action is unavailable.');
      }
      const teamRoute = /^\/api\/bots\/teams\/(team_[a-f0-9-]+)(?:\/runs(?:\/(tr_[a-f0-9-]+)(?:\/(stop))?)?)?$/.exec(url.pathname);
      if (teamRoute) {
        const [, teamId, runId, action] = teamRoute;
        if (action === 'stop' && req.method === 'POST') { const input = await readBody(req); if (!input || Object.keys(input).length) throw fault(400, 'Stop takes no additional settings.'); return json(res, 200, await bots.team.stop(teamId, runId)); }
        if (runId && req.method === 'GET') return json(res, 200, bots.team.detail(teamId, runId));
        if (!runId && url.pathname.endsWith('/runs') && req.method === 'POST') return json(res, 201, bots.team.start(teamId, await readBody(req)));
        if (!runId && !url.pathname.endsWith('/runs') && req.method === 'PATCH') return json(res, 200, bots.team.update(teamId, await readBody(req)));
        return error(res, 405, 'This team action is unavailable.');
      }
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
