/** Inert providers and private temporary journals only. No account, VM or model is contacted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createBotTeams } from '../server/bots-team.mjs';
import { createConversations } from '../server/conversations.mjs';

async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function fixture(t, script, extensions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-lifecycle-')); let chats;
  const seen = [];
  const bots = createBots({ directory, defaultWorkspace: () => directory, conversations: () => chats,
    runtime: { providers: async () => [], async run(input) { seen.push(input); await script(input); input.onFrame({ type: 'done' }); }, close() {} },
    tools: { definitions: () => [], finish: async () => {} }, ...extensions });
  chats = createConversations({ directory, enabled: () => true, validateSelection: input => bots.validateSelection(input), execute: input => bots.run(input), stop: id => bots.stop(id), pending: id => bots.pending(id) });
  const make = name => bots.create({ name, provider: 'codex', workspace: directory, policy: 'bypass' }).bot;
  const coordinator = make('Coordinator'), worker = make('Worker');
  const team = bots.team.create({ name: 'Lifecycle fixture', memberIds: [coordinator.id, worker.id], coordinatorId: coordinator.id, enabled: true, limits: { maxParallel: 1 } }).team;
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, bots, chats, coordinator, worker, team, seen, done: run => until(() => !['queued', 'running'].includes(bots.team.detail(team.id, run.id).run.state)) };
}

for (const [diagnostic, expected] of [
  ['The configured model API returned HTTP 402. Check its credentials and tool support in Models.', /billing or credits/],
  ['The configured model API returned HTTP 401.', /refused access/],
]) test('coordinator gets an actionable fixed failure without provider details or automatic replay: ' + diagnostic, async t => {
  const secret = 'PRIVATE_PROVIDER_RESPONSE_TOKEN_8b12', privatePath = '/Users/private/account/config'; let f, completion;
  f = fixture(t, async input => {
    if (input.message === 'Assign this task') await input.executeTool('assign_team_task', { botId: f.worker.id, message: 'Do the requested task' }, 'assign');
    else if (input.bot.id === f.worker.id) throw new Error(`${diagnostic}\n${secret} ${privatePath}`);
    else {
      completion = input.message;
      assert.match(completion, expected); assert.equal(completion.includes(secret), false);
      const status = await input.executeTool('list_subagents', {}, 'status');
      assert.equal(JSON.stringify(status).includes(secret), false); assert.equal(JSON.stringify(input.history).includes(secret), false);
    }
  });
  const request = { message: 'Assign this task', requestId: 'one-request', workMode: 'work' };
  const run = f.bots.team.message(f.team.id, request).run; await f.done(run);
  const channel = f.bots.team.channel(f.team.id), report = channel.messages.find(row => row.author.botId === f.worker.id && row.state === 'error');
  assert.match(report.content, expected); assert.equal(report.content.includes(secret), false); assert.equal(report.content.includes(privatePath), false);
  assert.equal(JSON.stringify(channel).includes(secret), false); assert.equal(JSON.stringify(channel).includes(privatePath), false);
  assert.equal(f.seen.filter(input => input.bot.id === f.worker.id).length, 1);
  assert.equal(f.seen.filter(input => input.message.startsWith('[Strata teammate result')).length, 1);
  assert.equal(f.bots.team.message(f.team.id, request).run.id, run.id); f.bots.team.tick(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.seen.filter(input => input.bot.id === f.worker.id).length, 1);
  assert.equal(f.bots.team.detail(f.team.id, run.id).run.state, 'error');
});

test('a step-limit stop pauses with continue and resumes that same run', async t => {
  const events = [];
  let f;
  f = fixture(t, async input => {
    if (input.message === 'Assign this task') await input.executeTool('assign_team_task', { botId: f.worker.id, message: 'Do the requested task' }, 'assign');
    else if (input.bot.id === f.worker.id && !input.message.startsWith('Continue from the checkpoint.')) throw new Error('The bot reached its 32-step limit. Continue in this chat to proceed.');
  });
  const stop = f.bots.team.subscribe((event, data) => { if (event === 'task.recovery') events.push(data); });
  const run = f.bots.team.message(f.team.id, { message: 'Assign this task', requestId: 'pause-request', workMode: 'work' }).run;
  await until(() => f.bots.team.channel(f.team.id).messages.some(row => row.recovery?.kind === 'paused'));
  const report = f.bots.team.channel(f.team.id).messages.find(row => row.recovery?.kind === 'paused');
  assert.equal(/step limit|32-step/i.test(report.content), false);
  assert.match(report.content, /finished the work so far/);
  assert.match(report.content, /still left/);
  assert.equal(report.recovery.question, 'Keep going?');
  assert.deepEqual(report.recovery.options, [{ id: 'continue', label: 'Keep going' }]);
  assert.match(report.recovery.jobId, /^tj_/);
  assert.match(report.recovery.runId, /^tr_/);
  assert.equal(f.bots.team.detail(f.team.id, run.id).run.state, 'running');
  const pausedJob = f.bots.team.activity().activity.find(row => row.id === report.recovery.jobId);
  assert.equal(pausedJob?.state, 'paused');
  const recovery = events.find(event => event.messageId === report.id);
  assert.equal(recovery.recovery.kind, 'paused');
  assert.equal(recovery.recovery.text, report.content);
  assert.deepEqual(recovery.recovery.options, [{ id: 'continue', label: 'Keep going' }]);
  assert.equal(recovery.jobId, report.recovery.jobId);
  assert.equal(recovery.runId, report.recovery.runId);
  const before = f.seen.filter(input => input.bot.id === f.worker.id).length;
  const chosen = f.bots.team.chooseTaskRecovery(f.team.id, report.id, { choice: 'continue' });
  assert.equal(chosen.choice, 'continue');
  assert.equal(chosen.message.recovery.choice, 'continue');
  f.bots.team.tick();
  await until(() => f.seen.filter(input => input.bot.id === f.worker.id).length > before);
  assert.match(f.seen.filter(input => input.bot.id === f.worker.id).at(-1).message, /^Continue from the checkpoint\./);
  stop();
});

test('private team completion also does not forward raw provider errors to the assigning bot', async t => {
  const secret = 'PRIVATE_DIRECT_TEAM_FAILURE_37a1'; let f, received = false;
  f = fixture(t, async input => {
    if (input.message === 'Delegate') await input.executeTool('spawn_subagent', { botId: f.worker.id, message: 'Bounded child task' }, 'child');
    else if (input.bot.id === f.worker.id) throw new Error(`The configured model API returned HTTP 402. ${secret}`);
    else { received = true; assert.match(input.message, /HTTP 402/); assert.equal(input.message.includes(secret), false); assert.equal(JSON.stringify(await input.executeTool('list_subagents', {}, 'status')).includes(secret), false); }
  });
  const run = f.bots.team.start(f.team.id, { message: 'Delegate' }).run; await f.done(run);
  assert.equal(received, true); assert.equal(f.seen.length, 3);
});

test('an account failure blocks already queued and newly reassigned retries only within that run', async t => {
  let f, failures = 0, blocked = 0;
  f = fixture(t, async input => {
    if (input.message === 'Assign two checks') {
      await input.executeTool('assign_team_task', { botId: f.worker.id, message: 'First check' }, 'first');
      await input.executeTool('assign_team_task', { botId: f.worker.id, message: 'Already queued second check' }, 'second');
    } else if (input.message === 'Explicit new request') {
      await input.executeTool('assign_team_task', { botId: f.worker.id, message: 'Owner explicitly requested another attempt' }, 'new-request');
    } else if (input.bot.id === f.worker.id) {
      failures++; throw new Error('The configured model API returned HTTP 402. PRIVATE_ACCOUNT_BODY');
    } else {
      await assert.rejects(input.executeTool('assign_team_task', { botId: f.worker.id, message: 'Automatic retry' }, 'retry'), /new explicit team request/);
      blocked++;
    }
  });
  const first = f.bots.team.message(f.team.id, { message: 'Assign two checks', requestId: 'initial', workMode: 'work' }).run; await f.done(first);
  assert.equal(failures, 1); assert.equal(blocked, 1);
  assert.ok(f.bots.team.channel(f.team.id).messages.some(row => /model account or access failure/.test(row.content)));
  const next = f.bots.team.message(f.team.id, { message: 'Explicit new request', requestId: 'new-human-request', workMode: 'work' }).run; await f.done(next);
  assert.equal(failures, 2); assert.equal(blocked, 2);
  assert.notEqual(first.id, next.id);
});

test('failure constructing tools before team.begin settles the exact accepted job once', async t => {
  const secret = 'PRIVATE_TOOL_CATALOG_ERROR_53c8';
  const extension = { snapshot: () => ({}), tools() { throw new Error(`The configured model API returned HTTP 402. ${secret}`); }, owns: () => false, finish: async () => {} };
  const f = fixture(t, async () => assert.fail('A rejected admission cannot invoke a model'), { mcp: extension });
  const run = f.bots.team.start(f.team.id, { message: 'Start bounded task' }).run; await f.done(run);
  assert.equal(f.bots.team.detail(f.team.id, run.id).run.state, 'error'); assert.equal(f.bots.team.pendingStart(run.rootChatId), null);
  assert.equal(f.bots.team.activity().activity.some(row => row.runId === run.id && row.state === 'running'), false);
  assert.equal(f.seen.length, 0); f.bots.team.tick(); assert.equal(f.seen.length, 0);
});

test('pending admission tokens reject wrong jobs, stale generations, duplicates and already-bound turns', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-admission-')); let sequence = 0;
  const profiles = new Map(['bot_a', 'bot_b'].map(id => [id, { id, name: id, policy: 'bypass' }]));
  const teams = createBotTeams({ directory, requireBot: id => profiles.get(id), schedule: () => {},
    conversations: () => ({ send() {}, stop: async () => {}, detail: () => ({ conversation: { messages: [] } }) }),
    createConversation: () => ({ conversation: { id: 'chat_' + (++sequence) } }), stopDirect: async () => {} });
  t.after(async () => { await teams.close(); rmSync(directory, { recursive: true, force: true }); });
  const team = teams.create({ name: 'Admission', memberIds: ['bot_a', 'bot_b'], coordinatorId: 'bot_a', enabled: true }).team;
  const first = teams.start(team.id, { message: 'First' }).run; teams.tick(); const token = teams.pendingStart(first.rootChatId); assert.ok(token);
  assert.equal(teams.rejectPendingStart(first.rootChatId, { ...token, jobId: 'wrong' }, new Error('Rejected')), false);
  assert.equal(teams.rejectPendingStart(first.rootChatId, { ...token, generation: token.generation + 1 }, new Error('Rejected')), false);
  await teams.stop(team.id, first.id); assert.equal(teams.rejectPendingStart(first.rootChatId, token, new Error('Late failure')), false);
  const second = teams.start(team.id, { message: 'Second' }).run; teams.tick(); const next = teams.pendingStart(second.rootChatId);
  assert.equal(teams.rejectPendingStart(second.rootChatId, token, new Error('Wrong job')), false);
  assert.equal(teams.rejectPendingStart(second.rootChatId, next, new Error('Failed before begin')), true);
  assert.equal(teams.rejectPendingStart(second.rootChatId, next, new Error('Duplicate failure')), false);
  assert.equal(teams.detail(team.id, second.id).run.state, 'error');
  const third = teams.start(team.id, { message: 'Third' }).run; teams.tick(); const bound = teams.pendingStart(third.rootChatId);
  teams.begin({ chatId: third.rootChatId, turnId: 'turn_current' });
  assert.equal(teams.rejectPendingStart(third.rootChatId, bound, new Error('After begin')), false);
  teams.end({ turnId: 'turn_current' }); assert.equal(teams.detail(team.id, third.id).run.state, 'completed');
});

test('durable finalization failure resolves an awaiting Stop, revokes the run and never starts queued children', async t => {
  let f, entered = false;
  f = fixture(t, async input => {
    if (input.bot.id !== f.coordinator.id) {
      assert.ok(!input.message.includes('Queued second child'), 'The queued sibling cannot start after journal failure');
    } else {
      await input.executeTool('spawn_subagent', { botId: f.worker.id, message: 'Running child' }, 'child');
      await input.executeTool('spawn_subagent', { botId: f.worker.id, message: 'Queued second child' }, 'queued-child'); entered = true;
    }
    await new Promise(resolve => { input.signal.addEventListener('abort', resolve, { once: true }); if (input.signal.aborted) resolve(); });
  });
  f.bots.team.update(f.team.id, { limits: { maxParallel: 2 } });
  const run = f.bots.team.start(f.team.id, { message: 'Delegate and wait' }).run; await until(() => entered && f.seen.length === 2);
  const file = join(f.directory, 'bot-teams.json'), backup = join(f.directory, 'saved-teams.json'); renameSync(file, backup); mkdirSync(file);
  try {
    const stopped = await Promise.race([f.bots.stop(run.rootChatId, { team: false }), new Promise((_, reject) => setTimeout(() => reject(new Error('Stop waited forever for finalization')), 1500))]);
    assert.equal(stopped.stopped, true); await until(() => !f.chats.detail(run.rootChatId).conversation.active);
    assert.equal(f.bots.team.detail(f.team.id, run.id).run.state, 'cleanup_pending');
    assert.equal(f.bots.team.activity().activity.some(row => row.runId === run.id && row.state === 'queued'), false);
    f.bots.team.tick(); assert.equal(f.seen.length, 2);
  } finally { rmSync(file, { recursive: true }); renameSync(backup, file); }
  await f.bots.team.stop(f.team.id, run.id);
  assert.equal(f.bots.team.detail(f.team.id, run.id).run.state, 'cancelled');
  assert.ok(JSON.parse(readFileSync(file)).runs.some(row => row.id === run.id && row.state === 'cancelled'));
});

test('Stop waits for every integration cleanup when one fails before another owned operation closes', async t => {
  let release, cleanupEntered, runtimeEntered = false, settled = false;
  const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { cleanupEntered = resolve; });
  const extension = finish => ({ snapshot: () => ({}), tools: () => [], owns: () => false, finish });
  const f = fixture(t, async input => {
    runtimeEntered = true;
    await new Promise(resolve => { input.signal.addEventListener('abort', resolve, { once: true }); if (input.signal.aborted) resolve(); });
  }, { skills: extension(async () => { throw new Error('Fixture integration cleanup failed'); }), mcp: extension(async () => { cleanupEntered(); await held; }) });
  const run = f.bots.team.start(f.team.id, { message: 'Wait for Stop' }).run; await until(() => runtimeEntered);
  const stopped = f.bots.stop(run.rootChatId, { team: false }).then(value => { settled = true; return value; }, error => { settled = true; return { error }; });
  await entered; await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(settled, false, 'An early integration failure must not acknowledge Stop while another cleanup is pending'); }
  finally { release(); }
  const result = await stopped; assert.match(result.error.message, /integration cleanup failed/);
});
