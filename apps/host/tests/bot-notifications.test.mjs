import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createBotNotifications, createBotNotificationRoutes, notificationSettings } from '../server/bot-notifications.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createTeamChannels } from '../server/bots-team-channel.mjs';
import { createNativeNotifications } from '../server/bot-notifications-native.mjs';

const at = '2026-10-21T10:00:00.000Z', device = 'a'.repeat(32), other = 'b'.repeat(32);
const immediate = () => new Promise(resolve => setImmediate(resolve));
const genericNative = () => ({ status: async () => ({ available: false, authorization: 'unavailable', detail: 'test' }), deliver: async () => ({ delivered: false }), permission: async () => ({ available: false }), open: async () => ({ destination: null }), context: async () => ({ saved: true }), setBridge() {} });
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-notifications-'));
  const snapshot = { conversations: [{ id: 's_old', createdAt: '2026-10-20T10:00:00.000Z', preferences: { botId: 'bot_test' }, messages: [] }], teams: [{ id: 'team_test', latestSequence: 0, messages: [] }], approvals: [] };
  const services = [];
  const open = overrides => { const value = createBotNotifications({ directory, now: () => Date.parse(at), start: false, native: genericNative(), sources: () => structuredClone(snapshot), ...options, ...overrides }); services.push(value); return value; };
  const service = open();
  t.after(() => { for (const item of services) item.close(); rmSync(directory, { recursive: true, force: true }); });
  const reply = (id = 'm_reply', index = 0) => snapshot.conversations[index].messages.push({ id, role: 'assistant', streaming: false, at, content: 'PRIVATE_PROMPT_PATH_KEY', reasoning: 'PRIVATE_THINKING', tools: [{ args: { token: 'PRIVATE_TOKEN' } }] });
  const team = (id = 'tm_one', kind = 'message', author = 'bot', state = 'done') => { const seq = snapshot.teams[0].messages.length + 1; snapshot.teams[0].latestSequence = seq; snapshot.teams[0].messages.push({ id, sequence: seq, kind, author: { type: author, botId: 'bot_test', name: 'PRIVATE_PROJECT_NAME' }, state, content: 'PRIVATE_WORKER_OUTPUT', createdAt: at }); };
  return { directory, snapshot, service, open, reply, team };
}
const enable = service => service.settings('desktop', { enabled: true });
const events = async (service, baseline) => (await service.feed('desktop', { after: baseline.nextCursor, journalId: baseline.journalId })).events;

test('native companion opens fixed Activity and a current conversation without notification opt-in or an event', async t => {
  let destination = { type: 'bots', id: 'activity' };
  const f = fixture(t, { native: { ...genericNative(), open: async () => ({ destination }) } });
  const before = readFileSync(join(f.directory, 'bot-notifications.json'));
  assert.deepEqual(await f.service.open(), { destination });
  destination = { type: 'chat', id: 's_old' };
  assert.deepEqual(await f.service.open(), { destination });
  assert.deepEqual(readFileSync(join(f.directory, 'bot-notifications.json')), before, 'Navigation neither enables notifications nor creates or changes history.');
});

test('native open rejects missing or removed chats, source failures, extra actions and arbitrary pages', async t => {
  let destination = { type: 'chat', id: 's_missing' }, unavailable = false;
  const f = fixture(t, { native: { ...genericNative(), open: async () => ({ destination }) } });
  const guarded = f.open({ sources: () => { if (unavailable) throw Error('Fixture sources unavailable'); return structuredClone(f.snapshot); }, native: { ...genericNative(), open: async () => ({ destination }) } });
  assert.deepEqual(await guarded.open(), { destination: null });
  destination = { type: 'chat', id: 's_old', approve: true }; assert.deepEqual(await guarded.open(), { destination: null });
  destination = { type: 'bots', id: 'settings' }; assert.deepEqual(await guarded.open(), { destination: null });
  destination = { type: 'bots', id: 'activity', command: 'run' }; assert.deepEqual(await guarded.open(), { destination: null });
  destination = { type: 'chat', id: 's_old' }; unavailable = true; assert.deepEqual(await guarded.open(), { destination: null }); unavailable = false;
  await enable(guarded); f.reply('m_before_removal'); guarded.reconcile();
  f.snapshot.conversations = [];
  assert.deepEqual(await guarded.open(), { destination: null }, 'A historical notification cannot resurrect a removed conversation.');
});

test('actual host open route preserves a once-only native companion destination through its private adapter', async t => {
  const queue = [{ type: 'bots', id: 'activity' }, { type: 'chat', id: 's_old' }], privateCalls = [];
  const native = createNativeNotifications({ env: { STRATA_SHELL_BRIDGE: 'http://127.0.0.1:19999', STRATA_SHELL_TOKEN: 'fixture-private-shell-token' }, fetcher: async (url, options) => {
    privateCalls.push({ url, method: options.method });
    assert.equal(options.headers.authorization, 'Bearer fixture-private-shell-token');
    return new Response(JSON.stringify({ destination: queue.shift() ?? null }), { headers: { 'content-type': 'application/json' } });
  } });
  const f = fixture(t, { native }); let port;
  const route = createBotNotificationRoutes({ notifications: f.service, port: () => port });
  const server = http.createServer((req, res) => route(req, res, new URL(req.url, `http://${req.headers.host}`)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const open = () => fetch(`http://127.0.0.1:${port}/api/bots/notifications/open`, { method: 'POST', body: '{}' }).then(response => response.json());
  assert.deepEqual(await open(), { destination: { type: 'bots', id: 'activity' } });
  assert.deepEqual(await open(), { destination: { type: 'chat', id: 's_old' } });
  assert.deepEqual(await open(), { destination: null });
  assert.equal(privateCalls.length, 3); assert.ok(privateCalls.every(call => call.url === 'http://127.0.0.1:19999/notifications/open' && call.method === 'POST'));
});

test('native team opens remain bound to an actual journal event', async t => {
  let destination = { type: 'team', id: 'team_test' };
  const f = fixture(t, { native: { ...genericNative(), open: async () => ({ destination }) } });
  assert.deepEqual(await f.service.open(), { destination: null });
  await enable(f.service); f.team('tm_visible'); f.service.reconcile();
  assert.deepEqual(await f.service.open(), { destination });
  destination = { type: 'team', id: 'team_forged' }; assert.deepEqual(await f.service.open(), { destination: null });
});

test('first read and first enable prime old history, while new terminal reply has stable safe identity', async t => {
  const f = fixture(t); f.reply('m_before_enable'); const base = await enable(f.service);
  assert.equal(base.events.length, 0); assert.equal(base.baseline, true); assert.equal(base.capabilities.previews, false);
  f.reply(); const rows = await events(f.service, base);
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'reply'); assert.deepEqual(rows[0].destination, { type: 'chat', id: 's_old' });
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_')); assert.equal(rows[0].title, 'New reply');
  assert.equal(statSync(join(f.directory, 'bot-notifications.json')).mode & 0o777, 0o600);
  assert.equal((await events(f.service, base))[0].id, rows[0].id);
});

test('restart reconciles a committed source missed before process exit without duplicates', async t => {
  const f = fixture(t); const base = await enable(f.service); f.reply('m_missed'); f.service.close();
  const reopened = f.open(); const rows = await events(reopened, base);
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'reply'); reopened.close();
  const again = f.open(); assert.deepEqual(await events(again, base), rows);
});

test('initial existing assistant history and streaming tokens never become alerts', async t => {
  const f = fixture(t); f.reply('m_imported'); f.service.close();
  writeFileSync(join(f.directory, 'bot-notifications.json'), JSON.stringify({ version: 1, broken: true }));
  const bytes = readFileSync(join(f.directory, 'bot-notifications.json'));
  const broken = f.open(); await assert.rejects(broken.feed(), /left unchanged/); assert.deepEqual(readFileSync(join(f.directory, 'bot-notifications.json')), bytes);
});

test('streaming assistant and its Thinking are ignored until the exact terminal identity', async t => {
  const f = fixture(t); const base = await enable(f.service); f.snapshot.conversations[0].messages.push({ id: 'm_stream', role: 'assistant', streaming: true, content: 'PRIVATE_DELTA', reasoning: 'PRIVATE_REASONING' });
  assert.equal((await events(f.service, base)).length, 0); f.snapshot.conversations[0].messages[0].streaming = false;
  const rows = await events(f.service, base); assert.equal(rows.length, 1); assert.ok(!JSON.stringify(rows).includes('PRIVATE_'));
});

test('empty and explicitly cancelled terminal turns advance source cursors without new reply banners', async t => {
  const f = fixture(t); const base = await enable(f.service);
  f.snapshot.conversations[0].messages.push({ id: 'm_empty_stopped', role: 'assistant', streaming: false, hasContent: false });
  f.snapshot.conversations[0].messages.push({ id: 'm_partial_stopped', role: 'assistant', streaming: false, hasContent: true, cancelled: true });
  assert.equal((await events(f.service, base)).length, 0);
  f.reply('m_real_result'); assert.equal((await events(f.service, base)).length, 1);
});

test('reconciliation drains bounded pages of missed direct completions instead of dropping page boundaries', async t => {
  const f = fixture(t); const base = await enable(f.service); for (let index = 0; index < 130; index++) f.reply(`m_${index}`);
  const first = await f.service.feed('desktop', { after: base.nextCursor, journalId: base.journalId }); assert.equal(first.events.length, 100); assert.equal(first.nextCursor, 100);
  const last = await f.service.feed('desktop', { after: first.nextCursor, journalId: base.journalId }); assert.equal(last.events.length, 30); assert.equal(last.nextCursor, 130);
});

test('public team message/report/failure route to room, human/system and private worker completions do not alert', async t => {
  const f = fixture(t); const base = await enable(f.service);
  f.snapshot.conversations[0].preferences.teamId = 'team_test'; f.reply();
  f.team('tm_user', 'message', 'user'); f.team('tm_status', 'status', 'system'); f.team(); f.team('tm_report', 'report'); f.team('tm_error', 'status', 'bot', 'error');
  const rows = await events(f.service, base); assert.deepEqual(rows.map(row => row.kind), ['team_message', 'completed', 'failed']);
  assert.ok(rows.every(row => row.destination.type === 'team')); assert.ok(!JSON.stringify(rows).includes('PRIVATE_'));
});

test('approval needs actual pending identity, deduplicates repeated polls and inherits team mute without leaking worker data', async t => {
  const f = fixture(t); const base = await enable(f.service);
  f.snapshot.approvals.push({ id: 'call_live', chatId: 's_private_worker', botId: 'bot_test', teamId: 'team_test', args: { token: 'PRIVATE_TOKEN' } });
  const rows = await events(f.service, base); assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'approval'); assert.equal(rows[0].destination.id, 's_private_worker'); assert.equal(Object.hasOwn(rows[0], 'teamId'), false);
  assert.deepEqual(await events(f.service, base), rows);
  f.snapshot.approvals = [];
  await f.service.settings('desktop', { muted: ['team:team_test'] });
  f.snapshot.approvals.push({ id: 'call_muted', chatId: 's_private_worker', teamId: 'team_test' });
  assert.equal((await events(f.service, base)).length, 0);
});

test('category settings and muted exact destinations filter delivery and cursor still advances', async t => {
  const f = fixture(t); const base = await enable(f.service); await f.service.settings('desktop', { replies: false, muted: ['team:team_test'] });
  f.reply(); f.team(); const feed = await f.service.feed('desktop', { after: base.nextCursor, journalId: base.journalId });
  assert.equal(feed.events.length, 0); assert.equal(feed.nextCursor, 2); assert.equal(feed.hasMore, false);
  await f.service.settings('desktop', { enabled: false }); f.reply('m_disabled'); await f.service.feed(); await enable(f.service); f.reply('m_new');
  assert.equal((await events(f.service, base)).length, 0); // replies remain explicitly off after re-enable
});

test('routine completion obeys its saved opt-in and work category without duplicate ordinary reply', async t => {
  const f = fixture(t); const base = await enable(f.service); f.snapshot.conversations[0].routine = true; f.snapshot.conversations[0].notifyOnCompletion = false;
  f.reply('m_routine_silent'); assert.equal((await events(f.service, base)).length, 0);
  f.snapshot.conversations.push({ id: 's_routine_second', createdAt: at, routine: true, notifyOnCompletion: true, messages: [] });
  f.reply('m_routine_work', 1); assert.deepEqual((await events(f.service, base)).map(row => row.kind), ['completed']);
  await f.service.settings('desktop', { work: false });
  f.snapshot.conversations.push({ id: 's_routine_third', createdAt: at, routine: true, notifyOnCompletion: true, messages: [] }); f.reply('m_routine_muted_category', 2); assert.equal((await events(f.service, base)).length, 0);
  f.reply('m_human_followup', 1); assert.deepEqual((await events(f.service, base)).map(row => row.kind), ['reply'], 'A later human continuation is an ordinary reply, not another scheduled completion.');
});

test('client scopes are isolated and invalid journal/cursor resets safely without replay', async t => {
  const f = fixture(t); await enable(f.service); await f.service.settings(device, { enabled: true }); const base = await f.service.feed(device); f.reply();
  assert.equal((await f.service.feed(device, { after: base.nextCursor, journalId: base.journalId })).events.length, 1);
  assert.equal((await f.service.feed(other, { after: base.nextCursor, journalId: base.journalId })).events.length, 0);
  for (const query of [{ after: 0, journalId: 'nj_other' }, { after: 1000, journalId: base.journalId }, { after: -1, journalId: base.journalId }]) { const result = await f.service.feed(device, query); assert.equal(result.baseline, true); assert.equal(result.events.length, 0); assert.equal(result.nextCursor, result.cursor); }
  assert.throws(() => notificationSettings({ clientId: other }), /valid notification/); assert.throws(() => notificationSettings({ muted: ['chat:../private'] }), /valid muted/);
});

test('desktop dispatch is host owned with no renderer/feed read, duplicate retries and focused suppression are consumed', async t => {
  let calls = 0, suppressed = false;
  const native = { ...genericNative(), status: async () => ({ available: true, authorization: 'authorized', detail: '' }), deliver: async () => { calls++; return suppressed ? { delivered: false, handled: true } : { delivered: true }; } };
  const f = fixture(t, { native }); await enable(f.service); f.reply(); f.service.reconcile(); await immediate(); await f.service.pumpDesktop(); assert.equal(calls, 1);
  f.service.reconcile(); await f.service.pumpDesktop(); assert.equal(calls, 1);
  suppressed = true; f.reply('m_focused'); f.service.reconcile(); await immediate(); await f.service.pumpDesktop(); assert.equal(calls, 2);
  suppressed = false; f.service.reconcile(); await f.service.pumpDesktop(); assert.equal(calls, 2);
});

test('late permission grant and first enable do not burst earlier desktop alerts', async t => {
  let calls = 0, permission = 'denied';
  const native = { ...genericNative(), status: async () => ({ available: true, authorization: permission, detail: '' }), deliver: async () => { calls++; return { delivered: true }; } };
  const f = fixture(t, { native }); await enable(f.service); f.reply('m_denied'); f.service.reconcile(); await immediate(); await f.service.pumpDesktop();
  permission = 'authorized'; f.service.reconcile(); await f.service.pumpDesktop(); assert.equal(calls, 0);
  f.reply('m_authorized'); f.service.reconcile(); await immediate(); await f.service.pumpDesktop(); assert.equal(calls, 1);
});

test('disable and re-enable while native permission read is held cannot deliver an earlier event', async t => {
  let held = false, release, calls = 0, available = false;
  const status = () => ({ available, authorization: available ? 'authorized' : 'unavailable', detail: '' });
  const native = { ...genericNative(), status: async () => held ? await new Promise(resolve => { release = () => resolve(status()); }) : status(), deliver: async () => { calls++; return { delivered: true }; } };
  const f = fixture(t, { native }); const base = await enable(f.service); f.reply('m_old'); const row = (await events(f.service, base))[0]; await immediate();
  available = true; held = true; const delivery = f.service.deliver(row.id); await immediate(); held = false;
  await f.service.settings('desktop', { enabled: false }); await f.service.settings('desktop', { enabled: true }); release();
  assert.equal((await delivery).delivered, false); assert.equal(calls, 0);
  f.reply('m_new'); f.service.reconcile(); await immediate(); await f.service.pumpDesktop(); assert.equal(calls, 1);
});

test('settings changes during an APNs await cannot regress a cursor or replay queued old events', async t => {
  let release, calls = 0;
  const apns = { status: () => ({ configured: true, detail: 'fixture' }), send: async () => { calls++; if (calls === 1) return await new Promise(resolve => { release = () => resolve({ ok: true }); }); return { ok: true }; } };
  const f = fixture(t, { apns, deviceAuthority: () => ({ available: true, ids: [device] }) }); await f.service.settings(device, { enabled: true }); f.service.registration(device, { token: 'c'.repeat(64), environment: 'sandbox' });
  f.reply('m_old_one'); f.service.reconcile(); await immediate(); f.reply('m_old_two'); f.service.reconcile();
  await f.service.settings(device, { enabled: false }); await f.service.settings(device, { enabled: true }); release(); await immediate(); await f.service.pump(); assert.equal(calls, 1);
  f.reply('m_after_reenable'); f.service.reconcile(); await immediate(); await f.service.pump(); assert.equal(calls, 2);
});

test('APNs retry outbox is durable, registration private, invalid token pruning and authoritative revocation fail closed', async t => {
  let sends = 0, result = { ok: false, invalidToken: false }, active = true, clock = Date.parse(at);
  const apns = { status: () => ({ configured: true, detail: 'fixture provider' }), send: async (registration, event, journalId, sound, canSend) => { assert.ok(canSend()); sends++; assert.equal(registration.token, 'c'.repeat(64)); assert.ok(journalId.startsWith('nj_')); return result; } };
  const f = fixture(t, { apns, now: () => clock, deviceAuthority: () => ({ available: active, ids: active ? [device] : [] }) });
  await f.service.settings(device, { enabled: true }); const base = await f.service.feed(device); f.service.registration(device, { token: 'c'.repeat(64), environment: 'sandbox' });
  f.reply(); f.service.reconcile(); await immediate(); assert.equal(sends, 1); assert.ok(!JSON.stringify(await f.service.feed(device)).includes('c'.repeat(64)));
  result = { ok: true }; clock += 31000; await f.service.pump(); assert.equal(sends, 2); await f.service.pump(); assert.equal(sends, 2);
  active = false; f.reply('m_disabled_pairing'); f.service.reconcile(); await immediate(); assert.equal(sends, 2);
  active = true; result = { ok: false, invalidToken: true }; await f.service.pump(); assert.equal(sends, 3); assert.equal((await f.service.feed(device)).push.registered, false);
  f.service.registration(device, { token: 'c'.repeat(64), environment: 'sandbox' }); f.service.close();
  const restarted = f.open({ deviceAuthority: () => ({ available: true, ids: [] }) }); f.reply('m_revoked_restart'); restarted.reconcile(); await immediate(); assert.equal(sends, 3); assert.equal((await restarted.feed(device)).push.registered, false);
  assert.equal(base.push.configured, true);
});

test('canonical source projections omit all text, prompts, reasoning, tool arguments and private links', t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-notifications-sources-')); const chats = createConversations({ directory });
  t.after(() => { chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const chat = chats.create().conversation; chats.begin(chat.id, 'PRIVATE_PROMPT', { userMessageId: 'm_user', assistantMessageId: 'm_assistant' }); chats.record(chat.id, { type: 'reasoning', text: 'PRIVATE_THINKING' }); chats.record(chat.id, { type: 'delta', text: 'PRIVATE_RESPONSE_PATH' }); chats.finish(chat.id);
  const projection = chats.notificationSources(); assert.ok(!JSON.stringify(projection).includes('PRIVATE_')); assert.equal(projection[0].messages[0].id, 'm_assistant');
  const channel = createTeamChannels({ directory }); channel.append('team_test', { content: 'PRIVATE_CONTENT', author: { type: 'bot', botId: 'bot_test', name: 'PRIVATE_NAME' }, chatId: 'PRIVATE_CHAT_LINK', runId: 'PRIVATE_RUN', kind: 'message' });
  assert.ok(!JSON.stringify(channel.notificationSources('team_test')).includes('PRIVATE_'));
});

test('private HTTP routes reject external origin/device spoof and desktop arbitrary payloads', async t => {
  const f = fixture(t); let port; const route = createBotNotificationRoutes({ notifications: f.service, port: () => port });
  const server = http.createServer((req, res) => { void route(req, res, new URL(req.url, `http://${req.headers.host}`)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${origin}/api/bots/notifications`, { headers: { origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await fetch(`${origin}/api/bots/notifications`, { headers: { origin, 'x-strata-companion-device': device } })).status, 403);
  assert.equal((await fetch(`${origin}/api/bots/notifications/settings`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, clientId: other }) })).status, 400);
  assert.equal((await fetch(`${origin}/api/bots/notifications/deliver`, { method: 'POST', body: JSON.stringify({ title: 'FORGED', body: 'PRIVATE' }) })).status, 400);
  assert.equal((await fetch(`${origin}/api/bots/notifications/open`, { method: 'POST', body: JSON.stringify({ destination: { type: 'chat', id: 's_forged' } }) })).status, 400);
  const response = await fetch(`${origin}/api/bots/notifications`, { headers: { origin } }); assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('fixed native test requires opt-in and actual authorization, changes no journal and accepts no chat/tool action', async t => {
  let calls = 0, authorization = 'denied';
  const native = { ...genericNative(), status: async () => ({ available: true, authorization, detail: '' }), test: async () => { calls++; return { delivered: true }; }, open: async () => ({ destination: { type: 'notifications', id: 'settings' } }) };
  const f = fixture(t, { native }); await assert.rejects(f.service.test(), /Enable Mac notifications/);
  await enable(f.service); await assert.rejects(f.service.test(), /Allow Strata notifications/); assert.equal(calls, 0);
  authorization = 'authorized'; const before = readFileSync(join(f.directory, 'bot-notifications.json'));
  assert.deepEqual(await f.service.test(), { delivered: true }); assert.equal(calls, 1); assert.deepEqual(readFileSync(join(f.directory, 'bot-notifications.json')), before); assert.deepEqual(await f.service.open(), { destination: { type: 'notifications', id: 'settings' } });
  let port; const route = createBotNotificationRoutes({ notifications: f.service, port: () => port }); const server = http.createServer((req, res) => { void route(req, res, new URL(req.url, `http://${req.headers.host}`)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port; t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${port}/api/bots/notifications/test`;
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ destination: { type: 'chat', id: 's_forged' } }) })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-strata-companion-device': device }, body: '{}' })).status, 405); assert.equal(calls, 1);
});
