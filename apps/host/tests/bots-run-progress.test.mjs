/** Inert providers, fake browsers and temporary files only; no SSH or VM actions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createBotTools } from '../server/bots-tools.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createConversationRoutes, addConversationEvents } from '../server/conversation-routes.mjs';
import { EventHub } from '../server/util.mjs';

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const held = signal => new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve(); });
function fixture(t, run) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-run-progress-')); let chats;
  const events = [], notify = (event, data) => events.push([event, data]);
  const page = { goto: async () => {}, url: () => 'https://example.test', screenshot: async () => Buffer.from('fixture'), locator: () => ({ innerText: async () => 'Fixture browser' }) };
  const tools = createBotTools({ directory, browserProbe: () => ({ found: true }), browserFactory: async () => ({ page, close: async () => {} }) });
  const bots = createBots({ directory, defaultWorkspace: () => directory, conversations: () => chats, tools, notify,
    runtime: { providers: async () => [], run, close() {} }, remoteSSH: { run: () => assert.fail('No SSH'), cua: () => assert.fail('No CUA') } });
  chats = createConversations({ directory, enabled: () => true, notify, pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: input => bots.validateSelection(input), execute: input => bots.run(input) });
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const make = name => bots.create({ name: `QA-TEST-${name}`, provider: 'codex', workspace: directory, computerMode: 'host', capabilities: 'both', policy: 'bypass' }).bot;
  const makeTeam = (coordinator, worker) => bots.team.create({ name: 'QA-TEST-Team', memberIds: [coordinator.id, worker.id], coordinatorId: coordinator.id, enabled: true }).team;
  return { directory, bots, chats, events, make, makeTeam };
}
async function serve(t, routeOf) {
  let server;
  const route = routeOf(() => server.address().port);
  server = http.createServer((req, res) => { void route(req, res, new URL(req.url, 'http://127.0.0.1')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('a team run emits task.progress with increasing steps, ids and the current tool name', async t => {
  const running = new Map();
  const f = fixture(t, async input => {
    if (input.bot.teamConversationOnly) return;
    await input.executeTool('read_file', { path: 'marker.txt' }, 'read');
    await input.executeTool('write_file', { path: 'qa-test-out.txt', content: 'done' }, 'write');
    running.set(input.sessionId, input); await held(input.signal);
  });
  writeFileSync(join(f.directory, 'marker.txt'), 'QA-TEST-fixture');
  const coordinator = f.make('Coordinator'), worker = f.make('Worker'), team = f.makeTeam(coordinator, worker);
  const progress = [];
  const unsubscribe = f.bots.team.subscribe((event, data) => { if (event === 'task.progress') progress.push(data); });
  t.after(unsubscribe);
  const run = f.bots.team.message(team.id, { message: 'QA-TEST-work', requestId: 'progress', workMode: 'work', recipientIds: [worker.id] }).run;
  await until(() => progress.filter(row => row.botId === worker.id).length >= 2);
  const steps = progress.filter(row => row.runId === run.id && row.botId === worker.id);
  assert.deepEqual(steps.map(row => [row.step, row.toolName]), [[1, 'read_file'], [2, 'write_file']]);
  for (const row of steps) {
    assert.equal(row.teamId, team.id);
    assert.match(row.jobId, /^tj_/);
    assert.match(row.conversationId, /^s_/);
  }
  await f.bots.team.stop(team.id, run.id);
});

test('a one-to-one bot conversation emits task.progress with the conversation id and tool steps', async t => {
  const f = fixture(t, async input => {
    await input.executeTool('read_file', { path: 'marker.txt' }, 'read');
    await input.executeTool('write_file', { path: 'qa-test-out.txt', content: 'done' }, 'write');
  });
  writeFileSync(join(f.directory, 'marker.txt'), 'QA-TEST-fixture');
  const conversation = f.bots.createConversation(f.make('Personal').id).conversation;
  f.chats.send(conversation.id, 'QA-TEST-progress');
  await until(() => !f.chats.detail(conversation.id).conversation.active);
  const steps = f.events.filter(([event, data]) => event === 'task.progress' && data.conversationId === conversation.id).map(([, data]) => data);
  assert.deepEqual(steps.map(({ step, toolName }) => ({ step, toolName })), [{ step: 1, toolName: 'read_file' }, { step: 2, toolName: 'write_file' }]);
  for (const data of steps) assert.deepEqual(Object.keys(data).sort(), ['conversationId', 'step', 'toolName']);
});

test('a conversation turn reports each agent and connected tool start once, in order', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-run-progress-'));
  const events = [];
  const chats = createConversations({ directory, enabled: () => true, notify: (event, data) => events.push([event, data]),
    execute: ({ onFrame }) => {
      onFrame({ type: 'agent-tool', tool: { id: 't1', name: 'qa_test_agent_tool', state: 'running' } });
      onFrame({ type: 'agent-tool', tool: { id: 't1', name: 'qa_test_agent_tool', state: 'done' } });
      onFrame({ type: 'native-tool', event: { id: 'n1', name: 'qa_test_connected_tool', event: 'call' } });
      onFrame({ type: 'native-tool', event: { id: 'n1', name: 'qa_test_connected_tool', event: 'result', ok: true } });
      return { text: 'done' };
    } });
  t.after(() => { chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const conversation = chats.create({}).conversation;
  chats.send(conversation.id, 'QA-TEST-tools');
  await until(() => !chats.detail(conversation.id).conversation.active);
  const steps = events.filter(([event]) => event === 'task.progress').map(([, data]) => data);
  assert.deepEqual(steps, [
    { conversationId: conversation.id, step: 1, toolName: 'qa_test_agent_tool' },
    { conversationId: conversation.id, step: 2, toolName: 'qa_test_connected_tool' },
  ]);
});

test('POST /api/bots/teams/:teamId/runs/:runId/stop stops a held run; bodies and unknown runs are rejected', async t => {
  const running = new Map();
  const f = fixture(t, async input => { if (input.bot.teamConversationOnly) return; running.set(input.sessionId, input); await held(input.signal); });
  const coordinator = f.make('Stop Coordinator'), worker = f.make('Stop Worker'), team = f.makeTeam(coordinator, worker);
  const run = f.bots.team.message(team.id, { message: 'QA-TEST-hold', requestId: 'stop-route', workMode: 'work', recipientIds: [worker.id] }).run;
  await until(() => running.size === 1);
  const base = await serve(t, port => createBotRoutes({ bots: f.bots, port }));
  const stop = (runId, options = {}) => fetch(`${base}/api/bots/teams/${team.id}/runs/${runId}/stop`, { method: 'POST', ...options });
  assert.equal((await stop(run.id, { headers: { 'content-type': 'application/json' }, body: '{"reason":"QA-TEST-extra"}' })).status, 400);
  assert.equal((await stop('tr_00000000000000000000000000000000')).status, 404);
  assert.equal((await stop(run.id, { headers: { origin: 'http://evil.invalid' } })).status, 403);
  assert.equal(f.bots.team.detail(team.id, run.id).run.state, 'running');
  assert.equal((await stop(run.id)).status, 200);
  assert.equal(f.bots.team.detail(team.id, run.id).run.state, 'cancelled');
  await until(() => [...running.values()].every(input => input.signal.aborted));
});

test('POST /api/companion/conversations/:id/stop stops a held turn and refuses non-local callers', async t => {
  const running = new Map();
  const f = fixture(t, async input => { running.set(input.sessionId, input); await held(input.signal); });
  const conversation = f.bots.createConversation(f.make('Companion').id).conversation;
  const base = await serve(t, port => createConversationRoutes({ conversations: f.chats, port }));
  const stop = (id, options = {}) => fetch(`${base}/api/companion/conversations/${id}/stop`, { method: 'POST', ...options });
  assert.equal((await stop(conversation.id, { headers: { origin: 'http://evil.invalid' } })).status, 403);
  f.chats.send(conversation.id, 'QA-TEST-hold');
  await until(() => running.size === 1);
  assert.equal((await stop(conversation.id)).status, 200);
  await until(() => !f.chats.detail(conversation.id).conversation.active);
  assert.equal((await stop('s_missing')).status, 404);
});

test('the team channel stream forwards task.progress with a bounded metadata payload', async t => {
  const running = new Map();
  const f = fixture(t, async input => {
    if (input.bot.teamConversationOnly) return;
    await input.executeTool('read_file', { path: 'marker.txt' }, 'read');
    running.set(input.sessionId, input); await held(input.signal);
  });
  writeFileSync(join(f.directory, 'marker.txt'), 'QA-TEST-fixture');
  const coordinator = f.make('Stream Coordinator'), worker = f.make('Stream Worker'), team = f.makeTeam(coordinator, worker);
  const base = await serve(t, port => createBotRoutes({ bots: f.bots, port }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/bots/teams/${team.id}/channel/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '';
  const readUntil = async marker => {
    const deadline = Date.now() + 3000;
    while (!text.includes(marker)) {
      if (Date.now() > deadline) throw Error(`Stream fixture timed out waiting for ${marker}`);
      const { value, done } = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(Error('Stream fixture read timed out')), 3000))]);
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  };
  const run = f.bots.team.message(team.id, { message: 'QA-TEST-stream', requestId: 'stream-progress', workMode: 'work', recipientIds: [worker.id] }).run;
  await readUntil('event: task.progress');
  const frame = text.split('\n\n').map(part => part.trim()).find(part => part.startsWith('event: task.progress'));
  const data = JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
  assert.deepEqual(Object.keys(data).sort(), ['botId', 'conversationId', 'jobId', 'runId', 'step', 'teamId', 'toolName']);
  assert.equal(data.teamId, team.id);
  assert.equal(data.runId, run.id);
  assert.deepEqual([data.step, data.toolName], [1, 'read_file']);
  await f.bots.team.stop(team.id, run.id);
});

class Subscriber extends EventEmitter {
  output = '';
  writeHead() {}
  write(frame) { this.output += frame; }
}
const hubRequest = (host = '127.0.0.1:47831', origin, remoteAddress = '127.0.0.1') => ({ headers: { host, ...(origin === undefined ? {} : { origin }) }, socket: { remoteAddress } });

test('task.progress on the shared event stream stays private to the local companion', t => {
  const hub = new EventHub(), conversations = { list: () => ({ conversations: [] }) };
  const local = new Subscriber(), foreign = new Subscriber();
  t.after(() => { local.emit('close'); foreign.emit('close'); });
  addConversationEvents({ req: hubRequest('127.0.0.1:47831', 'http://127.0.0.1:47831'), res: local, hub, conversations, port: 47831 });
  addConversationEvents({ req: hubRequest('127.0.0.1:47831', 'https://malicious.example'), res: foreign, hub, conversations, port: 47831 });
  hub.send('task.progress', { conversationId: 's_private', step: 3, toolName: 'qa_test_secret_tool' });
  assert.match(local.output, /event: task\.progress/);
  assert.match(local.output, /qa_test_secret_tool/);
  assert.doesNotMatch(foreign.output, /task\.progress|qa_test_secret_tool|s_private/);
});
