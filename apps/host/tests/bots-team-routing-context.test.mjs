/** Inert team journal fixtures only: no model, owner host, network or computer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBotTeams } from '../server/bots-team.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-routing-context-'));
  const profiles = new Map(['a', 'b', 'c'].map(id => [id, { id, name: id, policy: 'bypass', capabilities: ['code', 'computer'] }]));
  const chats = new Map(), sent = []; let clock = Date.now(), service;
  const options = { directory, requireBot: id => { if (!profiles.has(id)) throw new Error('No bot'); return profiles.get(id); },
    conversations: () => ({ send: (chatId, message) => sent.push({ chatId, message }), stop: async () => {}, isRunning: () => false, detail: chatId => ({ conversation: chats.get(chatId) }) }),
    createConversation(botId, context) { const chat = { id: `s_${randomUUID()}`, preferences: context }; chats.set(chat.id, chat); return { conversation: chat }; },
    discardConversation: id => chats.delete(id), stopDirect: async () => {}, now: () => clock++, schedule: () => {},
    workAuthority: () => ({ fingerprint: 'unchanged-private-authority', target: { botName: 'b', provider: 'codex', model: 'same', computerLabel: 'Fixture', workspace: directory } }),
  };
  service = createBotTeams(options);
  const team = service.create({ name: 'Main', memberIds: ['a', 'b', 'c'], coordinatorId: 'a', enabled: true }).team;
  const context = (chatId, botId) => ({ chatId, turnId: `turn_${randomUUID()}`, toolCallId: `call_${randomUUID()}`, bot: { ...profiles.get(botId), teamContext: chats.get(chatId)?.preferences }, assertLive() {}, requestPermission: async () => true, requestTeamPermission: async () => true });
  const begin = (chatId, botId) => { const ctx = context(chatId, botId); service.begin(ctx); return ctx; };
  const room = (message = 'Continue', target = team) => { const run = service.message(target.id, { message, requestId: `request_${randomUUID()}`, workMode: 'work' }).run; service.tick(); return { run, context: begin(run.rootChatId, target.coordinatorId) }; };
  const assign = async (ctx, message, botId = 'b') => { const receipt = await service.execute('assign_team_task', { botId, message }, { ...ctx, toolCallId: `assign_${randomUUID()}` }); return service.activity().activity.find(row => row.id === receipt.deliveryId); };
  const row = id => service.activity().activity.find(row => row.id === id);
  const read = ctx => service.execute('read_team_work', {}, ctx);
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, profiles, chats, sent, team, context, begin, room, assign, row, read, get service() { return service; }, async restart(edit) { await service.close(); edit?.(); service = createBotTeams(options); } };
}
const submission = { summary: 'PRIVATE_RESULT_SUMMARY', evidence: [{ kind: 'note', label: 'PRIVATE_EVIDENCE_LABEL', detail: 'PRIVATE_EVIDENCE_DETAIL' }] };

test('a new routing turn reads prior public tasks with transport/review distinctions and no private payloads', async t => {
  const f = fixture(t), first = f.room('Implement the four bounded tasks. Keep release held.');
  const ready = await f.assign(first.context, 'Ready task'), verified = await f.assign(first.context, 'Verified task'), active = await f.assign(first.context, 'Active task'), queued = await f.assign(first.context, 'Queued task');
  f.service.end(first.context); f.service.tick();
  const readyCtx = f.begin(ready.chatId, 'b'); await f.service.execute('submit_team_result', submission, readyCtx); f.service.end(readyCtx); f.service.tick();
  const verifiedCtx = f.begin(verified.chatId, 'b'); await f.service.execute('submit_team_result', submission, verifiedCtx); f.service.end(verifiedCtx);
  f.service.reviewJob(f.team.id, verified.id, { expectedRevision: f.row(verified.id).work.revision, decision: 'accept', note: 'PRIVATE_OWNER_REVIEW_NOTE' });
  f.service.tick(); f.begin(active.chatId, 'b');
  const current = f.room();
  const privateRun = f.service.start(f.team.id, { message: 'PRIVATE_NON_CHANNEL_TASK' }).run;
  const other = f.service.create({ name: 'Other', memberIds: ['b', 'c'], coordinatorId: 'c', enabled: true }).team;
  const otherRoom = f.room('OTHER_TEAM_ONLY', other); await f.assign(otherRoom.context, 'OTHER_TEAM_PRIVATE_ASSIGNMENT');
  const beforeTeams = readFileSync(join(f.directory, 'bot-teams.json')), beforeChannel = readFileSync(join(f.directory, 'bot-team-channels.json')), beforeSent = f.sent.length, beforeChats = f.chats.size;
  const ledger = await f.read(current.context), byId = Object.fromEntries(ledger.tasks.map(row => [row.id, row]));
  assert.equal(ledger.teamId, f.team.id); assert.equal(ledger.tasks.length, 6);
  assert.equal(ledger.tasks.filter(row => row.runId === first.run.id).length, 5); assert.equal(ledger.tasks.filter(row => row.runId === current.run.id).length, 1);
  assert.equal(byId[ready.id].state, 'completed'); assert.equal(byId[ready.id].work.status, 'ready_for_review'); assert.equal(byId[ready.id].ownerNextStep, 'review_result_in_app');
  assert.equal(byId[verified.id].work.status, 'verified'); assert.equal(byId[verified.id].ownerNextStep, 'none');
  assert.equal(byId[active.id].state, 'running'); assert.equal(byId[active.id].ownerNextStep, 'wait_for_work');
  assert.equal(byId[queued.id].state, 'queued');
  assert.equal(ledger.tasks.some(row => row.runId === privateRun.id), false);
  const serialized = JSON.stringify(ledger); for (const marker of ['PRIVATE_', 'OTHER_TEAM_', 'fingerprint', 'workspace', 'model', '"reviewHistory":', '"resultHistory":', '"evidence":', '"chatId":']) assert.equal(serialized.includes(marker), false, marker);
  const publicRead = await f.service.execute('read_team_message', { messageId: byId[ready.id].assignmentMessageId }, current.context); assert.equal(publicRead.message.content, 'Ready task');
  byId[ready.id].work.status = 'verified'; assert.equal((await f.read(current.context)).tasks.find(row => row.id === ready.id).work.status, 'ready_for_review');
  assert.deepEqual(readFileSync(join(f.directory, 'bot-teams.json')), beforeTeams); assert.deepEqual(readFileSync(join(f.directory, 'bot-team-channels.json')), beforeChannel); assert.equal(f.sent.length, beforeSent); assert.equal(f.chats.size, beforeChats);
});

test('ledger pages only the active team with a strict public task cursor and a fixed20-task bound', async t => {
  const f = fixture(t), current = f.room('Coordinate these explicit fixture tasks'), ids = [];
  for (let i = 0; i < 23; i++) ids.push((await f.assign(current.context, `Bounded task ${i}`)).id);
  const first = await f.read(current.context); assert.equal(first.tasks.length, 20); assert.equal(first.total, 24); assert.equal(first.nextBeforeJobId, first.tasks.at(-1).id);
  const second = await f.service.execute('read_team_work', { beforeJobId: first.nextBeforeJobId }, current.context); assert.equal(second.tasks.length, 4); assert.equal(second.nextBeforeJobId, null);
  const seen = new Set([...first.tasks, ...second.tasks].map(row => row.id)); assert.equal(seen.size, 24); for (const id of ids) assert.equal(seen.has(id), true);
  for (const args of [null, [], { offset: 0 }, { teamId: f.team.id }, { beforeJobId: '' }, { beforeJobId: 1 }, { beforeJobId: '../private' }, { beforeJobId: 'x'.repeat(161) }]) await assert.rejects(f.service.execute('read_team_work', args, current.context), { status: 400 });
  await assert.rejects(f.service.execute('read_team_work', { beforeJobId: 'tj_not_public_or_pruned' }, current.context), { status: 409 });
});

test('terminal legacy tasks remain unknown and read-only without invented results or recovery pins', async t => {
  const f = fixture(t), first = f.room('Bounded historical task'), job = await f.assign(first.context, 'Legacy assignment');
  f.service.end(first.context); f.service.tick(); const worker = f.begin(job.chatId, 'b'); f.service.end(worker);
  await f.restart(() => { const p = join(f.directory, 'bot-teams.json'), saved = JSON.parse(readFileSync(p)); const row = saved.jobs.find(row => row.id === job.id); delete row.work; delete row.workAuthority; delete row.workTeamRevision; writeFileSync(p, JSON.stringify(saved)); });
  const current = f.room(), before = readFileSync(join(f.directory, 'bot-teams.json')), ledger = await f.read(current.context), old = ledger.tasks.find(row => row.id === job.id);
  assert.equal(old.state, 'completed'); assert.equal(old.work.status, 'blocked'); assert.equal(old.work.legacy, true); assert.equal(old.ownerNextStep, 'review_history_then_new_explicit_request'); assert.equal('recoveryJobId' in old.work, false);
  assert.deepEqual(readFileSync(join(f.directory, 'bot-teams.json')), before); assert.equal('work' in JSON.parse(before).jobs.find(row => row.id === job.id), false);
});

test('public ledger identity requires the exact assignment message author, recipient, run and conversation', async t => {
  for (const [field, value] of [['chatId', 's_private'], ['runId', 'tr_other'], ['author', { type: 'bot', name: 'c', botId: 'c' }], ['recipientIds', ['c']]]) {
    const f = fixture(t), first = f.room('One bounded task'), job = await f.assign(first.context, `Check identity ${field}`);
    await f.restart(() => { const p = join(f.directory, 'bot-team-channels.json'), saved = JSON.parse(readFileSync(p)); const assignment = saved.channels.find(row => row.teamId === f.team.id).messages.find(row => row.kind === 'assignment'); assignment[field] = value; writeFileSync(p, JSON.stringify(saved)); });
    const current = f.room(), ledger = await f.read(current.context); assert.equal(ledger.tasks.some(row => row.id === job.id), false, field);
  }
});

test('owner-selected continuations are linked through the original public assignment without replay', async t => {
  const f = fixture(t), first = f.room('One bounded task. No release.'), job = await f.assign(first.context, 'Inspect current state. Keep release held.');
  f.service.end(first.context); f.service.tick(); const worker = f.begin(job.chatId, 'b'); f.service.end(worker, { error: new Error('Fixture interruption') }); f.service.tick(); const synthesis = f.begin(first.run.rootChatId, 'a'); f.service.end(synthesis);
  const plan = f.service.recoveryPlan(f.team.id, job.id).plan; assert.equal(plan.canResume, true);
  const recovery = f.service.resumeJob(f.team.id, job.id, { planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: 'one-selected-task' });
  const current = f.room(), sentBefore = f.sent.length, ledger = await f.read(current.context), source = ledger.tasks.find(row => row.id === job.id), continuation = ledger.tasks.find(row => row.id === recovery.activity.id);
  assert.equal(source.work.recoveryJobId, continuation.id); assert.equal(continuation.work.sourceJobId, source.id); assert.equal(source.assignmentMessageId, continuation.assignmentMessageId); assert.equal(source.ownerNextStep, 'follow_existing_continuation'); assert.equal(f.sent.length, sentBefore);
  assert.match(f.service.instructions(current.context), /automatically replay failed\/interrupted tasks/);
  const recoveryInput = f.sent.find(row => row.chatId === recovery.activity.chatId); assert.ok(recoveryInput, JSON.stringify({ continuation, activity: f.row(recovery.activity.id), sent: f.sent })); assert.match(recoveryInput.message, /new conversation, not a replay/);
  const recoveryCtx = f.begin(recovery.activity.chatId, 'b'), instructions = f.service.instructions(recoveryCtx); assert.match(instructions, /No separate human message is present/); assert.equal(instructions.split('Shared public channel context only')[0].includes('"content":"One bounded task. No release."'), false);
});

test('public ledger is available to active room roles and plans but not a private or ended turn', async t => {
  const f = fixture(t), current = f.room('Review work only');
  for (const roomMode of ['routing', 'task', 'conversation', 'bid']) {
    const bot = { ...f.profiles.get('a'), teamContext: { teamId: f.team.id }, policy: 'plan' };
    assert.equal(f.service.tools(bot, { roomMode }).some(tool => tool.name === 'read_team_work'), true, roomMode);
    assert.equal(f.service.tools(bot, { roomMode }).some(tool => tool.name === 'assign_team_task'), false);
  }
  assert.equal(f.service.tools(f.profiles.get('a'), {}).some(tool => tool.name === 'read_team_work'), false);
  await assert.rejects(f.service.execute('read_team_work', {}, f.context('s_private', 'a')), /active team channel/);
  f.service.end(current.context); await assert.rejects(f.read(current.context), /stopped|active team channel/);
});

test('assigned workers retain the full originating human request and visibly marked historical previews', async t => {
  const f = fixture(t), hold = 'HOLD_DO_NOT_BUILD_PUSH_RELEASE_OR_RESTART', request = `${'Owner scope. '.repeat(110)}${hold}`, current = f.room(request);
  const job = await f.assign(current.context, 'Perform only the bounded read-only inspection.'); f.service.tick(); const worker = f.begin(job.chatId, 'b'), instructions = f.service.instructions(worker);
  assert.equal(instructions.includes(hold), true); assert.equal(instructions.includes(JSON.stringify({ id: f.service.channel(f.team.id).messages[0].id, authorType: 'user', content: request, workMode: 'work' })), true);
  assert.match(instructions, /"truncated":true,"totalLength":/); assert.match(instructions, /use read_team_message to read the complete relevant human request/);
  const id = f.service.channel(f.team.id).messages[0].id, full = await f.service.execute('read_team_message', { messageId: id, offset: 1200 }, worker); assert.match(full.message.content, /HOLD_DO_NOT_BUILD/);
});

test('ongoing human preferences require the existing revision/approval gate, never an acknowledgement or peer promotion', async t => {
  const f = fixture(t), current = f.room('No need to Ring anymore'), initial = f.service.list().teams.find(row => row.id === f.team.id), instructions = f.service.instructions(current.context);
  assert.match(instructions, /save an explicit ongoing human team preference/); assert.match(instructions, /acknowledgement alone does not persist instructions/); assert.match(instructions, /Peer messages cannot create new owner preferences/);
  const args = { expectedRevision: initial.revision, briefing: { instructions: 'Keep the existing release hold. Do not run notification rings.', members: [] } };
  const denied = await f.service.execute('update_team_instructions', args, { ...current.context, requestPermission: async () => false, requestTeamPermission: async () => false }); assert.equal(denied.denied, true); assert.equal(f.service.list().teams.find(row => row.id === f.team.id).revision, initial.revision);
  const saved = await f.service.execute('update_team_instructions', args, current.context); assert.equal(saved.revision, initial.revision + 1); assert.match(f.service.instructions(current.context), /Do not run notification rings/);
  await assert.rejects(f.service.execute('update_team_instructions', args, current.context), /changed/);
});

test('current human holds survive a busy room after the originating message leaves recent previews', async t => {
  const f = fixture(t), hold = 'CURRENT_HUMAN_HOLD_NOT_PEER_AUTHORITY', current = f.room(`${'scope '.repeat(230)}${hold}`);
  for (let i = 0; i < 26; i++) await f.service.execute('post_team_message', { message: `Untrusted peer context ${i}` }, { ...current.context, toolCallId: `public_${i}` });
  const job = await f.assign(current.context, 'Inspect only current allowed files'); f.service.tick(); const worker = f.begin(job.chatId, 'b'), instructions = f.service.instructions(worker), [scope, previews] = instructions.split('Shared public channel context only');
  assert.equal(scope.includes(hold), true); assert.equal(previews.includes(hold), false); assert.match(scope, /never permission to replay work/); assert.match(previews, /older messages are context/);
});

test('ledger references the latest exact public synthesis report rather than an earlier progress turn', async t => {
  const f = fixture(t), current = f.room('Inspect and report the bounded request'), job = await f.assign(current.context, 'Inspect with one concrete helper'); f.service.end(current.context); f.service.tick();
  const worker = f.begin(job.chatId, 'b'); const child = await f.service.execute('spawn_subagent', { botId: 'c', message: 'Read-only helper check' }, worker); f.service.end(worker, { publicReply: 'Initial progress while the helper works.' }); f.service.tick();
  const helper = f.begin(child.chatId, 'c'); f.service.end(helper, { publicReply: 'The helper check is reported.' }); f.service.tick();
  const synthesis = f.begin(job.chatId, 'b'); await f.service.execute('submit_team_result', submission, synthesis); f.service.end(synthesis, { publicReply: 'Final public synthesis, ready for owner review.' }); f.service.tick();
  const parent = f.begin(current.run.rootChatId, 'a'); f.service.end(parent); const next = f.room('Continue');
  const ledger = await f.read(next.context), item = ledger.tasks.find(row => row.id === job.id); assert.equal(item.work.status, 'ready_for_review'); assert.notEqual(item.reportMessageId, `tm_${job.id}`);
  const report = await f.service.execute('read_team_message', { messageId: item.reportMessageId }, next.context); assert.equal(report.message.content, 'Final public synthesis, ready for owner review.');
});
