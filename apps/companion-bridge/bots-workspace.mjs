// Narrow paired-phone surface for durable teams, reviewed skills and saved MCP
// connections. Program paths, connection secrets and arbitrary tools stay on Mac.
import { botAvatarConfig } from './bots-lifecycle.mjs';
const error = (status, message) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const computerId = value => typeof value === 'string' && /^(host:(local|ssh_[a-f0-9]{32})|cua:bot_[a-f0-9-]+)$/.test(value);
const toolId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,300}$/.test(value);
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const date = value => Number.isFinite(value) && value >= 0 ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.+-]{8,30}Z?$/.test(value) ? value : undefined;
const states = new Set(['queued', 'running', 'completed', 'error', 'cancelled', 'interrupted', 'stopping', 'cleanup_pending']);
const limits = { maxParallel: [1, 8], maxDepth: [1, 4], maxHops: [1, 32], maxTurns: [1, 100], maxDurationMs: [60_000, 3_600_000] };
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
function object(value, keys, status) {
  if (!isObject(value) || Object.keys(value).some(key => !keys.includes(key))) throw error(status, 'Choose only the displayed team, skill or connection settings.');
}
function string(value, max, status, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) throw error(status, 'Enter a supported name or text.');
}
function ids(value, status, validate = id, max = 500) {
  if (!Array.isArray(value) || value.length > max || value.some(item => !validate(item)) || new Set(value).size !== value.length) throw error(status, 'Choose saved items from the current list.');
}
function teamBriefing(value, memberIds, status) {
  object(value, ['instructions', 'members'], status);
  string(value.instructions, 8000, status, true);
  if (!value.instructions.isWellFormed() || !Array.isArray(value.members) || value.members.length > 12) throw error(status, 'Review these public team instructions.');
  const seen = new Set();
  let total = value.instructions.length;
  for (const member of value.members) {
    object(member, ['botId', 'role', 'instructions'], status);
    if (!id(member.botId) || seen.has(member.botId) || memberIds && !memberIds.includes(member.botId)) throw error(status, 'Assign roles only to selected teammates.');
    seen.add(member.botId);
    string(member.role, 120, status, true); string(member.instructions, 4000, status, true);
    if (!member.role.isWellFormed() || !member.instructions.isWellFormed()) throw error(status, 'Review this teammate’s public instructions.');
    total += member.role.length + member.instructions.length;
  }
  if (total > 24000) throw error(status, 'Keep all team instructions and roles within 24,000 characters in total.');
  return { instructions: value.instructions, members: value.members.map(member => ({ botId: member.botId, role: member.role, instructions: member.instructions })) };
}
function connectorURL(value, status) {
  string(value, 4000, status);
  let url; try { url = new URL(value); } catch { throw error(status, 'Enter a complete connector URL.'); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw error(status, 'Use HTTPS, or an HTTP loopback address on the Mac.');
  return url.href;
}
function connectorSettings(body, method, status) {
  object(body, ['name', 'transport', 'url', 'catalogId', 'accountLabel', 'authType', 'apiKey', 'clearKey', 'botIds', 'teamIds', 'enabledToolIds', 'readOnlyToolIds', 'expectedInventoryDigest', 'customInstructions', 'enabled'], status);
  if (method === 'POST' || body.name !== undefined) string(body.name, 120, status);
  if (method === 'POST' || body.transport !== undefined) if (body.transport !== 'http') throw error(status, 'Set up local connector programs on your Mac.');
  if (body.url !== undefined) connectorURL(body.url, status);
  if (method === 'POST' && !body.catalogId && !body.url) throw error(status, 'Choose a connector or enter its server URL.');
  if (body.catalogId !== undefined && !id(body.catalogId)) throw error(status, 'Choose a supported connector.');
  if (body.accountLabel !== undefined) string(body.accountLabel, 120, status, true);
  if (body.authType !== undefined && !['none', 'bearer', 'oauth'].includes(body.authType)) throw error(status, 'Choose supported connector authentication.');
  if (body.apiKey !== undefined) string(body.apiKey, 8192, status, true);
  for (const key of ['clearKey', 'enabled']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw error(status, 'Review the connector settings.');
  if (body.customInstructions !== undefined) string(body.customInstructions, 8000, status, true);
  if (body.botIds !== undefined) ids(body.botIds, status, id, 256);
  if (body.teamIds !== undefined) ids(body.teamIds, status, id, 50);
  for (const key of ['enabledToolIds', 'readOnlyToolIds']) if (body[key] !== undefined) ids(body[key], status, toolId, 256);
  if ((body.expectedInventoryDigest !== undefined || method === 'PATCH') && (typeof body.expectedInventoryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedInventoryDigest))) throw error(status, 'Review the current connector setup, tools and access before saving.');
}
export function botWorkspaceRequest(path, method, body, status = 403, validateBody = true) {
  if (path.includes('..') || path.includes('%') || !path.startsWith('/api/bots/')) return null;
  const url = new URL(path, 'http://loopback.invalid');
  if (!path.startsWith('/api/bots/') || url.hash) return null;
  const p = url.pathname, query = [...url.searchParams];
  let route;
  if (p === '/api/bots/provider-models') route = { kind: 'providerModels' };
  else if (p === '/api/bots/activity') route = { kind: 'activity' };
  else if (p === '/api/bots/teams') route = { kind: 'teams' };
  else if (p === '/api/bots/skills') route = { kind: 'skills' };
  else if (p === '/api/bots/skills/assign') route = { kind: 'assignment' };
  else if (p === '/api/bots/connections') route = { kind: 'connections' };
  else if (p === '/api/bots/connectors/catalog') route = { kind: 'connectorCatalog' };
  else {
    const channel = /^\/api\/bots\/teams\/([A-Za-z0-9_-]{1,120})\/(channel|messages)$/.exec(p);
    const team = /^\/api\/bots\/teams\/([A-Za-z0-9_-]{1,120})(?:\/runs(?:\/([A-Za-z0-9_-]{1,120})(?:\/(stop))?)?)?$/.exec(p);
    const skill = /^\/api\/bots\/skills\/([A-Za-z0-9_-]{1,120})$/.exec(p);
    const connection = /^\/api\/bots\/connections\/([A-Za-z0-9_-]{1,120})(?:\/(check|auth|auth\/complete))?$/.exec(p);
    if (channel) route = { kind: channel[2] === 'channel' ? 'channel' : 'channelMessage', teamId: channel[1] };
    else if (team) route = { kind: p.includes('/runs') ? 'run' : 'team', teamId: team[1], runId: team[2], action: team[3] };
    else if (skill) route = { kind: 'skill', skillId: skill[1] };
    else if (connection) route = { kind: connection[2]?.startsWith('auth') ? 'connectionAuth' : 'connection', connectionId: connection[1], action: connection[2] };
    else return null;
  }
  if (query.length) {
    if (query.length !== 1 || method !== 'GET') throw error(status, 'Unsupported workspace query.');
    const [key, value] = query[0];
    if (route.kind === 'skills' && key === 'botId' && id(value)) route.botId = value;
    else if (route.kind === 'providerModels' && key === 'provider' && ['claude', 'codex', 'devin', 'grok', 'kimi', 'ollama', 'configured'].includes(value)) route.provider = value;
    else if (route.kind === 'channel' && ['after', 'before'].includes(key) && /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value))) route[key] = Number(value);
    else throw error(status, 'Choose a saved bot or provider.');
  } else if (route.kind === 'providerModels') throw error(status, 'Choose a provider.');
  const allowed = { teams: ['GET', 'POST'], team: ['PATCH'], channel: ['GET'], channelMessage: ['POST'], run: route.action === 'stop' ? ['POST'] : route.runId ? ['GET'] : ['POST'], activity: ['GET'], skills: ['GET', 'POST'], skill: ['PATCH', 'DELETE'], assignment: ['POST'], connections: ['GET', 'POST'], connection: route.action ? ['POST'] : ['PATCH', 'DELETE'], connectionAuth: route.action === 'auth/complete' ? ['POST'] : ['GET', 'POST', 'DELETE'], connectorCatalog: ['GET'], providerModels: ['GET'] };
  if (!allowed[route.kind].includes(method)) throw error(status, 'This workspace action is unavailable from iPhone.');
  if (!validateBody) return route;
  if (method === 'GET' || method === 'DELETE') {
    if (body !== undefined) throw error(status, 'This action does not accept settings.');
    return route;
  }
  if (route.kind === 'teams' || route.kind === 'team') {
    object(body, ['name', 'memberIds', 'coordinatorId', 'enabled', 'limits', 'execution', 'briefing', 'expectedRevision'], status);
    if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)) throw error(status, 'Review the current team revision.');
    if (body.execution !== undefined) {
      object(body.execution, body.execution.mode === 'individual' ? ['mode'] : ['mode', 'computerId', 'workspace'], status);
      if (!['individual', 'shared'].includes(body.execution.mode)) throw error(status, 'Choose a supported team computer mode.');
      if (body.execution.mode === 'shared') { if (!computerId(body.execution.computerId)) throw error(status, 'Choose a saved team computer.'); string(body.execution.workspace, 4000, status); }
    }
    if (method === 'POST' || body.name !== undefined) string(body.name, 80, status);
    if (method === 'POST' || body.memberIds !== undefined) { ids(body.memberIds, status, id, 12); if (body.memberIds.length < 2) throw error(status, 'Choose at least two bots.'); }
    if (method === 'POST' || body.coordinatorId !== undefined) if (!id(body.coordinatorId)) throw error(status, 'Choose a coordinator.');
    if (body.memberIds && body.coordinatorId && !body.memberIds.includes(body.coordinatorId)) throw error(status, 'The coordinator must be a team member.');
    if (body.briefing !== undefined) teamBriefing(body.briefing, body.memberIds, status);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw error(status, 'Review whether this team is enabled.');
    if (body.limits !== undefined) {
      object(body.limits, Object.keys(limits), status);
      for (const [key, value] of Object.entries(body.limits)) if (!Number.isInteger(value) || value < limits[key][0] || value > limits[key][1]) throw error(status, 'Choose supported team limits.');
    }
  } else if (route.kind === 'channelMessage') {
    object(body, ['message', 'requestId', 'recipientIds', 'replyToId'], status);
    string(body.message, 16_000, status);
    if (!id(body.requestId)) throw error(status, 'Choose a valid team message request.');
    if (body.recipientIds !== undefined) { ids(body.recipientIds, status, id, 12); if (!body.recipientIds.length) throw error(status, 'Choose a teammate or send to the team.'); }
    if (body.replyToId !== undefined && !id(body.replyToId)) throw error(status, 'Choose a message from this team.');
  } else if (route.kind === 'run') {
    object(body, route.action ? [] : ['message', 'requestId'], status);
    if (!route.action) { string(body.message, 16_000, status); if (body.requestId !== undefined && !id(body.requestId)) throw error(status, 'Choose a valid task request.'); }
  } else if (route.kind === 'skills' || route.kind === 'skill') {
    object(body, ['name', 'description', 'body', 'triggers', ...(method === 'PATCH' ? ['status', 'expectedRevision', 'expectedDigest'] : [])], status);
    for (const [key, max] of [['name', 120], ['description', 500], ['body', 64_000]]) if (method === 'POST' || body[key] !== undefined) string(body[key], max, status, key === 'description');
    if (body.triggers !== undefined) { if (!Array.isArray(body.triggers) || body.triggers.length > 32) throw error(status, 'Use a short list of skill triggers.'); for (const t of body.triggers) string(t, 160, status); }
    if (body.status !== undefined && !['draft', 'enabled'].includes(body.status)) throw error(status, 'Review a draft before enabling it.');
    if (body.expectedRevision !== undefined && !(Number.isInteger(body.expectedRevision) && body.expectedRevision >= 1)) throw error(status, 'Review the current skill revision.');
    if (body.expectedDigest !== undefined && (typeof body.expectedDigest !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.expectedDigest))) throw error(status, 'Review the current skill instructions.');
    if ((body.status === 'enabled' || body.expectedRevision !== undefined || body.expectedDigest !== undefined) && (body.expectedRevision === undefined || body.expectedDigest === undefined)) throw error(status, 'Review the current skill before enabling it.');
  } else if (route.kind === 'assignment') {
    object(body, ['botId', 'skillIds'], status); if (!id(body.botId)) throw error(status, 'Choose a saved bot.'); ids(body.skillIds, status, toolId, 32);
  } else if (route.kind === 'connections' || route.kind === 'connection') {
    if (route.action) object(body, [], status); else connectorSettings(body, method, status);
  } else if (route.kind === 'connectionAuth') {
    object(body, route.action === 'auth/complete' ? ['callbackURL'] : [], status);
    if (route.action === 'auth/complete') {
      string(body.callbackURL, 16000, status);
      let callback; try { callback = new URL(body.callbackURL); } catch { throw error(status, 'Paste the full connector sign-in callback.'); }
      if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) || callback.username || callback.password || callback.hash) throw error(status, 'Use the Mac callback shown by this connector sign-in.');
    }
  }
  return route;
}
const safeIds = value => (Array.isArray(value) ? value : []).filter(id).slice(0, 500);
const safeTools = value => (Array.isArray(value) ? value : []).filter(toolId).slice(0, 1_000);
function channelPreview(value) {
  // This optional caption may be absent on older hosts. Malformed captions
  // cannot hide the roster or carry internal fields into a paired client.
  if (!isObject(value) || !id(value.id) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !['message', 'assignment', 'report', 'status'].includes(value.kind)
    || !isObject(value.author) || !['user', 'bot', 'system'].includes(value.author.type) || typeof value.author.name !== 'string' || !value.author.name.trim() || value.author.name.length > 200 || value.author.name.includes('\0') || !value.author.name.isWellFormed()
    || value.author.type === 'bot' && !id(value.author.botId) || typeof value.content !== 'string' || value.content.length > 560 || value.content.includes('\0') || !value.content.isWellFormed() || Array.from(value.content).length > 280 || date(value.createdAt) === undefined) return undefined;
  return { id: value.id, sequence: value.sequence, kind: value.kind, author: { type: value.author.type, name: value.author.name, ...(value.author.type === 'bot' ? { botId: value.author.botId } : {}) }, content: value.content, createdAt: date(value.createdAt) };
}
function execution(value) {
  if (!isObject(value)) return undefined;
  if (value.mode === 'individual') return { mode: 'individual' };
  if (value.mode === 'shared' && computerId(value.computerId) && typeof value.workspace === 'string' && value.workspace.length > 0 && value.workspace.length <= 4000 && !value.workspace.includes('\0')) return { mode: 'shared', computerId: value.computerId, workspace: value.workspace };
}
function teamComputer(value) {
  if (!isObject(value) || !computerId(value.id) || !['host', 'cua'].includes(value.computerMode) || typeof value.name !== 'string' || !value.name.trim() || typeof value.workspace !== 'string' || value.workspace.length > 4000 || value.workspace.includes('\0') || typeof value.available !== 'boolean') return null;
  return { id: value.id, name: text(value.name, 200), label: text(value.label, 400), computerMode: value.computerMode, workspace: value.workspace, available: value.available, ...(id(value.memberId) ? { memberId: value.memberId } : {}), ...(typeof value.detail === 'string' ? { detail: text(value.detail, 1000) } : {}) };
}
function team(value) {
  const preview = channelPreview(value.channelPreview);
  let briefing;
  if (value.briefing !== undefined) {
    // Keep only the public schema. Future/private profile fields cannot cross pairing.
    try { const publicValue = { instructions: value.briefing.instructions, members: value.briefing.members?.map(member => ({ botId: member.botId, role: member.role, instructions: member.instructions })) }; briefing = teamBriefing(publicValue, safeIds(value.memberIds), 502); } catch { /* Optional newer information cannot hide an otherwise readable team. */ }
  }
  return { id: value.id, name: text(value.name, 200), memberIds: safeIds(value.memberIds), coordinatorId: id(value.coordinatorId) ? value.coordinatorId : '', enabled: value.enabled === true, limits: Object.fromEntries(Object.entries(limits).filter(([k, [low, high]]) => Number.isInteger(value.limits?.[k]) && value.limits[k] >= low && value.limits[k] <= high).map(([k]) => [k, value.limits[k]])), createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), ...(preview ? { channelPreview: preview } : {}), ...(briefing ? { briefing } : {}), ...(Number.isSafeInteger(value.revision) && value.revision > 0 ? { revision: value.revision } : {}), ...(execution(value.execution) ? { execution: execution(value.execution) } : {}) };
}
function run(value) {
  return { id: value.id, teamId: id(value.teamId) ? value.teamId : '', rootChatId: id(value.rootChatId) ? value.rootChatId : '', rootBotId: id(value.rootBotId) ? value.rootBotId : '', state: states.has(value.state) ? value.state : 'interrupted', limits: team(value).limits, consumedTurns: Number.isInteger(value.consumedTurns) ? value.consumedTurns : 0, createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), ...(typeof value.detail === 'string' ? { detail: text(value.detail, 2_000) } : {}) };
}
function channelSnapshot(value, route) {
  const invalid = () => { throw error(502, 'Strata returned unreadable team channel information.'); };
  if (!isObject(value) || value.teamId !== route.teamId || value.supported !== true || !Array.isArray(value.messages) || value.messages.length > 100 || !Array.isArray(value.activeRuns) || value.activeRuns.length > 200 || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 0 || typeof value.hasMore !== 'boolean' || typeof value.hasMoreBefore !== 'boolean') invalid();
  const seen = new Set(); let previous = 0;
  const messages = value.messages.map(v => {
    if (!isObject(v) || !id(v.id) || seen.has(v.id) || v.teamId !== route.teamId || !Number.isSafeInteger(v.sequence) || v.sequence <= previous || !['message', 'assignment', 'report', 'status'].includes(v.kind) || !isObject(v.author) || !['user', 'bot', 'system'].includes(v.author.type) || typeof v.author.name !== 'string' || !v.author.name.trim() || v.author.name.length > 200 || typeof v.content !== 'string' || v.content.length > 32_000 || v.content.includes('\0') || date(v.createdAt) === undefined || v.author.type === 'bot' && !id(v.author.botId)) invalid();
    seen.add(v.id); previous = v.sequence;
    for (const key of ['replyToId', 'runId', 'chatId']) if (v[key] !== undefined && !id(v[key])) invalid();
    if (v.recipientIds !== undefined && (!Array.isArray(v.recipientIds) || v.recipientIds.length > 12 || v.recipientIds.some(x => !id(x)) || new Set(v.recipientIds).size !== v.recipientIds.length)) invalid();
    let avatarConfig;
    if (v.author.avatarConfig !== undefined) { try { avatarConfig = botAvatarConfig(v.author.avatarConfig, 502); if (avatarConfig.shape === 'classic') delete avatarConfig.shape; } catch { /* Omit unavailable future artwork; never forward arbitrary assets or fields. */ } }
    return { id: v.id, sequence: v.sequence, teamId: v.teamId, kind: v.kind, author: { type: v.author.type, name: v.author.name, ...(v.author.type === 'bot' ? { botId: v.author.botId } : {}), ...(avatarConfig ? { avatarConfig } : {}) }, content: v.content, createdAt: date(v.createdAt), ...Object.fromEntries(['replyToId', 'runId', 'chatId'].filter(key => v[key] !== undefined).map(key => [key, v[key]])), ...(v.recipientIds ? { recipientIds: v.recipientIds } : {}), ...(['queued', 'working', 'done', 'error', 'interrupted', 'cancelled'].includes(v.state) ? { state: v.state } : {}) };
  });
  if (messages.length && value.nextSequence !== messages.at(-1).sequence || value.activeRuns.some(v => !isObject(v) || !id(v.id) || v.teamId !== route.teamId)) invalid();
  return { teamId: value.teamId, supported: true, messages, activeRuns: value.activeRuns.map(run), nextSequence: value.nextSequence, hasMore: value.hasMore, hasMoreBefore: value.hasMoreBefore, ...(messages.length ? { firstSequence: messages[0].sequence } : {}) };
}
function skill(value) {
  return { id: value.id, name: text(value.name, 200), description: text(value.description, 2_000), body: text(value.body, 64_000), triggers: (Array.isArray(value.triggers) ? value.triggers : []).filter(t => typeof t === 'string').slice(0, 50).map(t => text(t, 200)), source: value.source === 'library' ? 'library' : 'draft', status: value.status === 'enabled' ? 'enabled' : 'draft', revision: Number.isInteger(value.revision) ? value.revision : text(value.revision, 128), digest: text(value.digest, 128), botIds: safeIds(value.botIds) };
}
function connectorLink(value, loopback = false) {
  if (typeof value !== 'string' || value.length > 16000) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) return undefined;
    if (loopback && (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search)) return undefined;
    return url.href;
  } catch { return undefined; }
}
function connectorAuth(value) {
  if (!isObject(value)) return undefined;
  const authorizationURL = connectorLink(value.authorizationURL), redirectURL = connectorLink(value.redirectURL, true);
  return { status: ['not_connected', 'connected', 'connecting', 'waiting', 'expired', 'error'].includes(value.status) ? value.status : 'not_connected', detail: text(value.detail, 2000), ...(authorizationURL ? { authorizationURL } : {}), ...(redirectURL ? { redirectURL } : {}), ...(date(value.expiresAt) !== undefined ? { expiresAt: date(value.expiresAt) } : {}) };
}
function connectorFeatures(value) {
  return isObject(value) ? { connectorFeatures: Object.fromEntries(['catalog', 'httpCreation', 'teamAccess', 'oauth'].map(key => [key, value[key] === true])) } : {};
}
function connection(value) {
  let url; try { if (value.transport === 'http' && value.url) url = connectorURL(value.url, 502); } catch { /* Do not project malformed or credential-bearing URLs. */ }
  return { id: value.id, name: text(value.name, 200), transport: value.transport === 'http' ? 'http' : 'stdio', ...(url ? { url } : {}), ...(id(value.catalogId) ? { catalogId: value.catalogId } : {}), accountLabel: text(value.accountLabel, 120), authType: ['none', 'bearer', 'oauth'].includes(value.authType) ? value.authType : value.apiKeySet ? 'bearer' : 'none', enabled: value.enabled !== false, customInstructions: text(value.customInstructions, 8000), teamIds: safeIds(value.teamIds), ...(connectorAuth(value.auth) ? { auth: connectorAuth(value.auth) } : {}), oauthClientIdSet: value.oauthClientIdSet === true, oauthClientSecretSet: value.oauthClientSecretSet === true, apiKeySet: value.apiKeySet === true, inventoryDigest: typeof value.inventoryDigest === 'string' && /^[a-f0-9]{64}$/.test(value.inventoryDigest) ? value.inventoryDigest : '', botIds: safeIds(value.botIds), enabledToolIds: safeTools(value.enabledToolIds), readOnlyToolIds: safeTools(value.readOnlyToolIds), status: ['unchecked', 'starting', 'connected', 'unavailable'].includes(value.status) ? value.status : 'unchecked', detail: text(value.detail, 2_000), ...(date(value.checkedAt) !== undefined ? { checkedAt: date(value.checkedAt) } : {}), tools: (Array.isArray(value.tools) ? value.tools : []).filter(t => t && toolId(t.id)).slice(0, 256).map(t => ({ id: t.id, name: text(t.name, 300), description: text(t.description, 2_000), readOnly: t.readOnly === true })) };
}
export function publicBotWorkspace(body, route) {
  if (!isObject(body)) throw error(502, 'Strata returned unreadable workspace information.');
  const rows = (key, project, valid = id) => {
    if (!Array.isArray(body[key])) throw error(502, 'Strata returned unreadable workspace information.');
    return body[key].filter(v => v && valid(v.id)).slice(0, 1_000).map(project);
  };
  if (route.kind === 'channel') return channelSnapshot(body, route);
  if (route.kind === 'channelMessage') return { channel: channelSnapshot(body.channel, route), ...(body.run && id(body.run.id) && body.run.teamId === route.teamId ? { run: run(body.run) } : {}) };
  if (route.kind === 'teams' && Array.isArray(body.teams)) return { teams: rows('teams', team), runs: rows('runs', run), ...(body.channelsSupported === true ? { channelsSupported: true } : {}), ...(body.teamInstructionsSupported === true ? { teamInstructionsSupported: true } : {}), ...(body.teamSettingsSupported === true ? { teamSettingsSupported: true, teamComputers: (Array.isArray(body.teamComputers) ? body.teamComputers : []).slice(0, 1000).map(teamComputer).filter(Boolean) } : {}) };
  if (body.team && id(body.team.id)) return { team: team(body.team) };
  if (body.run && id(body.run.id)) return { run: run(body.run) };
  if (route.kind === 'activity') return { activity: rows('activity', v => ({ id: v.id, type: ['run', 'delivery', 'subagent'].includes(v.type) ? v.type : 'run', teamId: id(v.teamId) ? v.teamId : '', runId: id(v.runId) ? v.runId : '', title: text(v.title, 300), state: text(v.state, 60), ...Object.fromEntries(['botId', 'chatId', 'parentChatId', 'fromBotId', 'toBotId'].filter(k => id(v[k])).map(k => [k, v[k]])), createdAt: date(v.createdAt), updatedAt: date(v.updatedAt), ...(typeof v.detail === 'string' ? { detail: text(v.detail, 2_000) } : {}) })) };
  if (route.kind === 'skills' && Array.isArray(body.skills)) return { skills: rows('skills', skill, toolId), assignments: (Array.isArray(body.assignments) ? body.assignments : []).filter(v => id(v?.botId)).slice(0, 500).map(v => ({ botId: v.botId, skillIds: safeTools(v.skillIds) })) };
  if (body.skill && id(body.skill.id)) return { skill: skill(body.skill) };
  if (route.kind === 'assignment') return { saved: true };
  if (route.kind === 'connectorCatalog') return { connectors: rows('connectors', value => ({ id: value.id, name: text(value.name, 120), description: text(value.description, 2000), category: text(value.category, 120), transport: 'http', ...(connectorLink(value.url) ? { url: connectorLink(value.url) } : {}), authTypes: (Array.isArray(value.authTypes) ? value.authTypes : []).filter(kind => ['none', 'bearer', 'oauth'].includes(kind)), ...(connectorLink(value.documentationURL) ? { documentationURL: connectorLink(value.documentationURL) } : {}), setupNote: text(value.setupNote, 2000) })), ...connectorFeatures(body.connectorFeatures) };
  if (route.kind === 'connections' && Array.isArray(body.connections)) return { connections: rows('connections', connection), ...connectorFeatures(body.connectorFeatures) };
  if (body.connection && id(body.connection.id)) return { connection: connection(body.connection), ...(route.kind === 'connectionAuth' && connectorAuth(body.auth) ? { auth: connectorAuth(body.auth) } : {}) };
  if (route.kind === 'providerModels') return { provider: route.provider, models: (Array.isArray(body.models) ? body.models : []).filter(v => typeof v?.id === 'string').slice(0, 500).map(v => ({ id: text(v.id, 300), name: text(v.name, 300), efforts: (Array.isArray(v.efforts) ? v.efforts : []).filter(e => typeof e === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e)).slice(0, 20), ...(typeof v.defaultEffort === 'string' ? { defaultEffort: text(v.defaultEffort, 40) } : {}) })), detail: text(body.detail, 1_000) };
  if (body.deleted === true || body.removed === true) return { deleted: true };
  if (body.saved === true) return { saved: true };
  throw error(502, 'Strata returned unreadable workspace information.');
}

export async function handleBotWorkspace({ path, method, req, res, session, host, readBody, sendJSON, requireCurrentSession }) {
  const upstreamPath = path.replace(/^\/v1\//, '/api/');
  const route = botWorkspaceRequest(upstreamPath, method, undefined, 405, false);
  if (!route) return false;
  if (['GET', 'DELETE'].includes(method) && (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'])) throw error(400, 'This action does not accept settings.');
  const body = ['POST', 'PATCH'].includes(method) ? await readBody(req, ['teams', 'team'].includes(route.kind) ? 240_000 : 70_000) : undefined;
  botWorkspaceRequest(upstreamPath, method, body, 400);
  requireCurrentSession();
  try {
    if (route.kind === 'channelMessage') {
      const catalog = await host.json('/api/bots/teams'); requireCurrentSession();
      const selected = (catalog.teams ?? []).find(team => team.id === route.teamId);
      if (!selected || !selected.enabled || body.recipientIds?.some(botId => !selected.memberIds?.includes(botId))) throw error(409, 'Refresh this team and choose its available members.');
    }
    if (['teams', 'team'].includes(route.kind) && body?.briefing !== undefined) {
      const catalog = await host.json('/api/bots/teams'); requireCurrentSession();
      if (catalog.teamInstructionsSupported !== true) throw error(409, 'Update Strata on your Mac before changing team instructions.');
      const selected = route.kind === 'team' ? (catalog.teams ?? []).find(team => team.id === route.teamId) : undefined;
      if (route.kind === 'team' && !selected) throw error(404, 'This team is no longer available.');
      teamBriefing(body.briefing, body.memberIds ?? selected?.memberIds, 409);
    }
    if ((route.kind === 'teams' || route.kind === 'team') && (body?.memberIds || body?.coordinatorId) || route.kind === 'assignment' || ['connection', 'connections'].includes(route.kind) && body?.botIds) {
      const catalog = await host.json('/api/bots'); requireCurrentSession();
      const botIds = new Set((catalog.bots ?? []).map(bot => bot.id));
      if ((body?.memberIds ?? body?.botIds ?? [body?.botId]).filter(Boolean).some(botId => !botIds.has(botId)) || body?.coordinatorId && !botIds.has(body.coordinatorId)) throw error(409, 'Refresh the saved bots before changing this item.');
    }
    if (route.kind === 'assignment' || route.kind === 'skill') {
      const catalog = await host.json('/api/bots/skills'); requireCurrentSession();
      const skills = catalog.skills ?? [];
      if (route.kind === 'skill') {
        const selected = skills.find(skill => skill.id === route.skillId);
        if (!selected) throw error(404, 'This skill is no longer available.');
        if (selected.source === 'library') throw error(409, 'Library skills can be assigned but must be edited on Mac.');
        if (body?.expectedRevision !== undefined && body.expectedRevision !== selected.revision || body?.expectedDigest !== undefined && body.expectedDigest !== selected.digest) throw error(409, 'This skill changed. Review its current instructions before saving.');
      } else {
        const prior = new Set((catalog.assignments ?? []).find(assignment => assignment.botId === body.botId)?.skillIds ?? []);
        if (body.skillIds.some(skillId => !skills.some(skill => skill.id === skillId && (skill.status === 'enabled' || prior.has(skillId))))) throw error(409, 'Review and enable skills before assigning them.');
      }
    }
    if (['connection', 'connections', 'connectionAuth'].includes(route.kind) && method !== 'GET') {
      const catalog = await host.json('/api/bots/connections'); requireCurrentSession();
      const selected = route.connectionId ? (catalog.connections ?? []).find(connection => connection.id === route.connectionId) : undefined;
      if (route.connectionId && !selected) throw error(404, 'This connection is no longer available.');
      if (route.kind === 'connections' && catalog.connectorFeatures?.httpCreation !== true) throw error(409, 'Update Strata on your Mac before adding connectors from iPhone.');
      if (route.kind === 'connectionAuth' && (catalog.connectorFeatures?.oauth !== true || selected?.transport !== 'http')) throw error(409, 'Set up browser sign-in for this connector on your Mac.');
      if (body?.teamIds !== undefined && catalog.connectorFeatures?.teamAccess !== true) throw error(409, 'Update Strata on your Mac before changing team connector access.');
      const setupKeys = ['transport', 'url', 'catalogId', 'authType', 'apiKey', 'clearKey'];
      if (route.kind === 'connection' && setupKeys.some(key => Object.hasOwn(body ?? {}, key)) && (catalog.connectorFeatures?.httpCreation !== true || selected?.transport !== 'http')) throw error(409, 'Edit this connector’s program or credentials on your Mac.');
      if (body?.teamIds !== undefined) {
        const teams = await host.json('/api/bots/teams'); requireCurrentSession();
        const current = new Set((teams.teams ?? []).map(team => team.id));
        if (body.teamIds.some(teamId => !current.has(teamId))) throw error(409, 'Refresh the saved teams before changing connector access.');
      }
      if (route.kind === 'connectionAuth' && route.action === 'auth/complete') {
        let callback, expected; try { callback = new URL(body.callbackURL); expected = new URL(selected.auth?.redirectURL); } catch { throw error(409, 'Start a fresh connector sign-in on your Mac.'); }
        if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) throw error(409, 'Use this connector’s current sign-in callback.');
      }
      if (!selected) {
        if (body?.enabledToolIds?.length || body?.readOnlyToolIds?.length) throw error(409, 'Save and check the connector before enabling tools.');
      } else {
      if (body?.expectedInventoryDigest !== undefined && body.expectedInventoryDigest !== selected.inventoryDigest) throw error(409, 'This connection changed. Review its current tools before saving access.');
      const known = new Set((selected.tools ?? []).map(tool => tool.id));
      if (body?.enabledToolIds?.some(tool => !known.has(tool))) throw error(409, 'Check this connection and review its current tools.');
      const readonly = new Set(selected.readOnlyToolIds ?? []);
      if (body?.readOnlyToolIds?.some(tool => !readonly.has(tool) || !known.has(tool) || body.enabledToolIds && !body.enabledToolIds.includes(tool))) throw error(409, 'Classify read-only tools deliberately on your Mac.');
      }
    }
    requireCurrentSession();
    const result = await host.json(upstreamPath, { method, ...(body !== undefined ? { body } : {}), deviceId: session.id });
    requireCurrentSession();
    sendJSON(res, 200, publicBotWorkspace(result, route));
    return true;
  } catch (failure) {
    requireCurrentSession();
    if ([404, 405, 501].includes(failure.status) && method === 'GET') {
      const empty = { teams: { teams: [], runs: [] }, channel: { teamId: route.teamId, supported: false, messages: [], activeRuns: [], nextSequence: 0, hasMore: false, hasMoreBefore: false }, activity: { activity: [] }, skills: { skills: [], assignments: [] }, connections: { connections: [] }, providerModels: { provider: route.provider, models: [] } }[route.kind];
      if (empty) { sendJSON(res, 200, { ...empty, reason: 'Update Strata on your Mac to use this Bots feature.' }); return true; }
    }
    const status = [400, 404, 409, 413, 501].includes(failure.status) ? failure.status : 503;
    throw error(status, status === 409 ? 'Refresh this item and review its current settings before trying again.' : status === 404 ? 'This item is no longer available. Refresh Bots.' : 'Strata could not complete this action. Check the Mac and refresh before retrying.');
  }
}
