// Narrow paired-phone surface for durable teams, reviewed skills and saved MCP
// connections. Program paths, connection secrets and arbitrary tools stay on Mac.
const error = (status, message) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
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
  else {
    const team = /^\/api\/bots\/teams\/([A-Za-z0-9_-]{1,120})(?:\/runs(?:\/([A-Za-z0-9_-]{1,120})(?:\/(stop))?)?)?$/.exec(p);
    const skill = /^\/api\/bots\/skills\/([A-Za-z0-9_-]{1,120})$/.exec(p);
    const connection = /^\/api\/bots\/connections\/([A-Za-z0-9_-]{1,120})(?:\/(check))?$/.exec(p);
    if (team) route = { kind: p.includes('/runs') ? 'run' : 'team', teamId: team[1], runId: team[2], action: team[3] };
    else if (skill) route = { kind: 'skill', skillId: skill[1] };
    else if (connection) route = { kind: 'connection', connectionId: connection[1], action: connection[2] };
    else return null;
  }
  if (query.length) {
    if (query.length !== 1 || method !== 'GET') throw error(status, 'Unsupported workspace query.');
    const [key, value] = query[0];
    if (route.kind === 'skills' && key === 'botId' && id(value)) route.botId = value;
    else if (route.kind === 'providerModels' && key === 'provider' && ['claude', 'codex', 'grok', 'kimi', 'ollama', 'configured'].includes(value)) route.provider = value;
    else throw error(status, 'Choose a saved bot or provider.');
  } else if (route.kind === 'providerModels') throw error(status, 'Choose a provider.');
  const allowed = { teams: ['GET', 'POST'], team: ['PATCH'], run: route.action === 'stop' ? ['POST'] : route.runId ? ['GET'] : ['POST'], activity: ['GET'], skills: ['GET', 'POST'], skill: ['PATCH', 'DELETE'], assignment: ['POST'], connections: ['GET'], connection: route.action ? ['POST'] : ['PATCH', 'DELETE'], providerModels: ['GET'] };
  if (!allowed[route.kind].includes(method)) throw error(status, 'This workspace action is unavailable from iPhone.');
  if (!validateBody) return route;
  if (method === 'GET' || method === 'DELETE') {
    if (body !== undefined) throw error(status, 'This action does not accept settings.');
    return route;
  }
  if (route.kind === 'teams' || route.kind === 'team') {
    object(body, ['name', 'memberIds', 'coordinatorId', 'enabled', 'limits'], status);
    if (method === 'POST' || body.name !== undefined) string(body.name, 80, status);
    if (method === 'POST' || body.memberIds !== undefined) { ids(body.memberIds, status, id, 12); if (body.memberIds.length < 2) throw error(status, 'Choose at least two bots.'); }
    if (method === 'POST' || body.coordinatorId !== undefined) if (!id(body.coordinatorId)) throw error(status, 'Choose a coordinator.');
    if (body.memberIds && body.coordinatorId && !body.memberIds.includes(body.coordinatorId)) throw error(status, 'The coordinator must be a team member.');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw error(status, 'Review whether this team is enabled.');
    if (body.limits !== undefined) {
      object(body.limits, Object.keys(limits), status);
      for (const [key, value] of Object.entries(body.limits)) if (!Number.isInteger(value) || value < limits[key][0] || value > limits[key][1]) throw error(status, 'Choose supported team limits.');
    }
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
  } else if (route.kind === 'connection') {
    object(body, route.action ? [] : ['name', 'botIds', 'enabledToolIds', 'readOnlyToolIds', 'expectedInventoryDigest'], status);
    if (body.name !== undefined) string(body.name, 120, status);
    if (body.botIds !== undefined) ids(body.botIds, status);
    for (const key of ['enabledToolIds', 'readOnlyToolIds']) if (body[key] !== undefined) ids(body[key], status, toolId, 256);
    if ((body.expectedInventoryDigest !== undefined || ['botIds', 'enabledToolIds', 'readOnlyToolIds'].some(key => body[key] !== undefined)) && (typeof body.expectedInventoryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedInventoryDigest))) throw error(status, 'Review the current connection tools before changing access.');
  }
  return route;
}
const safeIds = value => (Array.isArray(value) ? value : []).filter(id).slice(0, 500);
const safeTools = value => (Array.isArray(value) ? value : []).filter(toolId).slice(0, 1_000);
function team(value) {
  return { id: value.id, name: text(value.name, 200), memberIds: safeIds(value.memberIds), coordinatorId: id(value.coordinatorId) ? value.coordinatorId : '', enabled: value.enabled === true, limits: Object.fromEntries(Object.entries(limits).filter(([k, [low, high]]) => Number.isInteger(value.limits?.[k]) && value.limits[k] >= low && value.limits[k] <= high).map(([k]) => [k, value.limits[k]])), createdAt: date(value.createdAt), updatedAt: date(value.updatedAt) };
}
function run(value) {
  return { id: value.id, teamId: id(value.teamId) ? value.teamId : '', rootChatId: id(value.rootChatId) ? value.rootChatId : '', rootBotId: id(value.rootBotId) ? value.rootBotId : '', state: states.has(value.state) ? value.state : 'interrupted', limits: team(value).limits, consumedTurns: Number.isInteger(value.consumedTurns) ? value.consumedTurns : 0, createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), ...(typeof value.detail === 'string' ? { detail: text(value.detail, 2_000) } : {}) };
}
function skill(value) {
  return { id: value.id, name: text(value.name, 200), description: text(value.description, 2_000), body: text(value.body, 64_000), triggers: (Array.isArray(value.triggers) ? value.triggers : []).filter(t => typeof t === 'string').slice(0, 50).map(t => text(t, 200)), source: value.source === 'library' ? 'library' : 'draft', status: value.status === 'enabled' ? 'enabled' : 'draft', revision: Number.isInteger(value.revision) ? value.revision : text(value.revision, 128), digest: text(value.digest, 128), botIds: safeIds(value.botIds) };
}
function connection(value) {
  return { id: value.id, name: text(value.name, 200), transport: value.transport === 'http' ? 'http' : 'stdio', apiKeySet: value.apiKeySet === true, inventoryDigest: typeof value.inventoryDigest === 'string' && /^[a-f0-9]{64}$/.test(value.inventoryDigest) ? value.inventoryDigest : '', botIds: safeIds(value.botIds), enabledToolIds: safeTools(value.enabledToolIds), readOnlyToolIds: safeTools(value.readOnlyToolIds), status: ['unchecked', 'starting', 'connected', 'unavailable'].includes(value.status) ? value.status : 'unchecked', detail: text(value.detail, 2_000), ...(date(value.checkedAt) !== undefined ? { checkedAt: date(value.checkedAt) } : {}), tools: (Array.isArray(value.tools) ? value.tools : []).filter(t => t && toolId(t.id)).slice(0, 256).map(t => ({ id: t.id, name: text(t.name, 300), description: text(t.description, 2_000), readOnly: t.readOnly === true })) };
}
export function publicBotWorkspace(body, route) {
  if (!isObject(body)) throw error(502, 'Strata returned unreadable workspace information.');
  const rows = (key, project, valid = id) => {
    if (!Array.isArray(body[key])) throw error(502, 'Strata returned unreadable workspace information.');
    return body[key].filter(v => v && valid(v.id)).slice(0, 1_000).map(project);
  };
  if (route.kind === 'teams' && Array.isArray(body.teams)) return { teams: rows('teams', team), runs: rows('runs', run) };
  if (body.team && id(body.team.id)) return { team: team(body.team) };
  if (body.run && id(body.run.id)) return { run: run(body.run) };
  if (route.kind === 'activity') return { activity: rows('activity', v => ({ id: v.id, type: ['run', 'delivery', 'subagent'].includes(v.type) ? v.type : 'run', teamId: id(v.teamId) ? v.teamId : '', runId: id(v.runId) ? v.runId : '', title: text(v.title, 300), state: text(v.state, 60), ...Object.fromEntries(['botId', 'chatId', 'parentChatId', 'fromBotId', 'toBotId'].filter(k => id(v[k])).map(k => [k, v[k]])), createdAt: date(v.createdAt), updatedAt: date(v.updatedAt), ...(typeof v.detail === 'string' ? { detail: text(v.detail, 2_000) } : {}) })) };
  if (route.kind === 'skills' && Array.isArray(body.skills)) return { skills: rows('skills', skill, toolId), assignments: (Array.isArray(body.assignments) ? body.assignments : []).filter(v => id(v?.botId)).slice(0, 500).map(v => ({ botId: v.botId, skillIds: safeTools(v.skillIds) })) };
  if (body.skill && id(body.skill.id)) return { skill: skill(body.skill) };
  if (route.kind === 'assignment') return { saved: true };
  if (route.kind === 'connections' && Array.isArray(body.connections)) return { connections: rows('connections', connection) };
  if (body.connection && id(body.connection.id)) return { connection: connection(body.connection) };
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
  const body = ['POST', 'PATCH'].includes(method) ? await readBody(req, 70_000) : undefined;
  botWorkspaceRequest(upstreamPath, method, body, 400);
  requireCurrentSession();
  try {
    if ((route.kind === 'teams' || route.kind === 'team') && (body?.memberIds || body?.coordinatorId) || route.kind === 'assignment' || route.kind === 'connection' && body?.botIds) {
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
      } else if (body.skillIds.some(skillId => !skills.some(skill => skill.id === skillId && skill.status === 'enabled'))) throw error(409, 'Review and enable skills before assigning them.');
    }
    if (route.kind === 'connection') {
      const catalog = await host.json('/api/bots/connections'); requireCurrentSession();
      const selected = (catalog.connections ?? []).find(connection => connection.id === route.connectionId);
      if (!selected) throw error(404, 'This connection is no longer available.');
      if (body?.expectedInventoryDigest !== undefined && body.expectedInventoryDigest !== selected.inventoryDigest) throw error(409, 'This connection changed. Review its current tools before saving access.');
      const known = new Set((selected.tools ?? []).map(tool => tool.id));
      if (body?.enabledToolIds?.some(tool => !known.has(tool))) throw error(409, 'Check this connection and review its current tools.');
      const readonly = new Set(selected.readOnlyToolIds ?? []);
      if (body?.readOnlyToolIds?.some(tool => !readonly.has(tool) || !known.has(tool) || body.enabledToolIds && !body.enabledToolIds.includes(tool))) throw error(409, 'Classify read-only tools deliberately on your Mac.');
    }
    requireCurrentSession();
    const result = await host.json(upstreamPath, { method, ...(body !== undefined ? { body } : {}), deviceId: session.id });
    requireCurrentSession();
    sendJSON(res, 200, publicBotWorkspace(result, route));
    return true;
  } catch (failure) {
    requireCurrentSession();
    if ([404, 405, 501].includes(failure.status) && method === 'GET') {
      const empty = { teams: { teams: [], runs: [] }, activity: { activity: [] }, skills: { skills: [], assignments: [] }, connections: { connections: [] }, providerModels: { provider: route.provider, models: [] } }[route.kind];
      if (empty) { sendJSON(res, 200, { ...empty, reason: 'Update Strata on your Mac to use this Bots feature.' }); return true; }
    }
    const status = [400, 404, 409, 413, 501].includes(failure.status) ? failure.status : 503;
    throw error(status, status === 409 ? 'Refresh this item and review its current settings before trying again.' : status === 404 ? 'This item is no longer available. Refresh Bots.' : 'Strata could not complete this action. Check the Mac and refresh before retrying.');
  }
}
