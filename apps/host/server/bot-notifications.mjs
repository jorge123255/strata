/** Durable, opt-in alerts derived from saved conversations and public team messages. */
import { randomUUID, createHash } from 'node:crypto';
import { privateExtensionStore } from './bots-extension-store.mjs';
import { isLocalCompanionRequest } from './companion-routes.mjs';
import { json, error, readBody } from './util.mjs';
import { createApnsSender } from './bot-notifications-apns.mjs';
import { createNativeNotifications } from './bot-notifications-native.mjs';

const copy = value => structuredClone(value);
const fault = (status, message) => Object.assign(new Error(message), { status });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const deviceId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const seq = value => Number.isSafeInteger(value) && value >= 0;
export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({ enabled: false, replies: true, teams: true, work: true, approvals: true, previews: false, sound: true, muted: [] });
const kinds = new Set(['reply', 'team_message', 'completed', 'failed', 'approval']);
const generic = { reply: ['New reply', 'A new reply is ready in Strata.'], team_message: ['Team update', 'A teammate posted a message in Strata.'], completed: ['Work completed', 'Bot work finished. Open Strata to see the result.'], failed: ['Work needs attention', 'Bot work needs attention. Open Strata to review it.'], approval: ['Approval needed', 'Strata is waiting for your approval. Open the conversation to review the action.'] };
export function notificationSettings(input, previous = DEFAULT_NOTIFICATION_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_NOTIFICATION_SETTINGS, key))) throw fault(400, 'Choose valid notification settings.');
  const result = { ...copy(previous) };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'muted') {
      if (!Array.isArray(value) || value.length > 200 || value.some(item => typeof item !== 'string' || !/^(chat|team):[A-Za-z0-9_.:-]{1,160}$/.test(item)) || new Set(value).size !== value.length) throw fault(400, 'Choose valid muted conversations.');
      result.muted = copy(value);
    } else { if (typeof value !== 'boolean') throw fault(400, 'Choose valid notification settings.'); result[key] = value; }
  }
  return result;
}
const eligible = (event, settings) => settings.enabled && !settings.muted.includes(`${event.destination.type}:${event.destination.id}`) && !(event.teamId && settings.muted.includes(`team:${event.teamId}`)) && (event.kind === 'approval' ? settings.approvals : event.kind === 'reply' ? settings.replies : event.kind === 'team_message' ? settings.teams : settings.work);
const publicEvent = event => Object.fromEntries(['id', 'sequence', 'kind', 'createdAt', 'title', 'body', 'destination', 'botId'].filter(key => event[key] !== undefined).map(key => [key, copy(event[key])]));
const sourceIdentity = (type, ...ids) => `nt_${createHash('sha256').update(JSON.stringify([type, ...ids])).digest('hex')}`;
const safeEvent = value => validId(value?.id) && seq(value.sequence) && value.sequence > 0 && kinds.has(value.kind) && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && value.title === generic[value.kind][0] && value.body === generic[value.kind][1] && ['chat', 'team'].includes(value.destination?.type) && validId(value.destination.id) && (value.teamId === undefined || validId(value.teamId)) && (value.botId === undefined || validId(value.botId));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createBotNotifications({ directory, sources = () => ({ conversations: [], teams: [], approvals: [] }), apns = createApnsSender({ directory }), native = createNativeNotifications(), deviceAuthority = () => ({ available: false, ids: [] }), now = Date.now, intervalMs = 1000, start = true } = {}) {
  const initial = { version: 1, journalId: `nj_${randomUUID()}`, nextSequence: 1, cutoverAt: new Date(now()).toISOString(), seeded: false, events: [], chatHeads: {}, teamHeads: {}, approvalKeys: [], clients: { desktop: { settings: copy(DEFAULT_NOTIFICATION_SETTINGS), baseline: 0, generation: 0 } }, registrations: {}, desktopDelivered: [], desktopCursor: 0 };
  let storage, state, unavailable = false;
  try {
    storage = privateExtensionStore(directory, 'bot-notifications.json', initial); state = storage.value;
    if (!validId(state.journalId) || !seq(state.nextSequence) || state.nextSequence < 1 || typeof state.seeded !== 'boolean' || !Number.isFinite(Date.parse(state.cutoverAt)) || !Array.isArray(state.events) || state.events.length > 2000 || state.events.some((event, index) => !safeEvent(event) || event.sequence >= state.nextSequence || index > 0 && event.sequence <= state.events[index - 1].sequence) || new Set(state.events.map(event => event.id)).size !== state.events.length || !record(state.chatHeads) || Object.keys(state.chatHeads).length > 10000 || Object.entries(state.chatHeads).some(([id, head]) => !validId(id) || head !== null && !validId(head)) || !record(state.teamHeads) || Object.keys(state.teamHeads).length > 50 || Object.entries(state.teamHeads).some(([id, head]) => !validId(id) || !seq(head)) || !Array.isArray(state.approvalKeys) || state.approvalKeys.length > 20000 || state.approvalKeys.some(key => !validId(key)) || !record(state.clients) || Object.keys(state.clients).length > 21 || !record(state.registrations) || Object.keys(state.registrations).length > 20 || !Array.isArray(state.desktopDelivered) || state.desktopDelivered.length > 2000 || state.desktopDelivered.some(id => !validId(id)) || !seq(state.desktopCursor)) throw new Error();
    for (const [id, client] of Object.entries(state.clients)) if (id !== 'desktop' && !deviceId(id) || !seq(client.baseline) || client.generation !== undefined && !seq(client.generation) || !record(client.settings) || Object.keys(client.settings).length !== Object.keys(DEFAULT_NOTIFICATION_SETTINGS).length || !notificationSettings(client.settings)) throw new Error();
    for (const [id, registration] of Object.entries(state.registrations)) if (!deviceId(id) || !/^[a-f0-9]{32,256}$/.test(registration.token ?? '') || !['sandbox', 'production'].includes(registration.environment) || !seq(registration.cursor)) throw new Error();
  } catch { state = copy(initial); unavailable = true; }
  let timer, scheduled = false, closed = false, pumping = false, desktopPumping = false;
  const retries = new Map(), inFlight = new Set();
  const current = () => state.nextSequence - 1;
  const requireReady = () => { if (unavailable) throw fault(503, 'Saved notifications could not be read. Existing bot work and notification files were left unchanged.'); };
  function persist() { storage.save(state); }
  function client(id) {
    if (id !== 'desktop' && !deviceId(id)) throw fault(403, 'Choose this paired device.');
    return state.clients[id] ?? { settings: copy(DEFAULT_NOTIFICATION_SETTINGS), baseline: current(), generation: 0 };
  }
  function append(kind, destination, key, botId, createdAt, teamId) {
    if (!kinds.has(kind) || !validId(destination.id)) return;
    const id = sourceIdentity(key);
    if (state.events.some(event => event.id === id)) return;
    const [title, body] = generic[kind];
    state.events.push({ id, sequence: state.nextSequence++, kind, createdAt: Number.isFinite(Date.parse(createdAt)) ? createdAt : new Date(now()).toISOString(), title, body, destination: copy(destination), ...(validId(botId) ? { botId } : {}), ...(validId(teamId) ? { teamId } : {}) });
    if (state.events.length > 2000) state.events.splice(0, state.events.length - 2000);
  }
  function reconcile() {
    if (closed || unavailable) return;
    const before = copy(state);
    try {
      const snapshot = sources(copy(state.teamHeads));
      const baseline = !state.seeded;
      for (const chat of (snapshot.conversations ?? []).slice(0, 10000)) {
        if (!validId(chat?.id) || !Array.isArray(chat.messages)) continue;
        const terminal = chat.messages.filter(message => message.role === 'assistant' && message.streaming !== true && validId(message.id));
        const known = Object.hasOwn(state.chatHeads, chat.id), old = state.chatHeads[chat.id], index = old ? terminal.findIndex(message => message.id === old) : -1;
        const created = !known && Date.parse(chat.createdAt) >= Date.parse(state.cutoverAt);
        const fresh = baseline || old && index < 0 || !known && !created ? [] : terminal.slice(index + 1, index + 101);
        // A private team worker's completion is represented only by its public journal message.
        if (!chat.preferences?.teamId) for (const message of fresh) {
          const routineCompletion = chat.routine && message.id === chat.messages[0]?.id;
          if (routineCompletion && chat.notifyOnCompletion !== true || message.cancelled || !message.error && message.hasContent === false) continue;
          append(message.error ? 'failed' : routineCompletion ? 'completed' : 'reply', { type: 'chat', id: chat.id }, `chat:${chat.id}:${message.id}`, chat.preferences?.botId, message.at);
        }
        state.chatHeads[chat.id] = fresh.at(-1)?.id ?? terminal.at(-1)?.id ?? null;
      }
      for (const team of (snapshot.teams ?? []).slice(0, 50)) {
        if (!validId(team?.id) || !Array.isArray(team.messages)) continue;
        const head = state.teamHeads[team.id] ?? 0;
        for (const message of team.messages) {
          if (!seq(message.sequence) || message.sequence <= head || !validId(message.id)) continue;
          if (!baseline && (message.author?.type === 'bot' || message.author?.type === 'system' && message.state === 'error')) {
            const kind = message.state === 'error' ? 'failed' : message.kind === 'report' ? 'completed' : message.kind === 'message' ? 'team_message' : null;
            if (kind) append(kind, { type: 'team', id: team.id }, `team:${team.id}:${message.id}`, message.author.botId, message.createdAt);
          }
          state.teamHeads[team.id] = Math.max(state.teamHeads[team.id] ?? 0, message.sequence);
        }
        if (baseline && seq(team.latestSequence)) state.teamHeads[team.id] = team.latestSequence;
        else if (!Object.hasOwn(state.teamHeads, team.id)) state.teamHeads[team.id] = head;
      }
      for (const request of (snapshot.approvals ?? []).slice(0, 10000)) {
        if (!validId(request.chatId) || !validId(request.id)) continue;
        const key = sourceIdentity('approval', request.chatId, request.id);
        if (state.approvalKeys.includes(key)) continue;
        state.approvalKeys.push(key);
        if (!baseline) append('approval', { type: 'chat', id: request.chatId }, key, request.botId, undefined, request.teamId);
      }
      if (state.approvalKeys.length > 20000) state.approvalKeys.splice(0, state.approvalKeys.length - 20000);
      state.seeded = true;
      if (JSON.stringify(state) !== JSON.stringify(before)) persist();
    } catch { state = before; /* Alerts must never fail or replay a bot action. A later tick reconciles saved source IDs. */ }
    void pump();
    void pumpDesktop();
  }
  function schedule() { if (!scheduled && !closed) { scheduled = true; queueMicrotask(() => { scheduled = false; reconcile(); }); } }
  async function pump() {
    if (pumping || closed || unavailable || !apns.status().configured) return;
    pumping = true;
    try {
      for (const [id, registration] of Object.entries(state.registrations)) {
        const authority = deviceAuthority();
        if (!authority.available) continue;
        if (!authority.ids.includes(id)) { delete state.registrations[id]; persist(); continue; }
        if ((retries.get(id) ?? 0) > now()) continue;
        const options = client(id), oldest = state.events[0]?.sequence ?? current() + 1;
        if (registration.cursor < oldest - 1) registration.cursor = current();
        for (const event of state.events.filter(row => row.sequence > registration.cursor).slice(0, 20)) {
          if (closed || state.registrations[id] !== registration) break;
          if (event.sequence <= registration.cursor) continue;
          if (!eligible(event, options.settings) || event.sequence <= options.baseline) { registration.cursor = event.sequence; persist(); continue; }
          let result;
          const canSend = () => { const active = deviceAuthority(); return !closed && active.available && active.ids.includes(id) && state.registrations[id] === registration && event.sequence > client(id).baseline && eligible(event, client(id).settings); };
          if (!canSend()) break;
          try { result = await apns.send(copy(registration), publicEvent(event), state.journalId, options.settings.sound, canSend); }
          catch { result = { ok: false, invalidToken: false }; }
          // Pair revocation or a preference change while HTTP/2 was pending cannot resurrect registration state.
          if (state.registrations[id] !== registration) break;
          if (result.invalidToken) { delete state.registrations[id]; persist(); break; }
          if (!result.ok) { retries.set(id, now() + 30000); break; }
          registration.cursor = Math.max(registration.cursor, event.sequence); persist();
        }
      }
    } catch { /* Keep the committed outbox available for a later bounded retry. */ }
    finally { pumping = false; }
  }
  async function feed(id = 'desktop', { after, journalId } = {}) {
    requireReady(); reconcile();
    const options = client(id), latest = current(), oldest = state.events[0]?.sequence ?? latest + 1;
    const reset = after === undefined || !seq(after) || journalId !== state.journalId || after > latest || after < oldest - 1;
    const rows = reset ? [] : state.events.filter(event => event.sequence > after).slice(0, 100);
    const nextCursor = rows.at(-1)?.sequence ?? (reset ? latest : after);
    return { supported: true, journalId: state.journalId, cursor: latest, nextCursor, hasMore: !reset && nextCursor < latest, ...(reset ? { baseline: true } : {}), events: rows.filter(event => event.sequence > options.baseline && eligible(event, options.settings)).map(publicEvent), settings: copy(options.settings), capabilities: { previews: false }, push: { ...apns.status(), registered: !!state.registrations[id] }, ...(id === 'desktop' ? { desktop: await native.status() } : {}) };
  }
  async function settings(id, input) {
    requireReady(); reconcile();
    const old = client(id), next = notificationSettings(input, old.settings);
    if (Object.keys(state.clients).length >= 21 && !state.clients[id]) throw fault(409, 'Remove an old paired device before enabling more notification settings.');
    state.clients[id] = { settings: next, baseline: !old.settings.enabled && next.enabled ? current() : old.baseline, generation: (old.generation ?? 0) + 1 };
    if (id === 'desktop') state.desktopCursor = current();
    if (state.registrations[id]) state.registrations[id].cursor = current();
    persist(); return feed(id);
  }
  function registration(id, input) {
    requireReady(); if (!deviceId(id)) throw fault(403, 'Register only this paired iPhone.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['token', 'environment'].includes(key)) || !/^[a-fA-F0-9]{32,256}$/.test(input.token ?? '') || !['sandbox', 'production'].includes(input.environment)) throw fault(400, 'Send a valid Apple push registration.');
    if (Object.keys(state.registrations).length >= 20 && !state.registrations[id]) throw fault(409, 'Remove an old paired device before registering another iPhone.');
    const old = state.registrations[id];
    state.registrations[id] = { token: input.token.toLowerCase(), environment: input.environment, cursor: old?.token === input.token.toLowerCase() && old?.environment === input.environment ? old.cursor : current() };
    persist(); return { registered: true, ...apns.status() };
  }
  function revoke(id, forget = false) {
    requireReady(); if (!deviceId(id)) throw fault(403, 'Remove only this paired iPhone.');
    delete state.registrations[id]; if (forget) delete state.clients[id]; retries.delete(id); persist();
    return { registered: false, ...apns.status() };
  }
  async function deliver(eventId) {
    requireReady(); const event = state.events.find(row => row.id === eventId), options = client('desktop');
    if (!event || !eligible(event, options.settings) || event.sequence <= options.baseline) throw fault(409, 'This notification is unavailable or muted.');
    if (state.desktopDelivered.includes(event.id) || inFlight.has(event.id)) return { delivered: false, detail: 'This notification was already handled.' };
    inFlight.add(event.id);
    try {
      const status = await native.status();
      if (status.authorization !== 'authorized') return { delivered: false, detail: status.detail };
      // Re-check preferences after awaiting the native permission read.
      const latest = client('desktop');
      if ((latest.generation ?? 0) !== (options.generation ?? 0) || event.sequence <= latest.baseline || !eligible(event, latest.settings)) return { delivered: false, handled: true, detail: 'Notification settings changed before delivery.' };
      const result = await native.deliver({ id: event.id, title: event.title, body: event.body, destination: copy(event.destination), sound: client('desktop').settings.sound });
      if (result.delivered || result.handled) { state.desktopDelivered.push(event.id); state.desktopDelivered = state.desktopDelivered.slice(-2000); persist(); }
      return result;
    } finally { inFlight.delete(event.id); }
  }
  async function pumpDesktop() {
    if (desktopPumping || closed || unavailable) return;
    desktopPumping = true;
    try {
      const oldest = state.events[0]?.sequence ?? current() + 1;
      if (!seq(state.desktopCursor) || state.desktopCursor < oldest - 1) state.desktopCursor = current();
      if (state.desktopCursor >= current()) return;
      const options = client('desktop'), status = await native.status();
      if (closed) return;
      // Permission is always explicit. Authorizing later does not replay earlier work.
      if (!options.settings.enabled) { state.desktopCursor = current(); persist(); return; }
      if (status.available !== true) return;
      if (status.authorization !== 'authorized') { state.desktopCursor = current(); persist(); return; }
      for (const event of state.events.filter(row => row.sequence > state.desktopCursor).slice(0, 20)) {
        if (closed) break;
        if (!eligible(event, client('desktop').settings) || event.sequence <= client('desktop').baseline || state.desktopDelivered.includes(event.id)) { state.desktopCursor = Math.max(state.desktopCursor, event.sequence); persist(); continue; }
        const result = await deliver(event.id);
        if (result.delivered || result.handled || state.desktopDelivered.includes(event.id)) { state.desktopCursor = Math.max(state.desktopCursor, event.sequence); persist(); }
        else break;
      }
    } catch { /* Native UI absence cannot stop the host or bot work. */ }
    finally { desktopPumping = false; }
  }
  reconcile();
  if (start) { timer = setInterval(reconcile, intervalMs); timer.unref?.(); }
  async function open() {
    const result = await native.open(), destination = result.destination;
    if (destination?.type === 'notifications' && destination?.id === 'settings' && Object.keys(destination).length === 2) return { destination: { type: 'notifications', id: 'settings' } };
    return { destination: destination && ['chat', 'team'].includes(destination.type) && validId(destination.id) && state.events.some(event => event.destination.type === destination.type && event.destination.id === destination.id) ? { type: destination.type, id: destination.id } : null };
  }
  async function test() {
    requireReady(); const options = client('desktop');
    if (!options.settings.enabled) throw fault(409, 'Enable Mac notifications before sending a test.');
    const status = await native.status();
    if (status.available !== true || status.authorization !== 'authorized') throw fault(409, 'Allow Strata notifications in macOS before sending a test.');
    if (!client('desktop').settings.enabled || (client('desktop').generation ?? 0) !== (options.generation ?? 0)) throw fault(409, 'Notification settings changed before the test.');
    return native.test(options.settings.sound);
  }
  return { feed, settings, registration, revoke, deliver, open, test, context: value => native.context(value), permission: () => native.permission(), schedule, reconcile, pump, pumpDesktop, setBridge: native.setBridge, close() { closed = true; clearInterval(timer); } };
}

export function createBotNotificationRoutes({ notifications, port }) {
  return async (req, res, url) => {
    res.removeHeader('access-control-allow-origin'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    if (!isLocalCompanionRequest(req, typeof port === 'function' ? port() : port)) return error(res, 403, 'Open notification settings in Strata on this Mac.');
    const device = req.headers['x-strata-companion-device'];
    if (device !== undefined && (req.headers.origin !== undefined || !deviceId(device))) return error(res, 403, 'Choose this paired device.');
    const id = device ?? 'desktop';
    try {
      const path = url.pathname, root = '/api/bots/notifications';
      if (path === root && req.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => !['after', 'journalId'].includes(key)) || [...url.searchParams].length > 2 || new Set(url.searchParams.keys()).size !== [...url.searchParams].length || url.searchParams.has('after') && !/^(0|[1-9][0-9]{0,15})$/.test(url.searchParams.get('after'))) throw fault(400, 'Choose a valid notification cursor.');
        const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined;
        return json(res, 200, await notifications.feed(id, { after, journalId: url.searchParams.get('journalId') ?? undefined }));
      }
      if (url.search) throw fault(400, 'This notification action has no query options.');
      if (path === `${root}/settings` && req.method === 'POST') return json(res, 200, await notifications.settings(id, await readBody(req, 64 * 1024)));
      if (path === `${root}/registration` && req.method === 'POST' && device) return json(res, 200, notifications.registration(device, await readBody(req, 4096)));
      if (path === `${root}/registration` && req.method === 'DELETE' && device) return json(res, 200, notifications.revoke(device));
      if (path === `${root}/device` && req.method === 'DELETE' && device) return json(res, 200, notifications.revoke(device, true));
      if ([`${root}/permission`, `${root}/open`, `${root}/test`].includes(path) && req.method === 'POST' && !device) { const body = await readBody(req, 2048); if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw fault(400, 'This notification action has no options.'); return json(res, 200, await (path.endsWith('/open') ? notifications.open() : path.endsWith('/test') ? notifications.test() : notifications.permission())); }
      if (path === `${root}/context` && req.method === 'POST' && !device) { const body = await readBody(req, 8192); if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || typeof body.hash !== 'string' || !body.hash.startsWith('#/') || body.hash.length > 4096 || body.destination !== null && (!body.destination || Object.keys(body.destination).length !== 2 || !['chat', 'team'].includes(body.destination.type) || !validId(body.destination.id))) throw fault(400, 'Choose the visible Strata conversation.'); return json(res, 200, await notifications.context(body)); }
      if (path === `${root}/deliver` && req.method === 'POST' && !device) { const body = await readBody(req, 2048); if (!body || Object.keys(body).length !== 1 || !validId(body.eventId)) throw fault(400, 'Choose a saved notification.'); return json(res, 200, await notifications.deliver(body.eventId)); }
      return error(res, 405, 'This notification action is unavailable.');
    } catch (failure) { return error(res, failure.status ?? 503, failure.status ? failure.message : 'Notifications are unavailable. Bot work was left unchanged.'); }
  };
}
