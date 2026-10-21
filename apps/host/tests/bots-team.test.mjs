import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createBotTeams, DEFAULT_TEAM_LIMITS } from '../server/bots-team.mjs';
import { createConversations } from '../server/conversations.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, timeout = 4000) { const at = Date.now(); while (!predicate()) { if (Date.now() - at > timeout) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
function fixture(t, run, extensions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bot-team-')); let chats;
  const runtime = { providers: async () => [], run, close() {} };
  const bots = createBots({ directory, runtime, tools: { definitions: () => [], finish: async () => {} }, defaultWorkspace: () => directory, conversations: () => chats, ...extensions });
  chats = createConversations({ directory, enabled: () => bots.hasProfiles(), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: selection => bots.validateSelection(selection), execute: input => bots.run(input) });
  const create = name => bots.create({ name, provider: 'codex', workspace: directory, policy: 'bypass' }).bot;
  const a = create('Coordinator'), b = create('Builder'), c = create('Reviewer');
  const team = (input = {}) => bots.team.create({ name: 'Engineering', memberIds: [a.id, b.id, c.id], coordinatorId: a.id, enabled: true, ...input }).team;
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, runtime, bots, chats, a, b, c, team };
}

test('team creation is opt-in, validates members and limits, and starts no model work', async t => {
  let count = 0;
  const f = fixture(t, async () => { count++; });
  const row = f.team({ enabled: false });
  assert.equal(row.enabled, false); assert.deepEqual(row.limits, DEFAULT_TEAM_LIMITS); assert.equal(count, 0);
  assert.throws(() => f.bots.team.start(row.id, { message: 'Run' }), /Enable collaboration/);
  assert.throws(() => f.team({ memberIds: [f.a.id, f.a.id] }), /different bots/);
  assert.throws(() => f.team({ coordinatorId: 'bot_missing' }), /coordinator/);
  assert.equal(f.team({ limits: { maxDepth: 100 } }).limits.maxDepth, 0);
  assert.throws(() => f.team({ limits: { maxDepth: -1 } }), /maxDepth/);
  assert.equal(statSync(join(f.directory, 'bot-teams.json')).mode & 0o777, 0o600);
});

test('coordinator delegates asynchronously, deduplicates tool identity and receives one completion in shared history', async t => {
  let f, deliveries = [], calls = 0;
  f = fixture(t, async input => {
    calls++;
    if (input.message === 'Build feature') {
      const first = await input.executeTool('spawn_subagent', { botId: f.b.id, message: 'Implement this feature' }, 'spawn1');
      const second = await input.executeTool('spawn_subagent', { botId: f.b.id, message: 'Implement this feature' }, 'spawn1');
      assert.deepEqual(second, first); deliveries.push(JSON.parse(first.content[0].text));
      input.onFrame({ type: 'delta', text: 'Assigned builder.' });
    } else if (input.bot.id === f.b.id) input.onFrame({ type: 'delta', text: 'Implementation and checks complete.' });
    else { assert.match(input.message, /another bot's report/); input.onFrame({ type: 'delta', text: 'Reviewed the builder result.' }); }
    input.onFrame({ type: 'done' });
  });
  const team = f.team(), first = f.bots.team.start(team.id, { message: 'Build feature', requestId: 'human-request' });
  const retry = f.bots.team.start(team.id, { message: 'Build feature', requestId: 'human-request' });
  assert.equal(retry.run.id, first.run.id);
  assert.throws(() => f.bots.team.start(team.id, { message: 'Different', requestId: 'human-request' }), /another team message/);
  await until(() => f.bots.team.detail(team.id, first.run.id).run.state === 'completed');
  assert.equal(calls, 3); assert.equal(deliveries.length, 1);
  assert.equal(f.bots.team.detail(team.id, first.run.id).run.consumedTurns, 3);
  const root = f.chats.detail(first.run.rootChatId).conversation;
  assert.equal(root.messages.length, 4); assert.match(root.messages[2].content, /Implementation and checks complete/);
  assert.equal(f.bots.team.activity().activity.filter(row => row.type === 'subagent').length, 1);
  assert.equal(f.chats.detail(deliveries[0].chatId).conversation.preferences.parentChatId, root.id);
});

test('team Stop revokes queued work, pending permissions and all descendants but preserves independent work', async t => {
  let f, rootId, childStarted = false, independentStarted = false;
  f = fixture(t, async input => {
    if (input.message === 'Independent') { independentStarted = true; await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); return; }
    if (input.message === 'Coordinate') {
      rootId = input.sessionId;
      await input.executeTool('spawn_subagent', { botId: f.b.id, message: 'Wait for approval' }, 'child');
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    } else { childStarted = true; await input.requestPermission({ id: 'write', name: 'write_file', args: { path: 'x' }, reason: 'Write file' }); }
  });
  f.bots.update(f.b.id, { policy: 'manual' });
  const independent = f.bots.createConversation(f.c.id).conversation.id;
  f.chats.send(independent, 'Independent'); await until(() => independentStarted);
  const team = f.team(), started = f.bots.team.start(team.id, { message: 'Coordinate' });
  await until(() => childStarted && f.bots.team.activity().activity.some(row => row.type === 'subagent' && f.bots.pending(row.chatId).length));
  assert.throws(() => f.bots.update(f.b.id, { name: 'Changed' }), /team work/);
  const stopped = await f.bots.team.stop(team.id, started.run.id);
  assert.equal(stopped.run.state, 'cancelled'); assert.equal(f.bots.pending(rootId).length, 0);
  assert.equal(f.chats.detail(independent).conversation.active, true);
  assert.equal(f.bots.team.activity().activity.filter(row => row.runId === started.run.id && row.state === 'running').length, 0);
  await f.chats.stop(independent);
});

test('root conversation Stop cancels delegated work after the coordinator has yielded its completed turn', async t => {
  let f, childStarted = false;
  f = fixture(t, async input => {
    if (input.message === 'Delegate then yield') { await input.executeTool('spawn_subagent', { botId: f.b.id, message: 'Wait for Stop' }, 'yield-child'); input.onFrame({ type: 'delta', text: 'The child is working.' }); }
    else { childStarted = true; await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); }
  });
  const team = f.team(), started = f.bots.team.start(team.id, { message: 'Delegate then yield' });
  await until(() => childStarted && !f.chats.detail(started.run.rootChatId).conversation.active);
  const child = f.bots.team.activity().activity.find(row => row.type === 'subagent' && row.runId === started.run.id); assert.equal(f.chats.detail(child.chatId).conversation.active, true);
  await f.chats.stop(started.run.rootChatId);
  assert.equal(f.chats.detail(child.chatId).conversation.active, false); assert.equal(f.bots.team.detail(team.id, started.run.id).run.state, 'cancelled');
});

test('one team-owned turn per bot remains exclusive while finite useful work outlives legacy hop and turn settings', async t => {
  let f, running = new Map(), maximum = 0;
  f = fixture(t, async input => {
    const n = (running.get(input.bot.id) ?? 0) + 1; running.set(input.bot.id, n); maximum = Math.max(maximum, n);
    try {
      if (input.message === 'Coordinate') {
        await input.executeTool('send_to_teammate', { botId: f.b.id, message: 'First' }, 'a');
        await input.executeTool('send_to_teammate', { botId: f.b.id, message: 'Second' }, 'b');
      } else if (input.bot.id === f.b.id && input.message.startsWith('[Assignment')) {
        const result = await input.executeTool('send_to_teammate', { botId: f.a.id, message: 'Ping-pong should stop' }, 'reply');
        assert.equal(result.isError, undefined); // Runtime fixture exposes the rejecting host call below.
      }
    } finally { running.set(input.bot.id, n - 1); }
    input.onFrame({ type: 'done' });
  });
  const team = f.team({ limits: { maxHops: 1, maxTurns: 3 } }), start = f.bots.team.start(team.id, { message: 'Coordinate' });
  await until(() => ['error', 'completed'].includes(f.bots.team.detail(team.id, start.run.id).run.state));
  assert.equal(maximum, 1); assert.ok(f.bots.team.detail(team.id, start.run.id).run.consumedTurns > 3);
  assert.equal(f.bots.team.detail(team.id, start.run.id).run.state, 'completed');
  assert.equal(f.bots.team.activity().activity.some(row => row.detail?.includes('budget')), false);
});

test('restart retains durable team receipts but interrupts in-flight work without replay', async t => {
  let f;
  f = fixture(t, async input => { await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); });
  const team = f.team(), run = f.bots.team.start(team.id, { message: 'Keep working' }).run;
  await until(() => f.bots.team.detail(team.id, run.id).run.state === 'running');
  let replayed = 0;
  const restored = createBotTeams({ directory: f.directory, requireBot: id => ({ id }), conversations: () => ({ send() { replayed++; } }), createConversation() { throw new Error('Must not create'); }, stopDirect: async () => {} });
  assert.equal(restored.detail(team.id, run.id).run.state, 'interrupted'); restored.tick(); assert.equal(replayed, 0);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'bot-teams.json'))).runs[0].state, 'interrupted');
  await restored.close();
});

test('extension assignments freeze per chat, host tools deduplicate and effort can explicitly clear a profile', async t => {
  let revision = 1, executed = 0, seen = [];
  const skill = { snapshot: () => ({ revision, instructions: `Skill revision ${revision}`, assignments: [] }), tools: () => [{ name: 'draft_skill', description: 'Draft', inputSchema: { type: 'object' } }], owns: name => name === 'draft_skill', async execute(name, args, context) { context.assertLive(); executed++; return { revision: context.bot.extensionSnapshots.skills.revision }; } };
  const f = fixture(t, async input => {
    seen.push(input.bot);
    const a = await input.executeTool('draft_skill', { name: 'Useful' }, 'same');
    const b = await input.executeTool('draft_skill', { name: 'Useful' }, 'same'); assert.deepEqual(a, b);
    await assert.rejects(async () => input.executeTool('draft_skill', { name: 'Different' }, 'same'), /different action/);
    input.onFrame({ type: 'done' });
  }, { skills: skill });
  f.bots.update(f.a.id, { effort: 'high' });
  const old = f.bots.createConversation(f.a.id).conversation; revision = 2;
  const next = f.bots.createConversation(f.a.id, { effort: '' }).conversation;
  assert.equal(old.preferences.botEffort, 'high'); assert.equal(next.preferences.botEffort, '');
  f.chats.send(old.id, 'Old'); await tick(); f.chats.send(next.id, 'New'); await tick();
  assert.equal(seen[0].extensionSnapshots.skills.revision, 1); assert.equal(seen[1].extensionSnapshots.skills.revision, 2);
  assert.match(seen[0].instructions, /Skill revision 1/); assert.equal(executed, 2);
  assert.equal(JSON.stringify(await f.bots.list()).includes('Skill revision'), false);
});

test('Stop in a child chat cancels its branch while coordinator and sibling remain live', async t => {
  let f;
  f = fixture(t, async input => {
    if (input.message === 'Coordinate') {
      await input.executeTool('spawn_subagent', { botId: f.b.id, message: 'First child' }, 'first');
      await input.executeTool('spawn_subagent', { botId: f.c.id, message: 'Second child' }, 'second');
    }
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
  });
  const team = f.team({ limits: { maxParallel: 3 } }), started = f.bots.team.start(team.id, { message: 'Coordinate' });
  await until(() => f.bots.team.activity().activity.filter(row => row.type === 'subagent' && row.state === 'running').length === 2);
  const child = f.bots.team.activity().activity.find(row => row.botId === f.b.id);
  await f.chats.stop(child.chatId);
  assert.equal(f.chats.detail(started.run.rootChatId).conversation.active, true);
  assert.equal(f.bots.team.activity().activity.find(row => row.botId === f.c.id).state, 'running');
  assert.equal(f.bots.team.activity().activity.find(row => row.id === child.id).state, 'cancelled');
  await f.bots.team.stop(team.id, started.run.id);
});

test('Stop waits for extension cleanup and retains a retryable team failure until it is confirmed', async t => {
  let releaseCleanup, cleanupStarted, uncertain = true;
  const started = new Promise(resolve => { cleanupStarted = resolve; });
  const extension = { snapshot: () => ({}), tools: () => [], owns: () => false,
    async finish() { if (releaseCleanup === undefined) { cleanupStarted(); await new Promise(resolve => { releaseCleanup = resolve; }); } if (uncertain) throw new Error('Integration cleanup unconfirmed'); } };
  const f = fixture(t, async input => { await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); }, { mcp: extension });
  const team = f.team(), row = f.bots.team.start(team.id, { message: 'Wait' });
  await until(() => f.chats.detail(row.run.rootChatId).conversation.active);
  await tick(); let acknowledged = false;
  const stop = f.bots.team.stop(team.id, row.run.id).then(value => { acknowledged = true; return value; });
  await started; await tick(); assert.equal(acknowledged, false); releaseCleanup();
  assert.equal((await stop).run.state, 'cleanup_pending');
  assert.equal((await f.bots.team.stop(team.id, row.run.id)).run.state, 'cleanup_pending');
  uncertain = false;
  assert.equal((await f.bots.team.stop(team.id, row.run.id)).run.state, 'cancelled');
});

test('team journals reject live and dangling symlinks without modifying their targets', t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-links-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'sentinel'); writeFileSync(target, 'unchanged'); symlinkSync(target, join(directory, 'bot-teams.json'));
  const args = { directory, requireBot() {}, conversations() {}, createConversation() {}, stopDirect() {} };
  assert.throws(() => createBotTeams(args), /regular file/); assert.equal(readFileSync(target, 'utf8'), 'unchanged');
  rmSync(join(directory, 'bot-teams.json')); symlinkSync(join(directory, 'missing'), join(directory, 'bot-teams.json'));
  assert.throws(() => createBotTeams(args), /regular file/);
});
