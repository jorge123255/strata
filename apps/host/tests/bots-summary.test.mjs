/** Sidebar summaries use public room lines and personal read cursors. No owner models or computers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBotTeams } from '../server/bots-team.mjs';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';

function journal(t) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bot-summary-room-'));
  const bots = new Map([['bot_a', { id: 'bot_a', name: 'Ada' }], ['bot_b', { id: 'bot_b', name: 'Bea' }]]);
  const cursors = new Map();
  let n = 0, clock = Date.parse('2026-10-23T00:00:00Z');
  const service = createBotTeams({
    directory, now: () => clock, schedule: () => {}, roomReadSequence: id => cursors.get(id) ?? 0,
    requireBot(id) { if (!bots.has(id)) throw Object.assign(new Error('Unknown current bot'), { status: 400 }); return bots.get(id); },
    conversations: () => ({ detail: () => ({ conversation: { messages: [] } }), send() {}, stop: async () => {}, isRunning: () => false }),
    createConversation() { return { conversation: { id: `s_${++n}` } }; },
    discardConversation() {}, stopDirect: async () => {},
  });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const team = service.create({ name: 'Room', memberIds: ['bot_a', 'bot_b'], coordinatorId: 'bot_a', enabled: true }).team;
  return { service, team, cursors, advance: () => { clock += 1000; } };
}

test('a room card counts members, unread public lines, the latest preview and who is speaking', async t => {
  const f = journal(t);
  const empty = f.service.roomCard(f.team.id);
  assert.equal(empty.memberCount, 2);
  assert.equal(empty.unreadCount, 0);
  assert.equal(empty.lastMessage, null);
  assert.deepEqual(empty.working, []);
  assert.deepEqual(f.service.botSignal('bot_b'), { working: false, error: false });
  const sent = f.service.message(f.team.id, { message: '  Hello\n\nteam  ', requestId: 'preview', recipientIds: ['bot_b'] });
  const queued = f.service.roomCard(f.team.id);
  assert.equal(queued.unreadCount, 0);
  assert.deepEqual(queued.lastMessage, { at: queued.lastMessage.at, preview: 'Hello team', authorName: 'You' });
  assert.deepEqual(queued.working, [{ botId: 'bot_b', name: 'Bea', state: 'queued' }]);
  assert.equal(f.service.botSignal('bot_b').working, false);
  f.service.tick();
  assert.equal(f.service.roomCard(f.team.id).working[0].state, 'working');
  assert.equal(f.service.botSignal('bot_b').working, true);
  const context = { bot: { id: 'bot_b', name: 'Bea' }, chatId: f.service.detail(f.team.id, sent.run.id).run.rootChatId, turnId: 'turn_b', toolCallId: 'call_b', assertLive() {}, requestPermission: async () => true, requestTeamPermission: async () => true };
  f.service.begin(context);
  f.advance();
  f.service.end(context, { error: 'hidden failure' });
  assert.deepEqual(f.service.botSignal('bot_b'), { working: false, error: true });
  assert.equal(f.service.roomCard(f.team.id).unreadCount, 1);
  assert.equal(f.service.roomCard(f.team.id).lastMessage.authorName, 'Bea');
  f.advance();
  const again = f.service.message(f.team.id, { message: 'Once more', requestId: 'again', recipientIds: ['bot_b'] }).run;
  f.service.tick();
  const nextContext = { ...context, chatId: f.service.detail(f.team.id, again.id).run.rootChatId, turnId: 'turn_b2', toolCallId: 'call_b2' };
  f.service.begin(nextContext);
  f.advance();
  f.service.end(nextContext, { publicReply: 'All clear' });
  assert.deepEqual(f.service.botSignal('bot_b'), { working: false, error: false });
  const latest = f.service.latestSequence(f.team.id);
  f.cursors.set(f.team.id, latest);
  assert.equal(f.service.roomCard(f.team.id).unreadCount, 0);
  assert.equal(f.service.roomCard(f.team.id, 0).unreadCount, 2);
  assert.equal(f.service.roomCard(f.team.id).lastMessage.preview, 'All clear');
});

function host(t, run) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bot-summary-'));
  let chats, hold = false;
  const waiters = [];
  let clock = Date.parse('2026-10-23T00:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const release = () => { hold = false; for (const resolve of waiters.splice(0)) resolve(); };
  const runtime = { providers: async () => [{ id: 'codex', name: 'Codex', available: true, detail: 'fixture' }], close() {}, run };
  const tools = { definitions: () => [], execute: () => {}, close() {} };
  const bots = createBots({ directory, runtime, tools, defaultWorkspace: () => directory, conversations: () => chats, now });
  chats = createConversations({ directory, now, enabled: () => bots.hasProfiles(), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: options => bots.approve(options), validateSelection: selection => bots.validateSelection(selection), execute: args => bots.run(args) });
  t.after(async () => { release(); await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = name => bots.create({ name, provider: 'codex', workspace: directory }).bot;
  return { directory, bots, chats, create, now, release, holdFor: () => { hold = true; }, wait: signal => new Promise(resolve => { if (!hold) return resolve(); const finish = () => resolve(); signal?.addEventListener('abort', finish, { once: true }); waiters.push(() => { signal?.removeEventListener('abort', finish); resolve(); }); }), advance: ms => { clock += ms; } };
}

const until = async (check, label) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 4000) throw new Error(label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('the summary reports room and personal unread without copying private transcripts', async t => {
  let reply = 'First note';
  const f = host(t, async ({ onFrame, signal }) => { await f.wait(signal); if (signal?.aborted) return; onFrame({ type: 'done', publicReply: reply }); });
  const ada = f.create('Ada'), bea = f.create('Bea'), cy = f.create('Cy');
  const team = f.bots.team.create({ name: 'Room', memberIds: [ada.id, bea.id], coordinatorId: ada.id, enabled: true }).team;
  const before = f.bots.summary();
  assert.deepEqual(before.rooms, [{ id: team.id, name: 'Room', memberCount: 2, unreadCount: 0, lastMessage: null, working: [] }]);
  assert.deepEqual(before.bots.map(row => row.status), ['idle', 'idle', 'idle']);
  assert.ok(before.bots.every(row => row.unreadCount === 0));
  f.holdFor();
  const text = `  Hello\n\nteam ${'y'.repeat(180)}`;
  f.bots.team.message(team.id, { message: text, requestId: 'hello', recipientIds: [bea.id] });
  const queued = f.bots.summary().rooms[0];
  assert.equal(queued.unreadCount, 0);
  assert.equal(queued.lastMessage.authorName, 'You');
  assert.equal(queued.lastMessage.preview.length, 140);
  assert.equal(queued.lastMessage.preview.startsWith('Hello team '), true);
  assert.deepEqual(queued.working, [{ botId: bea.id, name: 'Bea', state: 'queued' }]);
  assert.equal(f.bots.summary().bots.find(row => row.id === bea.id).status, 'idle');
  await until(() => f.bots.summary().bots.find(row => row.id === bea.id).status === 'working', 'Bea did not start');
  assert.equal(f.bots.summary().rooms[0].working[0].state, 'working');
  const teamChat = f.bots.createConversation(ada.id, {}, { teamId: team.id, teamRunId: 'tr_manual0000' }).conversation;
  f.chats.begin(teamChat.id, 'SECRET_TEAM_PROMPT');
  f.chats.record(teamChat.id, { type: 'delta', text: 'SECRET_TEAM_REPLY' });
  f.chats.record(teamChat.id, { type: 'done' });
  const personal = f.bots.createConversation(ada.id).conversation;
  f.chats.begin(personal.id, 'SECRET_USER_PROMPT');
  f.chats.record(personal.id, { type: 'error', message: 'SECRET_PROVIDER_FAILURE' });
  const errored = f.bots.summary();
  const adaRow = errored.bots.find(row => row.id === ada.id);
  assert.equal(adaRow.status, 'error');
  assert.equal(adaRow.unreadCount, 1);
  assert.equal(errored.bots.find(row => row.id === cy.id).unreadCount, 0);
  assert.equal(JSON.stringify(errored).includes('SECRET_'), false);
  assert.equal(f.bots.markBotRead(ada.id, {}).bot.unreadCount, 0);
  assert.equal(f.bots.summary().bots.find(row => row.id === ada.id).status, 'error');
  f.advance(1000);
  f.chats.begin(personal.id, 'Next');
  assert.equal(f.bots.summary().bots.find(row => row.id === ada.id).status, 'working');
  f.chats.record(personal.id, { type: 'delta', text: 'SECRET_NEXT_REPLY' });
  f.chats.record(personal.id, { type: 'done' });
  const followed = f.bots.summary().bots.find(row => row.id === ada.id);
  assert.equal(followed.status, 'idle');
  assert.equal(followed.unreadCount, 1);
  assert.equal(JSON.stringify(f.bots.summary()).includes('SECRET_'), false);
  f.release();
  await until(() => f.bots.summary().rooms[0].unreadCount === 1 && f.bots.summary().rooms[0].lastMessage.preview === 'First note', 'The room reply did not publish');
  assert.equal(f.bots.summary().rooms[0].lastMessage.authorName, 'Bea');
  assert.equal(f.bots.summary().bots.find(row => row.id === bea.id).status, 'idle');
  assert.equal(f.bots.summary().bots.find(row => row.id === bea.id).unreadCount, 0);
  const read = f.bots.markTeamRead(team.id, {});
  assert.equal(read.room.unreadCount, 0);
  assert.equal(statSync(join(f.directory, 'bot-reads.json')).mode & 0o777, 0o600);
  reply = 'Second note';
  f.bots.team.message(team.id, { message: 'Again', requestId: 'again', recipientIds: [bea.id] });
  await until(() => f.bots.summary().rooms[0].lastMessage.preview === 'Second note', 'The second reply did not publish');
  assert.equal(f.bots.summary().rooms[0].unreadCount, 1);
  assert.throws(() => f.bots.markTeamRead(team.id, { sequence: 1.5 }), error => error.status === 400);
  assert.throws(() => f.bots.markTeamRead(team.id, { sequence: 999 }), error => error.status === 400);
  assert.equal(f.bots.markTeamRead(team.id, { sequence: 0 }).room.unreadCount, 2);
  assert.throws(() => f.bots.markBotRead(ada.id, { at: '2099-01-01T00:00:00.000Z' }), error => error.status === 400);
  assert.throws(() => f.bots.markBotRead('bot_missing', {}), error => error.status === 404);
});

async function serve(t, bots) {
  const server = http.createServer((req, res) => { routes(req, res, new URL(req.url, `http://127.0.0.1:${server.address().port}`)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const routes = createBotRoutes({ bots, port });
  return { origin, port };
}

async function readEvent(reader, decoder, buffer) {
  const start = Date.now();
  for (;;) {
    while (!buffer.text.includes('\n\n')) {
      if (Date.now() - start > 4000) throw new Error('Summary stream ended before an event');
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Summary stream ended before an event');
      buffer.text += decoder.decode(chunk.value, { stream: true });
    }
    const split = buffer.text.indexOf('\n\n');
    const event = buffer.text.slice(0, split);
    buffer.text = buffer.text.slice(split + 2);
    if (event.startsWith('event:')) return event;
  }
}
async function readUntil(reader, decoder, buffer, check) {
  const start = Date.now();
  for (;;) {
    const payload = JSON.parse((await readEvent(reader, decoder, buffer)).replace(/^event: [^\n]+\ndata: /, ''));
    if (check(payload)) return payload;
    if (Date.now() - start > 4000) throw new Error('Summary stream did not reach the expected card');
  }
}

test('summary and room streams push the same card a mark-read call clears', async t => {
  let reply = 'Stream note';
  const f = host(t, async ({ onFrame }) => { onFrame({ type: 'done', publicReply: reply }); });
  const ada = f.create('Ada'), bea = f.create('Bea');
  const team = f.bots.team.create({ name: 'Room', memberIds: [ada.id, bea.id], coordinatorId: ada.id, enabled: true }).team;
  const { origin } = await serve(t, f.bots);
  const listed = await fetch(`${origin}/api/bots/summary`, { headers: { Origin: origin } });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).rooms[0].memberCount, 2);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${origin}/api/bots/summary/stream`, { headers: { Origin: origin }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder(), buffer = { text: '' };
  const first = JSON.parse((await readEvent(reader, decoder, buffer)).replace(/^event: bot-summary\ndata: /, ''));
  assert.equal(first.rooms[0].unreadCount, 0);
  const roomResponse = await fetch(`${origin}/api/bots/teams/${team.id}/channel/stream`, { headers: { Origin: origin }, signal: controller.signal });
  const roomReader = roomResponse.body.getReader(), roomBuffer = { text: '' };
  const roomFirst = JSON.parse((await readEvent(roomReader, decoder, roomBuffer)).replace(/^event: team-channel\ndata: /, ''));
  assert.equal(roomFirst.room.memberCount, 2);
  assert.deepEqual(roomFirst.room.working, []);
  f.bots.team.message(team.id, { message: 'Hello', requestId: 'streamed', recipientIds: [bea.id] });
  const roomNext = JSON.parse((await readEvent(roomReader, decoder, roomBuffer)).replace(/^event: team-channel\ndata: /, ''));
  assert.equal(roomNext.room.working[0].state, 'queued');
  const summaryNext = await readUntil(reader, decoder, buffer, payload => payload.rooms[0].lastMessage?.preview === 'Stream note' && payload.rooms[0].unreadCount === 1);
  assert.equal(summaryNext.rooms[0].memberCount, 2);
  const marked = await fetch(`${origin}/api/bots/teams/${team.id}/read`, { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(marked.status, 200);
  assert.equal((await marked.json()).room.unreadCount, 0);
  const cleared = await readUntil(reader, decoder, buffer, payload => payload.rooms[0].unreadCount === 0);
  assert.equal(cleared.rooms[0].lastMessage.preview, 'Stream note');
  const denied = await fetch(`${origin}/api/bots/summary`, { headers: { Origin: 'https://malicious.example' } });
  assert.equal(denied.status, 403);
  await reader.cancel();
  await roomReader.cancel();
});

test('read cursors survive a restart and a corrupt file is left unchanged', async t => {
  const f = host(t, async ({ onFrame }) => { onFrame({ type: 'done', publicReply: 'Kept' }); });
  const ada = f.create('Ada'), bea = f.create('Bea');
  const team = f.bots.team.create({ name: 'Room', memberIds: [ada.id, bea.id], coordinatorId: ada.id, enabled: true }).team;
  f.bots.team.message(team.id, { message: 'Hello', requestId: 'kept', recipientIds: [bea.id] });
  await until(() => f.bots.summary().rooms[0].unreadCount === 1, 'The kept reply did not publish');
  f.bots.markTeamRead(team.id, {});
  const personal = f.bots.createConversation(ada.id).conversation;
  f.chats.begin(personal.id, 'Hello');
  f.chats.record(personal.id, { type: 'delta', text: 'Answer' });
  f.chats.record(personal.id, { type: 'done' });
  f.bots.markBotRead(ada.id, {});
  await f.bots.close();
  f.chats.close();
  let restoredChats;
  const restored = createBots({ directory: f.directory, runtime: { providers: async () => [], run: async () => {}, close() {} }, tools: { definitions: () => [], execute: () => {}, close() {} }, defaultWorkspace: () => f.directory, conversations: () => restoredChats, now: f.now });
  restoredChats = createConversations({ directory: f.directory, now: f.now, enabled: () => true, pending: () => [], stop: async () => {}, approve: async () => {}, validateSelection: () => {}, execute: async () => {} });
  t.after(async () => { await restored.close(); restoredChats.close(); });
  const summary = restored.summary();
  assert.equal(summary.rooms[0].unreadCount, 0);
  assert.equal(summary.bots.find(row => row.name === 'Ada').unreadCount, 0);
  const broken = mkdtempSync(join(tmpdir(), 'strata-bot-summary-broken-'));
  t.after(() => rmSync(broken, { recursive: true, force: true }));
  const file = join(broken, 'bot-reads.json');
  writeFileSync(file, '{"version":1,"teams":[],"bots":{}}');
  const bytes = readFileSync(file);
  assert.throws(() => createBots({ directory: broken, runtime: { providers: async () => [], close() {} }, tools: { definitions: () => [], close() {} }, conversations: () => null }), error => error.status === 503 && /read cursors/.test(error.message));
  assert.deepEqual(readFileSync(file), bytes);
});
