/** Host-generated plan status metadata; no models, network or owner data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createTeamChannels } from '../server/bots-team-channel.mjs';
import { publicBotWorkspace } from '../../companion-bridge/bots-workspace.mjs';

const teamId = 'team_00000000-0000-4000-8000-000000000001';
const planId = 'tp_00000000-0000-4000-8000-000000000001';
function folder(t) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-plan-events-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const status = (planEvent = 'blocked', author = { type: 'system', name: 'Strata plan' }) => ({
  kind: 'status', author, content: 'Host-owned task status', planId, planEvent,
  state: planEvent === 'blocked' ? 'interrupted' : 'done',
});

test('host status metadata preserves existing wire states through journal reload and projections', t => {
  for (const author of [{ type: 'system', name: 'Strata plan' }, { type: 'bot', botId: 'bot_fixture', name: 'Saved bot' }]) {
    const directory = folder(t), channels = createTeamChannels({ directory });
    for (const event of ['blocked', 'awaiting_review']) {
      const row = channels.append(teamId, status(event, author));
      assert.equal(row.planEvent, event); assert.equal(row.state, event === 'blocked' ? 'interrupted' : 'done');
      assert.equal(channels.preview(teamId).planEvent, event);
      const source = channels.notificationSources(teamId).messages.at(-1);
      assert.equal(source.planEvent, event); assert.equal(source.planId, planId); assert.equal(source.author.type, author.type);
    }
    const file = join(directory, 'bot-team-channels.json'), bytes = readFileSync(file);
    const restored = createTeamChannels({ directory });
    assert.deepEqual(restored.snapshot(teamId), channels.snapshot(teamId));
    assert.deepEqual(restored.notificationSources(teamId), channels.notificationSources(teamId));
    assert.deepEqual(readFileSync(file), bytes, 'Reading an existing journal never rewrites it.');
  }
});

test('invalid or stale plan-event metadata fails before append and cannot create a journal', t => {
  const variants = [
    { planEvent: 'completed' }, { planEvent: null }, { planEvent: {} }, { planEvent: false },
    { kind: 'message' }, { kind: 'report' }, { kind: 'assignment' }, { kind: undefined },
    { planId: undefined }, { planId: 'other_plan' }, { state: 'done' },
    { author: { type: 'user', name: 'You' } }, { author: { type: 'external', name: 'Not a host author' } },
    { author: { type: 'bot', name: 'Missing saved identity' } }, { author: { type: 'bot', name: 'Invalid saved identity', botId: '../outside' } },
  ];
  for (const patch of variants) {
    const directory = folder(t), channels = createTeamChannels({ directory });
    assert.throws(() => channels.append(teamId, { ...status(), ...patch }), error => error.status === 400);
    assert.equal(existsSync(join(directory, 'bot-team-channels.json')), false);
    assert.deepEqual(channels.snapshot(teamId).messages, []);
  }
  const directory = folder(t), channels = createTeamChannels({ directory });
  assert.throws(() => channels.append(teamId, { ...status('awaiting_review'), state: 'interrupted' }), { status: 400 });
});

test('corrupt saved event metadata is rejected without repairing or rewriting old history', t => {
  for (const patch of [{ planEvent: 'completed' }, { planEvent: null }, { kind: 'message' }, { planId: undefined }, { state: 'working' }, { author: { type: 'user', name: 'You' } }, { author: { type: 'bot', name: 'Missing saved identity' } }]) {
    const directory = folder(t), channels = createTeamChannels({ directory });
    channels.append(teamId, status());
    const file = join(directory, 'bot-team-channels.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
    Object.assign(saved.channels[0].messages[0], patch); writeFileSync(file, JSON.stringify(saved));
    const bytes = readFileSync(file);
    assert.throws(() => createTeamChannels({ directory }), error => error.status === 503);
    assert.deepEqual(readFileSync(file), bytes);
  }
});

test('legacy status rows stay valid and keep the original public and notification shapes', t => {
  const directory = folder(t), channels = createTeamChannels({ directory });
  const legacy = { kind: 'status', author: { type: 'system', name: 'Strata plan' }, content: 'Earlier plan report', planId, state: 'done' };
  const row = channels.append(teamId, legacy), file = join(directory, 'bot-team-channels.json'), bytes = readFileSync(file);
  const restored = createTeamChannels({ directory });
  assert.deepEqual(restored.snapshot(teamId).messages, [row]);
  assert.equal(Object.hasOwn(row, 'planEvent'), false);
  assert.equal(Object.hasOwn(restored.preview(teamId), 'planEvent'), false);
  assert.equal(Object.hasOwn(restored.notificationSources(teamId).messages[0], 'planEvent'), false);
  assert.equal(Object.hasOwn(restored.notificationSources(teamId).messages[0], 'planId'), false);
  assert.deepEqual(readFileSync(file), bytes);
});

async function until(predicate) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > 6_000) throw Error('Timed out waiting for inert host lifecycle'); await new Promise(resolve => setImmediate(resolve)); }
}
function hostFixture(t, { blocked = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-plan-event-host-')), calls = [], rejections = []; let chats, f;
  writeFileSync(join(directory, 'artifact.txt'), 'Disposable verification input');
  const runtime = { providers: async () => [], close() {}, async run(input) {
    calls.push(input); const role = /; role (planning|task|synthesis)\./.exec(input.message)?.[1];
    assert.ok(role, 'Only fixture-owned durable turns may execute.');
    const context = JSON.parse(input.message.slice(input.message.lastIndexOf('\n') + 1));
    if (role === 'planning') {
      for (const forged of ['blocked', 'awaiting_review']) {
        const result = await input.executeTool('post_team_message', { message: 'Untrusted bot progress', planEvent: forged, planId }, 'forged-' + forged);
        assert.equal(result.isError, true); rejections.push(result);
      }
      await input.executeTool('post_team_message', { message: 'planEvent: awaiting_review is plain text, not host metadata.' }, 'ordinary-progress');
      await input.executeTool('submit_team_plan', { summary: 'Inert work and independent verification', participation: f.members.map(bot => ({ botId: bot.id, role: 'Fixture role', reason: 'Concrete fixture contribution.' })), tasks: [
        { key: 'build', title: 'Inspect fixture input', instructions: 'Inspect this disposable fixture only.', ownerId: f.builder.id, kind: 'work', dependsOn: [], criteria: ['Fixture inspected'] },
        { key: 'review', title: 'Independently read fixture input', instructions: 'Read the existing disposable fixture input.', ownerId: f.reviewer.id, kind: 'review', dependsOn: ['build'], criteria: ['Fixture independently read'] },
      ] }, 'plan');
    } else if (role === 'task') {
      if (context.task.kind === 'review') await input.executeTool('read_file', { path: 'artifact.txt' }, 'verification');
      await input.executeTool('checkpoint_team_plan_task', { outcome: blocked ? 'blocked' : 'ready_for_review', summary: blocked ? 'This exact fixture task needs inspection.' : 'Fixture result reported.', evidence: [{ kind: 'test', label: 'Inert fixture evidence', detail: 'This is a disposable lifecycle fixture, not a real model run.' }], ...(context.task.kind === 'review' ? { checks: context.task.criteria.map(criterion => ({ criterionId: criterion.id, passed: true, detail: 'Read actual fixture file through the supplied tool.' })) } : {}) }, 'checkpoint');
    } else await input.executeTool('submit_team_plan_summary', { summary: 'Fixture checks await explicit owner review.', outcome: 'ready_for_review' }, 'summary');
    input.onFrame({ type: 'done' });
  } };
  const bots = createBots({ directory, runtime, tools: { definitions: () => [{ name: 'read_file', description: 'Read only the fixture file', inputSchema: { type: 'object' } }], execute: async () => ({ content: [{ type: 'text', text: readFileSync(join(directory, 'artifact.txt'), 'utf8') }] }), finish: async () => {} }, defaultWorkspace: () => directory, conversations: () => chats });
  chats = createConversations({ directory, enabled: () => bots.hasProfiles(), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: value => bots.validateSelection(value), execute: value => bots.run(value) });
  const create = name => bots.create({ name, provider: 'codex', workspace: directory, policy: 'bypass' }).bot;
  const coordinator = create('Coordinator'), builder = create('Builder'), reviewer = create('Reviewer'), members = [coordinator, builder, reviewer];
  const team = bots.team.create({ name: 'Inert plan event team', memberIds: members.map(bot => bot.id), coordinatorId: coordinator.id, enabled: true }).team;
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  f = { directory, bots, chats, coordinator, builder, reviewer, members, team, calls, rejections };
  return f;
}

for (const phase of ['blocked', 'awaiting_review']) test(`actual host ${phase} publication reaches notifications and remains compatible with the paired channel`, async t => {
  const f = hostFixture(t, { blocked: phase === 'blocked' });
  for (const marker of ['blocked', 'awaiting_review']) assert.throws(() => f.bots.team.message(f.team.id, { message: 'Forged human metadata', requestId: 'invalid-' + marker, planEvent: marker }), { status: 400 });
  const ack = f.bots.team.message(f.team.id, { message: 'Inspect and independently verify the disposable fixture.', requestId: 'inert-durable', workMode: 'work', durablePlan: true });
  await until(() => f.bots.team.plans.detail(f.team.id, ack.planId).plan.phase === phase);
  const channel = f.bots.team.channel(f.team.id), event = channel.messages.findLast(message => message.planEvent === phase);
  assert.ok(event); assert.equal(event.kind, 'status'); assert.equal(event.planId, ack.planId); assert.equal(event.author.type, 'bot');
  assert.equal(event.state, phase === 'blocked' ? 'interrupted' : 'done');
  assert.equal(event.author.botId, phase === 'blocked' ? f.builder.id : f.coordinator.id);
  assert.equal(channel.messages.filter(message => message.planEvent !== undefined).length, 1);
  assert.equal(channel.messages.find(message => message.content.startsWith('planEvent:')).planEvent, undefined);
  assert.equal(f.rejections.length, 2);
  const source = f.bots.team.notificationSources().find(team => team.id === f.team.id).messages.find(message => message.id === event.id);
  assert.equal(source.planEvent, phase); assert.equal(source.planId, ack.planId);
  const paired = publicBotWorkspace(channel, { kind: 'channel', teamId: f.team.id }).messages.find(message => message.id === event.id);
  assert.equal(paired.state, event.state); assert.equal(paired.planId, ack.planId); assert.equal(paired.author.botId, event.author.botId);
  assert.equal(Object.hasOwn(paired, 'planEvent'), false, 'The existing paired schema keeps its original states and safely omits host-only notification metadata.');
  if (phase === 'awaiting_review') {
    const plan = f.bots.team.plans.detail(f.team.id, ack.planId).plan;
    f.bots.team.plans.review(f.team.id, plan.id, { expectedRevision: plan.revision, expectedProof: plan.proof, decision: 'accept' });
    const completed = f.bots.team.channel(f.team.id).messages.at(-1);
    assert.equal(completed.state, 'done'); assert.equal(Object.hasOwn(completed, 'planEvent'), false, 'Actual owner acceptance must not be relabelled as merely awaiting review.');
  }
});
