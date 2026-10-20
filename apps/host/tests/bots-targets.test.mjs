/** Bot selection/ownership fixtures. All SSH and inference operations are injected test doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOT_AVATARS, createBots, executionKey, normalizeBotExecution } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('Fixture did not settle'); }
function fixture(t, script = async c => { c.onFrame({ type: 'delta', text: 'Fixture answer' }); }) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bot-targets-'));
  const privateKey = 'fixture-maya-private-key';
  const connections = [
    { id: 'maya', name: 'Maya', baseUrl: 'https://maya.example.test/v1', protocol: 'openai-chat', apiKey: privateKey, models: [{ id: 'same-model', name: 'Maya-S24' }] },
    { id: 'strata', name: 'Remote Strata', baseUrl: 'https://strata.example.test/v1', protocol: 'openai-responses', apiKey: 'fixture-strata-private-key', models: [{ id: 'same-model', name: 'Coder' }], modelManagement: { transport: 'ssh', host: 'garage', user: 'operator', port: 2222 } },
  ];
  const providerRows = ['claude', 'codex', 'grok', 'kimi', 'ollama'].map(id => ({ id, name: id, available: true, detail: 'Fixture provider.' }));
  const calls = { probe: [], prepare: [], cua: [], run: [], inference: [], tool: [] };
  let chats;
  const runtime = { providers: async () => structuredClone(providerRows), run: async c => { calls.run.push(c); return script(c); }, close() {} };
  const modelProviders = { list: () => ({ connections: connections.map(({ apiKey, ...connection }) => structuredClone(connection)) }), resolve(selection) {
    const connection = connections.find(connection => connection.id === selection.connectionId), model = connection?.models.find(model => model.id === selection.modelId);
    if (!connection || !model) throw new Error('No selected fixture model.');
    return { connection, model };
  } };
  let probeStatus = { available: true, prepared: true, activeRuns: 0, detail: 'Fixture SSH helper ready.', providers: providerRows };
  const remoteSSH = { probe: async execution => { calls.probe.push(structuredClone(execution)); return structuredClone(probeStatus); }, prepare: async execution => { calls.prepare.push(structuredClone(execution)); return structuredClone(probeStatus); }, cua: async (execution, operation) => { calls.cua.push({ execution: structuredClone(execution), operation }); return { available: true }; } };
  const tools = { definitions: () => [], execute: async input => { calls.tool.push(input); return { content: [{ type: 'text', text: 'fixture result' }] }; }, finish() {}, close() {} };
  const options = { directory, runtime, tools, conversations: () => chats, remoteSSH, modelProviders, defaultWorkspace: () => directory,
    modelRequest: async (payload, bot, signal) => { calls.inference.push({ payload, bot: structuredClone(bot), signal }); return { text: 'Fixture model answer', toolCalls: [] }; } };
  const bots = createBots(options);
  chats = createConversations({ directory, enabled: () => bots.hasProfiles(), defaultWorkspace: () => directory, validateSelection: selection => bots.validateSelection(selection), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: request => bots.approve(request), execute: input => bots.run(input) });
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = patch => bots.create({ name: 'Fixture bot', provider: 'codex', workspace: directory, ...patch }).bot;
  return { directory, privateKey, connections, calls, bots, chats, options, create, setProbe: patch => { probeStatus = { ...probeStatus, ...patch }; } };
}

test('model and computer catalogs derive saved identities without probing, preparing or changing Maya', async t => {
  const f = fixture(t), before = structuredClone(f.connections);
  const listed = await f.bots.list();
  assert.equal(listed.models.length, 2);
  assert.deepEqual(listed.models.map(model => model.connectionId), ['maya', 'strata']);
  const ssh = listed.computers.find(computer => computer.kind === 'ssh');
  assert.equal(ssh.name, 'Remote Strata'); assert.equal(ssh.available, false);
  assert.equal(ssh.execution.host, 'garage'); assert.equal(ssh.execution.user, 'operator'); assert.equal(ssh.execution.port, 2222);
  assert.deepEqual(f.calls.probe, []); assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.run, []); assert.deepEqual(f.calls.inference, []);
  assert.equal(f.chats.available(), false);
  assert.deepEqual(f.connections, before); assert.equal(JSON.stringify(listed).includes('private-key'), false);
});

test('checking and preparing a saved SSH target are separate explicit operations', async t => {
  const f = fixture(t), target = (await f.bots.list()).computers.find(computer => computer.kind === 'ssh');
  const bot = f.create({ execution: { kind: 'ssh', host: 'other-server', user: 'any-user' }, workspace: '/home/any-user/project' });
  await f.bots.list(); assert.equal(f.calls.probe.length, 0); assert.equal(f.calls.prepare.length, 0);
  await f.bots.checkComputer({ computerId: target.id });
  assert.equal(f.calls.probe.length, 1); assert.equal(f.calls.prepare.length, 0);
  await f.bots.prepareComputer({ execution: { kind: 'ssh', host: 'other-server', user: 'any-user' } });
  assert.equal(f.calls.prepare.length, 1); assert.equal(f.calls.prepare[0].port, undefined, 'SSH config supplies an omitted port.');
  const catalog = await f.bots.list();
  assert.equal(catalog.computers.find(computer => computer.execution?.host === 'other-server').available, true);
  assert.equal(catalog.bots.find(profile => profile.id === bot.id).available, true);
  assert.equal(f.calls.run.length, 0);
  await assert.rejects(f.bots.prepareComputer({ execution: { kind: 'ssh', host: 'x' }, unexpected: true }), error => error.status === 400);
});

test('avatars are an exact safe palette and API credentials never become bot catalog or chat data', async t => {
  const f = fixture(t);
  for (const avatar of BOT_AVATARS) assert.equal(f.create({ avatar }).avatar, avatar);
  assert.throws(() => f.create({ avatar: 'https://avatar.example.test/photo.png' }), /bot avatars/);
  const bot = f.create({ provider: 'configured', avatar: '🦊', modelSource: { connectionId: 'maya', model: 'same-model' } });
  const created = f.bots.createConversation(bot.id).conversation;
  assert.equal(created.preferences.botAvatar, '🦊'); assert.equal(created.preferences.botModel, 'Maya · Maya-S24');
  const publicData = JSON.stringify({ bot, created, catalog: await f.bots.list() });
  assert.equal(publicData.includes(f.privateKey), false); assert.equal(publicData.includes('modelDestination'), false);
  assert.equal(readFileSync(join(f.directory, 'bots.json'), 'utf8').includes(f.privateKey), false, 'Configured sources store a reference, not a copied key.');
});

test('computer/model/workspace overrides freeze per chat and do not change the profile or Maya connection', async t => {
  const checkpoints = [], snapshots = [];
  const f = fixture(t, async c => {
    checkpoints.push(structuredClone(c.checkpoint)); snapshots.push(structuredClone(c.bot));
    await c.onCheckpoint({ nativeSessionId: `native-${c.sessionId}` }); c.onFrame({ type: 'delta', text: 'Fixture answer' });
  });
  const originalConnections = structuredClone(f.connections), catalog = await f.bots.list();
  const target = catalog.computers.find(computer => computer.kind === 'ssh'), selected = catalog.models.find(model => model.connectionId === 'strata');
  const bot = f.create({ avatar: '🦊', instructions: 'Original instructions.' });
  const chat = f.bots.createConversation(bot.id, { computerId: target.id, modelId: selected.id, workspace: '/home/operator/project' }).conversation;
  assert.equal(chat.workspace, '/home/operator/project'); assert.equal(chat.preferences.botComputer, 'Remote Strata'); assert.equal(chat.preferences.botModel, 'Remote Strata · Coder');
  f.chats.send(chat.id, 'First'); await until(() => !f.chats.detail(chat.id).conversation.active);
  f.bots.update(bot.id, { name: 'Edited profile', avatar: '🚀', provider: 'kimi', model: 'new-model', instructions: 'New instructions.' });
  f.chats.send(chat.id, 'Continue original'); await until(() => !f.chats.detail(chat.id).conversation.active);
  const next = f.bots.createConversation(bot.id).conversation;
  f.chats.send(next.id, 'Fresh'); await until(() => !f.chats.detail(next.id).conversation.active);
  assert.deepEqual(checkpoints, [null, { nativeSessionId: `native-${chat.id}` }, null]);
  assert.deepEqual(snapshots.slice(0, 2).map(snapshot => [snapshot.provider, snapshot.modelSource.connectionId, snapshot.workspace, snapshot.instructions, snapshot.avatar]), [
    ['configured', 'strata', '/home/operator/project', 'Original instructions.', '🦊'], ['configured', 'strata', '/home/operator/project', 'Original instructions.', '🦊'],
  ]);
  assert.equal(snapshots[2].provider, 'kimi'); assert.equal(snapshots[2].workspace, f.directory); assert.equal(snapshots[2].avatar, '🚀');
  assert.equal(f.chats.detail(chat.id).conversation.preferences.botAvatar, '🦊');
  assert.deepEqual(f.connections, originalConnections);
  assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.probe.length, 0);
});

test('destination drift blocks an existing configured chat before recording or starting a turn', async t => {
  const f = fixture(t), bot = f.create({ provider: 'configured', modelSource: { connectionId: 'maya', model: 'same-model' } });
  const chat = f.bots.createConversation(bot.id).conversation;
  f.connections[0].baseUrl = 'https://changed.example.test/v1';
  assert.throws(() => f.chats.send(chat.id, 'Do not send'), /changed its address/);
  assert.equal(f.chats.detail(chat.id).conversation.messages.length, 0); assert.equal(f.calls.run.length, 0);
  f.bots.update(bot.id, { name: 'Review changed endpoint' });
  assert.throws(() => f.chats.send(chat.id, 'Old chat remains pinned'), /changed its address/);
  const next = f.bots.createConversation(bot.id).conversation;
  f.chats.send(next.id, 'New selection'); await until(() => !f.chats.detail(next.id).conversation.active);
  assert.equal(f.calls.run.length, 1);
});

test('invalid catalogs and extra creation fields never create a fallback conversation', async t => {
  const f = fixture(t), bot = f.create();
  for (const selection of [{ computerId: 'removed' }, { modelId: 'removed' }, { execution: { kind: 'ssh', host: '-oProxyCommand=bad' } }, { execution: { kind: 'ssh', host: 'server' }, workspace: 'relative' }, { computerId: 'local', execution: { kind: 'local' } }, { remoteModel: { connectionId: 'maya' } }]) {
    assert.throws(() => f.bots.createConversation(bot.id, selection));
  }
  assert.equal(f.chats.list().conversations.length, 0); assert.equal(f.calls.run.length, 0);
  assert.notEqual(executionKey(normalizeBotExecution({ kind: 'ssh', host: 'alias' })), executionKey(normalizeBotExecution({ kind: 'ssh', host: 'alias', port: 22 })), 'An omitted port must honor SSH configuration.');
});

test('remote model callbacks cannot select another connection or act after the turn ends', async t => {
  let captured;
  const f = fixture(t, async c => {
    captured = c;
    await c.modelRequest({ messages: [], tools: [], system: 'Fixture' }, { provider: 'configured', modelSource: { connectionId: 'strata', model: 'same-model' } });
    c.onFrame({ type: 'delta', text: 'Fixture answer' });
  });
  const bot = f.create({ provider: 'configured', modelSource: { connectionId: 'maya', model: 'same-model' } });
  const chat = f.bots.createConversation(bot.id).conversation;
  f.chats.send(chat.id, 'Fixture'); await until(() => !f.chats.detail(chat.id).conversation.active);
  assert.equal(f.calls.inference.length, 1); assert.equal(f.calls.inference[0].bot.modelSource.connectionId, 'maya');
  assert.equal(f.calls.inference[0].signal.aborted, true);
  assert.throws(() => captured.modelRequest({ messages: [], tools: [] }), /ended/);
  assert.throws(() => captured.executeTool('anything', {}, 'late'), /ended/);
  assert.equal(f.calls.tool.length, 0);
});

test('cleanup-unconfirmed Stop is an error and persistently blocks the target until an idle check confirms cleanup', async t => {
  const f = fixture(t, async c => {
    c.onFrame({ type: 'delta', text: 'Partial fixture answer' });
    await new Promise((resolve, reject) => c.signal.addEventListener('abort', () => reject(Object.assign(new Error('Remote cleanup could not be confirmed.'), { code: 'ssh_cleanup_unconfirmed' })), { once: true }));
  });
  const bot = f.create({ execution: { kind: 'ssh', host: 'garage', user: 'operator', port: 2222 }, workspace: '/home/operator/project' });
  const chat = f.bots.createConversation(bot.id).conversation;
  f.chats.send(chat.id, 'Fixture'); await until(() => f.calls.run.length === 1);
  await assert.rejects(f.chats.stop(chat.id), error => error.code === 'ssh_cleanup_unconfirmed');
  await until(() => !f.chats.detail(chat.id).conversation.active);
  const message = f.chats.detail(chat.id).conversation.messages.at(-1);
  assert.equal(message.content, 'Partial fixture answer'); assert.match(message.error, /cleanup could not be confirmed/);
  assert.equal(f.bots.activeCount(), 0);
  assert.throws(() => f.chats.send(chat.id, 'Unsafe restart'), /cleanup could not be confirmed/);
  const restored = createBots(f.options); t.after(() => restored.close());
  assert.throws(() => restored.validateSelection({ botId: bot.id, chatId: chat.id }), /cleanup could not be confirmed/);
  const target = (await restored.list()).computers.find(computer => computer.execution?.host === 'garage');
  f.setProbe({ activeRuns: 1 }); await restored.checkComputer({ computerId: target.id });
  assert.throws(() => restored.validateSelection({ botId: bot.id, chatId: chat.id }), /cleanup could not be confirmed/);
  f.setProbe({ activeRuns: undefined }); await restored.checkComputer({ computerId: target.id });
  assert.throws(() => restored.validateSelection({ botId: bot.id, chatId: chat.id }), /cleanup could not be confirmed/);
  f.setProbe({ activeRuns: 0 }); await restored.checkComputer({ computerId: target.id });
  assert.doesNotThrow(() => restored.validateSelection({ botId: bot.id, chatId: chat.id }));
  assert.equal(f.calls.run.length, 1); assert.equal(f.calls.prepare.length, 0);
});

test('Pause stops every owned chat, persists across restart and blocks frozen chats until explicit Resume', async t => {
  const f = fixture(t, async c => { await new Promise(resolve => c.signal.addEventListener('abort', resolve, { once: true })); });
  const bot = f.create(), other = f.create({ name: 'Another bot' });
  const chats = [f.bots.createConversation(bot.id).conversation, f.bots.createConversation(bot.id).conversation];
  for (const chat of chats) f.chats.send(chat.id, 'Fixture');
  await until(() => f.bots.activeCount() === 2);
  await f.bots.pause(bot.id, { paused: true });
  await until(() => chats.every(chat => !f.chats.detail(chat.id).conversation.active));
  assert.equal(f.bots.activeCount(), 0);
  for (const chat of chats) assert.throws(() => f.chats.send(chat.id, 'Do not send'), /paused/);
  assert.throws(() => f.bots.createConversation(bot.id), /paused/);
  assert.doesNotThrow(() => f.bots.createConversation(other.id));
  const restored = createBots(f.options); t.after(() => restored.close());
  assert.throws(() => restored.validateSelection({ botId: bot.id, chatId: chats[0].id }), /paused/);
  f.bots.update(bot.id, { name: 'Still paused' });
  assert.equal((await f.bots.list()).bots.find(b => b.id === bot.id).paused, true);
  await f.bots.pause(bot.id, { paused: false });
  assert.doesNotThrow(() => f.bots.validateSelection({ botId: bot.id, chatId: chats[0].id }));
  assert.equal(f.calls.run.length, 2, 'Resume does not automatically start work.');
});

test('isolated CUA chats use the actual sandbox workspace and never accept a host path override', t => {
  const f = fixture(t), bot = f.create({ computerMode: 'cua', workspace: '/workspace' });
  assert.equal(f.bots.createConversation(bot.id).conversation.workspace, '/workspace');
  assert.throws(() => f.bots.createConversation(bot.id, { workspace: '/home/operator/project' }), /uses \/workspace/);
  assert.throws(() => f.create({ computerMode: 'cua' }), /uses \/workspace/);
});

test('native per-chat CUA preparation uses its frozen computer after the profile changes', async t => {
  const f = fixture(t), execution = { kind: 'ssh', host: 'original', user: 'operator' };
  const bot = f.create({ computerMode: 'cua', workspace: '/workspace', execution });
  const chat = f.bots.createConversation(bot.id).conversation;
  f.bots.update(bot.id, { execution: { kind: 'ssh', host: 'new', user: 'different' } });
  await f.bots.computer.prepare(bot.id, { chatId: chat.id });
  assert.deepEqual(f.calls.prepare, [execution]);
  assert.deepEqual(f.calls.cua, [{ execution, operation: 'prepare' }]);
  assert.equal(f.calls.run.length, 0); assert.equal(f.calls.inference.length, 0);
});

test('manual CUA cleanup uncertainty survives restart and blocks takeover until explicit computer Stop', async t => {
  const f = fixture(t), execution = { kind: 'ssh', host: 'isolated', user: 'operator' };
  f.options.remoteSSH.cua = async (_execution, operation) => {
    if (operation === 'control') throw Object.assign(new Error('Guest input cleanup unknown'), { cleanupUnconfirmed: true, code: 'cua_cleanup_unconfirmed' });
    if (operation === 'stop') return { stopped: true, cleanupConfirmed: true };
    return { available: true, cleanupConfirmed: true, frame: { data: 'fixture', mimeType: 'image/png', width: 100, height: 100 } };
  };
  const bot = f.create({ computerMode: 'cua', workspace: '/workspace', execution });
  const chat = f.bots.createConversation(bot.id).conversation;
  const lease = await f.bots.computer.takeover(bot.id, { chatId: chat.id });
  await assert.rejects(f.bots.computer.control(bot.id, { chatId: chat.id, leaseToken: lease.leaseToken, action: 'key', key: 'Enter' }), /cleanup unknown/);
  const restored = createBots(f.options); t.after(() => restored.close());
  await assert.rejects(restored.computer.takeover(bot.id, { chatId: chat.id }), /CUA cleanup is unconfirmed/);
  await assert.rejects(restored.computer.start(bot.id, { chatId: chat.id }), /CUA cleanup is unconfirmed/);
  assert.throws(() => restored.validateSelection({ botId: bot.id, chatId: chat.id }), /cleanup is unconfirmed/);
  await restored.computer.stop(bot.id, { chatId: chat.id });
  assert.doesNotThrow(() => restored.validateSelection({ botId: bot.id, chatId: chat.id }));
  const recovered = await restored.computer.takeover(bot.id, { chatId: chat.id });
  assert.equal(recovered.control.owned, true);
  assert.equal(f.calls.run.length, 0);
});

test('owned CUA computers must be explicitly stopped before removal or target changes, including after restart', async t => {
  const f = fixture(t), bot = f.create({ computerMode: 'cua', workspace: '/workspace', execution: { kind: 'ssh', host: 'isolated' } });
  f.options.remoteSSH.cua = async (_execution, operation) => operation === 'stop' ? { stopped: true, cleanupConfirmed: true } : { available: true, running: operation === 'start', cleanupConfirmed: true };
  await f.bots.computer.start(bot.id);
  assert.throws(() => f.bots.remove(bot.id), /Stop this bot’s isolated computer/);
  assert.throws(() => f.bots.update(bot.id, { execution: { kind: 'ssh', host: 'other' } }), /before changing/);
  const restored = createBots(f.options); t.after(() => restored.close());
  assert.throws(() => restored.remove(bot.id), /Stop this bot’s isolated computer/);
  await restored.computer.stop(bot.id);
  assert.equal(restored.remove(bot.id).deleted, bot.id);
  const untouched = f.create({ computerMode: 'cua', workspace: '/workspace' });
  assert.equal(f.bots.remove(untouched.id).deleted, untouched.id, 'Unprepared untouched profiles have no lifecycle ownership.');
});

test('provider preflight failure never creates a CUA lifecycle tombstone', async t => {
  const f = fixture(t, async () => { throw new Error('Fixture provider is signed out'); });
  const bot = f.create({ computerMode: 'cua', workspace: '/workspace' });
  const chat = f.bots.createConversation(bot.id).conversation;
  f.chats.send(chat.id, 'Fixture'); await until(() => !f.chats.detail(chat.id).conversation.active);
  assert.equal(f.bots.remove(bot.id).deleted, bot.id);
  assert.equal(f.chats.detail(chat.id).conversation.messages.length, 2);
});
