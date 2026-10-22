import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBotTeams } from '../server/bots-team.mjs';
import { normalizeResult, validateSavedWork } from '../server/bots-team-work.mjs';

// This fixture never invokes a model, native provider, owner host or tool. Each
// send records an inert request which a test explicitly begins/finishes.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-work-review-')), profiles = new Map([['a', { id: 'a', name: 'Coordinator', policy: 'bypass' }], ['b', { id: 'b', name: 'Builder', policy: 'bypass' }], ['c', { id: 'c', name: 'Reviewer', policy: 'bypass' }]]), chats = new Map(), sent = [];
  let clock = Date.now(), authority = 'same-private-auth', available = true, createCount = 0;
  const options = { directory, requireBot: id => { const row = profiles.get(id); if (!row) throw new Error('Missing bot'); return row; }, conversations: () => ({ send(chatId, message) { sent.push({ chatId, message }); }, stop: async () => {}, isRunning: () => false, detail: chatId => ({ conversation: chats.get(chatId) }) }), createConversation(botId, context) { const chat = { id: `s_${randomUUID()}`, messages: [], preferences: context }; chats.set(chat.id, chat); createCount++; return { conversation: chat }; }, discardConversation: id => chats.delete(id), stopDirect: async () => {}, workAuthority: () => ({ fingerprint: authority, target: { botName: 'Builder', provider: 'configured', model: 'Pinned', computerLabel: 'Original Mac', workspace: directory } }), assertRecoveryAvailable() { if (!available) throw new Error('Computer cleanup is unconfirmed.'); }, now: () => clock, schedule: () => {} };
  let service = createBotTeams(options);
  const team = service.create({ name: 'Testing', memberIds: ['a', 'b', 'c'], coordinatorId: 'a', enabled: true }).team;
  const context = (chatId, botId) => ({ chatId, turnId: `turn_${randomUUID()}`, toolCallId: `call_${randomUUID()}`, bot: profiles.get(botId), assertLive() {}, requestPermission: async () => true, requestTeamPermission: async () => true });
  function begin(chatId, botId) { const ctx = context(chatId, botId); service.begin(ctx); return ctx; }
  async function assignment(message = 'Implement the bounded feature') {
    const run = service.start(team.id, { message: 'Coordinate' }).run; service.tick();
    const root = begin(run.rootChatId, 'a'); await service.execute('spawn_subagent', { botId: 'b', message }, root); service.end(root); service.tick();
    const row = service.activity().activity.find(row => row.type === 'subagent' && row.runId === run.id); return { row, context: begin(row.chatId, 'b'), run };
  }
  function finish(ctx, outcome) { service.end(ctx, outcome); service.tick(); for (let i = 0; i < 10; i++) { const active = service.activity().activity.filter(row => row.type !== 'run' && row.state === 'running' && row.chatId !== ctx.chatId); if (!active.length) break; for (const row of active) { const c = begin(row.chatId, row.botId); service.end(c); } service.tick(); } }
  function row(id) { return service.activity().activity.find(row => row.id === id); }
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, profiles, chats, sent, options, team, context, begin, assignment, finish, row, get service() { return service; }, set authority(value) { authority = value; }, set available(value) { available = value; }, advance(ms) { clock += ms; }, get createCount() { return createCount; }, async restart() { await service.close(); service = createBotTeams(options); return service; } };
}
const result = () => ({ summary: 'Implemented the requested feature and checked it.', evidence: [{ kind: 'test', label: 'Focused checks', detail: '12 passed; no live production checks.' }] });
const inputFor = (plan, key = 'owner-resume') => ({ planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: key });

test('capability is additive and clean transport completion never verifies or invents evidence', async t => {
  const f = fixture(t), a = await f.assignment();
  assert.equal(f.service.list().teamWorkReviewSupported, true); assert.equal(f.service.activity().teamWorkReviewSupported, true); assert.equal(f.service.channel(f.team.id).teamWorkReviewSupported, true);
  assert.equal(f.row(a.row.id).work.status, 'working'); f.finish(a.context);
  const row = f.row(a.row.id); assert.equal(row.state, 'completed'); assert.equal(row.work.status, 'blocked'); assert.deepEqual(row.work.resultHistory, []);
  assert.throws(() => f.service.reviewJob(f.team.id, row.id, { expectedRevision: row.work.revision, decision: 'accept' }), /no submitted result/);
});

test('task submission reports immutable evidence and only explicit owner accept verifies exact revision', async t => {
  const f = fixture(t), a = await f.assignment(), args = result();
  const reported = await f.service.execute('submit_team_result', args, a.context); args.evidence[0].detail = 'mutated caller object';
  assert.equal(reported.work.status, 'ready_for_review'); assert.match(f.row(a.row.id).work.evidence[0].detail, /^12 passed/);
  assert.throws(() => f.service.reviewJob(f.team.id, a.row.id, { expectedRevision: reported.work.revision, decision: 'accept' }), /Wait for/);
  f.finish(a.context); const before = f.row(a.row.id).work;
  assert.equal(before.status, 'ready_for_review'); assert.throws(() => f.service.reviewJob(f.team.id, a.row.id, { expectedRevision: before.revision - 1, decision: 'accept' }), /changed/);
  const verified = f.service.reviewJob(f.team.id, a.row.id, { expectedRevision: before.revision, decision: 'accept', note: 'Inspected these supplied checks.' }).activity.work;
  assert.equal(verified.status, 'verified'); assert.equal(verified.reviewHistory[0].resultId, verified.resultHistory[0].id); assert.deepEqual(verified.resultHistory, before.resultHistory);
  assert.equal(f.service.recoveryPlan(f.team.id, a.row.id).plan.canResume, false);
});

test('a bot cannot submit outside its active task or forge verification and malformed evidence is rejected', async t => {
  const f = fixture(t), a = await f.assignment();
  await assert.rejects(f.service.execute('submit_team_result', result(), { ...a.context, chatId: 'another-chat' }), /exact active/);
  await assert.rejects(f.service.execute('submit_team_result', { ...result(), verified: true }, a.context), /summary and labeled/);
  for (const args of [{ summary: 'Done', evidence: [] }, { summary: 'Done', evidence: [{ kind: 'shell', label: 'bad', detail: 'x' }] }, { summary: 'Done', evidence: [{ kind: 'file', label: 'x', detail: 'y', verified: true }] }, { summary: 'Done', evidence: [{ kind: 'link', label: 'x', detail: 'https://secret:password@example.com/' }] }]) await assert.rejects(f.service.execute('submit_team_result', args, a.context));
  assert.equal(f.row(a.row.id).work.resultHistory.length, 0); f.finish(a.context);
  await assert.rejects(f.service.execute('submit_team_result', result(), a.context), /active assigned task/);
});

test('a clear blocked submission requires no fabricated evidence and cannot be accepted as verified', async t => {
  const f = fixture(t), a = await f.assignment();
  await f.service.execute('submit_team_result', { outcome: 'blocked', summary: 'The owner needs to grant access to the requested folder.' }, a.context); f.finish(a.context);
  const row = f.row(a.row.id); assert.equal(row.work.status, 'blocked'); assert.equal(row.work.summary, 'The owner needs to grant access to the requested folder.'); assert.deepEqual(row.work.evidence, []);
  assert.throws(() => f.service.reviewJob(f.team.id, row.id, { expectedRevision: row.work.revision, decision: 'accept' }), /no submitted result/);
});

test('reject retains original claims and makes only that task eligible for an explicit guided continuation', async t => {
  const f = fixture(t), a = await f.assignment('x'.repeat(140) + ' Keep the deployment and restart hold.');
  await f.service.execute('submit_team_result', result(), a.context); f.finish(a.context); const original = f.row(a.row.id);
  f.service.reviewJob(f.team.id, a.row.id, { expectedRevision: original.work.revision, decision: 'reject', note: 'Add the missing test.' });
  const bytes = readFileSync(join(f.directory, 'bot-teams.json')), before = f.sent.length, count = f.createCount;
  const plan = f.service.recoveryPlan(f.team.id, a.row.id).plan;
  assert.equal(plan.canResume, true); assert.equal(f.sent.length, before); assert.equal(f.createCount, count); assert.deepEqual(readFileSync(join(f.directory, 'bot-teams.json')), bytes);
  const resumed = f.service.resumeJob(f.team.id, a.row.id, inputFor(plan));
  assert.notEqual(resumed.activity.id, a.row.id); assert.notEqual(resumed.activity.chatId, a.row.chatId); assert.equal(resumed.activity.work.sourceJobId, a.row.id); assert.equal(f.row(a.row.id).work.recoveryJobId, resumed.activity.id);
  assert.deepEqual(f.row(a.row.id).work.resultHistory, original.work.resultHistory); assert.equal(f.sent.length, before);
  f.service.tick(); const continuation = f.sent.at(-1); assert.match(continuation.message, /First inspect/); assert.match(continuation.message, /Keep the deployment and restart hold/); assert.match(continuation.message, /Add the missing test/); assert.match(continuation.message, /"author":"owner"/); assert.match(continuation.message, /not a replay/); assert.notEqual(continuation.message, 'x'.repeat(140) + ' Keep the deployment and restart hold.');
  assert.deepEqual(f.service.resumeJob(f.team.id, a.row.id, inputFor(plan)).activity.id, resumed.activity.id);
  assert.throws(() => f.service.resumeJob(f.team.id, a.row.id, { ...inputFor(plan), expectedRevision: 99 }), /another selection/);
});

test('recovery expires and rejects changed authority, team revision, paused bots and quarantine', async t => {
  const f = fixture(t), a = await f.assignment(); f.finish(a.context, { error: new Error('Failed check') });
  const plan = f.service.recoveryPlan(f.team.id, a.row.id).plan; f.advance(10 * 60 * 1000 + 1);
  assert.throws(() => f.service.resumeJob(f.team.id, a.row.id, inputFor(plan)), /expired/);
  const fresh = f.service.recoveryPlan(f.team.id, a.row.id).plan; f.authority = 'changed'; assert.throws(() => f.service.resumeJob(f.team.id, a.row.id, inputFor(fresh)), /access changed|tool access changed/); f.authority = 'same-private-auth';
  f.available = false; assert.equal(f.service.recoveryPlan(f.team.id, a.row.id).plan.canResume, false); f.available = true;
  f.profiles.get('b').paused = true; assert.match(f.service.recoveryPlan(f.team.id, a.row.id).plan.blockedReason, /Resume this bot/); f.profiles.get('b').paused = false;
  f.service.update(f.team.id, { name: 'Updated public settings' }); assert.match(f.service.recoveryPlan(f.team.id, a.row.id).plan.blockedReason, /team instructions or membership changed/);
});

test('failed durable recovery write leaves no runnable orphan, source link, chat or receipt', async t => {
  const f = fixture(t), a = await f.assignment(); f.finish(a.context); const plan = f.service.recoveryPlan(f.team.id, a.row.id).plan, count = f.chats.size, before = f.row(a.row.id);
  const journal = join(f.directory, 'bot-teams.json'), saved = readFileSync(journal), foreign = join(f.directory, 'foreign.json'); unlinkSync(journal); symlinkSync(foreign, journal);
  assert.throws(() => f.service.resumeJob(f.team.id, a.row.id, inputFor(plan)), /symbolic|saved|private|storage|linked/i);
  assert.equal(f.chats.size, count); assert.deepEqual(f.row(a.row.id).work, before.work); assert.equal(f.service.activity().activity.some(row => row.work?.sourceJobId === a.row.id), false);
  unlinkSync(journal); const { writeFileSync } = await import('node:fs'); writeFileSync(journal, saved, { mode: 0o600 });
  assert.equal(f.service.resumeJob(f.team.id, a.row.id, inputFor(plan)).activity.work.sourceJobId, a.row.id);
});

test('recovery receipt survives restart and does not replay newly interrupted continuation', async t => {
  const f = fixture(t), a = await f.assignment(); f.finish(a.context); const plan = f.service.recoveryPlan(f.team.id, a.row.id).plan, input = inputFor(plan), resumed = f.service.resumeJob(f.team.id, a.row.id, input);
  await f.restart(); const before = f.sent.length; f.service.tick();
  assert.equal(f.sent.length, before); const retry = f.service.resumeJob(f.team.id, a.row.id, input); assert.equal(retry.activity.id, resumed.activity.id); assert.equal(retry.activity.state, 'cancelled');
});

test('no bot-supplied verified history can pass saved result validation', () => {
  assert.throws(() => validateSavedWork({ status: 'verified', revision: 1, evidence: [], resultHistory: [], reviewHistory: [] }), /saved team result/);
  assert.throws(() => normalizeResult({ summary: 'Verified', evidence: [{ kind: 'note', label: 'self', detail: 'I declare it verified', reviewer: 'owner' }] }));
});

test('a non-channel root execution task has a discoverable reviewable job identity', async t => {
  const f = fixture(t), run = f.service.start(f.team.id, { message: 'A bounded owner task' }).run; f.service.tick(); const ctx = f.begin(run.rootChatId, 'a');
  const task = f.service.activity().activity.find(row => row.chatId === run.rootChatId && row.work); assert.match(task.id, /^tj_/); assert.equal(task.type, 'delivery');
  await f.service.execute('submit_team_result', result(), ctx); f.finish(ctx);
  const verified = f.service.reviewJob(f.team.id, task.id, { expectedRevision: f.row(task.id).work.revision, decision: 'accept' }); assert.equal(verified.activity.work.status, 'verified');
});

test('submission cap rejects additional claims without truncating immutable evidence', async t => {
  const f = fixture(t), a = await f.assignment();
  for (let i = 0; i < 16; i++) await f.service.execute('submit_team_result', { ...result(), summary: `Result ${i}` }, a.context);
  const before = f.row(a.row.id).work; await assert.rejects(f.service.execute('submit_team_result', result(), a.context), /history is full/); assert.deepEqual(f.row(a.row.id).work, before);
});

test('scope and quarantine are checked again after owner selection before launch', async t => {
  const f = fixture(t), a = await f.assignment(); f.finish(a.context); const plan = f.service.recoveryPlan(f.team.id, a.row.id).plan, before = f.sent.length;
  const resumed = f.service.resumeJob(f.team.id, a.row.id, inputFor(plan)); f.authority = 'newly-revoked-tools'; f.service.tick();
  assert.equal(f.sent.length, before); assert.equal(f.row(resumed.activity.id).state, 'error'); assert.equal(f.row(resumed.activity.id).work.status, 'blocked');
});

test('verified sibling work appears as a completed reference and is never selected for recovery', async t => {
  const f = fixture(t), first = await f.assignment();
  await f.service.execute('submit_team_result', result(), first.context); f.finish(first.context); f.service.reviewJob(f.team.id, first.row.id, { expectedRevision: f.row(first.row.id).work.revision, decision: 'accept' });
  const no = f.service.recoveryPlan(f.team.id, first.row.id).plan; assert.equal(no.canResume, false); assert.throws(() => f.service.resumeJob(f.team.id, first.row.id, inputFor(no)), /unavailable/);
});

test('an accepted recovery protects its source run through the 200-terminal-run pruning boundary', async t => {
  const f = fixture(t), a = await f.assignment(); f.finish(a.context);
  // The source is now the oldest terminal run. Populate the normal journal's
  // retention boundary before accepting its recovery continuation.
  for (let i = 0; i < 199; i++) { const run = f.service.start(f.team.id, { message: `Completed unrelated turn ${i}` }).run; f.service.tick(); const ctx = f.begin(run.rootChatId, 'a'); f.finish(ctx); }
  const plan = f.service.recoveryPlan(f.team.id, a.row.id).plan; assert.equal(plan.canResume, true); const resumed = f.service.resumeJob(f.team.id, a.row.id, inputFor(plan));
  // Creating the 201st terminal sibling triggers pruning while recovery is queued.
  const other = f.service.start(f.team.id, { message: 'Newest unrelated owner task' }).run; f.service.tick(); const otherCtx = f.begin(other.rootChatId, 'a'); f.service.end(otherCtx); f.service.tick();
  assert.ok(f.row(a.row.id)); assert.ok(f.sent.some(row => row.chatId === resumed.activity.chatId)); assert.equal(f.row(resumed.activity.id).state, 'running');
});

test('an assigned bot can submit its final evidence from its exact delegated-results continuation', async t => {
  const f = fixture(t), a = await f.assignment();
  await f.service.execute('spawn_subagent', { botId: 'c', message: 'Independently check the requested feature' }, a.context);
  await f.service.execute('submit_team_result', { ...result(), summary: 'Initial implementation before delegated checks.' }, a.context);
  f.service.end(a.context); f.service.tick();
  const child = f.service.activity().activity.find(row => row.type === 'subagent' && row.botId === 'c');
  const cctx = f.begin(child.chatId, 'c'); await f.service.execute('submit_team_result', { ...result(), summary: 'Delegated focused checks passed.' }, cctx); f.service.end(cctx); f.service.tick();
  const continuation = f.service.activity().activity.find(row => row.botId === 'b' && row.id !== a.row.id && row.state === 'running'); assert.ok(continuation);
  assert.equal(f.row(a.row.id).work.status, 'working');
  const bctx = f.begin(continuation.chatId, 'b'), submitted = await f.service.execute('submit_team_result', { ...result(), summary: 'Implementation and delegated checks reconciled.' }, bctx);
  assert.equal(submitted.jobId, a.row.id); assert.equal(submitted.work.resultHistory.length, 2); f.finish(bctx);
  assert.equal(f.row(a.row.id).work.status, 'ready_for_review'); assert.equal(f.row(a.row.id).work.summary, 'Implementation and delegated checks reconciled.');
});

test('restart during delegated synthesis recovers the original task ledger once without losing claims', async t => {
  const f = fixture(t), a = await f.assignment();
  await f.service.execute('spawn_subagent', { botId: 'c', message: 'Run the delegated checks' }, a.context);
  await f.service.execute('submit_team_result', result(), a.context); f.service.end(a.context); f.service.tick();
  const child = f.service.activity().activity.find(row => row.type === 'subagent' && row.botId === 'c'), childCtx = f.begin(child.chatId, 'c'); await f.service.execute('submit_team_result', result(), childCtx); f.service.end(childCtx); f.service.tick();
  const before = f.row(a.row.id).work; assert.equal(before.status, 'working'); const beforeSent = f.sent.length;
  // Simulate an unexpected process loss: reconstruct directly from the durable
  // journal before any graceful Stop can alter its in-flight transport rows.
  const restored = createBotTeams(f.options); t.after(() => restored.close()); restored.tick();
  const recovered = restored.activity().activity.find(row => row.id === a.row.id).work;
  assert.equal(recovered.status, 'interrupted'); assert.deepEqual(recovered.resultHistory, before.resultHistory); assert.equal(recovered.revision, before.revision + 1); assert.equal(f.sent.length, beforeSent);
  assert.equal(restored.recoveryPlan(f.team.id, a.row.id).plan.canResume, true);
  const twice = createBotTeams(f.options); t.after(() => twice.close()); const second = twice.activity().activity.find(row => row.id === a.row.id).work;
  assert.deepEqual(second, recovered); assert.equal(f.sent.length, beforeSent);
});

test('legacy task history remains exact and cannot gain an invented recovery pin or verified state', async t => {
  const f = fixture(t), a = await f.assignment(); f.finish(a.context); await f.service.close();
  const journal = join(f.directory, 'bot-teams.json'), saved = JSON.parse(readFileSync(journal));
  delete saved.recoveryKeys;
  for (const job of saved.jobs) for (const key of ['work', 'workAuthority', 'workTeamRevision', 'workSubmittedTurnId']) delete job[key];
  const { writeFileSync } = await import('node:fs'); writeFileSync(journal, JSON.stringify(saved), { mode: 0o600 });
  const restored = createBotTeams(f.options); t.after(() => restored.close());
  const after = JSON.parse(readFileSync(journal)); assert.deepEqual(after.jobs, saved.jobs); assert.deepEqual(after.runs, saved.runs); assert.deepEqual(after.teams, saved.teams); assert.deepEqual(after.recoveryKeys, []);
  const row = restored.activity().activity.find(row => row.id === a.row.id); assert.equal(row.work.status, 'blocked'); assert.deepEqual(row.work.resultHistory, []); assert.equal(row.work.legacy, true);
  const plan = restored.recoveryPlan(f.team.id, a.row.id).plan; assert.equal(plan.canResume, false); assert.match(plan.blockedReason, /team instructions|snapshot/);
});
