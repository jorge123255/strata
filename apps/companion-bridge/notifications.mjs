/** A paired device can manage only its own notification cursor, preferences and registration. */
const fail = (status, message) => Object.assign(new Error(message), { status });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const keys = new Set(['enabled', 'replies', 'teams', 'work', 'approvals', 'previews', 'sound', 'muted']);
const states = new Set(['reply', 'team_message', 'completed', 'failed', 'approval']);
export function notificationRoute(path, method) {
  const url = new URL(path, 'http://bridge.invalid');
  const match = /^\/api\/bots\/notifications(?:\/(settings|registration|device))?$/.exec(url.pathname);
  if (!match) return null;
  const action = match[1];
  if (!action && method !== 'GET' || action === 'settings' && method !== 'POST' || action === 'registration' && !['POST', 'DELETE'].includes(method) || action === 'device' && method !== 'DELETE') throw fail(405, 'This notification action is unavailable.');
  const params = [...url.searchParams];
  if (action && params.length || params.length > 2 || new Set(params.map(([key]) => key)).size !== params.length || params.some(([key, value]) => key === 'after' ? !/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value)) : key !== 'journalId' || !validId(value))) throw fail(400, 'Choose a valid notification cursor.');
  return { action, path: url.pathname + url.search };
}
export function notificationRequest(path, method, body, owner) {
  const route = notificationRoute(path, method);
  if (!route) return null;
  if (!/^[a-f0-9]{32}$/.test(owner ?? '')) throw fail(403, 'Choose this paired iPhone.');
  if (method === 'GET' || method === 'DELETE') { if (body !== undefined) throw fail(400, 'This notification action has no body.'); return route; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Send valid notification settings.');
  if (route.action === 'settings') {
    if (Object.keys(body).some(key => !keys.has(key)) || Object.entries(body).some(([key, value]) => key === 'muted' ? !Array.isArray(value) || value.length > 200 || value.some(item => typeof item !== 'string' || !/^(chat|team):[A-Za-z0-9_.:-]{1,160}$/.test(item)) || new Set(value).size !== value.length : typeof value !== 'boolean')) throw fail(400, 'Choose valid notification settings.');
  } else if (Object.keys(body).length !== 2 || typeof body.token !== 'string' || !/^[a-fA-F0-9]{32,256}$/.test(body.token) || !['sandbox', 'production'].includes(body.environment)) throw fail(400, 'Send a valid Apple push registration.');
  return route;
}
function preferences(value) {
  if (!value || [...keys].some(key => key === 'muted' ? !Array.isArray(value[key]) || value[key].length > 200 || value[key].some(item => typeof item !== 'string' || !/^(chat|team):[A-Za-z0-9_.:-]{1,160}$/.test(item)) : typeof value[key] !== 'boolean')) throw fail(502, 'Strata returned invalid notification settings.');
  return Object.fromEntries([...keys].map(key => [key, structuredClone(value[key])]));
}
function event(value) {
  if (!validId(value?.id) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !states.has(value.kind) || !Number.isFinite(Date.parse(value.createdAt)) || !['chat', 'team'].includes(value.destination?.type) || !validId(value.destination.id) || typeof value.title !== 'string' || value.title.length > 160 || typeof value.body !== 'string' || value.body.length > 600) throw fail(502, 'Strata returned an invalid notification.');
  return { id: value.id, sequence: value.sequence, kind: value.kind, createdAt: value.createdAt, title: value.title, body: value.body, destination: { type: value.destination.type, id: value.destination.id }, ...(validId(value.botId) ? { botId: value.botId } : {}) };
}
export function notificationResponse(value, registration = false) {
  if (registration) {
    if (typeof value?.registered !== 'boolean' || typeof value.configured !== 'boolean' || typeof value.detail !== 'string') throw fail(502, 'Strata returned invalid push status.');
    return { registered: value.registered, configured: value.configured, detail: value.detail.slice(0, 600) };
  }
  if (value?.supported !== true || !validId(value.journalId) || ![value.cursor, value.nextCursor].every(number => Number.isSafeInteger(number) && number >= 0) || value.nextCursor > value.cursor || typeof value.hasMore !== 'boolean' || !Array.isArray(value.events) || value.events.length > 100 || typeof value.push?.configured !== 'boolean' || typeof value.push.detail !== 'string') throw fail(502, 'Strata returned invalid notification status.');
  const events = value.events.map(event);
  if (events.some((row, index) => row.sequence > value.nextCursor || index > 0 && row.sequence <= events[index - 1].sequence)) throw fail(502, 'Strata returned an invalid notification cursor.');
  return { supported: true, journalId: value.journalId, cursor: value.cursor, nextCursor: value.nextCursor, hasMore: value.hasMore, ...(value.baseline === true ? { baseline: true } : {}), events, settings: preferences(value.settings), capabilities: { previews: false }, push: { configured: value.push.configured, detail: value.push.detail.slice(0, 600), ...(typeof value.push.registered === 'boolean' ? { registered: value.push.registered } : {}) } };
}
export async function handleNotifications({ path, method, req, res, session, host, readBody, sendJSON, requireCurrentSession }) {
  const apiPath = path.replace(/^\/v1\/notifications/, '/api/bots/notifications');
  const route = notificationRoute(apiPath, method);
  if (!route || route.action === 'device') throw fail(404, 'Unknown companion endpoint.');
  const body = method === 'POST' ? await readBody(req, 64 * 1024) : undefined;
  notificationRequest(apiPath, method, body, session.id); requireCurrentSession();
  const response = await host.json(apiPath, { method, ...(body !== undefined ? { body } : {}), deviceId: session.id });
  requireCurrentSession();
  sendJSON(res, 200, notificationResponse(response, route.action === 'registration'));
}
