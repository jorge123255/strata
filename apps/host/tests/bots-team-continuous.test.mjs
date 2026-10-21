/** Disposable journals and inert providers only; no owner models, files or computers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBotTeams, DEFAULT_TEAM_LIMITS } from '../server/bots-team.mjs';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';

async function until(fn) { const deadline = Date.now() + 7000; while (!fn()) { if (Date.now() > deadline) throw Error('Continuous fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); } }
function journal(t, count = 4) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-continuous-'));
  const bots = new Map(Array.from({ length: count }, (_, i) => [`bot_${i}`, { id: `bot_${i}`, name: `Member ${i}`, policy: 'bypass' }]));
  const chats = new Map(), sent = [], stopped = [], scheduled = [], cleanup = { stop: async () => {} }; let n = 0, clock = Date.parse('2026-10-21T00:00:00Z');
  const options = { directory, now: () => clock, requireBot(id) { if (!bots.has(id)) throw Error('Unknown bot'); return bots.get(id); },
    conversations: () => ({ detail: id => ({ conversation: chats.get(id) }), send: id => sent.push(id), stop: async id => { stopped.push(id); } }),
    createConversation(botId) { const conversation = { id: `s_${++n}`, botId, messages: [] }; chats.set(conversation.id, conversation); return { conversation }; },
    stopDirect: async id => cleanup.stop(id), schedule: fn => scheduled.push(fn) };
  const service = createBotTeams(options), file = join(directory, 'bot-teams.json');
  const snapshot = () => JSON.parse(readFileSync(file));
  const team = (extra = {}) => service.create({ name: 'Continuous work', memberIds: [...bots.keys()], coordinatorId: 'bot_0', enabled: true, ...extra }).team;
  const context = (job, turnId = `turn_${job.id}`) => ({ bot: bots.get(job.botId), chatId: job.chatId, turnId, toolCallId: `call_${job.id}`, assertLive() {}, requestPermission: async () => true, requestTeamPermission: async () => true });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, bots, chats, sent, stopped, scheduled, cleanup, options, service, snapshot, team, context, advance: delta => { clock += delta; } };
}
function fixture(t, script, count = 4) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-participation-')); let chats;
  const seen = [], effects = [];
  const bots = createBots({ directory, runtime: { providers: async () => [], async run(input) { seen.push(input); await script(input); input.onFrame({ type: 'done' }); }, close() {} },
    tools: { definitions: () => [{ name: 'write_file', description: 'Write', inputSchema: { type: 'object' } }], execute: async () => { effects.push(true); return { content: [] }; }, finish: async () => {} },
    defaultWorkspace: () => directory, conversations: () => chats });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: input => bots.validateSelection(input), execute: input => bots.run(input) });
  const members = Array.from({ length: count }, (_, i) => bots.create({ name: `Member ${i}`, provider: 'codex', workspace: directory, policy: 'bypass' }).bot);
  const team = bots.team.create({ name: 'Public group', memberIds: members.map(bot => bot.id), coordinatorId: members[0].id, enabled: true }).team;
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, bots, chats, members, team, seen, effects, send: (message, extra = {}) => bots.team.message(team.id, { message, requestId: `request_${seen.length}_${message.length}`, ...extra }), done: run => until(() => !['queued', 'running'].includes(bots.team.detail(team.id, run.id).run.state)) };
}
const say = (input, text) => input.onFrame({ type: 'delta', text });

test('all team settings canonicalize to continuous while restart preserves every historical field exactly', async t => {
  const f = journal(t), first = f.team({ limits: { maxDepth: 8, maxHops: 20, maxTurns: 100, maxDurationMs: 50000, maxParallel: 3 } });
  const second = f.team({ name: 'Second', limits: { maxDepth: 1, maxTurns: 1 } });
  assert.deepEqual(first.limits, DEFAULT_TEAM_LIMITS); assert.equal(f.service.list().teamContinuousSupported, true);
  for (const key of Object.keys(DEFAULT_TEAM_LIMITS)) for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.service.update(first.id, { limits: { [key]: value } }), { status: 400 });
  const run = f.service.start(first.id, { message: 'Historical completed work' }).run;
  f.service.tick(); const root = f.snapshot().jobs.find(job => job.runId === run.id), context = f.context(root); f.service.begin(context); f.service.end(context);
  await f.service.close(); const legacy = f.snapshot();
  legacy.teams[0].limits = { maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000, maxParallel: 2 };
  legacy.teams[1].limits = { maxDepth: 99, maxHops: 88, maxTurns: 77, maxDurationMs: 123456, maxParallel: 9 };
  legacy.runs[0].limits = { ...legacy.teams[0].limits }; legacy.runs[0].deadline = 123; legacy.jobs[0].opaqueAuditMarker = 'unchanged';
  writeFileSync(f.file, JSON.stringify(legacy));
  const restored = createBotTeams(f.options); t.after(() => restored.close());
  const expected = structuredClone(legacy); for (const row of expected.teams) row.limits = { ...row.limits, ...DEFAULT_TEAM_LIMITS };
  assert.deepEqual(f.snapshot(), expected); assert.equal(expected.teams[1].id, second.id);
  assert.deepEqual(restored.detail(first.id, run.id).run.limits, legacy.runs[0].limits);
});

test('finite useful work crosses 24 turns, legacy duration, hop and nesting limits without a replacement cutoff', async t => {
  const f = journal(t, 2), team = f.team({ limits: { maxTurns: 2, maxDepth: 1, maxHops: 1, maxDurationMs: 1 } });
  const run = f.service.start(team.id, { message: 'Finite requested work' }).run;
  let work = 0, turns = 0;
  while (['queued', 'running'].includes(f.service.detail(team.id, run.id).run.state)) {
    f.service.tick(); const active = f.snapshot().jobs.find(job => job.runId === run.id && job.state === 'running');
    assert.ok(active, 'finite fixture must have useful runnable work');
    const context = f.context(active); f.service.begin(context); assert.equal(f.service.isContinuousTurn(context.turnId), true);
    if (!active.completion && work++ < 40) await f.service.execute('spawn_subagent', { botId: active.botId === 'bot_0' ? 'bot_1' : 'bot_0', message: `Requested finite stage ${work}` }, context);
    f.advance(3600000); f.service.end(context, { publicReply: `Stage result ${turns++}` });
    assert.equal(f.service.isContinuousTurn(context.turnId), false);
  }
  const saved = f.snapshot(), result = f.service.detail(team.id, run.id).run;
  assert.equal(work, 41); assert.equal(result.state, 'completed'); assert.ok(result.consumedTurns > 80);
  assert.ok(Math.max(...saved.jobs.map(job => job.depth)) >= 40); assert.ok(Math.max(...saved.jobs.map(job => job.hop)) >= 40);
  assert.equal(result.deadline, undefined); assert.equal(saved.jobs.some(job => /budget|limit|deadline/i.test(job.detail ?? '')), false);
  assert.equal(f.service.isContinuousTurn('unbound'), false);
});

test('continuous authority is turn-bound and Stop invalidates it before cleanup, without admitting late work', async t => {
  const f = journal(t), team = f.team(), run = f.service.message(team.id, { message: 'Hi everyone', requestId: 'stop-opening' }).run;
  f.service.tick(); const root = f.snapshot().jobs.find(job => job.runId === run.id), context = f.context(root); f.service.begin(context);
  assert.equal(f.service.isContinuousTurn(context.turnId), true);
  let release, entered = false, resolved = false; const held = new Promise(resolve => { release = resolve; }); f.cleanup.stop = async () => { entered = true; await held; };
  const other = f.team({ name: 'Unrelated request', memberIds: ['bot_2', 'bot_3'], coordinatorId: 'bot_2' }), unrelated = f.service.start(other.id, { message: 'Independent' }).run; f.service.tick();
  const stopping = f.service.stop(team.id, run.id).then(value => { resolved = true; return value; }); assert.equal(f.service.isContinuousTurn(context.turnId), false);
  await until(() => entered); assert.equal(resolved, false); assert.equal(f.service.detail(other.id, unrelated.id).run.state, 'running');
  f.service.end(context, { publicReply: 'Late reply must not wake peers' }); release(); await stopping; f.service.tick();
  assert.equal(f.snapshot().jobs.filter(job => job.runId === run.id).length, 1); assert.equal(f.sent.length, 2);
  assert.equal(f.service.detail(team.id, run.id).run.state, 'cancelled');
  assert.equal(f.service.channel(team.id).messages.some(row => row.content.includes('Late reply')), false);
});

for (const message of ['Hi everyone', 'hello team!', '@everyone please answer', '@all hello', 'hey guys']) test('server guarantees the opening round even if the router omits invitations: ' + message, async t => {
  const f = fixture(t, async input => { assert.equal(input.bot.teamConversationOnly, true); assert.equal(input.tools.some(tool => tool.name === 'write_file'), false); if (!input.message.startsWith('[The public conversation invitations')) say(input, `Answer ${input.bot.id}`); });
  const run = f.send(message).run; await f.done(run);
  const replies = f.bots.team.channel(f.team.id).messages.filter(row => row.content.startsWith('Answer '));
  assert.equal(replies.length, 4); assert.equal(new Set(replies.map(row => row.author.botId)).size, 4); assert.equal(f.seen.length, 5); assert.equal(f.effects.length, 0);
});

for (const message of ['Build the feature', 'What is the status?', 'The handoff says @everyone should respond', '> @everyone hello', '"@everyone hello"', '```text\n@everyone hello\n```', 'Please inspect this code: @all', 'Hi, can you check the status?']) test('quoted mentions and ordinary requests do not automatically wake the team: ' + message, async t => {
  const f = fixture(t, async input => say(input, 'One routing reply'));
  const run = f.send(message).run; await f.done(run); assert.equal(f.seen.length, 1);
  assert.equal(f.bots.team.detail(f.team.id, run.id).run.expectedParticipation, undefined);
});

test('explicit recipients get one initial reply per available member despite omitted subset and duplicate router calls', async t => {
  let f;
  f = fixture(t, async input => {
    if (input.bot.id === f.members[0].id && input.message === 'Address these members') {
      const first = JSON.parse((await input.executeTool('invite_teammates', { botIds: [f.members[1].id], message: 'First addressed question' }, 'first')).content[0].text);
      const posted = JSON.parse((await input.executeTool('post_team_message', { message: 'Another visible reference' }, 'post')).content[0].text);
      const repeated = JSON.parse((await input.executeTool('invite_teammates', { botIds: [f.members[1].id], message: 'Reworded duplicate', replyToId: posted.messageId }, 'second')).content[0].text);
      assert.deepEqual(repeated.deliveryIds, first.deliveryIds);
    }
    if (!input.message.startsWith('[The public conversation invitations')) say(input, `Reply ${input.bot.id}`);
  }, 5);
  await f.bots.pause(f.members[3].id, { paused: true });
  const run = f.send('Address these members', { recipientIds: f.members.slice(0, 4).map(bot => bot.id) }).run; await f.done(run);
  const ids = f.seen.filter(input => input.bot.id !== f.members[0].id).map(input => input.bot.id);
  assert.deepEqual(ids.sort(), [f.members[1].id, f.members[2].id].sort());
  const user = f.bots.team.channel(f.team.id).messages.find(row => row.author.type === 'user'); assert.ok(user.recipientIds.includes(f.members[3].id));
});

test('coordinator-only recipient does not fan out and new roster members are never backfilled into an old opening', async t => {
  let f, release, entered = false;
  f = fixture(t, async input => { if (input.message === 'Hello team') { entered = true; await new Promise(resolve => { release = resolve; }); } say(input, 'Reply'); });
  const first = f.send('Only you', { recipientIds: [f.members[0].id] }).run; await f.done(first); assert.equal(f.seen.length, 1);
  const run = f.send('Hello team', { requestId: 'frozen-roster' }).run; await until(() => entered);
  const outsider = f.bots.create({ name: 'Late outsider', provider: 'codex', workspace: f.directory, policy: 'bypass' }).bot;
  assert.throws(() => f.bots.team.update(f.team.id, { memberIds: [...f.team.memberIds, outsider.id] }), /Stop this team/);
  release(); await f.done(run); assert.equal(f.seen.some(input => input.bot.id === outsider.id), false);
});

test('a concrete task assigned to an explicit recipient satisfies participation without an extra conversational wake', async t => {
  let f;
  f = fixture(t, async input => {
    if (input.message === 'Check the requested file') await input.executeTool('assign_team_task', { botId: f.members[1].id, message: 'Inspect the authorized workspace file' }, 'real-task');
    else if (input.message.startsWith('[Assignment')) { assert.equal(input.bot.teamConversationOnly, undefined); say(input, 'File checked: useful result.'); }
  });
  const run = f.send('Check the requested file', { recipientIds: [f.members[1].id] }).run; await f.done(run);
  const workerTurns = f.seen.filter(input => input.bot.id === f.members[1].id); assert.equal(workerTurns.length, 1); assert.equal(workerTurns[0].bot.teamContext.channelMode, 'task');
});

for (const message of ['Who wants this task?', 'Any volunteers for this task?']) test('volunteer request reconciles omitted bids, waits for all, and opens only one decision: ' + message, async t => {
  let f, release, summaries = 0;
  f = fixture(t, async input => {
    if (input.message.startsWith('[The invited teammates')) { summaries++; return; }
    if (input.bot.teamContext?.channelMode === 'bid') {
      assert.equal(input.tools.some(tool => ['write_file', 'assign_team_task', 'invite_teammates'].includes(tool.name)), false);
      if (input.bot.id === f.members[2].id) await new Promise(resolve => { release = resolve; }); say(input, `${input.bot.name} offers`);
    }
  });
  const run = f.send(message).run; await until(() => release); assert.equal(summaries, 0); release(); await f.done(run);
  assert.equal(summaries, 1); assert.equal(f.seen.filter(input => input.bot.teamContext?.channelMode === 'bid').length, 3); assert.equal(f.effects.length, 0);
});

test('channel result arrivals retain every public report but resume the coordinator once after all siblings', async t => {
  let f, release, summaries = 0;
  f = fixture(t, async input => {
    if (input.message === 'Do the work') for (const bot of f.members.slice(1)) await input.executeTool('assign_team_task', { botId: bot.id, message: `Concrete ${bot.name}` }, bot.id);
    else if (input.message.startsWith('[Assignment')) {
      if (input.bot.id === f.members[3].id) await new Promise(resolve => { release = resolve; }); say(input, `Result ${input.bot.name}`);
    } else if (input.message.startsWith('[Strata teammate result')) {
      summaries++; const references = input.message.split('\n').slice(1).map(line => JSON.parse(line)); assert.equal(references.length, 3);
      for (const reference of references) { assert.ok(reference.reportId); assert.ok(reference.chatId); assert.ok(reference.jobId); assert.equal(reference.state, 'completed'); }
      say(input, 'Three results reviewed.');
    }
  });
  const run = f.send('Do the work').run; await until(() => release && f.bots.team.channel(f.team.id).messages.filter(row => row.kind === 'report').length === 2);
  assert.equal(summaries, 0); release(); await f.done(run); assert.equal(summaries, 1);
  assert.equal(f.bots.team.channel(f.team.id).messages.filter(row => row.kind === 'report').length, 3);
});

test('outer coordinator waits for delegated descendants and receives the worker’s latest synthesis rather than its earlier intention', async t => {
  let f, release, outer = 0, worker = 0;
  f = fixture(t, async input => {
    if (input.message === 'Perform nested requested work') await input.executeTool('assign_team_task', { botId: f.members[1].id, message: 'Own this work and delegate its independent check' }, 'owner');
    else if (input.message.startsWith('[Assignment') && input.bot.id === f.members[1].id) { await input.executeTool('spawn_subagent', { botId: f.members[2].id, message: 'Run the independent requested check' }, 'child'); say(input, 'I assigned the check; it has not finished.'); }
    else if (input.message.startsWith('[Assignment')) { await new Promise(resolve => { release = resolve; }); say(input, 'Independent check result.'); }
    else if (input.message.startsWith('[Strata teammate result') && input.bot.id === f.members[1].id) { worker++; say(input, 'Final worker synthesis with the check result.'); }
    else if (input.message.startsWith('[Strata teammate result')) {
      outer++; const reference = JSON.parse(input.message.split('\n')[1]); assert.match(reference.preview, /Final worker synthesis/); assert.ok(reference.resultJobId); assert.ok(reference.initialReportId); say(input, 'Outer synthesis.');
    }
  });
  const run = f.send('Perform nested requested work').run; await until(() => release); assert.equal(outer, 0); assert.equal(worker, 0);
  release(); await f.done(run); assert.equal(worker, 1); assert.equal(outer, 1);
});

test('batch references span bounded pages without losing later members or reclassifying provider replies as verified success', async t => {
  const f = journal(t, 65), team = f.team(), run = f.service.message(team.id, { message: 'Do requested work', requestId: 'batch-pages' }).run;
  f.service.tick(); const root = f.snapshot().jobs.find(job => job.type === 'run'), context = f.context(root); f.service.begin(context);
  for (const id of [...f.bots.keys()].slice(1)) await f.service.execute('assign_team_task', { botId: id, message: `Actual work ${id}` }, { ...context, toolCallId: id });
  f.service.end(context); f.service.tick();
  for (const job of f.snapshot().jobs.filter(row => row.state === 'running')) { const current = f.context(job); f.service.begin(current); f.service.end(current, { publicReply: `${'Substantive result '.repeat(510)}TAIL_${job.botId}` }); }
  const batches = f.snapshot().jobs.filter(job => job.resultBatch); assert.equal(batches.length, 1);
  const batch = batches[0]; assert.ok(batch.message.length < 16000); assert.match(batch.message, /not independently verified task success/);
  assert.equal(batch.resultReferences.length, 64); assert.ok(batch.resultReferences.join('\n').length > 14000);
  const references = batch.resultReferences.map(line => JSON.parse(line));
  assert.equal(references.length, 64); assert.equal(new Set(references.map(row => row.botId)).size, 64);
  const reports = f.service.channel(team.id).messages.filter(row => row.kind === 'report'); assert.equal(reports.length, 64);
  for (const reference of references) assert.ok(reports.some(report => report.id === reference.reportId && report.author.botId === reference.botId));
  f.service.tick(); const active = f.snapshot().jobs.find(job => job.resultBatch && job.state === 'running'), reader = f.context(active); f.service.begin(reader);
  const paged = []; let offset = 0;
  do { const page = await f.service.execute('read_team_results', { offset }, reader); paged.push(...page.results); offset = page.nextOffset; assert.equal(page.total, 64); } while (offset !== null);
  assert.deepEqual(paged, references);
  for (const args of [{ offset: -1 }, { offset: 0.5 }, { offset: 65 }, { offset: Number.MAX_SAFE_INTEGER }, { runId: 'other' }, { teamId: team.id }]) await assert.rejects(f.service.execute('read_team_results', args, reader), { status: 400 });
  for (const reference of references) {
    const first = await f.service.execute('read_team_message', { messageId: reference.reportId }, reader); assert.equal(first.message.content.length, 8000); assert.equal(first.nextOffset, 8000);
    const last = await f.service.execute('read_team_message', { messageId: reference.reportId, offset: first.nextOffset }, reader); assert.match(last.message.content, new RegExp(`TAIL_${reference.botId}$`)); assert.equal(last.nextOffset, null);
  }
  f.service.end(reader, { publicReply: 'All reports read and synthesized.' }); f.service.tick();
  assert.equal(f.snapshot().jobs.filter(job => job.resultBatch).length, 1); assert.equal(f.service.detail(team.id, run.id).run.state, 'completed');
  await assert.rejects(f.service.execute('read_team_results', {}, reader), /active team channel turn/);
});

test('public message reads are scoped to the bound active team, paged, and never a private conversation reader', async t => {
  const f = journal(t), team = f.team(), other = f.team({ name: 'Other team' });
  const first = f.service.message(team.id, { message: 'Public request', requestId: 'public-read' }).run;
  const hidden = f.service.message(other.id, { message: 'Other team private marker', requestId: 'other' }).run;
  f.chats.get(first.rootChatId).messages.push({ role: 'assistant', content: 'PRIVATE_HISTORY_MARKER' });
  f.service.tick(); const root = f.snapshot().jobs.find(job => job.runId === first.id), context = f.context(root); f.service.begin(context);
  const message = f.service.channel(team.id).messages[0];
  const read = await f.service.execute('read_team_message', { messageId: message.id }, context); assert.equal(read.message.content, 'Public request'); assert.equal(JSON.stringify(read).includes('PRIVATE_HISTORY_MARKER'), false);
  await assert.rejects(f.service.execute('read_team_results', {}, context), { status: 409 });
  await assert.rejects(f.service.execute('read_team_message', { messageId: hidden.channelMessageId }, context), { status: 404 });
  await assert.rejects(f.service.execute('read_team_message', { messageId: first.rootChatId }, context), { status: 404 });
  for (const args of [{ messageId: message.id, teamId: other.id }, { messageId: message.id, offset: -1 }, { messageId: message.id, offset: 0.5 }, { messageId: message.id, offset: Number.MAX_SAFE_INTEGER }]) await assert.rejects(f.service.execute('read_team_message', args, context), { status: 400 });
  f.service.end(context); await assert.rejects(f.service.execute('read_team_message', { messageId: message.id }, context), /active team channel turn/);
});

test('an exact failed task is not requeued in fresh chats in the same run; changed work and a new human request remain possible', async t => {
  let f, attempts = 0, blocked = 0;
  f = fixture(t, async input => {
    if (input.message === 'Run this check' || input.message === 'Explicitly retry') await input.executeTool('assign_team_task', { botId: f.members[1].id, message: 'Exact requested check' }, 'initial');
    else if (input.message.startsWith('[Assignment') && input.message.includes('Exact requested check')) { attempts++; throw Error('Unclassified provider failure PRIVATE_SECRET'); }
    else if (input.message.startsWith('[Strata teammate result') && input.message.includes('task_error')) {
      blocked++; await assert.rejects(input.executeTool('assign_team_task', { botId: f.members[1].id, message: 'Exact requested check' }, 'fresh-tool-id'), /already failed/);
      await input.executeTool('assign_team_task', { botId: f.members[1].id, message: 'Different authorized check after resolving the blocker' }, 'different');
    }
  }, 2);
  const first = f.send('Run this check').run; await f.done(first); assert.equal(attempts, 1); assert.equal(blocked, 1);
  const next = f.send('Explicitly retry', { requestId: 'new-owner-request' }).run; await f.done(next); assert.equal(attempts, 2); assert.equal(blocked, 2);
  assert.equal(JSON.stringify(f.bots.team.channel(f.team.id)).includes('PRIVATE_SECRET'), false);
});

for (const diagnostic of ['Devin could not confirm a single native model.', 'Devin selected a different model. Refresh the native model catalog and reselect the desired model before retrying.']) test('Devin model mismatch has safe actionable public guidance and no automatic retry: ' + diagnostic, async t => {
  let f;
  f = fixture(t, async input => {
    if (input.message === 'Check model') await input.executeTool('assign_team_task', { botId: f.members[1].id, message: 'Requested check' }, 'check');
    else if (input.bot.id === f.members[1].id) throw Error(`${diagnostic} SECRET_NATIVE_MODEL_BODY`);
    else {
      assert.match(input.message, /Model settings need attention/); assert.match(input.message, /Refresh its model catalog/); assert.equal(input.message.includes('SECRET_NATIVE_MODEL_BODY'), false);
      assert.match(input.bot.instructions, /never assign a fresh bot to inspect an inaccessible previous conversation/);
      await assert.rejects(input.executeTool('assign_team_task', { botId: f.members[1].id, message: 'Try another diagnostic' }, 'retry'), /new explicit team request/);
    }
  }, 2);
  const run = f.send('Check model').run; await f.done(run); assert.equal(f.seen.filter(input => input.bot.id === f.members[1].id).length, 1);
  assert.equal(JSON.stringify(f.bots.team.channel(f.team.id)).includes('SECRET_NATIVE_MODEL_BODY'), false);
});
