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

test('a bot in multiple teams reads only the active team briefing in a shared channel', async t => {
  let f;
  const marker = 'OTHER_TEAM_ONLY_PROJECT_AND_MEMBER_INSTRUCTIONS';
  f = fixture(t, async input => {
    const result = JSON.parse((await input.executeTool('list_teammates', {}, 'scoped-roster')).content[0].text);
    assert.deepEqual(result.teams.map(team => team.id), [f.team.id]);
    assert.equal(JSON.stringify(result).includes(marker), false);
    assert.equal(input.bot.instructions.includes(marker), false);
    say(input, 'I see only this team’s shared instructions.');
  });
  f.bots.team.create({ name: 'Other project', memberIds: [f.a.id, f.b.id], coordinatorId: f.a.id, enabled: true,
    briefing: { instructions: marker, members: [{ botId: f.b.id, role: 'Other project role', instructions: marker }] } });
  const started = f.send('Review this team’s roles');
  await f.done(started.run);
  assert.equal(f.bots.team.detail(f.team.id, started.run.id).run.state, 'completed');
  assert.equal(JSON.stringify(f.bots.team.channel(f.team.id)).includes(marker), false);
});

test('channel catalog and cursor reads start no models and create no channel journal', async t => {
  const f = fixture(t, async () => { throw new Error('Read must not run'); });
  assert.equal(f.bots.team.list().channelsSupported, true);
  assert.deepEqual(f.bots.team.channel(f.team.id), { teamId: f.team.id, supported: true, messages: [], activeRuns: [], presence: [], nextSequence: 0, hasMore: false, hasMoreBefore: false, teamWorkReviewSupported: true, teamWorkflowsSupported: true, teamWorkPlansSupported: true });
  assert.equal(existsSync(join(f.directory, 'bot-team-channels.json')), false);
  assert.equal(f.seen.length, 0);
});

test('coordinator routes a group greeting semantically, each member replies once with exact identity and no execution tools', async t => {
  let f;
  f = fixture(t, async input => {
    if (input.message.startsWith('[The public conversation invitations')) return;
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
  assert.equal(f.seen.length, 4); assert.equal(replies.length, 3); assert.equal(new Set(replies.map(row => row.author.botId)).size, 3);
  assert.equal(replies.find(row => row.author.botId === f.b.id).author.avatarConfig.shape, 'orb');
  assert.deepEqual(snapshot.messages.map(row => row.sequence), snapshot.messages.map((_, index) => index + 1));
  assert.equal(snapshot.messages.filter(row => row.author.type === 'user').length, 1); assert.equal(snapshot.activeRuns.length, 0); assert.equal(f.effects.length, 0);
  assert.equal(statSync(join(f.directory, 'bot-team-channels.json')).mode & 0o777, 0o600);
  assert.throws(() => f.send('Different', { requestId: 'same-greeting' }), /another team message/);
  // The speaker is chosen after the message returns. A finished room chat cannot silently become ordinary unrestricted work.
  const rootChatId = f.bots.team.detail(f.team.id, first.run.id).run.rootChatId;
  f.chats.send(rootChatId, 'Write a file'); await until(() => !f.chats.detail(rootChatId).conversation.active);
  assert.equal(f.seen.length, 4); assert.equal(f.effects.length, 0);
});

test('Everyone addressing includes paused members as context but invites only available bots; a paused coordinator cannot route new work', async t => {
  let f;
  f = fixture(t, async input => {
    if (input.message.startsWith('[The public conversation invitations')) return;
    if (input.bot.id === f.a.id) {
      assert.match(input.bot.instructions, new RegExp(f.c.id));
      await input.executeTool('invite_teammates', { botIds: [f.b.id, f.c.id], message: 'Please greet everyone once.' }, 'available-greeting');
    }
    say(input, `Hello from ${input.bot.name}`);
  });
  await f.bots.pause(f.c.id, { paused: true });
  const draft = { requestId: 'everyone-paused', recipientIds: f.team.memberIds };
  const started = f.send('Hi everyone', draft); await f.done(started.run);
  assert.ok(f.seen.some(input => input.bot.id === f.a.id));
  assert.ok(f.seen.some(input => input.bot.id === f.b.id));
  assert.equal(f.seen.some(input => input.bot.id === f.c.id), false);
  const channel = f.bots.team.channel(f.team.id), user = channel.messages.find(row => row.author.type === 'user');
  assert.deepEqual(user.recipientIds, [...f.team.memberIds].sort());
  assert.equal(channel.messages.some(row => row.author.botId === f.c.id), false);
  await f.bots.pause(f.a.id, { paused: true });
  assert.equal(f.send('Hi everyone', draft).run.id, started.run.id);
  const direct = f.send('Another addressed message', { requestId: 'coordinator-paused', recipientIds: [f.b.id] }); await f.done(direct.run);
  assert.equal(f.seen.at(-1).bot.id, f.b.id); assert.equal(f.seen.at(-1).bot.teamContext.channelMode, 'conversation');
  assert.equal(f.bots.team.detail(f.team.id, direct.run.id).run.rootBotId, f.b.id);
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
  const started = f.send('Assign failing work', { workMode: 'work' }); await f.done(started.run);
  const publicJournal = readFileSync(join(f.directory, 'bot-team-channels.json'), 'utf8');
  assert.equal(publicJournal.includes(marker), false); assert.equal(publicJournal.includes('/Users/private/provider/config'), false);
  assert.ok(f.bots.team.channel(f.team.id).messages.some(row => row.state === 'error' && row.content.includes('could not finish')));
  assert.equal(f.seen.filter(input => input.message.startsWith('[Strata teammate result')).length, 1);
});

test('explicit work recipients run directly and chat recipients do not take a coordinator detour', async t => {
  let f, task = false;
  f = fixture(t, async input => {
    assert.equal(input.bot.teamConversationOnly, undefined);
    task = true; assert.equal(input.tools.some(tool => tool.name === 'write_file'), true);
    await input.executeTool('write_file', { path: 'owned' }, 'write'); say(input, `${input.bot.name} finished assigned work`);
  });
  const started = f.send('Build and review the feature', { workMode: 'work', recipientIds: [f.b.id, f.a.id] }); await f.done(started.run);
  const rows = f.bots.team.channel(f.team.id).messages;
  assert.equal(task, true); assert.equal(f.effects.length, 2); assert.equal(f.seen.length, 2);
  assert.equal(f.seen.every(input => input.bot.teamContext.channelMode === 'task'), true);
  assert.equal(rows.filter(row => row.kind === 'report').length, 2);
  assert.ok(rows.some(row => row.kind === 'report' && row.author.botId === f.a.id));
  assert.equal(f.seen.some(input => input.bot.id === f.c.id), false);
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
    if (input.message.startsWith('[The public conversation invitations')) return;
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
  assert.equal(f.seen.length, 4); assert.equal(rows.filter(row => row.kind === 'assignment').length, 0);
  const question = rows.find(row => row.content === 'Reviewer, which edge case matters?'), answer = rows.find(row => row.content === 'Reviewer: include reconnect handling.');
  assert.equal(question.author.botId, f.b.id); assert.equal(answer.author.botId, f.c.id); assert.equal(answer.replyToId, question.id);
  assert.equal(f.effects.length, 0);
});

test('one coordinator follow-up sees every public invitation branch, then can assign the authorized next step without a wake loop', async t => {
  let f, releaseReviewer, summaries = 0, nestedAnswers = 0;
  f = fixture(t, async input => {
    if (input.message === 'Collect strengths and use them to review this feature') {
      await input.executeTool('invite_teammates', { botIds: [f.b.id, f.c.id], message: 'Which part of reviewing this feature can you own?' }, 'strengths');
      say(input, 'Share your strengths so I can choose the reviewer.');
    } else if (input.message.startsWith('[The public conversation invitations')) {
      summaries++;
      assert.equal(input.bot.id, f.a.id);
      assert.match(input.bot.instructions, /Builder can implement/);
      assert.match(input.bot.instructions, /Reviewer can verify reconnects/);
      assert.match(input.bot.instructions, /The reconnect edge case matters/);
      assert.match(input.message, /end silently/);
      await assert.rejects(input.executeTool('invite_teammates', { botIds: [f.b.id], message: 'Say the same thing again' }, 'no-repeat'), /cannot open another invitation round/);
      await input.executeTool('assign_team_task', { botId: f.c.id, message: 'Review the requested feature for reconnect issues' }, 'chosen-reviewer');
      say(input, 'Reviewer owns the reconnect review; Builder is available for implementation.');
    } else if (!input.bot.teamConversationOnly) {
      await input.executeTool('write_file', { path: 'review.txt' }, 'review');
      say(input, 'Review complete; reconnect handling is covered.');
    } else if (input.message.startsWith('[Strata teammate result')) {
      say(input, 'The requested review is complete.');
    } else if (input.bot.id === f.b.id) {
      await input.executeTool('invite_teammates', { botIds: [f.c.id], message: 'Reviewer, which reconnect edge case matters?' }, 'peer-question');
      say(input, 'Builder can implement fixes.');
    } else if (input.message.includes('which reconnect edge case')) {
      nestedAnswers++;
      say(input, 'The reconnect edge case matters.');
    } else {
      await new Promise(resolve => { releaseReviewer = resolve; });
      say(input, 'Reviewer can verify reconnects.');
    }
  });
  const started = f.send('Collect strengths and use them to review this feature');
  await until(() => releaseReviewer);
  assert.equal(summaries, 0);
  releaseReviewer();
  await f.done(started.run);
  assert.equal(summaries, 1); assert.equal(nestedAnswers, 1); assert.equal(f.effects.length, 1);
  const rows = f.bots.team.channel(f.team.id).messages;
  assert.equal(rows.filter(row => row.kind === 'assignment').length, 1);
  assert.equal(rows.filter(row => row.content === 'The requested review is complete.').length, 1);
  const saved = JSON.parse(readFileSync(join(f.directory, 'bot-teams.json'), 'utf8'));
  assert.equal(saved.runs.find(row => row.id === started.run.id).conversationSummaryQueued, true);
  f.bots.team.tick(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(summaries, 1);
});

test('legacy turn and hop settings cannot cut off the single useful conversation follow-up or cause invitation replay', async t => {
  for (const limits of [{ maxTurns: 3 }, { maxHops: 1 }]) {
    let f, summaries = 0;
    f = fixture(t, async input => {
      if (input.message.startsWith('[The public conversation invitations')) { summaries++; return; }
      if (input.bot.id === f.a.id) await input.executeTool('invite_teammates', { botIds: [f.b.id, f.c.id], message: 'What can you contribute?' }, 'budgeted-invitation');
      say(input, `Public answer from ${input.bot.name}`);
    });
    f.bots.team.update(f.team.id, { limits });
    const started = f.send('Collect strengths'); await f.done(started.run);
    assert.equal(summaries, 0); assert.equal(f.seen.length, 3);
    assert.equal(f.bots.team.channel(f.team.id).activeRuns.length, 0);
    assert.equal(f.bots.team.detail(f.team.id, started.run.id).run.limits.maxTurns, limits.maxTurns ?? 24);
    assert.equal(f.bots.team.detail(f.team.id, started.run.id).run.limits.maxHops, limits.maxHops ?? 8);
  }
});

test('a final invited peer failing before runtime still wakes the coordinator with only a public generic failure', async t => {
  let f, summaries = 0;
  const privateMarker = 'PRIVATE_START_FAILURE_8be42';
  f = fixture(t, async input => {
    if (input.message.startsWith('[The public conversation invitations')) {
      summaries++;
      assert.match(input.bot.instructions, /Builder has implementation experience/);
      assert.match(input.bot.instructions, /could not start its turn/);
      assert.equal(input.bot.instructions.includes(privateMarker), false);
      say(input, 'Builder can help; Reviewer could not join this discussion.');
    } else if (input.bot.id === f.a.id) {
      await input.executeTool('invite_teammates', { botIds: [f.b.id, f.c.id], message: 'Share your strengths.' }, 'start-failure');
      say(input, 'Please share what you can contribute.');
    } else say(input, 'Builder has implementation experience.');
  });
  f.bots.team.update(f.team.id, { limits: { maxParallel: 1 } });
  const send = f.chats.send;
  f.chats.send = (chatId, message) => {
    if (f.chats.detail(chatId).conversation.preferences.botId === f.c.id) throw new Error(privateMarker);
    return send(chatId, message);
  };
  const started = f.send('Collect strengths'); await f.done(started.run);
  assert.equal(summaries, 1);
  assert.equal(f.bots.team.detail(f.team.id, started.run.id).run.state, 'error');
  const publicJournal = JSON.stringify(f.bots.team.channel(f.team.id));
  assert.equal(publicJournal.includes(privateMarker), false);
  assert.equal(f.bots.team.channel(f.team.id).messages.filter(row => row.author.botId === f.c.id && row.state === 'error').length, 1);
});

test('mixed public discussion and bids wait for every branch and produce one coordinator decision', async t => {
  let f, releaseDiscussion, releaseRouter, bidFinished = false, decisions = 0, redundantSummaries = 0;
  f = fixture(t, async input => {
    if (input.message === 'Discuss the approach and offer an owner') {
      await input.executeTool('invite_teammates', { botIds: [f.b.id], message: 'Builder, offer to own the implementation.', purpose: 'bid' }, 'mixed-bid');
      await input.executeTool('invite_teammates', { botIds: [f.c.id], message: 'Reviewer, which edge case should the owner check?' }, 'mixed-discussion');
      await new Promise(resolve => { releaseRouter = resolve; });
      say(input, 'Let us choose an owner after the discussion.');
    } else if (input.message.startsWith('[The invited teammates')) {
      decisions++;
      assert.match(input.bot.instructions, /Builder can own implementation/);
      assert.match(input.bot.instructions, /Reviewer recommends reconnect coverage/);
      say(input, 'Builder is the proposed owner, with reconnect coverage from Reviewer.');
    } else if (input.message.startsWith('[The public conversation invitations')) redundantSummaries++;
    else if (input.bot.teamContext.channelMode === 'bid') { bidFinished = true; say(input, 'Builder can own implementation.'); }
    else { await new Promise(resolve => { releaseDiscussion = resolve; }); say(input, 'Reviewer recommends reconnect coverage.'); }
  });
  f.bots.team.update(f.team.id, { limits: { maxParallel: 3 } });
  const started = f.send('Discuss the approach and offer an owner');
  await until(() => bidFinished && releaseDiscussion && releaseRouter);
  assert.equal(decisions, 0);
  releaseDiscussion(); await until(() => f.bots.team.channel(f.team.id).messages.some(row => row.content === 'Reviewer recommends reconnect coverage.'));
  assert.equal(decisions, 0);
  releaseRouter(); await f.done(started.run);
  assert.equal(decisions, 1); assert.equal(redundantSummaries, 0);
});

test('a coordinator paused after yielding leaves an honest follow-up failure instead of stranding cleanup or replaying peers', async t => {
  let f, releasePeer;
  f = fixture(t, async input => {
    if (input.bot.id === f.a.id) {
      await input.executeTool('invite_teammates', { botIds: [f.b.id], message: 'Offer your approach.' }, 'pause-followup');
      say(input, 'Builder will describe the approach.');
    } else {
      await new Promise(resolve => { releasePeer = resolve; });
      say(input, 'Builder can implement the requested change.');
    }
  });
  const started = f.send('Discuss the implementation');
  await until(() => {
    const rootChatId = f.bots.team.detail(f.team.id, started.run.id).run.rootChatId;
    return !!(releasePeer && rootChatId && !f.chats.detail(rootChatId).conversation.active);
  });
  await f.bots.pause(f.a.id, { paused: true });
  releasePeer(); await f.done(started.run);
  assert.equal(f.bots.team.detail(f.team.id, started.run.id).run.state, 'error');
  assert.equal(f.bots.team.channel(f.team.id).messages.filter(row => row.state === 'error' && row.content.includes('coordinator follow-up could not be queued')).length, 1);
  assert.equal(f.seen.length, 2);
  f.bots.team.tick(); assert.equal(f.seen.length, 2);
});

test('public team briefing persists separately from private profiles and roster edits prune only removed entries', async t => {
  const f = fixture(t, async () => assert.fail('Settings must not start models'));
  assert.equal(f.bots.team.list().teamInstructionsSupported, true);
  const briefing = { instructions: 'Review code and report evidence.', members: [{ botId: f.b.id, role: 'Builder', instructions: 'Implement the assigned changes.' }, { botId: f.c.id, role: 'Reviewer', instructions: 'Verify the result independently.' }] };
  f.bots.team.update(f.team.id, { expectedRevision: 1, briefing });
  f.bots.team.update(f.team.id, { expectedRevision: 2, memberIds: [f.a.id, f.b.id] });
  const team = f.bots.team.list().teams[0];
  assert.deepEqual(team.briefing, { instructions: briefing.instructions, members: [briefing.members[0]] });
  assert.throws(() => f.bots.team.update(f.team.id, { expectedRevision: 3, briefing }), /current team member/);
  assert.equal(f.bots.team.list().teams[0].revision, 3);
  assert.equal((await f.bots.list()).bots.find(row => row.id === f.b.id).instructions, '');
  const restored = createBotTeams({ directory: f.directory, requireBot: id => ({ id }), conversations: () => f.chats, createConversation: () => assert.fail('No work on restart'), stopDirect: async () => {} });
  assert.deepEqual(restored.list().teams[0].briefing, team.briefing); await restored.close();
});

test('active coordinator saves only public role instructions for later turns and cannot edit private profiles or execution', async t => {
  let f, nextInstructions, editResult;
  f = fixture(t, async input => {
    if (input.message === 'Give Builder the review role and review the feature') {
      const roster = JSON.parse((await input.executeTool('list_teammates', {}, 'read-team')).content[0].text).teams[0];
      assert.equal(roster.revision, 1);
      editResult = JSON.parse((await input.executeTool('update_team_instructions', { expectedRevision: roster.revision, briefing: { instructions: 'Work on the requested engineering project.', members: [{ botId: f.b.id, role: 'Verifier', instructions: 'Review evidence before reporting completion.' }] } }, 'set-role')).content[0].text);
      assert.equal(editResult.revision, 2);
      assert.equal(input.bot.instructions.includes('Review evidence before reporting completion.'), false);
      await assert.rejects(input.executeTool('update_team_instructions', { expectedRevision: 2, briefing: {}, policy: 'bypass' }, 'forged-policy'), /current team revision and public briefing/);
      await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Review the requested feature' }, 'review-role');
      say(input, 'Builder is the verifier for this team.');
    } else if (input.bot.id === f.b.id) {
      nextInstructions = input.bot.instructions;
      assert.match(nextInstructions, /Verifier/); assert.match(nextInstructions, /Review evidence before reporting completion/);
      await assert.rejects(async () => input.executeTool('update_team_instructions', { expectedRevision: 2, briefing: {} }, 'peer-edit'), /not assigned|cannot execute/);
      say(input, 'Review complete.');
    } else say(input, 'The verified result is complete.');
  });
  f.bots.update(f.b.id, { instructions: 'BUILDER_PRIVATE_PROFILE' });
  const before = (await f.bots.list()).bots.map(({ conversations, active, ...row }) => row);
  const started = f.send('Give Builder the review role and review the feature', { workMode: 'work' }); await f.done(started.run);
  assert.match(nextInstructions, /BUILDER_PRIVATE_PROFILE/);
  assert.equal(editResult.accepted, true);
  assert.deepEqual((await f.bots.list()).bots.map(({ conversations, active, ...row }) => row), before);
  const journal = f.bots.team.channel(f.team.id).messages;
  assert.equal(journal.some(row => row.content.includes('BUILDER_PRIVATE_PROFILE')), false);
  assert.equal(journal.filter(row => row.kind === 'status' && row.content.includes('revision 2')).length, 1);
});

test('public instruction edits require coordinator approval and compare revision again after the decision', async t => {
  let f, results;
  f = fixture(t, async input => {
    results = await Promise.allSettled(['first', 'second'].map(id => input.executeTool('update_team_instructions', { expectedRevision: 1, briefing: { instructions: `${id} public instructions` } }, id)));
    say(input, 'Reviewed instruction changes.');
  });
  f.bots.update(f.a.id, { policy: 'manual' });
  const started = f.send('Maintain the public project instructions', { workMode: 'work' });
  await until(() => f.bots.pending(started.run.rootChatId).length === 2);
  assert.equal(f.bots.team.list().teams[0].revision, 1);
  await f.bots.approve({ chatId: started.run.rootChatId, callId: 'first', decision: 'approve' });
  await until(() => f.bots.team.list().teams[0].revision === 2);
  await f.bots.approve({ chatId: started.run.rootChatId, callId: 'second', decision: 'approve' });
  await f.done(started.run);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /changed while the edit awaited approval/);
  assert.equal(f.bots.team.list().teams[0].briefing.instructions, 'first public instructions');
  assert.equal(f.bots.team.list().teams[0].revision, 2);
});

test('Plan and noncoordinator conversation turns cannot edit team instructions', async t => {
  let f, peerTried = false;
  f = fixture(t, async input => {
    assert.equal(input.tools.some(row => row.name === 'update_team_instructions'), false);
    await assert.rejects(async () => input.executeTool('update_team_instructions', { expectedRevision: 1, briefing: {} }, 'forbidden-edit'), /not assigned|cannot execute/);
    if (input.message.startsWith('[The public conversation invitations')) return;
    if (input.bot.id === f.a.id) await input.executeTool('invite_teammates', { botIds: [f.b.id], message: 'Offer your review approach.' }, 'peer');
    else peerTried = true;
    say(input, 'Plan only.');
  });
  f.bots.update(f.a.id, { policy: 'plan' });
  // A silent summary must also retain Plan policy and no editing tool.
  const started = f.send('Discuss the review approach'); await f.done(started.run);
  assert.equal(peerTried, true); assert.equal(f.bots.team.list().teams[0].revision, 1);
});

test('a saved instruction edit reports a failed public audit honestly and stale retries cannot apply it twice', async t => {
  let f, observedFailure;
  f = fixture(t, async input => {
    const path = join(f.directory, 'bot-team-channels.json'), original = readFileSync(path), target = join(f.directory, 'unchanged-audit-target');
    writeFileSync(target, 'UNCHANGED'); rmSync(path); symlinkSync(target, path);
    try {
      await assert.rejects(input.executeTool('update_team_instructions', { expectedRevision: 1, briefing: { instructions: 'Saved public instructions' } }, 'audit-edit'), error => { observedFailure = error; return error.applied === true && error.revision === 2; });
      assert.equal(readFileSync(target, 'utf8'), 'UNCHANGED');
    } finally { rmSync(path); writeFileSync(path, original); }
    await assert.rejects(input.executeTool('update_team_instructions', { expectedRevision: 1, briefing: { instructions: 'Saved public instructions' } }, 'stale-retry'), /team changed/);
    say(input, 'The instructions were saved; the update notice needs attention.');
  });
  const started = f.send('Update project instructions', { workMode: 'work' }); await f.done(started.run);
  assert.equal(observedFailure.code, 'team_instructions_saved_notice_failed');
  assert.equal(f.bots.team.list().teams[0].revision, 2);
  assert.equal(f.bots.team.list().teams[0].briefing.instructions, 'Saved public instructions');
});

test('manual routing approval gates task creation while each assigned bot retains its own policy', async t => {
  let f, taskStarted = false;
  f = fixture(t, async input => {
    if (input.bot.teamContext?.channelMode === 'task' && input.message === 'Make a change') {
      await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Make requested change' }, 'dispatch'); say(input, 'Assigned.');
    } else if (!input.bot.teamConversationOnly) { taskStarted = true; assert.equal(input.bot.policy, 'plan'); say(input, 'I can only plan the change.'); }
    else say(input, 'Plan received.');
  });
  f.bots.update(f.a.id, { policy: 'manual' }); f.bots.update(f.b.id, { policy: 'plan' });
  const started = f.send('Make a change', { workMode: 'work' }); await until(() => f.bots.pending(started.run.rootChatId).length === 1);
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
  const started = f.send('Assign work', { workMode: 'work' }); await f.done(started.run);
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

test('conversation-only prompts keep own profile instructions but exclude private memory, extensions and provider checkpoints', async t => {
  let f;
  const extension = { snapshot: () => ({ instructions: 'PRIVATE_EXTENSION_MARKER' }), tools: () => { throw new Error('A conversation must not load extension tools'); }, owns: () => false, finish: async () => {} };
  f = fixture(t, async input => {
    assert.equal(JSON.stringify(input.bot).includes('PRIVATE_EXTENSION_MARKER'), false);
    assert.equal(input.bot.instructions.includes('PRIVATE_PROFILE_MARKER'), true);
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
