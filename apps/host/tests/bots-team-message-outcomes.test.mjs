/** Real manager/journal paths with disposable team files and an inert provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotTools } from '../server/bots-tools.mjs';

async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Disposable public-message turn did not start.');
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function fixture(t, { durable = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-public-message-outcome-'));
  const calls = [], faults = {}, releases = new Map();
  let chats;
  const bots = createBots({ directory, conversations: () => chats, defaultWorkspace: () => directory,
    runtime: { providers: async () => [], close() {}, async run(input) {
      calls.push(input);
      await new Promise(resolve => { releases.set(input.sessionId, resolve); input.signal.addEventListener('abort', resolve, { once: true }); });
      if (!input.signal.aborted) input.onFrame({ type: 'done' });
    } },
    tools: durable ? createBotTools({ directory, browserProbe: () => null }) : { definitions: () => [], execute: async () => assert.fail('No computer tool should run.'), finish: async () => {} },
    notify(_event, payload) {
      if (faults.afterPublicAppend && payload?.teamChannelChanged) throw Object.assign(new Error('Synthetic failure after public append.'), { status: 400 });
    },
  });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: input => bots.validateSelection(input), execute: input => bots.run(input) });
  const members = (durable ? ['Coordinator', 'Researcher', 'Builder', 'Reviewer'] : ['Coordinator', 'Unused teammate']).map(name => bots.create({ name, provider: 'codex', workspace: directory, policy: 'bypass' }).bot);
  const team = bots.team.create({ name: 'Disposable public messages', coordinatorId: members[0].id, memberIds: members.map(bot => bot.id), enabled: true }).team;
  const intake = bots.team.message(team.id, { message: 'Work only on this disposable fixture.', requestId: 'fixture-owner-request', ...(durable ? { workMode: 'work', durablePlan: true } : {}) });
  t.after(async () => { faults.afterPublicAppend = false; await bots.close(); chats.close(); rmSync(directory, { force: true, recursive: true }); });
  await until(() => calls.length === 1);
  const input = calls[0], room = () => bots.team.channel(team.id).messages;
  const actions = () => bots.harnessActions(input.sessionId).actions;
  const invoke = async (args, id) => { try { return { result: await input.executeTool('post_team_message', args, id) }; } catch (error) { return { error }; } };
  return { directory, bots, calls, faults, input, room, actions, invoke, members, team, intake, release: call => releases.get(call.sessionId)() };
}

test('malformed public text field is a known no-effect error; corrected message publishes without waking peers', async t => {
  const f = await fixture(t), file = join(f.directory, 'bot-team-channels.json'), before = readFileSync(file);
  const bad = await f.invoke({ text: 'Must not be published.' }, 'wrong-field');
  assert.equal(f.actions()[0].state, 'error', 'Pure argument rejection must not leave an uncertain mutation receipt.');
  assert.equal(bad.error, undefined); assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /supported public team message settings/);
  assert.deepEqual(readFileSync(file), before); assert.equal(f.room().length, 1); assert.equal(f.calls.length, 1);
  const corrected = await f.invoke({ message: 'Corrected public progress.' }, 'correct-field');
  assert.equal(corrected.error, undefined); assert.equal(corrected.result.isError, undefined);
  assert.equal(f.room().filter(row => row.content === 'Corrected public progress.').length, 1);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.actions().map(row => row.state).sort(), ['error', 'succeeded']);
  const after = readFileSync(file);
  await f.invoke({ message: 'Corrected public progress.' }, 'correct-field');
  assert.deepEqual(readFileSync(file), after, 'The exact already-published call cannot publish twice.');
});

test('every public-message argument validation rejection precedes channel effects', async t => {
  const f = await fixture(t), file = join(f.directory, 'bot-team-channels.json'), before = readFileSync(file);
  const invalid = [null, [], {}, { message: '' }, { message: ' ' }, { message: 'x'.repeat(8001) }, { message: 'nul\0text' }, { message: 'No', replyToId: 1 }, { message: 'No', replyToId: 'tm_missing' }, { message: 'No', extra: true }];
  for (const [index, args] of invalid.entries()) {
    const result = await f.invoke(args, `invalid-${index}`);
    assert.equal(result.error, undefined); assert.equal(result.result.isError, true);
    assert.deepEqual(readFileSync(file), before);
  }
  assert.equal(f.actions().length, invalid.length); assert.equal(f.actions().every(row => row.state === 'error'), true);
  assert.equal(f.calls.length, 1);
});

for (const target of ['bot-team-channels.json', 'bot-teams.json']) test(`public-message ${target} persistence failure remains uncertain`, async t => {
  const f = await fixture(t), path = join(f.directory, target), backup = `${path}.fixture-backup`;
  renameSync(path, backup); mkdirSync(path);
  let result;
  try { result = await f.invoke({ message: `Publish during ${target} fault.` }, 'persist-failure'); }
  finally { rmSync(path, { recursive: true, force: true }); renameSync(backup, path); }
  assert.ok(result.error); assert.equal(f.actions()[0].state, 'uncertain');
  assert.equal(f.room().some(row => row.content === `Publish during ${target} fault.`), target === 'bot-teams.json');
  assert.equal(f.calls.length, 1);
});

test('a 400 thrown after public append remains uncertain and cannot publish twice', async t => {
  const f = await fixture(t);
  f.faults.afterPublicAppend = true;
  const failed = await f.invoke({ message: 'Published before synthetic notification failure.' }, 'partial-publish');
  f.faults.afterPublicAppend = false;
  assert.equal(failed.error?.status, 400); assert.equal(f.actions()[0].state, 'uncertain');
  assert.equal(f.room().filter(row => row.content === 'Published before synthetic notification failure.').length, 1);
  const before = readFileSync(join(f.directory, 'bot-team-channels.json'));
  await f.invoke({ message: 'Published before synthetic notification failure.' }, 'partial-publish');
  assert.deepEqual(readFileSync(join(f.directory, 'bot-team-channels.json')), before);
  assert.equal(f.calls.length, 1);
});

test('corrected public progress does not strand a real durable dependency after its ready checkpoint', async t => {
  const f = await fixture(t, { durable: true }), [coordinator, researcher, builder, reviewer] = f.members;
  writeFileSync(join(f.directory, 'context.txt'), 'Disposable research context.');
  const tasks = [
    { key: 'research', title: 'Research', instructions: 'Read context.txt and report its context.', ownerId: researcher.id, kind: 'work', dependsOn: [], criteria: ['Read fixture context'] },
    { key: 'build', title: 'Build', instructions: 'Write output.txt with the fixture result.', ownerId: builder.id, kind: 'work', dependsOn: ['research'], criteria: ['Write fixture output'] },
    { key: 'review', title: 'Review', instructions: 'Independently read the actual fixture files.', ownerId: reviewer.id, kind: 'review', dependsOn: ['research', 'build'], criteria: ['Observe both actual fixture artifacts'] },
  ];
  const plan = () => f.bots.team.plans.detail(f.team.id, f.intake.planId).plan;
  await f.input.executeTool('submit_team_plan', { summary: 'Research, dependent work and independent review.', tasks, participation: f.members.map(bot => ({ botId: bot.id, role: bot.id === coordinator.id ? 'Coordinator' : 'Scoped contributor', reason: 'One distinct fixture role.' })) }, 'plan');
  f.release(f.input); await until(() => f.calls.length === 2);
  const research = f.calls[1], before = readFileSync(join(f.directory, 'bot-team-channels.json'));
  const rejected = await research.executeTool('post_team_message', { text: 'Must not publish.' }, 'malformed-progress');
  assert.equal(rejected.isError, true); assert.deepEqual(readFileSync(join(f.directory, 'bot-team-channels.json')), before);
  await research.executeTool('post_team_message', { message: 'Research fixture context captured.' }, 'correct-progress');
  await research.executeTool('read_file', { path: 'context.txt' }, 'read-context');
  assert.equal(f.calls.length, 2, 'Public posts cannot wake the dependent task before a checkpoint.');
  await research.executeTool('checkpoint_team_plan_task', { outcome: 'ready_for_review', summary: 'Read actual fixture context.', evidence: [{ kind: 'file', label: 'Context', detail: 'context.txt' }] }, 'research-ready');
  f.release(research); await until(() => f.calls.length === 3);
  const build = f.calls[2]; assert.equal(build.bot.id, builder.id);
  await build.executeTool('write_file', { path: 'output.txt', content: 'Fixture result.' }, 'write-output');
  await build.executeTool('checkpoint_team_plan_task', { outcome: 'ready_for_review', summary: 'Wrote fixture output.', evidence: [{ kind: 'file', label: 'Output', detail: 'output.txt' }] }, 'build-ready');
  f.release(build); await until(() => f.calls.length === 4);
  const review = f.calls[3]; assert.equal(review.bot.id, reviewer.id);
  await review.executeTool('read_file', { path: 'context.txt' }, 'verify-context');
  await review.executeTool('read_file', { path: 'output.txt' }, 'verify-output');
  const reviewTask = plan().tasks.find(task => task.key === 'review');
  await review.executeTool('checkpoint_team_plan_task', { outcome: 'ready_for_review', summary: 'Independently read both actual fixture artifacts.', evidence: [{ kind: 'file', label: 'Observed output', detail: 'output.txt' }], checks: reviewTask.criteria.map(criterion => ({ criterionId: criterion.id, passed: true, detail: 'Read actual context.txt and output.txt through the supplied file tool.' })) }, 'review-ready');
  f.release(review); await until(() => f.calls.length === 5);
  const synthesis = f.calls[4]; assert.equal(synthesis.bot.id, coordinator.id);
  await synthesis.executeTool('submit_team_plan_summary', { outcome: 'ready_for_review', summary: 'Fixture research and dependent output are independently reviewed; owner acceptance remains pending.' }, 'summary');
  f.release(synthesis); await until(() => plan().phase === 'awaiting_review');
  assert.equal(plan().tasks.every(task => task.state === 'ready_for_review'), true);
  assert.equal(f.calls.filter(call => call.bot.id === builder.id).length, 1);
  assert.equal(f.bots.harnessActions(research.sessionId).counts.uncertain, 0);
  assert.equal(f.bots.harnessActions(research.sessionId).counts.error, 1);
  assert.equal(readFileSync(join(f.directory, 'output.txt'), 'utf8'), 'Fixture result.');
});
