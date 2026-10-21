import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotTeams } from '../server/bots-team.mjs';
import { createTeamChannels } from '../server/bots-team-channel.mjs';

async function until(predicate, timeout = 4000) { const at = Date.now(); while (!predicate()) { if (Date.now() - at > timeout) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
function fixture(t, execute, extras = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-channel-')); let chats;
  const effects = [], seen = [];
  const runtime = { providers: async () => [], async run(input) { seen.push(input); await execute(input); input.onFrame({ type: 'done' }); }, close() {} };
  const bots = createBots({ directory, runtime, tools: { definitions: () => [{ name: 'write_file', description: 'Write', inputSchema: { type: 'object' } }], execute: async input => { effects.push(input); return { content: [{ type: 'text', text: 'Written' }] }; }, finish: async () => {} }, defaultWorkspace: () => directory, conversations: () => chats, ...extras });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: selection => bots.validateSelection(selection), execute: input => bots.run(input) });
  const create = (name, patch = {}) => bots.create({ name, provider: 'codex', workspace: directory, policy: 'bypass', ...patch }).bot;
  const a = create('Coordinator'), b = create('Builder', { avatarConfig: { kind: 'koala', shape: 'orb', color: 'sky', eyes: 'round', ears: 'round' } }), c = create('Reviewer');
  const team = bots.team.create({ name: 'Engineering', memberIds: [a.id, b.id, c.id], coordinatorId: a.id, enabled: true }).team;
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, bots, chats, a, b, c, team, effects, seen, send: (message, extra = {}) => bots.team.message(team.id, { message, requestId: `request-${seen.length}-${message.length}`, ...extra }), done: run => until(() => !['queued', 'running'].includes(bots.team.detail(team.id, run.id).run.state)) };
}
const say = (input, text) => input.onFrame({ type: 'delta', text });

test('channel catalog and cursor reads start no models and create no channel journal', async t => {
  const f = fixture(t, async () => { throw new Error('Read must not run'); });
  assert.equal(f.bots.team.list().channelsSupported, true);
  assert.deepEqual(f.bots.team.channel(f.team.id), { teamId: f.team.id, supported: true, messages: [], activeRuns: [], nextSequence: 0, hasMore: false, hasMoreBefore: false });
  assert.equal(existsSync(join(f.directory, 'bot-team-channels.json')), false);
  assert.equal(f.seen.length, 0);
});

test('coordinator routes a group greeting semantically, each member replies once with exact identity and no execution tools', async t => {
  let f;
  f = fixture(t, async input => {
    assert.equal(input.bot.teamConversationOnly, true);
    assert.equal(input.tools.some(tool => tool.name === 'write_file'), false);
    assert.equal(await input.requestPermission({ id: 'native', name: 'shell', args: {} }), false);
    await assert.rejects(async () => input.executeTool('write_file', {}, 'forbidden'), /cannot execute/);
    if (input.bot.id === f.a.id) {
      assert.match(input.bot.instructions, /Public roster/); assert.match(input.bot.instructions, /Builder/); assert.match(input.bot.instructions, /Reviewer/);
      await input.executeTool('invite_teammates', { botIds: [f.b.id, f.c.id], message: 'Everyone, please say hello once.' }, 'greeting');
      const duplicateWake = await input.executeTool('invite_teammates', { botIds: [f.b.id, f.c.id], message: 'Another wording of the same greeting' }, 'second-greeting');
      assert.match(duplicateWake.content[0].text, /not woken twice/);
    }
    say(input, `Hi from ${input.bot.name}`);
  });
  const first = f.send('Hi everyone', { requestId: 'same-greeting' });
  const retry = f.send('Hi everyone', { requestId: 'same-greeting' }); assert.equal(first.run.id, retry.run.id);
  await f.done(first.run);
  const snapshot = f.bots.team.channel(f.team.id), replies = snapshot.messages.filter(row => row.content.startsWith('Hi from'));
  assert.equal(f.seen.length, 3); assert.equal(replies.length, 3); assert.equal(new Set(replies.map(row => row.author.botId)).size, 3);
  assert.equal(replies.find(row => row.author.botId === f.b.id).author.avatarConfig.shape, 'orb');
  assert.deepEqual(snapshot.messages.map(row => row.sequence), snapshot.messages.map((_, index) => index + 1));
  assert.equal(snapshot.messages.filter(row => row.author.type === 'user').length, 1); assert.equal(snapshot.activeRuns.length, 0); assert.equal(f.effects.length, 0);
  assert.equal(statSync(join(f.directory, 'bot-team-channels.json')).mode & 0o777, 0o600);
  assert.throws(() => f.send('Different', { requestId: 'same-greeting' }), /another team message/);
  // Completed routing chats cannot silently become ordinary unrestricted bot chats.
  f.chats.send(first.run.rootChatId, 'Write a file'); await until(() => !f.chats.detail(first.run.rootChatId).conversation.active);
  assert.equal(f.seen.length, 3); assert.equal(f.effects.length, 0);
});

test('Everyone addressing includes paused members as context but invites only available bots; a paused coordinator cannot route new work', async t => {
  let f;
  f = fixture(t, async input => {
    if (input.bot.id === f.a.id) {
      assert.match(input.bot.instructions, new RegExp(f.c.id));
      await input.executeTool('invite_teammates', { botIds: [f.b.id, f.c.id], message: 'Please greet everyone once.' }, 'available-greeting');
    }
    say(input, `Hello from ${input.bot.name}`);
  });
  await f.bots.pause(f.c.id, { paused: true });
  const draft = { requestId: 'everyone-paused', recipientIds: f.team.memberIds };
  const started = f.send('Hi everyone', draft); await f.done(started.run);
  assert.deepEqual(f.seen.map(input => input.bot.id).sort(), [f.a.id, f.b.id].sort());
  const channel = f.bots.team.channel(f.team.id), user = channel.messages.find(row => row.author.type === 'user');
  assert.deepEqual(user.recipientIds, [...f.team.memberIds].sort());
  assert.equal(channel.messages.some(row => row.author.botId === f.c.id), false);
  await f.bots.pause(f.a.id, { paused: true });
  assert.equal(f.send('Hi everyone', draft).run.id, started.run.id);
  assert.throws(() => f.send('Another addressed message', { requestId: 'coordinator-paused', recipientIds: [f.b.id] }), /Resume the coordinator/);
  assert.equal(f.seen.length, 2); assert.equal(f.bots.team.channel(f.team.id).messages.length, channel.messages.length);
});

test('provider failure details stay out of the public room and all subsequent coordinator context', async t => {
  let f;
  const marker = 'PRIVATE_PROVIDER_FAILURE_KEY_AND_PATH_9f8ea0';
  f = fixture(t, async input => {
    if (input.message === 'Assign failing work') {
      await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Do the requested task' }, 'failing-task'); say(input, 'Assigned the task.');
    } else if (input.bot.id === f.b.id) throw new Error(`${marker} /Users/private/provider/config`);
    else {
      assert.equal(input.message.includes(marker), false);
      assert.equal(input.bot.instructions.includes(marker), false);
      assert.equal(JSON.stringify(input.history).includes(marker), false);
      const status = await input.executeTool('list_subagents', {}, 'public-status');
      assert.equal(JSON.stringify(status).includes(marker), false);
      assert.equal(JSON.stringify(status).includes('/Users/private/provider/config'), false);
      say(input, 'The task needs attention. Review its linked conversation.');
    }
  });
  const started = f.send('Assign failing work'); await f.done(started.run);
  const publicJournal = readFileSync(join(f.directory, 'bot-team-channels.json'), 'utf8');
  assert.equal(publicJournal.includes(marker), false); assert.equal(publicJournal.includes('/Users/private/provider/config'), false);
  assert.ok(f.bots.team.channel(f.team.id).messages.some(row => row.state === 'error' && row.content.includes('could not finish')));
  assert.equal(f.seen.filter(input => input.message.startsWith('[Strata teammate result')).length, 1);
});

test('explicit recipients still reach semantic coordinator so addressed tasks can execute only as assigned work', async t => {
  let f, task = false;
  f = fixture(t, async input => {
    if (input.bot.teamConversationOnly) {
      if (input.message === '@everyone build and review') {
        assert.match(input.bot.instructions, /explicitly addressed/);
        await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Build feature' }, 'build');
        await input.executeTool('assign_team_task', { botId: f.a.id, message: 'Review feature yourself' }, 'self');
      }
      say(input, 'Coordinated the public request.');
    } else {
      task = true; assert.equal(input.tools.some(tool => tool.name === 'write_file'), true);
      await input.executeTool('write_file', { path: 'owned' }, 'write'); say(input, `${input.bot.name} finished assigned work`);
    }
  });
  const started = f.send('@everyone build and review', { recipientIds: [f.b.id, f.a.id] }); await f.done(started.run);
  const rows = f.bots.team.channel(f.team.id).messages;
  assert.equal(task, true); assert.equal(f.effects.length, 2);
  assert.equal(rows.filter(row => row.kind === 'assignment').length, 2); assert.equal(rows.filter(row => row.kind === 'report').length, 2);
  assert.ok(rows.some(row => row.kind === 'report' && row.author.botId === f.a.id));
  assert.equal(f.seen.filter(input => !input.bot.teamConversationOnly && input.bot.id === f.a.id).length, 1);
});

test('bids are public conversation only, coordinator chooses after all offers and receives task report once', async t => {
  let f, releaseReviewer, summaries = 0;
  f = fixture(t, async input => {
    if (input.message === 'Who wants this task?') {
      await input.executeTool('invite_teammates', { botIds: [f.b.id, f.c.id], message: 'Who can take the implementation?', purpose: 'bid' }, 'bids'); say(input, 'Please offer what you can own.');
    } else if (input.bot.teamContext?.channelMode === 'bid') {
      assert.equal(input.tools.some(tool => ['write_file', 'assign_team_task', 'invite_teammates'].includes(tool.name)), false);
      if (input.bot.id === f.c.id) await new Promise(resolve => { releaseReviewer = resolve; });
      say(input, `${input.bot.name} offers to help`);
    } else if (input.message.startsWith('[The invited teammates')) {
      summaries++; assert.match(input.bot.instructions, /Builder offers/); assert.match(input.bot.instructions, /Reviewer offers/);
      await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Implement the requested feature' }, 'chosen-owner'); say(input, 'Builder owns implementation; Reviewer can review later.');
    } else if (!input.bot.teamConversationOnly) say(input, 'Implementation complete.');
    else say(input, 'The assigned result is complete.');
  });
  const started = f.send('Who wants this task?'); await until(() => releaseReviewer);
  assert.equal(summaries, 0); assert.equal(f.bots.team.channel(f.team.id).messages.some(row => row.kind === 'assignment'), false);
  releaseReviewer(); await f.done(started.run);
  const rows = f.bots.team.channel(f.team.id).messages;
  assert.equal(summaries, 1); assert.equal(rows.filter(row => row.content.includes('offers to help')).length, 2);
  assert.equal(rows.filter(row => row.kind === 'assignment').length, 1); assert.equal(rows.filter(row => row.kind === 'report').length, 1);
  assert.equal(f.seen.filter(input => input.message.startsWith('[Strata teammate result')).length, 1);
});

test('peers ask and answer visibly without waking everyone or receiving task authority', async t => {
  let f;
  f = fixture(t, async input => {
    if (input.message === 'Discuss the approach') {
      await input.executeTool('invite_teammates', { botIds: [f.b.id], message: 'Builder, what approach would you use?' }, 'builder'); say(input, 'Let us discuss the approach.');
    } else if (input.bot.id === f.b.id) {
      const result = await input.executeTool('invite_teammates', { botIds: [f.c.id], message: 'Reviewer, which edge case matters?' }, 'question');
      const repeated = await input.executeTool('invite_teammates', { botIds: [f.c.id], message: 'Reviewer, which edge case matters?' }, 'question'); assert.deepEqual(result, repeated);
      await assert.rejects(async () => input.executeTool('assign_team_task', { botId: f.c.id, message: 'Do work' }, 'cannot-assign'), /cannot execute/);
      say(input, 'I would split the implementation from review.');
    } else { say(input, 'Reviewer: include reconnect handling.'); }
  });
  const started = f.send('Discuss the approach'); await f.done(started.run);
  const rows = f.bots.team.channel(f.team.id).messages;
  assert.equal(f.seen.length, 3); assert.equal(rows.filter(row => row.kind === 'assignment').length, 0);
  const question = rows.find(row => row.content === 'Reviewer, which edge case matters?'), answer = rows.find(row => row.content === 'Reviewer: include reconnect handling.');
  assert.equal(question.author.botId, f.b.id); assert.equal(answer.author.botId, f.c.id); assert.equal(answer.replyToId, question.id);
  assert.equal(f.effects.length, 0);
});

test('manual routing approval gates task creation while each assigned bot retains its own policy', async t => {
  let f, taskStarted = false;
  f = fixture(t, async input => {
    if (input.bot.teamConversationOnly && input.message === 'Make a change') {
      await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Make requested change' }, 'dispatch'); say(input, 'Assigned.');
    } else if (!input.bot.teamConversationOnly) { taskStarted = true; assert.equal(input.bot.policy, 'plan'); say(input, 'I can only plan the change.'); }
    else say(input, 'Plan received.');
  });
  f.bots.update(f.a.id, { policy: 'manual' }); f.bots.update(f.b.id, { policy: 'plan' });
  const started = f.send('Make a change'); await until(() => f.bots.pending(started.run.rootChatId).length === 1);
  assert.equal(taskStarted, false); assert.equal(f.bots.team.channel(f.team.id).messages.some(row => row.kind === 'assignment'), false);
  await f.bots.approve({ chatId: started.run.rootChatId, callId: 'dispatch', decision: 'approve' }); await f.done(started.run);
  assert.equal(taskStarted, true); assert.equal(f.effects.length, 0);
});

test('a human can continue completed assigned work with its frozen profile without reopening or leaking to the old room', async t => {
  let f, continued;
  f = fixture(t, async input => {
    if (input.message === 'Assign work') { await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Implement feature' }, 'task'); say(input, 'Assigned Builder.'); }
    else if (input.message === 'Private follow-up') { continued = input; say(input, 'Private continuation result'); }
    else say(input, 'Finished.');
  });
  f.bots.update(f.b.id, { model: 'task-model-v1' });
  const started = f.send('Assign work'); await f.done(started.run);
  const before = f.bots.team.channel(f.team.id), task = before.messages.find(row => row.kind === 'assignment');
  f.bots.update(f.b.id, { model: 'task-model-v2', policy: 'plan' });
  f.chats.send(task.chatId, 'Private follow-up'); await until(() => continued && !f.chats.detail(task.chatId).conversation.active);
  assert.equal(continued.bot.model, 'task-model-v1'); assert.equal(continued.bot.policy, 'bypass'); assert.equal(continued.bot.teamConversationOnly, undefined);
  assert.deepEqual(f.bots.team.channel(f.team.id).messages, before.messages); assert.equal(f.bots.team.detail(f.team.id, started.run.id).run.state, 'completed');
  assert.equal(continued.tools.some(tool => tool.name === 'assign_team_task'), false);
});

test('public history contains no private teammate instructions and invitation context is bounded', async t => {
  let f;
  f = fixture(t, async input => {
    if (input.bot.id === f.a.id) { assert.equal(input.bot.instructions.includes('BUILDER_PRIVATE_SECRET'), false); await input.executeTool('invite_teammates', { botIds: [f.c.id], message: 'Please answer publicly.' }, 'ask'); }
    else { assert.equal(input.bot.instructions.includes('BUILDER_PRIVATE_SECRET'), false); assert.match(input.bot.instructions, /Shared public channel context only/); }
    say(input, 'Public answer');
  });
  f.bots.update(f.b.id, { instructions: 'BUILDER_PRIVATE_SECRET' });
  const started = f.send('Discuss publicly'); await f.done(started.run);
  assert.equal(readFileSync(join(f.directory, 'bot-team-channels.json'), 'utf8').includes('BUILDER_PRIVATE_SECRET'), false);
});

test('conversation-only prompts exclude own private instructions, memory, extension snapshots and provider checkpoints', async t => {
  let f;
  const extension = { snapshot: () => ({ instructions: 'PRIVATE_EXTENSION_MARKER' }), tools: () => { throw new Error('A conversation must not load extension tools'); }, owns: () => false, finish: async () => {} };
  f = fixture(t, async input => {
    assert.equal(JSON.stringify(input.bot).includes('PRIVATE_EXTENSION_MARKER'), false);
    assert.equal(input.bot.instructions.includes('PRIVATE_PROFILE_MARKER'), false);
    assert.equal(input.bot.instructions.includes('PRIVATE_MEMORY_MARKER'), false);
    assert.equal(JSON.stringify(input.history).includes('PRIVATE_HISTORY_MARKER'), false);
    assert.equal(input.checkpoint, null); await input.onCheckpoint({ nativeSessionId: 'private-provider-checkpoint' });
    say(input, 'Only public context.');
  }, { skills: extension, mcp: extension });
  f.bots.update(f.a.id, { instructions: 'PRIVATE_PROFILE_MARKER' });
  f.bots.work.update(f.a.id, { memory: 'PRIVATE_MEMORY_MARKER' });
  const privateChat = f.bots.createConversation(f.a.id).conversation;
  f.chats.sync([{ session: { ...privateChat, messages: [{ id: 'm_private', role: 'user', content: 'PRIVATE_HISTORY_MARKER' }] }, baseRevision: privateChat.revision }]);
  const started = f.send('Public greeting'); await f.done(started.run);
  assert.equal(readFileSync(join(f.directory, 'bots.json'), 'utf8').includes('private-provider-checkpoint'), false);
});

test('failed atomic channel receipt write rolls back new message, run and empty chat; safe retry starts once', async t => {
  const f = fixture(t, async input => say(input, 'Answered once'));
  const target = join(f.directory, 'unrelated.json'), path = join(f.directory, 'bot-team-channels.json'); writeFileSync(target, 'UNTOUCHED'); symlinkSync(target, path);
  const beforeChats = f.chats.list().conversations.length, beforeRuns = f.bots.team.list().runs.length;
  assert.throws(() => f.send('Retry safely', { requestId: 'failed-write' }), /not a regular file/);
  assert.equal(f.chats.list().conversations.length, beforeChats); assert.equal(f.bots.team.list().runs.length, beforeRuns);
  assert.equal(f.bots.team.channel(f.team.id).messages.length, 0); assert.equal(f.seen.length, 0); assert.equal(readFileSync(target, 'utf8'), 'UNTOUCHED');
  rmSync(path); const result = f.send('Retry safely', { requestId: 'failed-write' }); await f.done(result.run);
  assert.equal(f.send('Retry safely', { requestId: 'failed-write' }).run.id, result.run.id); assert.equal(f.seen.length, 1);
});

test('run journal failure retains one public delivery receipt and error, so restart/retry cannot duplicate work', async t => {
  const f = fixture(t, async input => say(input, 'Must not run'));
  const path = join(f.directory, 'bot-teams.json'), original = readFileSync(path), target = join(f.directory, 'not-a-team-journal'); writeFileSync(target, 'UNTOUCHED'); rmSync(path); symlinkSync(target, path);
  assert.throws(() => f.send('Uncertain delivery', { requestId: 'uncertain' }), /not a regular file/);
  const retry = f.send('Uncertain delivery', { requestId: 'uncertain' }); assert.equal(retry.run, undefined); assert.equal(f.seen.length, 0);
  assert.equal(retry.channel.messages.filter(row => row.author.type === 'user').length, 1); assert.equal(retry.channel.messages.at(-1).state, 'error');
  rmSync(path); writeFileSync(path, original);
  let replayed = 0; const restored = createBotTeams({ directory: f.directory, requireBot: id => ({ id, name: 'Restored' }), conversations: () => ({ send() { replayed++; } }), createConversation() { throw new Error('No replay'); }, stopDirect: async () => {} });
  assert.equal(restored.message(f.team.id, { message: 'Uncertain delivery', requestId: 'uncertain' }).run, undefined); restored.tick(); assert.equal(replayed, 0); await restored.close();
});

test('Stop revokes room turns and late public speech without touching independent bot work', async t => {
  let f, lateTool, independent;
  f = fixture(t, async input => {
    if (input.message === 'Independent') { independent = input.sessionId; await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); return; }
    if (input.bot.id === f.a.id) { await input.executeTool('invite_teammates', { botIds: [f.b.id], message: 'Wait here.' }, 'wait'); say(input, 'Waiting on Builder.'); }
    else { lateTool = input.executeTool; await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); }
  });
  const direct = f.bots.createConversation(f.c.id).conversation.id; f.chats.send(direct, 'Independent'); await until(() => independent);
  const started = f.send('Coordinate'); await until(() => lateTool);
  await f.bots.team.stop(f.team.id, started.run.id);
  await assert.rejects(async () => lateTool('post_team_message', { message: 'Late stale speech' }, 'late'), /ended|stopped|aborted/i);
  assert.equal(f.chats.detail(direct).conversation.active, true);
  const rows = f.bots.team.channel(f.team.id).messages; assert.equal(rows.some(row => row.content === 'Late stale speech'), false); assert.ok(rows.some(row => row.kind === 'status' && row.state === 'interrupted'));
  await f.chats.stop(direct);
});

test('restart preserves channel IDs and retry receipt, marks work interrupted and never replays it', async t => {
  let f;
  f = fixture(t, async input => { await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); });
  const started = f.send('Retain this request', { requestId: 'durable' }); await until(() => f.seen.length);
  const ids = f.bots.team.channel(f.team.id).messages.map(row => row.id); let replayed = 0;
  const restored = createBotTeams({ directory: f.directory, requireBot: id => ({ id, name: 'Restored' }), conversations: () => ({ send() { replayed++; } }), createConversation() { throw new Error('No replay'); }, stopDirect: async () => {} });
  const restoredChannel = restored.channel(f.team.id); assert.deepEqual(restoredChannel.messages.slice(0, ids.length).map(row => row.id), ids);
  assert.equal(restoredChannel.activeRuns.length, 0); assert.equal(restoredChannel.messages.at(-1).state, 'interrupted'); restored.tick();
  assert.equal(restored.message(f.team.id, { message: 'Retain this request', requestId: 'durable' }).run.id, started.run.id); assert.equal(replayed, 0);
  await restored.close();
});

test('journal pagination has stable ascending order and separate forward/backward cursor signals', t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-pages-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journal = createTeamChannels({ directory });
  for (let index = 1; index <= 230; index++) journal.append('team_fixture', { author: { type: 'user', name: 'You' }, content: `Message ${index}` });
  const latest = journal.snapshot('team_fixture'); assert.equal(latest.messages.length, 100); assert.equal(latest.firstSequence, 131); assert.equal(latest.nextSequence, 230); assert.equal(latest.hasMoreBefore, true);
  const old = journal.snapshot('team_fixture', { before: 131 }); assert.equal(old.firstSequence, 31); assert.equal(old.nextSequence, 130); assert.equal(old.hasMoreBefore, true);
  const newer = journal.snapshot('team_fixture', { after: 0 }); assert.equal(newer.firstSequence, 1); assert.equal(newer.nextSequence, 100); assert.equal(newer.hasMore, true); assert.equal(newer.hasMoreBefore, false);
  assert.equal(journal.snapshot('team_fixture', { after: 230 }).nextSequence, 230); assert.equal(journal.snapshot('team_fixture', { after: 230 }).messages.length, 0); assert.equal(journal.snapshot('team_fixture', { after: 230 }).hasMoreBefore, true);
  const reopened = createTeamChannels({ directory }); assert.deepEqual(reopened.snapshot('team_fixture'), latest);
});

test('foreign replies, recipients, unknown settings and invalid cursors fail before any model work', async t => {
  const f = fixture(t, async input => say(input, 'Unused'));
  const bad = [{ recipientIds: ['bot_foreign'] }, { recipientIds: [f.b.id, f.b.id] }, { recipientIds: [] }, { replyToId: 'tm_foreign' }, { policy: 'bypass' }, { requestId: 'a space' }];
  for (const extra of bad) assert.throws(() => f.send('Hello', extra), { status: 400 });
  for (const options of [{ after: -1 }, { after: 1.2 }, { after: '1' }, { after: 1, before: 2 }, { limit: 100 }, { after: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => f.bots.team.channel(f.team.id, options), { status: 400 });
  assert.equal(f.seen.length, 0); assert.equal(f.bots.team.channel(f.team.id).messages.length, 0);
});

test('channel journal rejects symlinks and corrupt order without rewriting the original', t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-invalid-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'bot-team-channels.json'), target = join(directory, 'target.json'); writeFileSync(target, '{"version":1,"channels":[],"receipts":[]}'); symlinkSync(target, file);
  assert.throws(() => createTeamChannels({ directory }), /not a regular file/); assert.equal(readFileSync(target, 'utf8'), '{"version":1,"channels":[],"receipts":[]}');
  rmSync(file); const invalid = JSON.stringify({ version: 1, channels: [{ teamId: 'team_fixture', nextSequence: 1, messages: [{ id: 'tm_one', sequence: 1, teamId: 'team_fixture', kind: 'message', author: { type: 'user', name: 'You' }, content: 'x', createdAt: new Date().toISOString() }] }], receipts: [] }); writeFileSync(file, invalid);
  assert.throws(() => createTeamChannels({ directory }), /saved team message is invalid/); assert.equal(readFileSync(file, 'utf8'), invalid);
});
