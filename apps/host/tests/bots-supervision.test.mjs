import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botSupervisionSnapshot } from '../server/bots-supervision.mjs';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
const now = Date.parse('2026-10-21T17:00:00.000Z'), at = new Date(now).toISOString();
const bot = { id: 'bot_fixture', name: 'Builder', paused: false, providerSettings: { apiKey: 'PRIVATE-KEY' } };
const chat = (id, patch = {}) => ({ id, title: 'Work', updatedAt: at, active: false, preferences: { botId: bot.id, botName: bot.name, botComputer: 'Saved computer' }, messages: [], ...patch });
const tool = (state = 'proposed') => ({ id: 'call_fixture', name: 'browser_click', state, live: true, args: { password: 'PRIVATE-ARGS' }, preview: 'PRIVATE-COMMAND', result: 'PRIVATE-RESULT' });
const answer = patch => ({ role: 'assistant', hasContent: true, content: 'PRIVATE-TRANSCRIPT', ...patch });
const snapshot = (conversations, pending = () => [], bots = [bot]) => botSupervisionSnapshot({ bots, conversations, pendingCount: id => pending(id).length, now });

test('real waiting requests outrank errors and running work; historical proposed cards never become approvals', () => {
  const result = snapshot([
    chat('s_historical', { messages: [answer({ tools: [tool()] })] }),
    chat('s_working', { active: true, messages: [answer({ tools: [tool('running')] })] }),
    chat('s_error', { messages: [answer({ error: true })] }),
    chat('s_waiting', { active: true, messages: [answer({ tools: [tool()] })] }),
  ], id => id === 's_waiting' ? [{ id: 'call_fixture', args: 'PRIVATE-REQUEST', resolve() {} }] : []);
  assert.deepEqual(result.sessions.map(row => [row.id, row.state]), [['s_waiting','approval'],['s_error','error'],['s_working','working'],['s_historical','completed']]);
  assert.deepEqual(result.counts, { waiting: 1, working: 1, completed: 1, errors: 1 });
  assert.equal(result.sessions[0].approvalCount, 1);
  assert.equal(result.sessions[2].toolName, 'browser_click');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('call_fixture'), false, 'Display cards carry no actionable approval identities.');
});

test('new prompts and inactive conversations never inherit an old running tool; paused profiles do not hide waiting turns', () => {
  const result = snapshot([
    chat('s_new_turn', { active: true, messages: [answer({ tools: [tool('running')] }), { role: 'user', content: 'Next' }] }),
    chat('s_inactive', { messages: [answer({ tools: [tool('running')] })] }),
    chat('s_paused_wait', { active: true }),
  ], id => id === 's_paused_wait' ? [{}] : [], [{ ...bot, paused: true }]);
  assert.equal(result.sessions.find(row => row.id === 's_new_turn').state, 'thinking');
  assert.equal(result.sessions.find(row => row.id === 's_new_turn').toolName, undefined);
  assert.equal(result.sessions.find(row => row.id === 's_inactive').toolName, undefined);
  assert.equal(result.sessions[0].state, 'approval');
});

test('personal, team and subagent chats retain exact identities without leaking private content or inventing work from goals', () => {
  const result = snapshot([
    chat('s_personal', { active: true }),
    chat('s_team', { active: true, preferences: { botId: bot.id, teamId: 'team_fixture' } }),
    chat('s_child', { active: true, preferences: { botId: bot.id, teamId: 'team_fixture', parentChatId: 's_team' } }),
    chat('s_other_model', { active: true, preferences: { remoteModel: { name: 'Maya' } } }),
    chat('s_goal_gap', { loop: { status: 'running' }, goal: { status: 'active' } }),
    chat('s_missing_profile', { active: true, preferences: { botId: 'bot_deleted' } }),
  ]);
  assert.deepEqual(new Set(result.sessions.map(row => row.id)), new Set(['s_personal','s_team','s_child']));
  assert.equal(result.sessions.find(row => row.id === 's_personal').teamId, undefined);
  assert.equal(result.sessions.find(row => row.id === 's_child').parentChatId, 's_team');
  assert.equal(result.sessions.find(row => row.id === 's_team').teamId, 'team_fixture');
});

test('recent results expire after 24 hours; unfinished, cancelled and corrupt-date history does not claim completion', () => {
  const result = snapshot([
    chat('s_recent', { messages: [answer({})] }),
    chat('s_old', { updatedAt: new Date(now - 86_400_001).toISOString(), messages: [answer({})] }),
    chat('s_cancelled', { messages: [answer({ cancelled: true })] }),
    chat('s_streaming', { messages: [answer({ streaming: true })] }),
    chat('s_invalid_date', { updatedAt: 'bad', messages: [answer({})] }),
    chat('s_future', { updatedAt: new Date(now + 60_001).toISOString(), messages: [answer({})] }),
  ]);
  assert.deepEqual(result.sessions.map(row => row.id), ['s_recent']);
});

test('supervision is bounded with deterministic urgency and text sizes', () => {
  const result = snapshot(Array.from({ length: 250 }, (_, index) => chat('s_' + String(index).padStart(3, '0'), { active: true, title: 'x'.repeat(400), messages: [answer({ tools: [{ ...tool('running'), name: 'z'.repeat(200) }] })] })));
  assert.equal(result.sessions.length, 200); assert.equal(result.hasMore, true); assert.equal(result.counts.working, 250);
  assert.equal(result.sessions[0].id, 's_000'); assert.equal(result.sessions[0].title.length, 300); assert.equal(result.sessions[0].toolName.length, 120);
});

test('actual bot runtime supervision follows pending → completion without executing, granting, probing providers or changing Maya', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-supervision-'));
  let chats, starts = 0, providerChecks = 0;
  const bots = createBots({ directory, defaultWorkspace: () => directory, conversations: () => chats,
    runtime: { async providers() { providerChecks++; return []; }, async run({ requestPermission, onFrame }) { starts++; await requestPermission({ id: 'call_review', name: 'write_file', args: { token: 'PRIVATE' } }); onFrame({ type: 'delta', text: 'Done' }); }, close() {} },
    tools: { definitions: () => [], execute() { throw new Error('No computer action authorized.'); }, close() {} } });
  chats = createConversations({ directory, enabled: () => bots.hasProfiles(), pending: id => bots.pending(id), approve: options => bots.approve(options), stop: id => bots.stop(id), validateSelection: options => bots.validateSelection(options), execute: options => bots.run(options) });
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const profile = bots.create({ name: 'Builder', provider: 'codex', workspace: directory }).bot;
  const id = bots.createConversation(profile.id).conversation.id;
  chats.send(id, 'Synthetic supervision test'); await new Promise(resolve => setImmediate(resolve));
  const before = readFileSync(join(directory, 'bots.json'), 'utf8');
  chats.list = () => { throw new Error('Supervision must never copy full conversation history.'); };
  const source = chats.supervisionSources();
  assert.equal(JSON.stringify(source).includes('PRIVATE'), false);
  assert.equal(Object.hasOwn(source[0].messages[0], 'content'), false);
  assert.equal(bots.supervision().sessions[0].state, 'approval');
  assert.equal(bots.supervision().sessions[0].id, id); assert.equal(starts, 1); assert.equal(providerChecks, 0);
  assert.equal(readFileSync(join(directory, 'bots.json'), 'utf8'), before);
  assert.equal(bots.pending(id).length, 1);
  await chats.approval(id, 'call_review', 'deny'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(bots.supervision().sessions[0].state, 'completed'); assert.equal(bots.pending(id).length, 0);
});

test('host supervision accepts only exact local read-only requests', async t => {
  let port, reads = 0;
  const routes = createBotRoutes({ bots: { supervision() { reads++; return snapshot([]); } }, port: () => port });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, `http://${req.headers.host}`)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${port}/api/bots/supervision`;
  assert.equal((await fetch(url)).status, 200); assert.equal(reads, 1);
  for (const method of ['POST','DELETE','PATCH']) assert.equal((await fetch(url, { method })).status, 405);
  assert.equal((await fetch(url + '?approve=all')).status, 400);
  assert.equal((await fetch(url, { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal(reads, 1);
});
