import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import http from 'node:http';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, run = async ({ onFrame }) => { onFrame({ type: 'reasoning', text: 'Provider progress' }); onFrame({ type: 'delta', text: 'Shared answer' }); }) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bots-'));
  let chats;
  const runtime = { providers: async () => ['claude','codex','grok','kimi','ollama','devin'].map(id => ({ id, name: id, available: true, detail: 'fixture' })), run, close() {} };
  const tools = { definitions: () => [], execute: () => {}, close() {} };
  const bots = createBots({ directory, runtime, tools, defaultWorkspace: () => directory, conversations: () => chats });
  chats = createConversations({ directory, enabled: () => bots.hasProfiles(), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: options => bots.approve(options),
    validateSelection: selection => bots.validateSelection(selection), execute: args => bots.run(args) });
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = (input = {}) => bots.create({ name: 'Builder', provider: 'codex', workspace: directory, ...input }).bot;
  return { directory, runtime, tools, bots, chats, create };
}

test('six provider profiles are opt-in; creation does not start a turn or modify model services', async t => {
  let runs = 0;
  const { bots, chats, create, directory } = fixture(t, async () => { runs++; });
  assert.equal(chats.available(), false);
  const serviceFile = join(directory, 'model-providers.json'); writeFileSync(serviceFile, '{"name":"Maya"}');
  for (const provider of ['claude','codex','grok','kimi','ollama','devin']) create({ provider });
  assert.equal((await bots.list()).bots.length, 6); assert.equal(chats.available(), true); assert.equal(runs, 0);
  assert.equal(readFileSync(serviceFile, 'utf8'), '{"name":"Maya"}');
});

test('Devin personal chats keep saved defaults and shared history without activating a provider', async t => {
  let runs = 0;
  const f = fixture(t, async () => { runs++; });
  const bot = f.create({ name: 'Devin teammate', provider: 'devin', model: 'verified-fixture-model', effort: '', policy: 'plan', capabilities: 'both' });
  const chat = f.bots.createConversation(bot.id).conversation;
  assert.equal(chat.preferences.botId, bot.id);
  assert.equal(chat.preferences.mode, 'plan');
  const saved = JSON.parse(readFileSync(join(f.directory, 'bots.json'), 'utf8'));
  const frozen = saved.chatProfiles.find(([id]) => id === chat.id)[1];
  assert.equal(frozen.provider, 'devin'); assert.equal(frozen.model, 'verified-fixture-model');
  assert.equal(frozen.workspace, f.directory); assert.equal(frozen.policy, 'plan');
  assert.deepEqual(f.chats.detail(chat.id).conversation.messages, []);
  assert.equal(runs, 0, 'Opening a Devin chat must not send a prompt or start its computer.');
  f.bots.update(bot.id, { model: 'next-fixture-model', policy: 'bypass' });
  const old = JSON.parse(readFileSync(join(f.directory, 'bots.json'), 'utf8')).chatProfiles.find(([id]) => id === chat.id)[1];
  assert.equal(old.model, 'verified-fixture-model'); assert.equal(old.policy, 'plan');
  assert.equal((await f.bots.list()).bots.find(row => row.id === bot.id).provider, 'devin');
});

test('catalog projects no API secrets and stores private configuration atomically', async t => {
  const { bots, create, directory } = fixture(t);
  const bot = create({ provider: 'ollama', providerSettings: { apiKey: 'private-test-key', baseURL: 'https://ollama.com/v1' } });
  assert.equal(bot.providerSettings.apiKeySet, true);
  assert.equal(JSON.stringify(await bots.list()).includes('private-test-key'), false);
  assert.equal(statSync(join(directory, 'bots.json')).mode & 0o777, 0o600);
  bots.update(bot.id, { name: 'Renamed' });
  assert.equal(JSON.parse(readFileSync(join(directory, 'bots.json'))).bots[0].providerSettings.apiKey, 'private-test-key');
  bots.update(bot.id, { providerSettings: { clearKey: true } });
  assert.equal((await bots.list()).bots[0].providerSettings.apiKeySet, false);
});

test('avatar families round-trip, reject unknown fields and freeze existing conversation faces', t => {
  const { bots, chats, create } = fixture(t);
  const face = { color: 'sky', eyes: 'star', ears: 'round' };
  const bot = create({ avatarConfig: face });
  const chat = bots.createConversation(bot.id).conversation;
  for (const kind of ['koala', 'fox', 'cat', 'robot']) {
    assert.deepEqual(bots.update(bot.id, { avatarConfig: { ...face, kind } }).bot.avatarConfig, { ...face, kind });
  }
  assert.deepEqual(chats.detail(chat.id).conversation.preferences.botAvatarConfig, face);
  const next = bots.createConversation(bot.id).conversation;
  assert.deepEqual(next.preferences.botAvatarConfig, { ...face, kind: 'robot' });
  for (const invalid of [{ ...face, kind: null }, { ...face, kind: 'external' }, { ...face, image: 'https://external' }, { color: 'sky', eyes: 'star' }]) {
    assert.throws(() => bots.update(bot.id, { avatarConfig: invalid }), error => error.status === 400);
  }
});

test('Mac and phone continue exact conversation and retain Thinking after restart', async t => {
  const { bots, chats, create, directory } = fixture(t);
  const bot = create(); const { conversation } = bots.createConversation(bot.id);
  assert.equal(conversation.preferences.botId, bot.id);
  assert.equal(conversation.workspace, directory);
  assert.equal(conversation.messages.length, 0);
  chats.send(conversation.id, 'Work from Mac'); await tick();
  chats.send(conversation.id, 'Continue from phone'); await tick();
  const saved = chats.detail(conversation.id).conversation;
  assert.equal(saved.messages.length, 4);
  assert.equal(saved.messages[1].reasoning, 'Provider progress');
  assert.equal(saved.messages[3].content, 'Shared answer');
  chats.close(); const restored = createConversations({ directory });
  assert.deepEqual(restored.detail(conversation.id).conversation.messages, saved.messages);
  restored.close();
});

test('real pending tool identity blocks execution until approval; phone decision resumes it', async t => {
  let ran = false;
  const { bots, chats, create } = fixture(t, async ({ requestPermission, onFrame }) => {
    if (await requestPermission({ id: 'call-1', name: 'write_file', args: { path: 'x' }, reason: 'Write x' })) ran = true;
    onFrame({ type: 'agent-tool', tool: { id: 'call-1', state: ran ? 'done' : 'denied' } });
  });
  const { conversation } = bots.createConversation(create().id);
  chats.send(conversation.id, 'Write'); await tick();
  assert.equal(ran, false); assert.equal(chats.detail(conversation.id).pending[0].id, 'call-1');
  await chats.approval(conversation.id, 'call-1', 'approve'); await tick();
  assert.equal(ran, true); assert.equal(chats.detail(conversation.id).conversation.active, false);
  assert.equal(chats.detail(conversation.id).conversation.messages.at(-1).tools[0].state, 'done');
});

test('Stop cancels waiting approvals and only its own bot conversation', async t => {
  const ended = [];
  const { bots, chats, create } = fixture(t, async ({ sessionId, requestPermission }) => { await requestPermission({ id: 'same-call', name: 'command' }); ended.push(sessionId); });
  const id = create().id, a = bots.createConversation(id).conversation.id, b = bots.createConversation(id).conversation.id;
  chats.send(a, 'A'); chats.send(b, 'B'); await tick();
  assert.throws(() => chats.send(a, 'Duplicate'), e => e.status === 409);
  await chats.stop(a); await tick();
  assert.deepEqual(ended, [a]); assert.equal(chats.detail(b).conversation.active, true);
  assert.equal(chats.detail(a).pending.length, 0);
  await chats.approval(b, 'same-call', 'deny'); await tick();
});

test('profile settings cannot change during a live turn, and deleting keeps all history', async t => {
  const { bots, chats, create } = fixture(t, async ({ requestPermission }) => { await requestPermission({ id: 'wait', name: 'command' }); });
  const bot = create(), id = bots.createConversation(bot.id).conversation.id;
  chats.send(id, 'Wait'); await tick();
  assert.throws(() => bots.update(bot.id, { policy: 'bypass' }), e => e.status === 409);
  assert.throws(() => bots.remove(bot.id), e => e.status === 409);
  await chats.stop(id); await tick(); bots.remove(bot.id);
  assert.equal(chats.detail(id).conversation.messages[0].content, 'Wait');
  assert.equal(chats.detail(id).conversation.preferences.botName, 'Builder');
  assert.throws(() => chats.send(id, 'Again'), e => e.status === 404);
});

test('existing chats retain their execution profile; new chats get edited model and fresh native session', async t => {
  const received = [];
  const models = [];
  const { bots, chats, create } = fixture(t, async ({ bot, checkpoint, onCheckpoint }) => { received.push(checkpoint); models.push(bot.model); onCheckpoint({ nativeSessionId: 'native-1' }); });
  const bot = create(), id = bots.createConversation(bot.id).conversation.id;
  chats.send(id, 'One'); await tick(); chats.send(id, 'Two'); await tick();
  bots.update(bot.id, { model: 'different' }); chats.send(id, 'Three'); await tick();
  const next = bots.createConversation(bot.id).conversation.id; chats.send(next, 'Four'); await tick();
  assert.deepEqual(received, [null, { nativeSessionId: 'native-1' }, { nativeSessionId: 'native-1' }, null]);
  assert.deepEqual(models, ['', '', '', 'different']);
});

test('renderer snapshots cannot change bot ownership or turn bot chat into ordinary inference', t => {
  const { bots, chats, create } = fixture(t);
  const bot = create(), initial = bots.createConversation(bot.id).conversation;
  chats.sync([{ session: { ...initial, workspace: '/tmp/other', preferences: {} }, baseRevision: initial.revision }]);
  const saved = chats.detail(initial.id).conversation;
  assert.equal(saved.preferences.botId, bot.id); assert.equal(saved.workspace, initial.workspace);
  assert.throws(() => chats.preferences(initial.id, { mode: 'bypass' }), e => e.status === 409);
});

test('remote model API is not SSH or desktop authority; unconfigured targets fail before a new chat', t => {
  const { bots, chats, create } = fixture(t);
  const bot = create({ execution: { kind: 'ssh', host: 'server.example', user: 'different-user', port: 2222 } });
  assert.throws(() => bots.createConversation(bot.id), e => e.status === 409);
  assert.equal(chats.list().conversations.length, 0);
  assert.throws(() => create({ execution: { kind: 'ssh', host: '-oProxyCommand=bad', user: 'root' } }), /SSH host/);
  assert.throws(() => create({ providerSettings: { baseURL: 'http://example.com' } }), /HTTPS/);
});

test('corrupt bot catalog is left unchanged rather than silently reset', t => {
  const { directory, runtime, tools } = fixture(t);
  const file = join(directory, 'bots.json'); writeFileSync(file, '{broken');
  assert.throws(() => createBots({ directory, runtime, tools }), /left unchanged/);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});

test('bot API rejects foreign Origin, nonloopback hosts and unknown actions', async t => {
  const { bots } = fixture(t);
  let port; const routes = createBotRoutes({ bots, port: () => port });
  const server = http.createServer((req,res) => routes(req,res,new URL(req.url, `http://${req.headers.host}`)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${port}/api/bots`;
  assert.equal((await fetch(url, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: `server.example:${port}` } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  const response = await fetch(url); assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(url + '/unknown')).status, 404);
});
