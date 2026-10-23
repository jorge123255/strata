import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamPlans } from '../server/bots-team-plans.mjs';

function fixture(t) {
  const members = ['coordinator', 'builder', 'reviewer']; let saved, blocked = false, clock = 1700000000000;
  const deliveries = [], events = [];
  const core = createTeamPlans({ directory: '/unused', now: () => clock++, store: { read: () => undefined, save: value => { saved = structuredClone(value); }, assertOwner() {}, close() {} },
    teamFor: () => ({ id: 'team_fixture', enabled: true, revision: 1, memberIds: members, coordinatorId: members[0] }),
    prepare: () => ({ authorities: Object.fromEntries(members.map(id => [id, 'a'.repeat(64)])), resourceKeys: Object.fromEntries(members.map(id => [id, `local:/fixture/${id}`])) }),
    ensure: (_row, options) => { if (blocked && (options.attempt?.taskId || options.inspect || options.resuming)) throw Object.assign(new Error('Inspect unresolved action receipts and computer cleanup before continuing this workflow. No old action will be replayed.'), { code: 'team_plan_receipts_unresolved' }); },
    dispatch: (_row, attempt) => { const result = { chatId: `s_${deliveries.length}`, jobId: `tj_${deliveries.length}` }; deliveries.push({ ...attempt, ...result }); return result; },
    stopRun: async () => {}, publish: (_row, event) => events.push(event.content),
  }); t.after(() => core.close());
  const plan = core.create('team_fixture', { requestId: 'progress', goal: 'Complete the isolated fixture and independently review it.' }).plan;
  const get = () => core.detail('team_fixture', plan.id).plan;
  function start(kind, key) { core.pump(); const row = saved.plans[0], task = row.tasks.find(t => t.key === key), a = row.attempts.findLast(a => a.kind === kind && a.state === 'pending' && (!task || a.taskId === task.id)); assert.ok(a?.chatId); core.beforeStart(plan.id, a.id, a.chatId); return { a, binding: { ...core.binding(plan.id, a.id), chatId: a.chatId, botId: a.botId, assertLive() {}, hasVerificationEvidence: () => true } }; }
  const planning = start('planning');
  const base = { instructions: 'Only this fixture.', criteria: ['Verify the result.'], kind: 'work', ownerId: 'builder', dependsOn: [] };
  core.submission('submit_team_plan', { summary: 'Fixture graph.', participation: members.map(botId => ({ botId, role: 'Relevant fixture role', reason: 'Concrete work or review.' })), tasks: [
    { ...base, key: 'completed', title: 'Completed prerequisite' }, { ...base, key: 'remaining', title: 'Remaining task', dependsOn: ['completed'] },
    { ...base, key: 'review', title: 'Independent review', ownerId: 'reviewer', kind: 'review', dependsOn: ['completed', 'remaining'] },
  ] }, planning.binding); core.finish(plan.id, planning.a.id);
  function checkpoint(key, overrides = {}) { const { a, binding } = start('task', key), row = get().tasks.find(t => t.key === key); core.submission('checkpoint_team_plan_task', { outcome: 'ready_for_review', summary: `Actual report for ${key}.`, evidence: [{ kind: 'test', label: 'Fixture check', detail: 'Observed fixture result.' }], ...(row.kind === 'review' ? { checks: row.criteria.map(c => ({ criterionId: c.id, passed: true, detail: 'Observed exact criterion.' })) } : {}), ...overrides }, binding); core.finish(plan.id, a.id); }
  checkpoint('completed');
  return { core, get, start, checkpoint, events, block: value => { blocked = value; }, saved: () => structuredClone(saved) };
}

test('explicit resume and actual start replace stale blocker progress without changing completed results or task evidence', t => {
  const f = fixture(t), completed = f.get().tasks[0];
  f.checkpoint('remaining', { outcome: 'working', summary: 'Completed a useful first chunk.', progress: 'Exact observed progress.', nextStep: 'Inspect the remaining chunk.' });
  const prior = f.saved().plans[0].tasks.find(t => t.key === 'remaining');
  f.block(true); f.core.pump(); const blocked = f.get(), oldReason = blocked.summary;
  assert.match(oldReason, /unresolved action receipts/i);
  f.block(false); const inspected = f.get();
  const resumed = f.core.resume('team_fixture', inspected.id, { expectedRevision: inspected.revision, expectedProof: inspected.proof, requestId: 'resume', inspected: true }).plan;
  assert.equal(resumed.phase, 'running'); assert.notEqual(resumed.summary, oldReason);
  assert.doesNotMatch(resumed.summary, /unresolved action receipts/i);
  assert.match(resumed.tasks.find(t => t.key === 'remaining').summary, /queued|inspect/i);
  assert.deepEqual(resumed.tasks[0], completed);
  const retained = f.saved().plans[0].tasks.find(t => t.key === 'remaining');
  assert.equal(retained.progress, prior.progress); assert.equal(retained.nextStep, prior.nextStep); assert.deepEqual(retained.evidence, prior.evidence);
  f.start('task', 'remaining'); const running = f.get();
  assert.doesNotMatch(running.summary, /unresolved action receipts/i);
  assert.match(running.summary, /running|working/i);
  assert.match(running.tasks.find(t => t.key === 'remaining').summary, /running|working/i);
  assert.deepEqual(running.tasks[0], completed);
  assert.equal(f.events.filter(e => e.startsWith('Team plan running')).some(e => e.includes(oldReason)), false);
});

test('fresh synthesis progress after inspected recovery preserves all completed work and independent reviews', t => {
  const f = fixture(t); f.checkpoint('remaining'); f.checkpoint('review');
  const completed = f.saved().plans[0].tasks;
  const synthesis = f.start('synthesis'); f.core.finish(f.get().id, synthesis.a.id, { error: 'A fixture provider failed.' });
  const blocked = f.get();
  const resumed = f.core.resume('team_fixture', blocked.id, { expectedRevision: blocked.revision, expectedProof: blocked.proof, requestId: 'resume-summary', inspected: true }).plan;
  assert.equal(resumed.phase, 'summarizing'); assert.match(resumed.summary, /fresh synthesis/i);
  f.start('synthesis'); assert.match(f.get().summary, /summarizing completed/i);
  assert.deepEqual(f.saved().plans[0].tasks, completed);
});

test('ordinary working continuation retains its real progress report rather than replacing it with a status placeholder', t => {
  const f = fixture(t);
  f.checkpoint('remaining', { outcome: 'working', summary: 'Implemented the first useful chunk.', progress: 'Exact durable progress.', nextStep: 'Inspect and finish the next chunk.' });
  const reported = f.get().tasks.find(t => t.key === 'remaining');
  f.start('task', 'remaining'); const current = f.get().tasks.find(t => t.key === 'remaining');
  assert.equal(current.summary, reported.summary); assert.equal(current.nextStep, reported.nextStep); assert.deepEqual(current.evidence, reported.evidence);
});
