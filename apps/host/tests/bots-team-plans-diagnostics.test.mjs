import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamPlans } from '../server/bots-team-plans.mjs';

const teamId = 'team_01234567-0123-4123-8123-0123456789ab';
const receiptError = 'Inspect unresolved action receipts and computer cleanup before continuing this workflow. No old action will be replayed.';
const members = ['coordinator', 'forum', 'triage', 'healthy', 'reviewer'];
const task = (key, ownerId, dependsOn = [], kind = 'work') => ({ key, title: key, instructions: 'Perform only this bounded fixture task.', ownerId, dependsOn, kind, criteria: ['Verify the fixture result.'] });
const selection = plan => ({ expectedRevision: plan.revision, expectedProof: plan.proof });

function fixture(initial) {
  let saved = structuredClone(initial), blocker, inspectedError, dispatchedError, clock = 1700000000000;
  const deliveries = [];
  const store = { read: () => structuredClone(saved), save: value => { saved = structuredClone(value); }, assertOwner() {}, close() {} };
  const controller = createTeamPlans({ directory: '/unused', store, now: () => clock++,
    teamFor: () => ({ id: teamId, revision: 1, enabled: true, coordinatorId: 'coordinator', memberIds: members }),
    prepare: () => ({ authorities: Object.fromEntries(members.map(id => [id, 'a'.repeat(64)])), resourceKeys: Object.fromEntries(members.map(id => [id, `local:/fixture/${id}`])) }),
    ensure(row, options = {}) {
      if (options.inspect && inspectedError) throw inspectedError;
      const selected = row.tasks.find(t => t.id === (options.attempt?.taskId ?? options.taskId));
      if (selected?.key === 'source_triage' && blocker) throw blocker;
    },
    dispatch(row, attempt) {
      if (attempt.taskId && dispatchedError) throw dispatchedError;
      const bound = { chatId: `s_${deliveries.length}`, jobId: `tj_${deliveries.length}` };
      deliveries.push({ planId: row.id, ...attempt, ...bound });
      return bound;
    },
    stopRun: async () => {},
  });
  const get = id => controller.detail(teamId, id).plan;
  const privateRow = id => saved.plans.find(p => p.id === id);
  function start(id, kind, key) {
    controller.pump();
    const row = privateRow(id), target = row.tasks.find(t => t.key === key);
    const attempt = [...row.attempts].reverse().find(a => a.kind === kind && a.state === 'pending' && (!target || a.taskId === target.id));
    assert.ok(attempt?.chatId, `queued ${key ?? kind}`);
    controller.beforeStart(id, attempt.id, attempt.chatId);
    return { attempt, binding: { ...controller.binding(id, attempt.id), chatId: attempt.chatId, botId: attempt.botId,
      assertLive() { assert.equal(controller.isLive(id, attempt.id, this.generation), true); }, hasVerificationEvidence: () => true } };
  }
  function create({ sibling = false } = {}) {
    const plan = controller.create(teamId, { requestId: 'diagnostic-fixture', goal: 'Inspect fixture forum work, then triage and independently review it.' }).plan;
    const { attempt, binding } = start(plan.id, 'planning');
    const tasks = [task('forum_read', 'forum'), task('source_triage', 'triage', ['forum_read'])];
    if (sibling) tasks.push(task('healthy_branch', 'healthy', ['forum_read']));
    tasks.push(task('review', 'reviewer', tasks.map(t => t.key), 'review'));
    controller.submission('submit_team_plan', { summary: 'Concrete fixture assignments.', tasks,
      participation: members.map(botId => ({ botId, role: 'Fixture participant', reason: 'Assigned work or availability considered.' })) }, binding);
    controller.finish(plan.id, attempt.id);
    complete(plan.id, 'forum_read');
    return get(plan.id);
  }
  function complete(id, key) {
    const { attempt, binding } = start(id, 'task', key);
    controller.submission('checkpoint_team_plan_task', { outcome: 'ready_for_review', summary: `Verified ${key}.`, evidence: [{ kind: 'test', label: 'Fixture check', detail: 'Actual fixture check passed.' }] }, binding);
    controller.finish(id, attempt.id);
  }
  return { controller, get, create, complete, deliveries, start, snapshot: () => structuredClone(saved),
    block(error, inspect = error) { blocker = error; inspectedError = inspect; },
    inspect(error) { inspectedError = error; }, dispatchError(error) { dispatchedError = error; } };
}

test('receipt-blocked descendant shows safe exact task context and stays nonresumable without replay', t => {
  const f = fixture(); t.after(() => f.controller.close());
  const plan = f.create(); f.block(new Error(receiptError)); f.controller.pump();
  const blocked = f.get(plan.id), triage = blocked.tasks.find(t => t.key === 'source_triage');
  assert.equal(blocked.canResume, false);
  assert.match(triage.summary, /source_triage.*action receipts/i);
  assert.match(blocked.blockedReason, /source_triage.*action receipts/i);
  assert.match(blocked.summary, /source_triage.*action receipts/i);
  assert.doesNotMatch(blocked.blockedReason, /access.*changed|restore.*settings/i);
  const before = f.snapshot(), calls = f.deliveries.length;
  assert.throws(() => f.controller.resume(teamId, plan.id, { ...selection(blocked), requestId: 'inspect-only', inspected: true, taskId: triage.id }), /source_triage.*action receipts/i);
  f.controller.pump(); assert.equal(f.deliveries.length, calls); assert.deepEqual(f.snapshot(), before);
});

test('typed receipt cause requires the exact host message, while legacy failures stay honestly ambiguous', t => {
  for (const [code, expected, rejected] of [
    ['team_plan_receipts_unresolved', /unresolved action receipts/i, /storage is unavailable/i],
    ['team_plan_receipts_unavailable', /receipt storage is unavailable/i, /unresolved action receipts prevent/i],
    ['unrecognized_code', /unresolved receipts or unavailable receipt storage/i, /receipt storage is unavailable/i],
  ]) {
    const f = fixture(); t.after(() => f.controller.close());
    const plan = f.create(); f.block(Object.assign(new Error(receiptError), { code })); f.controller.pump();
    const blocked = f.get(plan.id);
    assert.equal(blocked.canResume, false); assert.match(blocked.blockedReason, expected); assert.doesNotMatch(blocked.blockedReason, rejected);
    assert.equal(f.deliveries.length, 2, 'only planner and completed ancestor were dispatched');
  }
  for (const code of ['team_plan_receipts_unresolved', 'team_plan_receipts_unavailable']) {
    const f = fixture(); t.after(() => f.controller.close());
    const plan = f.create(), error = Object.assign(new Error(`${receiptError} Bearer fixture-secret`), { code });
    f.block(error); f.controller.pump(); const blocked = f.get(plan.id);
    assert.doesNotMatch(JSON.stringify([blocked, f.snapshot()]), /Bearer|fixture-secret/);
    assert.match(blocked.tasks.find(t => t.key === 'source_triage').summary, /pinned access/);
    assert.doesNotMatch(blocked.blockedReason, /unresolved action receipts|storage is unavailable/i);
  }
});

test('a launch-time receipt refusal records a safe blocker and revokes only that exact attempt', t => {
  const f = fixture(); t.after(() => f.controller.close());
  const plan = f.create({ sibling: true }); f.controller.pump();
  const queued = f.snapshot().plans[0].attempts.find(a => a.taskId === f.get(plan.id).tasks.find(t => t.key === 'source_triage').id);
  f.block(Object.assign(new Error(receiptError), { code: 'team_plan_receipts_unresolved' }));
  assert.throws(() => f.controller.beforeStart(plan.id, queued.id, queued.chatId), /source_triage.*unresolved action receipts/i);
  assert.equal(f.controller.isLive(plan.id, queued.id, queued.generation), false);
  assert.equal(f.get(plan.id).tasks.find(t => t.key === 'source_triage').state, 'blocked');
  f.complete(plan.id, 'healthy_branch');
  const calls = f.deliveries.length; f.controller.pump(); assert.equal(f.deliveries.length, calls);
  assert.equal(f.get(plan.id).tasks.find(t => t.key === 'healthy_branch').state, 'ready_for_review');
});

test('fresh inspection replaces a stale generic blocker with the known receipt cause without saving', t => {
  const f = fixture(); t.after(() => f.controller.close());
  const plan = f.create(); f.block(new Error('opaque fixture failure'), undefined); f.controller.pump();
  const before = f.snapshot(); f.inspect(new Error(receiptError));
  assert.match(f.get(plan.id).blockedReason, /action receipts/i);
  assert.equal(f.get(plan.id).canResume, false); assert.deepEqual(f.snapshot(), before);
});

test('unknown and secret-bearing ensure/dispatch/resume errors remain generic and never enter checkpoints', t => {
  for (const source of ['ensure', 'dispatch']) {
    const f = fixture(); t.after(() => f.controller.close());
    const plan = f.create(), secret = 'sk-fixture-private credential=/fixture/private';
    const error = new Error(`The original bot model, computer, workspace, instructions or tool access changed. ${secret}`);
    if (source === 'ensure') f.block(error); else { f.dispatchError(error); f.inspect(error); }
    f.controller.pump(); const blocked = f.get(plan.id), before = f.snapshot();
    assert.equal(blocked.canResume, false); assert.doesNotMatch(JSON.stringify([blocked, before]), /sk-fixture-private|credential=/);
    assert.match(blocked.tasks.find(t => t.key === 'source_triage').summary, /pinned access/);
    f.block(error);
    assert.throws(() => f.controller.resume(teamId, plan.id, { ...selection(blocked), requestId: 'no-secret-resume', inspected: true, taskId: blocked.tasks.find(t => t.key === 'source_triage').id }), e => !e.message.includes(secret) && /inspect/i.test(e.message));
    assert.deepEqual(f.snapshot(), before);
  }
});

test('a blocked branch does not prevent a healthy distinct-resource sibling from dispatching and finishing', t => {
  const f = fixture(); t.after(() => f.controller.close());
  const plan = f.create({ sibling: true }); f.block(new Error(receiptError)); f.controller.pump();
  assert.equal(f.get(plan.id).tasks.find(t => t.key === 'source_triage').state, 'blocked');
  f.complete(plan.id, 'healthy_branch');
  const result = f.get(plan.id);
  assert.equal(result.tasks.find(t => t.key === 'healthy_branch').state, 'ready_for_review');
  assert.equal(result.tasks.find(t => t.key === 'source_triage').state, 'blocked');
  assert.equal(f.deliveries.filter(d => d.taskId === result.tasks.find(t => t.key === 'source_triage').id).length, 0);
});

test('known access, cleanup and delivery failures retain distinct closed-vocabulary diagnostics', t => {
  for (const [message, expected] of [
    ['The original bot model, computer, workspace, instructions or tool access changed.', /access.*changed/i],
    ['Team plan cleanup must be confirmed before continuing.', /cleanup.*confirmed/i],
    ['The task delivery receipt is unavailable.', /delivery.*receipt/i],
    ['Workflow checkpoints are owned by another live controller.', /checkpoint.*storage|storage.*checkpoint/i],
  ]) {
    const f = fixture(); t.after(() => f.controller.close());
    const plan = f.create(); f.block(new Error(message)); f.controller.pump();
    const blocked = f.get(plan.id); assert.equal(blocked.canResume, false);
    assert.match(blocked.tasks.find(t => t.key === 'source_triage').summary, expected);
    assert.match(blocked.blockedReason, expected);
  }
});

test('dispatch receipt failures persist through the unchanged saved schema without automatic dispatch on reload', t => {
  const f = fixture(); t.after(() => f.controller.close());
  const plan = f.create(); f.dispatchError(new Error('The task delivery receipt is unavailable.'));
  f.controller.pump(); const saved = f.snapshot(), blocked = f.get(plan.id);
  assert.match(blocked.summary, /source_triage.*delivery receipt/i);
  assert.equal(saved.version, 1);
  const g = fixture(saved); t.after(() => g.controller.close());
  g.controller.pump(); assert.equal(g.deliveries.length, 0);
  assert.equal(g.get(plan.id).phase, 'blocked');
  assert.equal(g.get(plan.id).tasks.find(t => t.key === 'source_triage').summary, blocked.tasks.find(t => t.key === 'source_triage').summary);
  assert.deepEqual(g.snapshot(), saved, 'loading and read-only diagnostics do not rewrite saved data');
});
