// Narrow paired-phone surface for durable teams, reviewed skills and saved MCP
// connections and reviewable bot-created command tools. Tool configuration never
// executes commands; execution stays with the selected bot and its permissions.
import { botAvatarConfig } from './bots-lifecycle.mjs';
const error = (status, message) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const computerId = value => typeof value === 'string' && /^(host:(local|ssh_[a-f0-9]{32})|cua:bot_[a-f0-9-]+)$/.test(value);
const toolId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,300}$/.test(value);
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const date = value => Number.isFinite(value) && value >= 0 ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.+-]{8,30}Z?$/.test(value) ? value : undefined;
const states = new Set(['queued', 'running', 'completed', 'error', 'cancelled', 'interrupted', 'stopping', 'cleanup_pending']);
// Zero means all available members on capable hosts. Older positive values are
// forwarded unchanged; the selected host remains the authority for execution.
const limits = { maxParallel: [0, Number.MAX_SAFE_INTEGER], maxDepth: [1, 4], maxHops: [1, 32], maxTurns: [1, 100], maxDurationMs: [60_000, 3_600_000] };
const continuousLimits = value => isObject(value) && Object.keys(value).length === Object.keys(limits).length && Object.keys(limits).every(key => value[key] === 0);
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
  if (!value.instructions.isWellFormed() || !Array.isArray(value.members)) throw error(status, 'Review these public team instructions.');
  const seen = new Set();
  const selected = memberIds ? new Set(memberIds) : null;
  let total = value.instructions.length;
  for (const member of value.members) {
    object(member, ['botId', 'role', 'instructions'], status);
    if (!id(member.botId) || seen.has(member.botId) || selected && !selected.has(member.botId)) throw error(status, 'Assign roles only to selected teammates.');
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
function createdToolSchema(value, status) {
  object(value, ['type', 'properties', 'required', 'additionalProperties'], status);
  if (value.type !== 'object' || value.additionalProperties !== false || !isObject(value.properties) || Object.keys(value.properties).length > 32) throw error(status, 'Use a flat object input schema with no extra properties.');
  for (const [name, field] of Object.entries(value.properties)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) throw error(status, 'Use simple names for tool inputs.');
    object(field, ['type', 'description', 'enum', 'minimum', 'maximum', 'maxLength'], status);
    if (!['string', 'number', 'integer', 'boolean'].includes(field.type)) throw error(status, 'Use text, number or boolean tool inputs.');
    if (field.description !== undefined) string(field.description, 500, status, true);
    const matches = v => field.type === 'string' ? typeof v === 'string' && !v.includes('\0') : field.type === 'boolean' ? typeof v === 'boolean' : Number.isFinite(v) && (field.type !== 'integer' || Number.isSafeInteger(v));
    if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 64 || field.enum.some(v => !matches(v)))) throw error(status, 'Review the allowed tool input values.');
    for (const key of ['minimum', 'maximum']) if (field[key] !== undefined && (!['number', 'integer'].includes(field.type) || !Number.isFinite(field[key]) || field.type === 'integer' && !Number.isSafeInteger(field[key]))) throw error(status, 'Review numeric input limits.');
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) throw error(status, 'Review numeric input limits.');
    if (field.maxLength !== undefined && (field.type !== 'string' || !Number.isSafeInteger(field.maxLength) || field.maxLength < 0 || field.maxLength > 64000)) throw error(status, 'Review text input limits.');
  }
  if (!Array.isArray(value.required) || new Set(value.required).size !== value.required.length || value.required.some(key => typeof key !== 'string' || !Object.hasOwn(value.properties, key))) throw error(status, 'Required inputs must appear in the tool schema.');
  if (JSON.stringify(value).length > 16000) throw error(status, 'Keep tool input definitions within 16,000 characters.');
  return structuredClone(value);
}
function createdToolSettings(body, method, status) {
  object(body, ['name', 'description', 'command', 'inputSchema', 'timeoutSeconds', ...(method === 'PATCH' ? ['status', 'botIds', 'teamIds', 'expectedRevision', 'expectedDigest'] : [])], status);
  for (const [key, max] of [['name', 120], ['description', 2000], ['command', 32000]]) if (body[key] !== undefined || method === 'POST' && ['name', 'command'].includes(key)) string(body[key], max, status, key === 'description');
  if (body.inputSchema !== undefined) createdToolSchema(body.inputSchema, status);
  if (body.timeoutSeconds !== undefined && (!Number.isSafeInteger(body.timeoutSeconds) || body.timeoutSeconds < 1 || body.timeoutSeconds > 120)) throw error(status, 'Choose a tool timeout from 1 to 120 seconds.');
  if (method === 'PATCH') {
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || typeof body.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedDigest)) throw error(status, 'Review the current tool revision before saving.');
    if (body.status !== undefined && !['draft', 'enabled'].includes(body.status)) throw error(status, 'Review the tool before enabling it.');
    if (body.botIds !== undefined) ids(body.botIds, status, id, 256);
    if (body.teamIds !== undefined) ids(body.teamIds, status, id, 50);
  }
}
function createdToolProof(body, status) {
  object(body, ['expectedRevision', 'expectedDigest'], status);
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || typeof body.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedDigest)) throw error(status, 'Review the current tool revision before deleting it.');
}
export function botWorkspaceRequest(path, method, body, status = 403, validateBody = true) {
  if (path.includes('..') || path.includes('%') || !path.startsWith('/api/bots/')) return null;
  const url = new URL(path, 'http://loopback.invalid');
  if (!path.startsWith('/api/bots/') || url.hash) return null;
  const p = url.pathname, query = [...url.searchParams];
  let route;
  if (p === '/api/bots/provider-models') route = { kind: 'providerModels' };
  else if (p === '/api/bots/activity') route = { kind: 'activity' };
  else if (p === '/api/bots/supervision') route = { kind: 'supervision' };
  else if (p === '/api/bots/teams') route = { kind: 'teams' };
  else if (p === '/api/bots/skills') route = { kind: 'skills' };
  else if (p === '/api/bots/skills/assign') route = { kind: 'assignment' };
  else if (p === '/api/bots/tools') route = { kind: 'createdTools' };
  else if (p === '/api/bots/connections') route = { kind: 'connections' };
  else if (p === '/api/bots/connectors/catalog') route = { kind: 'connectorCatalog' };
  else {
    const channel = /^\/api\/bots\/teams\/([A-Za-z0-9_-]{1,120})\/(channel|messages)$/.exec(p);
    const team = /^\/api\/bots\/teams\/([A-Za-z0-9_-]{1,120})(?:\/runs(?:\/([A-Za-z0-9_-]{1,120})(?:\/(stop))?)?)?$/.exec(p);
    const task = /^\/api\/bots\/teams\/(team_[a-f0-9-]+)\/jobs\/(tj_[a-f0-9-]+)\/(review|recovery|resume)$/.exec(p);
    const skill = /^\/api\/bots\/skills\/([A-Za-z0-9_-]{1,120})$/.exec(p);
    const createdTool = /^\/api\/bots\/tools\/(tool_[a-f0-9-]{1,100})$/.exec(p);
    const connection = /^\/api\/bots\/connections\/([A-Za-z0-9_-]{1,120})(?:\/(check|auth|auth\/complete|auth\/cancel))?$/.exec(p);
    if (task) route = { kind: 'task', teamId: task[1], jobId: task[2], action: task[3] };
    else if (channel) route = { kind: channel[2] === 'channel' ? 'channel' : 'channelMessage', teamId: channel[1] };
    else if (team) route = { kind: p.includes('/runs') ? 'run' : 'team', teamId: team[1], runId: team[2], action: team[3] };
    else if (skill) route = { kind: 'skill', skillId: skill[1] };
    else if (createdTool) route = { kind: 'createdTool', toolId: createdTool[1] };
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
  const allowed = { teams: ['GET', 'POST'], team: ['PATCH'], channel: ['GET'], channelMessage: ['POST'], run: route.action === 'stop' ? ['POST'] : route.runId ? ['GET'] : ['POST'], activity: ['GET'], supervision: ['GET'], skills: ['GET', 'POST'], skill: ['PATCH', 'DELETE'], assignment: ['POST'], connections: ['GET', 'POST'], connection: route.action ? ['POST'] : ['PATCH', 'DELETE'], connectionAuth: ['auth/complete', 'auth/cancel'].includes(route.action) ? ['POST'] : ['GET', 'POST', 'DELETE'], connectorCatalog: ['GET'], providerModels: ['GET'] };
  allowed.createdTools = ['GET', 'POST']; allowed.createdTool = ['PATCH', 'DELETE'];
  if (!(route.kind === 'task' ? route.action === 'recovery' ? ['GET'] : ['POST'] : allowed[route.kind]).includes(method)) throw error(status, 'This workspace action is unavailable from iPhone.');
  if (!validateBody) return route;
  if (route.kind === 'createdTool' && method === 'DELETE') { createdToolProof(body, status); return route; }
  if (method === 'GET' || method === 'DELETE') {
    if (body !== undefined) throw error(status, 'This action does not accept settings.');
    return route;
  }
  if (route.kind === 'task') {
    object(body, route.action === 'review' ? ['expectedRevision','decision','note'] : ['planId','expectedRevision','idempotencyKey'], status);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) throw error(status, 'Review the current task result.');
    if (route.action === 'review') {
      if (!['accept','reject'].includes(body.decision)) throw error(status, 'Choose a review decision.');
      if (body.note !== undefined) string(body.note,2500,status,true);
    } else if (!id(body.planId) || !id(body.idempotencyKey)) throw error(status, 'Review the current recovery plan before continuing.');
  } else if (route.kind === 'teams' || route.kind === 'team') {
    object(body, ['name', 'memberIds', 'coordinatorId', 'enabled', 'limits', 'execution', 'briefing', 'expectedRevision'], status);
    if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)) throw error(status, 'Review the current team revision.');
    if (body.execution !== undefined) {
      object(body.execution, body.execution.mode === 'individual' ? ['mode'] : ['mode', 'computerId', 'workspace'], status);
      if (!['individual', 'shared'].includes(body.execution.mode)) throw error(status, 'Choose a supported team computer mode.');
      if (body.execution.mode === 'shared') { if (!computerId(body.execution.computerId)) throw error(status, 'Choose a saved team computer.'); string(body.execution.workspace, 4000, status); }
    }
    if (method === 'POST' || body.name !== undefined) string(body.name, 80, status);
    if (method === 'POST' || body.memberIds !== undefined) { ids(body.memberIds, status, id, Infinity); if (body.memberIds.length < 2) throw error(status, 'Choose at least two bots.'); }
    if (method === 'POST' || body.coordinatorId !== undefined) if (!id(body.coordinatorId)) throw error(status, 'Choose a coordinator.');
    if (body.memberIds && body.coordinatorId && !body.memberIds.includes(body.coordinatorId)) throw error(status, 'The coordinator must be a team member.');
    if (body.briefing !== undefined) teamBriefing(body.briefing, body.memberIds, status);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw error(status, 'Review whether this team is enabled.');
    if (body.limits !== undefined) {
      object(body.limits, Object.keys(limits), status);
      if (!continuousLimits(body.limits)) for (const [key, value] of Object.entries(body.limits)) if (!Number.isSafeInteger(value) || value < limits[key][0] || value > limits[key][1]) throw error(status, 'Choose supported team limits.');
    }
  } else if (route.kind === 'channelMessage') {
    object(body, ['message', 'requestId', 'recipientIds', 'replyToId', 'workMode'], status);
    string(body.message, 16_000, status);
    if (!id(body.requestId)) throw error(status, 'Choose a valid team message request.');
    if (body.recipientIds !== undefined) { ids(body.recipientIds, status, id, Infinity); if (!body.recipientIds.length) throw error(status, 'Choose a teammate or send to the team.'); }
    if (body.replyToId !== undefined && !id(body.replyToId)) throw error(status, 'Choose a message from this team.');
    if (body.workMode !== undefined && !['chat', 'work'].includes(body.workMode)) throw error(status, 'Choose Chat or Work for this team message.');
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
  } else if (['createdTools', 'createdTool'].includes(route.kind)) {
    createdToolSettings(body, method, status);
  } else if (route.kind === 'assignment') {
    object(body, ['botId', 'skillIds'], status); if (!id(body.botId)) throw error(status, 'Choose a saved bot.'); ids(body.skillIds, status, toolId, 32);
  } else if (route.kind === 'connections' || route.kind === 'connection') {
    if (route.action) object(body, [], status); else connectorSettings(body, method, status);
  } else if (route.kind === 'connectionAuth') {
    object(body, route.action === 'auth/complete' ? ['callbackURL'] : route.action === 'auth/cancel' ? ['expectedState'] : ['callbackTarget'], status);
    if (route.action === 'auth/cancel' && (typeof body.expectedState !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedState))) throw error(status, 'Choose the pending sign-in you want to cancel.');
    if (body.callbackTarget !== undefined && body.callbackTarget !== 'iphone') throw error(status, 'Choose a supported connector sign-in destination.');
    if (route.action === 'auth/complete') {
      string(body.callbackURL, 16000, status);
      let callback; try { callback = new URL(body.callbackURL); } catch { throw error(status, 'Paste the full connector sign-in callback.'); }
      const iphone = callback.protocol === 'strata:' && callback.host === 'connector-oauth' && callback.pathname === '/callback' && !callback.port;
      const mac = callback.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname);
      if ((!iphone && !mac) || callback.username || callback.password || callback.hash) throw error(status, 'Use this connector’s exact sign-in callback.');
    }
  }
  return route;
}
const safeIds = value => (Array.isArray(value) ? value : []).filter(id).slice(0, 500);
const teamIds = value => {
  if (!Array.isArray(value)) return [];
  ids(value, 502, id, Infinity);
  return [...value];
};
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
  const memberIds = teamIds(value.memberIds);
  let briefing;
  if (value.briefing !== undefined) {
    // Keep only the public schema. Future/private profile fields cannot cross pairing.
    try { const publicValue = { instructions: value.briefing.instructions, members: value.briefing.members?.map(member => ({ botId: member.botId, role: member.role, instructions: member.instructions })) }; briefing = teamBriefing(publicValue, memberIds, 502); } catch { /* Optional newer information cannot hide an otherwise readable team. */ }
  }
  return { id: value.id, name: text(value.name, 200), memberIds, coordinatorId: id(value.coordinatorId) ? value.coordinatorId : '', enabled: value.enabled === true, limits: continuousLimits(value.limits) ? Object.fromEntries(Object.keys(limits).map(key => [key, 0])) : Object.fromEntries(Object.entries(limits).filter(([k, [low, high]]) => Number.isSafeInteger(value.limits?.[k]) && value.limits[k] >= low && value.limits[k] <= high).map(([k]) => [k, value.limits[k]])), createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), ...(preview ? { channelPreview: preview } : {}), ...(briefing ? { briefing } : {}), ...(Number.isSafeInteger(value.revision) && value.revision > 0 ? { revision: value.revision } : {}), ...(execution(value.execution) ? { execution: execution(value.execution) } : {}) };
}
function run(value) {
  const fanout = Number.isSafeInteger(value.consumedTurns) && Number.isSafeInteger(value.rosterFanoutTurns) && value.rosterFanoutTurns >= 0 && value.rosterFanoutTurns <= value.consumedTurns ? { rosterFanoutTurns: value.rosterFanoutTurns } : {};
  return { id: value.id, teamId: id(value.teamId) ? value.teamId : '', rootChatId: id(value.rootChatId) ? value.rootChatId : '', rootBotId: id(value.rootBotId) ? value.rootBotId : '', state: states.has(value.state) ? value.state : 'interrupted', limits: team(value).limits, consumedTurns: Number.isInteger(value.consumedTurns) ? value.consumedTurns : 0, ...fanout, createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), ...(typeof value.detail === 'string' ? { detail: text(value.detail, 2_000) } : {}) };
}
function taskText(value, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || !value.isWellFormed() || !empty && !value.trim()) throw error(502, 'Strata returned unreadable task results.');
  return value;
}
function taskEvidence(value) {
  if (!Array.isArray(value) || value.length > 32) throw error(502, 'Strata returned unreadable task evidence.');
  return value.map(v => {
    if (!isObject(v) || !['file','test','link','note'].includes(v.kind)) throw error(502, 'Strata returned unreadable task evidence.');
    return {kind:v.kind,label:taskText(v.label,160),detail:taskText(v.detail,4000)};
  });
}
function taskWork(value) {
  if (!isObject(value) || !['working','ready_for_review','verified','blocked','interrupted'].includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision<1 || !Array.isArray(value.resultHistory) || value.resultHistory.length>16 || !Array.isArray(value.reviewHistory) || value.reviewHistory.length>32) throw error(502, 'Strata returned unreadable task review information.');
  const resultHistory = value.resultHistory.map(v => {
    if (!isObject(v) || !id(v.id) || !id(v.botId) || !date(v.submittedAt) || v.outcome!==undefined && !['ready_for_review','blocked'].includes(v.outcome)) throw error(502, 'Strata returned unreadable submitted results.');
    return {id:v.id,botId:v.botId,summary:taskText(v.summary,8000),evidence:taskEvidence(v.evidence),submittedAt:v.submittedAt,...(v.outcome?{outcome:v.outcome}:{})};
  });
  const reviewHistory = value.reviewHistory.map(v => {
    if (!isObject(v) || !id(v.resultId) || !['accept','reject'].includes(v.decision) || !date(v.reviewedAt)) throw error(502, 'Strata returned unreadable review history.');
    return {resultId:v.resultId,decision:v.decision,reviewedAt:v.reviewedAt,...(v.note!==undefined?{note:taskText(v.note,2500,true)}:{})};
  });
  const evidence = taskEvidence(value.evidence);
  if (value.status==='verified' && (!resultHistory.length || reviewHistory.at(-1)?.decision!=='accept' || reviewHistory.at(-1).resultId!==resultHistory.at(-1).id)) throw error(502, 'Strata returned an unverified task result.');
  if (value.legacy!==undefined && typeof value.legacy!=='boolean' || value.legacy===true && (['ready_for_review','verified'].includes(value.status) || resultHistory.length || reviewHistory.length || evidence.length || value.sourceJobId!==undefined || value.recoveryJobId!==undefined)) throw error(502, 'Strata returned inconsistent task history information.');
  return {status:value.status,revision:value.revision,evidence,resultHistory,reviewHistory,...(value.legacy!==undefined?{legacy:value.legacy}:{}),...(value.summary!==undefined?{summary:taskText(value.summary,8000)}:{}),...Object.fromEntries(['sourceJobId','recoveryJobId'].filter(key=>id(value[key])).map(key=>[key,value[key]]))};
}
function taskActivity(v) {
  return { id: v.id, type: ['run','delivery','subagent'].includes(v.type) ? v.type : 'run', teamId:id(v.teamId)?v.teamId:'',runId:id(v.runId)?v.runId:'',title:text(v.title,300),state:text(v.state,60),...Object.fromEntries(['botId','chatId','parentChatId','fromBotId','toBotId'].filter(k=>id(v[k])).map(k=>[k,v[k]])),createdAt:date(v.createdAt),updatedAt:date(v.updatedAt),...(typeof v.detail==='string'?{detail:text(v.detail,2000)}:{}),...(v.work!==undefined?{work:taskWork(v.work)}:{}) };
}
function taskRecovery(value,route) {
  if (!isObject(value) || !id(value.id) || value.jobId!==route.jobId || !id(value.sourceRunId) || !id(value.botId) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision<1 || typeof value.canResume!=='boolean' || !date(value.expiresAt) || !Array.isArray(value.completedReports) || value.completedReports.length>1000 || !Array.isArray(value.steps) || value.steps.length>32) throw error(502, 'Strata returned unreadable recovery information.');
  return {id:value.id,jobId:value.jobId,sourceRunId:value.sourceRunId,botId:value.botId,expectedRevision:value.expectedRevision,canResume:value.canResume,expiresAt:value.expiresAt,...Object.fromEntries(['botName','provider','model','computerLabel','workspace','summary'].map(key=>[key,taskText(value[key],key==='summary'?8000:key==='workspace'?4000:500,true)])),...(value.blockedReason!==undefined?{blockedReason:taskText(value.blockedReason,2500)}:{}),steps:value.steps.map(v=>taskText(v,2000)),completedReports:value.completedReports.map(v=>{if(!isObject(v)||!id(v.jobId)||!id(v.chatId))throw error(502,'Strata returned unreadable earlier results.');return{jobId:v.jobId,chatId:v.chatId,summary:taskText(v.summary,8000),...(id(v.reportId)?{reportId:v.reportId}:{})};})};
}
function channelSnapshot(value, route) {
  const invalid = () => { throw error(502, 'Strata returned unreadable team channel information.'); };
  if (!isObject(value) || value.teamId !== route.teamId || value.supported !== true || !Array.isArray(value.messages) || value.messages.length > 100 || !Array.isArray(value.activeRuns) || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 0 || typeof value.hasMore !== 'boolean' || typeof value.hasMoreBefore !== 'boolean') invalid();
  const seen = new Set(); let previous = 0;
  const messages = value.messages.map(v => {
    if (!isObject(v) || !id(v.id) || seen.has(v.id) || v.teamId !== route.teamId || !Number.isSafeInteger(v.sequence) || v.sequence <= previous || !['message', 'assignment', 'report', 'status'].includes(v.kind) || !isObject(v.author) || !['user', 'bot', 'system'].includes(v.author.type) || typeof v.author.name !== 'string' || !v.author.name.trim() || v.author.name.length > 200 || typeof v.content !== 'string' || v.content.length > 32_000 || v.content.includes('\0') || date(v.createdAt) === undefined || v.author.type === 'bot' && !id(v.author.botId)) invalid();
    seen.add(v.id); previous = v.sequence;
    for (const key of ['replyToId', 'runId', 'chatId']) if (v[key] !== undefined && !id(v[key])) invalid();
    if (v.recipientIds !== undefined && (!Array.isArray(v.recipientIds) || v.recipientIds.some(x => !id(x)) || new Set(v.recipientIds).size !== v.recipientIds.length)) invalid();
    if (v.workMode !== undefined && (v.author.type !== 'user' || !['chat', 'work'].includes(v.workMode))) invalid();
    let avatarConfig;
    if (v.author.avatarConfig !== undefined) { try { avatarConfig = botAvatarConfig(v.author.avatarConfig, 502); if (avatarConfig.shape === 'classic') delete avatarConfig.shape; } catch { /* Omit unavailable future artwork; never forward arbitrary assets or fields. */ } }
    return { id: v.id, sequence: v.sequence, teamId: v.teamId, kind: v.kind, author: { type: v.author.type, name: v.author.name, ...(v.author.type === 'bot' ? { botId: v.author.botId } : {}), ...(avatarConfig ? { avatarConfig } : {}) }, content: v.content, createdAt: date(v.createdAt), ...(v.workMode !== undefined ? { workMode: v.workMode } : {}), ...Object.fromEntries(['replyToId', 'runId', 'chatId'].filter(key => v[key] !== undefined).map(key => [key, v[key]])), ...(v.recipientIds ? { recipientIds: v.recipientIds } : {}), ...(['queued', 'working', 'done', 'error', 'interrupted', 'cancelled'].includes(v.state) ? { state: v.state } : {}) };
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
  const authorizationURL = connectorLink(value.authorizationURL), redirectURL = value.callbackTarget === 'iphone' && value.redirectURL === 'strata://connector-oauth/callback' ? value.redirectURL : connectorLink(value.redirectURL, true);
  return { status: ['not_connected', 'connected', 'connecting', 'waiting', 'expired', 'error'].includes(value.status) ? value.status : 'not_connected', detail: text(value.detail, 2000), ...(['mac', 'iphone'].includes(value.callbackTarget) ? { callbackTarget: value.callbackTarget } : {}), ...(authorizationURL ? { authorizationURL } : {}), ...(redirectURL ? { redirectURL } : {}), ...(date(value.expiresAt) !== undefined ? { expiresAt: date(value.expiresAt) } : {}) };
}
function connectorSource(value) {
  const safe = connectorLink(value);
  if (!safe) return undefined;
  const url = new URL(safe);
  return url.protocol === 'https:' && !url.search ? safe : undefined;
}
function connectorFeatures(value) {
  return isObject(value) ? { connectorFeatures: Object.fromEntries(['catalog', 'httpCreation', 'teamAccess', 'oauth', 'iphoneOAuth'].map(key => [key, value[key] === true])) } : {};
}
function connection(value) {
  let url; try { if (value.transport === 'http' && value.url) url = connectorURL(value.url, 502); } catch { /* Do not project malformed or credential-bearing URLs. */ }
  return { id: value.id, name: text(value.name, 200), transport: value.transport === 'http' ? 'http' : 'stdio', ...(url ? { url } : {}), ...(id(value.catalogId) ? { catalogId: value.catalogId } : {}), accountLabel: text(value.accountLabel, 120), authType: ['none', 'bearer', 'oauth'].includes(value.authType) ? value.authType : value.apiKeySet ? 'bearer' : 'none', enabled: value.enabled !== false, customInstructions: text(value.customInstructions, 8000), teamIds: safeIds(value.teamIds), ...(connectorAuth(value.auth) ? { auth: connectorAuth(value.auth) } : {}), oauthClientIdSet: value.oauthClientIdSet === true, oauthClientSecretSet: value.oauthClientSecretSet === true, apiKeySet: value.apiKeySet === true, inventoryDigest: typeof value.inventoryDigest === 'string' && /^[a-f0-9]{64}$/.test(value.inventoryDigest) ? value.inventoryDigest : '', botIds: safeIds(value.botIds), enabledToolIds: safeTools(value.enabledToolIds), readOnlyToolIds: safeTools(value.readOnlyToolIds), status: ['unchecked', 'starting', 'connected', 'unavailable'].includes(value.status) ? value.status : 'unchecked', detail: text(value.detail, 2_000), ...(date(value.checkedAt) !== undefined ? { checkedAt: date(value.checkedAt) } : {}), tools: (Array.isArray(value.tools) ? value.tools : []).filter(t => t && toolId(t.id)).slice(0, 256).map(t => ({ id: t.id, name: text(t.name, 300), description: text(t.description, 2_000), readOnly: t.readOnly === true })) };
}
function createdTool(value) {
  if (!isObject(value) || !/^tool_[a-f0-9-]{1,100}$/.test(value.id) || !['draft', 'enabled'].includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) throw error(502, 'Strata returned an unreadable reusable tool.');
  for (const [key, max] of [['name', 120], ['description', 2000], ['command', 32000]]) string(value[key], max, 502, key === 'description');
  createdToolSchema(value.inputSchema, 502);
  if (!Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 120) throw error(502, 'Strata returned an unreadable tool timeout.');
  ids(value.botIds, 502, id, 256); ids(value.teamIds, 502, id, 50);
  return { id: value.id, name: value.name, description: value.description, command: value.command, inputSchema: structuredClone(value.inputSchema), timeoutSeconds: value.timeoutSeconds, status: value.status, revision: value.revision, digest: value.digest, botIds: [...value.botIds], teamIds: [...value.teamIds], createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), ...(id(value.provenance?.botId) ? { provenance: { botId: value.provenance.botId } } : {}) };
}
export function publicBotWorkspace(body, route) {
  if (!isObject(body)) throw error(502, 'Strata returned unreadable workspace information.');
  if (['createdTools', 'createdTool'].includes(route.kind)) {
    if (route.kind === 'createdTools' && Array.isArray(body.tools) && body.tools.length <= 256) return { tools: body.tools.map(createdTool), createdToolsSupported: body.createdToolsSupported === true };
    if (body.tool && (!route.toolId || body.tool.id === route.toolId)) return { tool: createdTool(body.tool) };
    if (route.kind === 'createdTool' && (body.removed === true || body.deleted === true)) return { deleted: true };
    throw error(502, 'Strata returned unreadable reusable tools.');
  }
  const rows = (key, project, valid = id, max = 1_000) => {
    if (!Array.isArray(body[key])) throw error(502, 'Strata returned unreadable workspace information.');
    return body[key].filter(v => v && valid(v.id)).slice(0, max).map(project);
  };
  if (route.kind === 'channel') return channelSnapshot(body, route);
  if (route.kind === 'task') {
    if (route.action==='recovery') return {plan:taskRecovery(body.plan,route)};
    if (!isObject(body.activity) || !id(body.activity.id) || body.activity.teamId!==route.teamId || !body.activity.work) throw error(502, 'Strata returned an unrelated task.');
    if (route.action==='review' && body.activity.id!==route.jobId || route.action==='resume' && (body.activity.id===route.jobId || body.activity.work.sourceJobId!==route.jobId || !isObject(body.run) || body.run.teamId!==route.teamId || body.activity.runId!==body.run.id)) throw error(502, 'Strata returned an unrelated task action.');
    return {activity:taskActivity(body.activity),...(route.action==='resume'?{run:run(body.run)}:{})};
  }
  if (route.kind === 'channelMessage') return { channel: channelSnapshot(body.channel, route), ...(body.run && id(body.run.id) && body.run.teamId === route.teamId ? { run: run(body.run) } : {}) };
  if (route.kind === 'teams' && Array.isArray(body.teams)) return { teams: rows('teams', team), runs: rows('runs', run, id, Infinity), ...(body.teamUnrestrictedSupported === true ? { teamUnrestrictedSupported: true } : {}), ...(body.teamContinuousSupported === true ? { teamContinuousSupported: true } : {}), ...(body.teamWorkReviewSupported === true ? { teamWorkReviewSupported: true } : {}), ...(body.teamCoordinatorWorkToolsSupported === true ? { teamCoordinatorWorkToolsSupported: true } : {}), ...(body.channelsSupported === true ? { channelsSupported: true } : {}), ...(body.teamInstructionsSupported === true ? { teamInstructionsSupported: true } : {}), ...(body.teamSettingsSupported === true ? { teamSettingsSupported: true, teamComputers: (Array.isArray(body.teamComputers) ? body.teamComputers : []).slice(0, 1000).map(teamComputer).filter(Boolean) } : {}) };
  if (body.team && id(body.team.id)) return { team: team(body.team) };
  if (body.run && id(body.run.id)) return { run: run(body.run) };
  if (route.kind === 'activity') return { activity: rows('activity', taskActivity), ...(body.teamWorkReviewSupported === true ? {teamWorkReviewSupported:true} : {}) };
  if (route.kind === 'supervision') {
    const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
    const sessions = rows('sessions', v => ({ id: v.id, botId: v.botId, name: text(v.name, 120), title: text(v.title, 300), state: v.state, approvalCount: count(v.approvalCount),
      ...(typeof v.toolName === 'string' ? { toolName: text(v.toolName, 120) } : {}), ...(typeof v.computerName === 'string' ? { computerName: text(v.computerName, 120) } : {}),
      ...Object.fromEntries(['teamId', 'parentChatId'].filter(k => id(v[k])).map(k => [k, v[k]])), updatedAt: date(v.updatedAt) }))
      .filter(v => id(v.botId) && ['approval', 'error', 'working', 'thinking', 'completed'].includes(v.state) && (v.state !== 'approval' || v.approvalCount > 0)).slice(0, 200);
    return { supported: body.supported === true, sessions: body.supported === true ? sessions : [], counts: Object.fromEntries(['waiting', 'working', 'completed', 'errors'].map(key => [key, count(body.counts?.[key])])), hasMore: body.hasMore === true, updatedAt: date(body.updatedAt) };
  }
  if (route.kind === 'skills' && Array.isArray(body.skills)) return { skills: rows('skills', skill, toolId), assignments: (Array.isArray(body.assignments) ? body.assignments : []).filter(v => id(v?.botId)).slice(0, 500).map(v => ({ botId: v.botId, skillIds: safeTools(v.skillIds) })) };
  if (body.skill && id(body.skill.id)) return { skill: skill(body.skill) };
  if (route.kind === 'assignment') return { saved: true };
  if (route.kind === 'connectorCatalog') return { connectors: rows('connectors', value => ({ id: value.id, name: text(value.name, 120), description: text(value.description, 2000), category: text(value.category, 120), ...(Array.isArray(value.aliases) ? { aliases: value.aliases.filter(label => typeof label === 'string').slice(0, 32).map(label => text(label, 120)) } : {}), transport: 'http', ...(connectorLink(value.url) ? { url: connectorLink(value.url) } : {}), authTypes: (Array.isArray(value.authTypes) ? value.authTypes : []).filter(kind => ['none', 'bearer', 'oauth'].includes(kind)), ...(connectorLink(value.documentationURL) ? { documentationURL: connectorLink(value.documentationURL) } : {}), ...(connectorSource(value.sourceURL) ? { sourceURL: connectorSource(value.sourceURL) } : {}), ...(value.setupState !== undefined ? { setupState: ['ready', 'configuration', 'managed', 'unavailable'].includes(value.setupState) ? value.setupState : 'unavailable' } : {}), ...(typeof value.phoneSignIn === 'boolean' ? { phoneSignIn: value.phoneSignIn } : {}), setupNote: text(value.setupNote, 2000) })), ...connectorFeatures(body.connectorFeatures) };
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
  const toolDeletion = route.kind === 'createdTool' && method === 'DELETE';
  if (['GET', 'DELETE'].includes(method) && !toolDeletion && (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'])) throw error(400, 'This action does not accept settings.');
  const body = ['POST', 'PATCH'].includes(method) || toolDeletion ? await readBody(req, ['createdTools', 'createdTool'].includes(route.kind) ? 256_000 : ['teams', 'team'].includes(route.kind) ? 240_000 : 70_000) : undefined;
  botWorkspaceRequest(upstreamPath, method, body, 400);
  requireCurrentSession();
  try {
    let teamCatalog;
    const currentTeams = async () => { if (!teamCatalog) { teamCatalog = await host.json('/api/bots/teams'); requireCurrentSession(); } return teamCatalog; };
    if (['createdTools', 'createdTool'].includes(route.kind) && method !== 'GET') {
      const catalog = await host.json('/api/bots/tools'); requireCurrentSession();
      if (catalog.createdToolsSupported !== true || !Array.isArray(catalog.tools)) throw error(409, 'Update Strata on your Mac before managing reusable tools.');
      if (route.toolId) {
        const selected = catalog.tools.find(tool => tool.id === route.toolId);
        if (!selected) throw error(404, 'This tool is no longer available.');
        if (selected.revision !== body.expectedRevision || selected.digest !== body.expectedDigest) throw error(409, 'This tool changed. Review its current version before saving.');
      }
      if (body?.botIds !== undefined) {
        const catalog = await host.json('/api/bots'); requireCurrentSession();
        const current = new Set((catalog.bots ?? []).map(bot => bot.id));
        if (body.botIds.some(botId => !current.has(botId))) throw error(409, 'Refresh the saved bots before changing tool access.');
      }
      if (body?.teamIds !== undefined) {
        const catalog = await currentTeams();
        const current = new Set((catalog.teams ?? []).map(team => team.id));
        if (body.teamIds.some(teamId => !current.has(teamId))) throw error(409, 'Refresh the saved teams before changing tool access.');
      }
    }
    if (['teams', 'team'].includes(route.kind) && continuousLimits(body?.limits)) {
      const catalog = await currentTeams();
      if (catalog.teamContinuousSupported !== true) throw error(409, 'Update Strata on your Mac before changing continuous team work.');
    }
    if (route.kind === 'channelMessage') {
      const catalog = await currentTeams();
      if (body.workMode !== undefined && catalog.teamCoordinatorWorkToolsSupported !== true) throw error(409, 'Update Strata on your Mac before choosing Chat or Work for a team message.');
      const selected = (catalog.teams ?? []).find(team => team.id === route.teamId);
      const members = new Set(Array.isArray(selected?.memberIds) ? selected.memberIds : []);
      if (!selected || !selected.enabled || body.recipientIds?.some(botId => !members.has(botId))) throw error(409, 'Refresh this team and choose its available members.');
    }
    if (['teams', 'team'].includes(route.kind) && body?.briefing !== undefined) {
      const catalog = await currentTeams();
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
      if (route.kind === 'connectionAuth' && body?.callbackTarget === 'iphone' && catalog.connectorFeatures?.iphoneOAuth !== true) throw error(409, 'Update Strata on your Mac before signing in on iPhone.');
      if (route.kind === 'connectionAuth' && route.action === 'auth/cancel' && catalog.connectorFeatures?.iphoneOAuth !== true) throw error(409, 'Update Strata on your Mac before cancelling sign-in from iPhone.');
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
        if (callback.protocol !== expected.protocol || callback.host !== expected.host || callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.protocol === 'strata:' && (catalog.connectorFeatures?.iphoneOAuth !== true || selected.auth?.callbackTarget !== 'iphone' || selected.auth?.redirectURL !== 'strata://connector-oauth/callback')) throw error(409, 'Use this connector’s current sign-in callback.');
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
      const empty = { teams: { teams: [], runs: [] }, channel: { teamId: route.teamId, supported: false, messages: [], activeRuns: [], nextSequence: 0, hasMore: false, hasMoreBefore: false }, activity: { activity: [] }, supervision: { supported: false, sessions: [], counts: { waiting: 0, working: 0, completed: 0, errors: 0 }, hasMore: false }, skills: { skills: [], assignments: [] }, createdTools: { tools: [], createdToolsSupported: false }, connections: { connections: [] }, providerModels: { provider: route.provider, models: [] } }[route.kind];
      if (empty) { sendJSON(res, 200, { ...empty, reason: 'Update Strata on your Mac to use this Bots feature.' }); return true; }
    }
    const status = [400, 404, 409, 413, 501].includes(failure.status) ? failure.status : 503;
    throw error(status, status === 409 ? 'Refresh this item and review its current settings before trying again.' : status === 404 ? 'This item is no longer available. Refresh Bots.' : 'Strata could not complete this action. Check the Mac and refresh before retrying.');
  }
}
