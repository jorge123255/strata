/** Disposable journals only. No owner models, files or computers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBotTeams, DEFAULT_TEAM_LIMITS, MAX_TEAM_MEMBERS } from '../server/bots-team.mjs';
import { createBotRoutes, createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';

function journal(t, count = 4, hooks = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-room-'));
  const bots = new Map(Array.from({ length: count }, (_, i) => [`bot_${i}`, { id: `bot_${i}`, name: `Member ${i}`, policy: 'bypass' }]));
  const chats = new Map(), sent = [];
  let n = 0, clock = Date.parse('2026-10-23T00:00:00Z');
  const options = {
    directory, now: () => clock,
    requireBot(id) { if (!bots.has(id)) throw Object.assign(new Error('Unknown current bot'), { status: 400 }); return bots.get(id); },
    conversations: () => ({ detail: id => ({ conversation: chats.get(id) }), send(id) { sent.push(id); }, stop: async () => {} }),
    createConversation(botId) { const conversation = { id: `s_${++n}`, botId, messages: [] }; chats.set(conversation.id, conversation); return { conversation }; },
    discardConversation: id => chats.delete(id), stopDirect: async () => {}, schedule: () => {}, ...hooks,
  };
  const service = createBotTeams(options), file = join(directory, 'bot-teams.json');
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const snapshot = () => JSON.parse(readFileSync(file));
  const writeDraft = (chatId, text) => { const chat = chats.get(chatId); chat.messages = [{ role: 'assistant', content: text, streaming: true }]; };
  const make = (memberCount = count, extra = {}) => {
    const memberIds = [...bots.keys()].slice(0, memberCount);
    return service.create({ name: 'Room', memberIds, coordinatorId: memberIds[0], enabled: true, ...extra }).team;
  };
  const jobs = runId => snapshot().jobs.filter(job => job.runId === runId);
  const context = job => ({ bot: bots.get(job.botId), chatId: job.chatId, turnId: `turn_${job.id}`, toolCallId: `call_${job.id}`, assertLive() {}, requestPermission: async () => true, requestTeamPermission: async () => true });
  return { bots, sent, service, snapshot, writeDraft, make, jobs, context, advance: delta => { clock += delta; } };
}
const replies = channel => channel.messages.filter(row => row.author.type === 'bot').map(row => row.content);

test('team defaults are finite, saved limits persist, and explicit zeros stay continuous', async t => {
  const f = journal(t, 2);
  assert.equal(MAX_TEAM_MEMBERS, 12);
  assert.deepEqual(DEFAULT_TEAM_LIMITS, { maxParallel: 2, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 });
  const chosen = { maxParallel: 3, maxDepth: 4, maxHops: 9, maxTurns: 11, maxDurationMs: 120000 };
  const team = f.make(2, { limits: chosen });
  assert.deepEqual(team.limits, chosen);
  assert.deepEqual(f.service.update(team.id, { limits: { maxTurns: 5 } }).team.limits, { ...chosen, maxTurns: 5 });
  for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.service.update(team.id, { limits: { maxHops: value } }), { status: 400 });
  const zeros = { maxParallel: 0, maxDepth: 0, maxHops: 0, maxTurns: 0, maxDurationMs: 0 };
  const open = f.make(2, { name: 'Open', limits: zeros });
  assert.deepEqual(open.limits, zeros);
  const run = f.service.start(open.id, { message: 'Keep going' }).run;
  f.service.tick();
  const root = f.jobs(run.id).find(job => job.state === 'running'), ctx = f.context(root);
  f.service.begin(ctx);
  assert.equal(f.service.isContinuousTurn(ctx.turnId), true);
  assert.equal(f.service.isContinuousTurn('unbound'), false);
});

test('the host rejects a thirteenth member and accepts twelve', async t => {
  const f = journal(t, 13), ids = [...f.bots.keys()];
  assert.throws(() => f.service.create({ name: 'Too many', memberIds: ids, coordinatorId: ids[0], enabled: true }), error => error.status === 400 && /2 to 12/.test(error.message));
  const team = f.service.create({ name: 'Full room', memberIds: ids.slice(0, 12), coordinatorId: ids[0], enabled: true }).team;
  assert.equal(team.memberIds.length, 12);
  assert.deepEqual(team.limits, DEFAULT_TEAM_LIMITS);
});

test('a picked teammate is addressed directly, even when the coordinator is paused', async t => {
  const f = journal(t), team = f.make();
  f.bots.get('bot_0').paused = true;
  const sent = f.service.message(team.id, { message: 'Please look at this', requestId: 'direct-one', recipientIds: ['bot_2'] });
  assert.equal(sent.run.rootBotId, 'bot_2');
  assert.equal(sent.run.directDelivery, true);
  assert.deepEqual(f.jobs(sent.run.id).map(job => ({ botId: job.botId, channelMode: job.channelMode, type: job.type })), [{ botId: 'bot_2', channelMode: 'conversation', type: 'run' }]);
  f.service.tick();
  const job = f.jobs(sent.run.id)[0], ctx = f.context(job);
  f.service.begin(ctx); f.service.end(ctx, { publicReply: 'Looking' }); f.service.tick();
  assert.equal(f.jobs(sent.run.id).length, 1);
  assert.equal(f.service.detail(team.id, sent.run.id).run.state, 'completed');
  assert.deepEqual(replies(f.service.channel(team.id)), ['Looking']);
  const work = f.service.message(team.id, { message: 'Do this bounded check', requestId: 'direct-work', recipientIds: ['bot_1'], workMode: 'work' }).run;
  assert.deepEqual(f.jobs(work.id).map(job => ({ botId: job.botId, channelMode: job.channelMode })), [{ botId: 'bot_1', channelMode: 'task' }]);
});

test('a plain greeting asks the selector once, and an everyone flag does not', async t => {
  const calls = [];
  const f = journal(t, 4, { selectSpeakers(input) { calls.push(input.history.at(-1)?.content); return { speakers: ['bot_1'] }; } });
  const team = f.make();
  f.bots.get('bot_3').paused = true;
  const plain = f.service.message(team.id, { message: 'Hi everyone', requestId: 'plain-hi' }).run;
  assert.equal(f.jobs(plain.id).length, 0);
  f.service.tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(f.jobs(plain.id).map(job => ({ botId: job.botId, channelMode: job.channelMode })), [{ botId: 'bot_1', channelMode: 'conversation' }]);
  const flagged = f.service.message(team.id, { message: 'Hi everyone', requestId: 'flagged', everyone: true }).run;
  assert.equal(flagged.directDelivery, true);
  assert.deepEqual(flagged.requestedRecipientIds, ['bot_0', 'bot_1', 'bot_2', 'bot_3']);
  assert.deepEqual(f.jobs(flagged.id).map(job => job.botId), ['bot_0']);
  f.service.tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(f.jobs(flagged.id).map(job => job.botId), ['bot_0']);
  const legacy = f.service.message(team.id, { message: '@all hello', requestId: 'legacy-at' }).run;
  f.service.tick();
  assert.equal(f.jobs(legacy.id).length, 1);
  assert.equal(f.jobs(legacy.id)[0].botId, 'bot_0');
  const suppressed = f.service.message(team.id, { message: '@everyone hello', requestId: 'suppressed', everyone: false }).run;
  f.service.tick();
  assert.equal(f.jobs(suppressed.id).length, 1);
  assert.equal(f.jobs(suppressed.id)[0].channelMode, 'conversation');
  assert.throws(() => f.service.message(team.id, { message: 'Hello', requestId: 'bad-flag', everyone: 'yes' }), { status: 400 });
  const retry = f.service.message(team.id, { message: 'Hi everyone', requestId: 'flagged', everyone: true });
  assert.equal(retry.run.id, flagged.id);
  assert.equal(f.jobs(flagged.id).length, 1);
});

test('@everyone and @all get one short reply from every available member, in order, without the selector', async t => {
  const calls = [];
  const f = journal(t, 4, { selectSpeakers(input) { calls.push(input.history.at(-1)?.content ?? ''); return { speakers: ['bot_1'] }; } });
  const team = f.make(4, { talkativeness: { bot_2: 0 }, limits: { maxHops: 1, maxParallel: 2, maxDepth: 2, maxTurns: 24, maxDurationMs: 600000 } });
  f.bots.get('bot_3').paused = true;
  const said = ['One sentence from the first.', 'A different second sentence.', 'Third member, briefly.'];
  const run = f.service.message(team.id, { message: '@everyone hi', requestId: 'all-hi' }).run;
  assert.equal(calls.length, 0);
  assert.deepEqual(f.jobs(run.id).map(job => job.botId), ['bot_0']);
  for (let index = 0; index < said.length; index++) {
    f.service.tick();
    const job = f.jobs(run.id).find(row => row.state === 'running');
    assert.equal(job.botId, `bot_${index}`);
    assert.equal(job.hop, 0);
    const ctx = f.context(job);
    f.service.begin(ctx);
    const instructions = f.service.instructions(ctx);
    assert.match(instructions, /one or two sentences/);
    assert.match(instructions, /@everyone hi/);
    for (const earlier of said.slice(0, index)) assert.match(instructions, new RegExp(earlier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    f.service.end(ctx, { publicReply: said[index] });
  }
  f.service.tick();
  assert.equal(calls.length, 0);
  assert.deepEqual(replies(f.service.channel(team.id)), said);
  assert.equal(f.jobs(run.id).some(job => job.botId === 'bot_3'), false);
  assert.equal(f.service.detail(team.id, run.id).run.state, 'completed');

  const flagged = f.service.message(team.id, { message: 'Hello room', requestId: 'flagged-all', everyone: true }).run;
  f.service.tick();
  assert.equal(calls.length, 0);
  assert.equal(f.jobs(flagged.id).find(row => row.state === 'running').botId, 'bot_0');
  for (const text of ['Flagged first line.', 'Flagged second line.', 'Flagged third line.']) {
    const job = f.jobs(flagged.id).find(row => row.state === 'running');
    const ctx = f.context(job);
    f.service.begin(ctx);
    f.service.end(ctx, { publicReply: text });
    f.service.tick();
  }
  assert.deepEqual(f.jobs(flagged.id).map(job => job.botId), ['bot_0', 'bot_1', 'bot_2']);
  assert.equal(f.service.detail(team.id, flagged.id).run.state, 'completed');

  const duplicate = f.service.message(team.id, { message: '@all hello', requestId: 'all-duplicate' }).run;
  f.service.tick();
  const first = f.context(f.jobs(duplicate.id).find(row => row.state === 'running'));
  f.service.begin(first);
  f.service.end(first, { publicReply: 'Ship the small fix today and tell the user.' });
  f.service.tick();
  const second = f.context(f.jobs(duplicate.id).find(row => row.state === 'running'));
  assert.equal(second.bot.id, 'bot_1');
  f.service.begin(second);
  f.service.end(second, { publicReply: 'Ship the small fix today and tell the user now.' });
  f.service.tick();
  assert.equal(f.jobs(duplicate.id).some(job => job.botId === 'bot_2'), false);
  assert.deepEqual(replies(f.service.channel(team.id)).filter(line => line.startsWith('Ship ')), ['Ship the small fix today and tell the user.']);
  assert.equal(f.service.detail(team.id, duplicate.id).run.state, 'completed');
  assert.equal(calls.length, 0);

  const greeting = f.service.message(team.id, { message: 'Hi everyone', requestId: 'plain-greeting' }).run;
  f.service.tick();
  assert.deepEqual(calls, ['Hi everyone']);
  assert.deepEqual(f.jobs(greeting.id).map(job => job.botId), ['bot_1']);
  const greetingJob = f.jobs(greeting.id).find(row => row.state === 'running');
  const greetingCtx = f.context(greetingJob);
  f.service.begin(greetingCtx);
  f.service.end(greetingCtx, { publicReply: 'Hello from one teammate.' });
  const greetingLine = f.service.channel(team.id).messages.find(row => row.content === 'Hello from one teammate.');
  assert.equal(Object.hasOwn(greetingLine, 'replyGroupId'), false);
});

test('@everyone and @all replies share the human message id on the saved line and the live events', async t => {
  const calls = [];
  const f = journal(t, 3, { selectSpeakers(input) { calls.push(input); return { speakers: ['bot_1'] }; } });
  const team = f.make(3);
  const stream = await openRoomStream(t, f.service, team.id);
  t.after(() => stream.cancel());
  assert.match(await stream.readEvent(), /^event: team-channel/);
  const run = f.service.message(team.id, { message: '@everyone hi', requestId: 'group-hi' }).run;
  const opening = f.service.channel(team.id).messages.find(row => row.author.type === 'user');
  assert.equal(Object.hasOwn(opening, 'replyGroupId'), false);
  const queued = stream.parse(await stream.readEvent());
  assert.equal(queued.name, 'team-channel');
  assert.equal(Object.hasOwn(queued.data, 'replyGroupId'), false);
  f.service.tick();
  const working = stream.parse(await stream.readEvent());
  assert.equal(working.data.presence[0].state, 'working');
  assert.equal(Object.hasOwn(working.data, 'replyGroupId'), false);
  const firstJob = f.jobs(run.id).find(row => row.state === 'running');
  const first = f.context(firstJob);
  f.service.begin(first);
  assert.equal(stream.parse(await stream.readEvent()).name, 'team-channel');
  f.service.noteRoomDelta(firstJob.chatId, 'One.');
  const live = stream.parse(await stream.readEvent());
  const firstId = `tm_${firstJob.id}`;
  assert.equal(live.name, 'message.partial');
  assert.equal(live.json, JSON.stringify({ messageId: firstId, botId: 'bot_0', seq: 1, text: 'One.', delta: 'One.', done: false, replyGroupId: opening.id }));
  f.service.end(first, { publicReply: 'One short reply.' });
  const done = stream.parse(await stream.readEvent());
  assert.equal(done.json, JSON.stringify({ messageId: firstId, botId: 'bot_0', seq: 2, text: 'One short reply.', delta: 'One short reply.', done: true, replyGroupId: opening.id }));
  const savedEvent = stream.parse(await stream.readEvent());
  assert.equal(savedEvent.name, 'team-channel');
  assert.equal(savedEvent.data.messageId, firstId);
  assert.equal(savedEvent.data.replyGroupId, opening.id);
  assert.equal(stream.parse(await stream.readEvent()).data.replyGroupId, undefined);
  f.service.tick();
  assert.equal(stream.parse(await stream.readEvent()).data.presence[0].botId, 'bot_1');
  const secondJob = f.jobs(run.id).find(row => row.state === 'running');
  const second = f.context(secondJob);
  f.service.begin(second);
  assert.equal(stream.parse(await stream.readEvent()).name, 'team-channel');
  f.service.end(second, { publicReply: 'Two short replies.' });
  const secondDone = stream.parse(await stream.readEvent());
  assert.equal(secondDone.data.replyGroupId, opening.id);
  assert.equal(secondDone.data.botId, 'bot_1');
  const secondSaved = stream.parse(await stream.readEvent());
  assert.equal(secondSaved.data.messageId, `tm_${secondJob.id}`);
  assert.equal(secondSaved.data.replyGroupId, opening.id);
  assert.equal(stream.parse(await stream.readEvent()).data.replyGroupId, undefined);
  f.service.tick();
  assert.equal(stream.parse(await stream.readEvent()).data.presence[0].botId, 'bot_2');
  const thirdJob = f.jobs(run.id).find(row => row.state === 'running');
  const third = f.context(thirdJob);
  f.service.begin(third);
  assert.equal(stream.parse(await stream.readEvent()).name, 'team-channel');
  f.service.end(third, { publicReply: 'Three, still short.' });
  assert.equal(stream.parse(await stream.readEvent()).data.replyGroupId, opening.id);
  assert.equal(stream.parse(await stream.readEvent()).data.replyGroupId, opening.id);
  const grouped = f.service.channel(team.id).messages.filter(row => row.author.type === 'bot');
  assert.deepEqual(grouped.map(row => row.content), ['One short reply.', 'Two short replies.', 'Three, still short.']);
  assert.deepEqual(grouped.map(row => row.replyGroupId), [opening.id, opening.id, opening.id]);
  assert.equal(calls.length, 0);

  const flagged = f.service.message(team.id, { message: '@all hello', requestId: 'group-all', everyone: true }).run;
  const flaggedOpening = f.service.channel(team.id).messages.find(row => row.content === '@all hello');
  for (const text of ['All one.', 'All two.', 'All three.']) {
    f.service.tick();
    const job = f.jobs(flagged.id).find(row => row.state === 'running');
    const ctx = f.context(job);
    f.service.begin(ctx);
    f.service.end(ctx, { publicReply: text });
  }
  const flaggedLines = f.service.channel(team.id).messages.filter(row => row.content.startsWith('All '));
  assert.deepEqual(flaggedLines.map(row => row.replyGroupId), [flaggedOpening.id, flaggedOpening.id, flaggedOpening.id]);
  assert.equal(calls.length, 0);
  await stream.cancel();
});

test('a room speaker can pass without publishing, and a later speaker still answers', async t => {
  const script = [['bot_0'], ['bot_1'], []];
  const f = journal(t, 4, { selectSpeakers() { return { speakers: script.shift() ?? [] }; } });
  const team = f.make();
  const run = f.service.message(team.id, { message: 'Hello room', requestId: 'pass-room' }).run;
  f.service.tick();
  const first = f.jobs(run.id).find(job => job.state === 'running');
  const passing = f.context(first);
  f.service.begin(passing);
  assert.match(f.service.instructions(passing), /Address teammates by name/);
  assert.match(f.service.instructions(passing), /Recent room, with authors/);
  assert.match(f.service.instructions(passing), /pass_team_turn/);
  assert.deepEqual(await f.service.execute('pass_team_turn', {}, passing), { passed: true, notice: 'You passed. Nothing will be published for this turn.' });
  f.service.end(passing, { publicReply: 'This pass must stay private' });
  assert.deepEqual(replies(f.service.channel(team.id)), []);
  f.service.tick();
  const second = f.jobs(run.id).find(job => job.state === 'running');
  assert.equal(second.botId, 'bot_1');
  const answering = f.context(second);
  f.service.begin(answering); f.service.end(answering, { publicReply: 'I can take the next step.' });
  f.service.tick();
  assert.deepEqual(replies(f.service.channel(team.id)), ['I can take the next step.']);
  assert.equal(f.service.detail(team.id, run.id).run.state, 'completed');
  assert.equal(f.jobs(run.id).filter(job => job.state === 'running').length, 0);
});

test('turn, time, hop, depth and parallel limits stop the next piece of work', async t => {
  const turns = journal(t, 2), turnTeam = turns.make(2, { limits: { maxTurns: 1, maxParallel: 2 } });
  const turnRun = turns.service.start(turnTeam.id, { message: 'Root' }).run;
  turns.service.tick();
  const turnCtx = turns.context(turns.jobs(turnRun.id).find(job => job.state === 'running'));
  turns.service.begin(turnCtx);
  await turns.service.execute('spawn_subagent', { botId: 'bot_1', message: 'Child' }, turnCtx);
  turns.service.end(turnCtx, { publicReply: 'Done' }); turns.service.tick();
  assert.equal(turns.service.detail(turnTeam.id, turnRun.id).run.consumedTurns, 1);
  assert.ok(turns.jobs(turnRun.id).some(job => /turn limit/.test(job.detail ?? '')));

  const timed = journal(t, 2), timedTeam = timed.make(2, { limits: { maxDurationMs: 1, maxTurns: 0, maxParallel: 2 } });
  const timeRun = timed.service.start(timedTeam.id, { message: 'Root' }).run;
  timed.service.tick();
  const timeCtx = timed.context(timed.jobs(timeRun.id).find(job => job.state === 'running'));
  timed.service.begin(timeCtx);
  await timed.service.execute('spawn_subagent', { botId: 'bot_1', message: 'Later' }, timeCtx);
  timed.advance(10); timed.service.end(timeCtx, { publicReply: 'Done' }); timed.service.tick();
  assert.equal(timed.service.detail(timedTeam.id, timeRun.id).run.consumedTurns, 1);
  assert.ok(timed.jobs(timeRun.id).some(job => /time limit/.test(job.detail ?? '')));

  const hops = journal(t, 3), hopTeam = hops.make(3, { limits: { maxHops: 1, maxDepth: 4, maxParallel: 2 } });
  const hopRun = hops.service.start(hopTeam.id, { message: 'Root' }).run;
  hops.service.tick();
  const hopCtx = hops.context(hops.jobs(hopRun.id).find(job => job.state === 'running'));
  hops.service.begin(hopCtx);
  await hops.service.execute('spawn_subagent', { botId: 'bot_1', message: 'Allowed child' }, hopCtx);
  hops.service.tick();
  const child = hops.jobs(hopRun.id).find(job => job.hop === 1 && job.state === 'running');
  assert.ok(child);
  const childCtx = hops.context(child);
  hops.service.begin(childCtx);
  await assert.rejects(() => hops.service.execute('spawn_subagent', { botId: 'bot_2', message: 'Too many hops' }, childCtx), error => error.status === 409 && /hop limit/.test(error.message));

  const depth = journal(t, 3), depthTeam = depth.make(3, { limits: { maxDepth: 1, maxHops: 8, maxParallel: 2 } });
  const depthRun = depth.service.start(depthTeam.id, { message: 'Root' }).run;
  depth.service.tick();
  const depthCtx = depth.context(depth.jobs(depthRun.id).find(job => job.state === 'running'));
  depth.service.begin(depthCtx);
  await depth.service.execute('spawn_subagent', { botId: 'bot_1', message: 'Allowed depth' }, depthCtx);
  depth.service.tick();
  const deep = depth.jobs(depthRun.id).find(job => job.depth === 1 && job.state === 'running');
  const deepCtx = depth.context(deep);
  depth.service.begin(deepCtx);
  await assert.rejects(() => depth.service.execute('spawn_subagent', { botId: 'bot_2', message: 'Too deep' }, deepCtx), error => error.status === 409 && /depth limit/.test(error.message));

  const parallel = journal(t, 3), parallelTeam = parallel.make(3, { limits: { maxParallel: 1, maxTurns: 0, maxHops: 0, maxDepth: 0 } });
  const parallelRun = parallel.service.start(parallelTeam.id, { message: 'Root' }).run;
  parallel.service.tick();
  const parallelCtx = parallel.context(parallel.jobs(parallelRun.id).find(job => job.state === 'running'));
  parallel.service.begin(parallelCtx);
  await parallel.service.execute('spawn_subagent', { botId: 'bot_1', message: 'One' }, { ...parallelCtx, toolCallId: 'one' });
  await parallel.service.execute('spawn_subagent', { botId: 'bot_2', message: 'Two' }, { ...parallelCtx, toolCallId: 'two' });
  parallel.service.end(parallelCtx, { publicReply: 'Delegated' }); parallel.service.tick();
  const children = parallel.jobs(parallelRun.id).filter(job => job.type === 'subagent');
  assert.equal(children.filter(job => job.state === 'running').length, 1);
  assert.equal(children.filter(job => job.state === 'queued').length, 1);
});

test('the channel stream pushes presence for the open room', async t => {
  const f = journal(t, 2), team = f.make(2);
  const server = http.createServer((req, res) => { route(req, res, new URL(req.url, `http://127.0.0.1:${server.address().port}`)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const route = createBotRoutes({ bots: { team: f.service }, port });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${origin}/api/bots/teams/${team.id}/channel/stream`, { headers: { Origin: origin }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const buffer = { text: '' };
  const readEvent = async () => {
    while (!buffer.text.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Room stream ended before an event');
      buffer.text += decoder.decode(chunk.value, { stream: true });
    }
    const split = buffer.text.indexOf('\n\n');
    const event = buffer.text.slice(0, split);
    buffer.text = buffer.text.slice(split + 2);
    return event;
  };
  const first = await readEvent();
  assert.match(first, /^event: team-channel/);
  assert.deepEqual(JSON.parse(first.slice(first.indexOf('data: ') + 6)).presence, []);
  f.service.message(team.id, { message: 'Hello', requestId: 'streamed', everyone: true });
  const second = await readEvent();
  const queued = JSON.parse(second.slice(second.indexOf('data: ') + 6));
  assert.equal(queued.presence.length, 1);
  assert.equal(queued.presence[0].state, 'queued');
  f.service.tick();
  const third = await readEvent();
  const payload = JSON.parse(third.slice(third.indexOf('data: ') + 6));
  assert.equal(payload.teamId, team.id);
  assert.equal(payload.presence.length, 1);
  assert.equal(payload.presence[0].state, 'working');
  await reader.cancel();
});

test('a 12-member @everyone room asks every member once, in order, and does not call the selector', async t => {
  const calls = [];
  const f = journal(t, 12, { selectSpeakers(input) { calls.push(input); return { speakers: ['bot_3', 'bot_4'] }; } });
  const team = f.make(12);
  const run = f.service.message(team.id, { message: '@everyone hi', requestId: 'twelve-hi' }).run;
  assert.equal(calls.length, 0);
  assert.deepEqual(f.jobs(run.id).map(job => job.botId), ['bot_0']);
  const said = [];
  for (let index = 0; index < 12; index++) {
    f.service.tick();
    const job = f.jobs(run.id).find(row => row.state === 'running');
    assert.equal(job.botId, `bot_${index}`);
    assert.equal(job.hop, 0);
    const ctx = f.context(job);
    f.service.begin(ctx);
    if (index > 0) assert.match(f.service.instructions(ctx), new RegExp(`Hello from bot_${index - 1}`));
    const text = `Hello from bot_${index}.`;
    said.push(text);
    f.service.end(ctx, { publicReply: text });
  }
  f.service.tick();
  assert.equal(calls.length, 0);
  assert.equal(f.jobs(run.id).length, 12);
  assert.deepEqual(replies(f.service.channel(team.id)), said);
  assert.equal(f.service.detail(team.id, run.id).run.state, 'completed');
  assert.equal(f.service.channel(team.id).presence.length, 0);
});

test('a mention bypasses the selector until that bot has replied', async t => {
  const calls = [];
  const f = journal(t, 4, { selectSpeakers(input) { calls.push(input); return { speakers: ['bot_0'] }; } });
  const team = f.make();
  const run = f.service.message(team.id, { message: 'Please look', requestId: 'mention', recipientIds: ['bot_2'] }).run;
  assert.equal(calls.length, 0);
  assert.deepEqual(f.jobs(run.id).map(job => job.botId), ['bot_2']);
  f.service.tick();
  assert.equal(calls.length, 0);
  const speaker = f.context(f.jobs(run.id)[0]);
  f.service.begin(speaker); f.service.end(speaker, { publicReply: 'Looking now' });
  assert.equal(calls.length, 0);
  f.service.tick();
  assert.equal(calls.length, 1);
  assert.equal(f.jobs(run.id).some(job => job.botId === 'bot_0' && job.state === 'running'), true);
});

test('talkativeness 0 stays silent unless that bot was mentioned', async t => {
  const f = journal(t, 3, { selectSpeakers() { return { speakers: ['bot_0', 'bot_1'] }; } });
  const team = f.make(3, { talkativeness: { bot_0: 0, bot_1: 50 } });
  const quiet = f.service.message(team.id, { message: 'Anyone around?', requestId: 'quiet' }).run;
  f.service.tick();
  assert.deepEqual(f.jobs(quiet.id).map(job => job.botId), ['bot_1']);
  const named = f.service.message(team.id, { message: '@Member 0 a question', requestId: 'named' }).run;
  assert.equal(f.jobs(named.id)[0].botId, 'bot_0');
});

test('the same bot does not speak twice in a row', async t => {
  const rounds = [['bot_0'], ['bot_0', 'bot_1']];
  const f = journal(t, 3, { selectSpeakers() { return { speakers: rounds.shift() ?? [] }; } });
  const team = f.make(3);
  const run = f.service.message(team.id, { message: 'Thoughts?', requestId: 'turns' }).run;
  f.service.tick();
  const first = f.jobs(run.id).find(job => job.state === 'running');
  assert.equal(first.botId, 'bot_0');
  const ctx = f.context(first); f.service.begin(ctx); f.service.end(ctx, { publicReply: 'First thought' });
  f.service.tick();
  const second = f.jobs(run.id).find(job => job.state === 'running');
  assert.equal(second.botId, 'bot_1');
  assert.equal(f.jobs(run.id).filter(job => job.botId === 'bot_0').length, 1);
});

test('a bot named by another bot speaks next, and a later hop past the limit does not', async t => {
  const calls = [];
  const f = journal(t, 3, { selectSpeakers(input) { calls.push(input.addressedBotId ?? null); return { speakers: ['bot_2'] }; } });
  const team = f.make(3, { limits: { maxHops: 1, maxParallel: 2, maxDepth: 2, maxTurns: 24, maxDurationMs: 600000 } });
  const run = f.service.message(team.id, { message: 'Let us decide', requestId: 'handoff' }).run;
  f.service.tick();
  assert.equal(f.jobs(run.id)[0].botId, 'bot_2');
  const first = f.context(f.jobs(run.id)[0]);
  f.service.begin(first); f.service.end(first, { publicReply: 'Member 1, I would ship the small fix. Do you agree?' });
  f.service.tick();
  assert.equal(calls.at(-1), 'bot_1');
  const handoff = f.jobs(run.id).find(job => job.state === 'running');
  assert.equal(handoff.botId, 'bot_1');
  assert.equal(handoff.hop, 1);
  const second = f.context(handoff);
  f.service.begin(second); f.service.end(second, { publicReply: 'Member 0, I agree, with one change.' });
  f.service.tick();
  assert.equal(f.jobs(run.id).some(job => job.botId === 'bot_0' && job.hop === 2), false);
  assert.equal(f.service.detail(team.id, run.id).run.state, 'completed');
});

test('a near-duplicate reply is dropped and the chain pauses', async t => {
  const calls = [];
  const rounds = [['bot_1'], ['bot_0'], ['bot_2']];
  const f = journal(t, 3, { selectSpeakers() { calls.push(calls.length); return { speakers: rounds.shift() ?? [] }; } });
  const team = f.make(3);
  const run = f.service.message(team.id, { message: 'What should we ship?', requestId: 'duplicate' }).run;
  f.service.tick();
  const first = f.context(f.jobs(run.id).find(job => job.state === 'running'));
  f.service.begin(first); f.service.end(first, { publicReply: 'Ship the small fix today and tell the user.' });
  f.service.tick();
  const second = f.context(f.jobs(run.id).find(job => job.state === 'running'));
  assert.equal(second.bot.id, 'bot_0');
  f.service.begin(second); f.service.end(second, { publicReply: 'Ship the small fix today and tell the user now.' });
  f.service.tick();
  assert.deepEqual(replies(f.service.channel(team.id)), ['Ship the small fix today and tell the user.']);
  assert.equal(f.jobs(run.id).some(job => job.botId === 'bot_2'), false);
  assert.equal(calls.length, 2);
  assert.equal(f.service.detail(team.id, run.id).run.state, 'completed');
});

test('bidding mode skips the selector and starts the most urgent candidate', async t => {
  const asked = [];
  const f = journal(t, 3, {
    selectSpeakers() { throw new Error('The selector stays quiet while bidding is on.'); },
    bidSpeaker(input) { asked.push(input.candidate.id); return input.candidate.id === 'bot_1' ? { pass: true } : { urgency: 6 }; },
  });
  const team = f.make(3, { bidding: true, talkativeness: { bot_0: 0, bot_1: 80, bot_2: 100 } });
  assert.deepEqual(team.talkativeness, { bot_0: 0, bot_1: 80, bot_2: 100 });
  assert.equal(team.bidding, true);
  const run = f.service.message(team.id, { message: 'Hello room', requestId: 'bid-mode' }).run;
  f.service.tick();
  assert.deepEqual(asked, ['bot_1', 'bot_2']);
  assert.equal(f.jobs(run.id).filter(job => job.state === 'running').map(job => job.botId).join(), 'bot_2');
});

test('talkativeness accepts 0 to 100, omits the default, and bidding is stored only when on', async t => {
  const f = journal(t, 3);
  const team = f.make(3, { talkativeness: { bot_0: 0, bot_1: 50, bot_2: 100 }, bidding: false });
  assert.deepEqual(team.talkativeness, { bot_0: 0, bot_2: 100 });
  assert.equal(Object.hasOwn(team, 'bidding'), false);
  for (const value of [-1, 101, 1.5]) assert.throws(() => f.service.update(team.id, { talkativeness: { bot_0: value } }), { status: 400 });
  const saved = f.service.update(team.id, { talkativeness: { bot_0: 50, bot_2: 50 }, bidding: true }).team;
  assert.equal(saved.talkativeness, undefined);
  assert.equal(saved.bidding, true);
  const cleared = f.service.update(saved.id, { bidding: false }).team;
  assert.equal(Object.hasOwn(cleared, 'bidding'), false);
  assert.equal(Object.hasOwn(f.snapshot().teams.find(row => row.id === team.id), 'bidding'), false);
});

test('a direct question asks the selector twice and then bids once', async t => {
  const calls = { select: 0, bid: 0 };
  const f = journal(t, 3, {
    selectSpeakers() { calls.select++; return { speakers: [] }; },
    bidSpeaker() { calls.bid++; return { urgency: 4 }; },
  });
  const team = f.make(3);
  const run = f.service.message(team.id, { message: 'Should we ship this?', requestId: 'ask' }).run;
  f.service.tick();
  assert.equal(calls.select, 1);
  assert.equal(f.jobs(run.id).length, 0);
  f.service.tick();
  assert.equal(calls.select, 2);
  assert.equal(calls.bid, 3);
  assert.equal(f.jobs(run.id).filter(job => job.state === 'running').length, 1);
});

test('typing pauses the next speaker and a new message pauses the old chain', async t => {
  const rounds = [['bot_0'], ['bot_1'], []];
  const f = journal(t, 3, { selectSpeakers() { return { speakers: rounds.shift() ?? [] }; } });
  const team = f.make(3);
  const first = f.service.message(team.id, { message: 'Start', requestId: 'typing' }).run;
  assert.deepEqual(f.service.setTyping(team.id, { typing: true }), { typing: true });
  f.service.tick();
  assert.equal(f.jobs(first.id).length, 0);
  f.service.setTyping(team.id, { typing: false });
  f.service.tick();
  assert.equal(f.jobs(first.id).filter(job => job.state === 'running').length, 1);
  const second = f.service.message(team.id, { message: 'Newer', requestId: 'newer' }).run;
  const running = f.jobs(first.id).find(job => job.state === 'running');
  const ctx = f.context(running); f.service.begin(ctx); f.service.end(ctx, { publicReply: 'Too late to continue' });
  f.service.tick();
  assert.equal(f.jobs(first.id).length, 1);
  assert.equal(f.jobs(second.id).some(job => job.botId === 'bot_1'), true);
});

async function openRoomStream(t, service, teamId) {
  const server = http.createServer((req, res) => { route(req, res, new URL(req.url, `http://127.0.0.1:${server.address().port}`)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const route = createBotRoutes({ bots: { team: service }, port });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${origin}/api/bots/teams/${teamId}/channel/stream`, { headers: { Origin: origin }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const buffer = { text: '' };
  const readEvent = async () => {
    while (!buffer.text.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Room stream ended before an event');
      buffer.text += decoder.decode(chunk.value, { stream: true });
    }
    const split = buffer.text.indexOf('\n\n');
    const event = buffer.text.slice(0, split);
    buffer.text = buffer.text.slice(split + 2);
    return event;
  };
  const parse = raw => {
    const name = /^event: ([^\n]+)/.exec(raw)[1];
    const json = raw.slice(raw.indexOf('data: ') + 6);
    return { name, json, data: JSON.parse(json) };
  };
  return { readEvent, parse, cancel: () => reader.cancel() };
}

test('the room stream sends message.partial text and then the same final message', async t => {
  let picks = 1;
  const f = journal(t, 2, { selectSpeakers() { return { speakers: picks-- > 0 ? ['bot_1'] : [] }; } });
  const team = f.make(2);
  const run = f.service.message(team.id, { message: 'Hello', requestId: 'partials' }).run;
  f.service.tick();
  const job = f.jobs(run.id).find(row => row.state === 'running');
  const ctx = f.context(job);
  f.service.begin(ctx);
  const stream = await openRoomStream(t, f.service, team.id);
  const opened = await stream.readEvent();
  assert.match(opened, /^event: team-channel/);

  f.service.noteRoomDelta(job.chatId, 'Hi');
  const first = stream.parse(await stream.readEvent());
  const messageId = `tm_${job.id}`;
  assert.equal(first.name, 'message.partial');
  assert.equal(first.json, JSON.stringify({ messageId, botId: 'bot_1', seq: 1, text: 'Hi', delta: 'Hi', done: false }));

  f.writeDraft(job.chatId, 'Hi there');
  f.service.tick();
  const second = stream.parse(await stream.readEvent());
  assert.equal(second.name, 'message.partial');
  assert.equal(second.json, JSON.stringify({ messageId, botId: 'bot_1', seq: 2, text: 'Hi there', delta: ' there', done: false }));

  f.service.end(ctx, { publicReply: 'Hi there!' });
  const finished = stream.parse(await stream.readEvent());
  assert.equal(finished.name, 'message.partial');
  assert.equal(finished.json, JSON.stringify({ messageId, botId: 'bot_1', seq: 3, text: 'Hi there!', delta: '!', done: true }));
  const saved = stream.parse(await stream.readEvent());
  assert.equal(saved.name, 'team-channel');
  assert.equal(saved.data.messageId, messageId);
  assert.equal(f.service.channel(team.id).messages.find(row => row.id === messageId).content, 'Hi there!');
  await stream.cancel();
});

test('a reply with no live deltas still ends on message.partial and the same message id', async t => {
  const f = journal(t, 2, { selectSpeakers() { return { speakers: ['bot_1'] }; } });
  const team = f.make(2);
  const run = f.service.message(team.id, { message: 'Hello', requestId: 'final-only' }).run;
  f.service.tick();
  const job = f.jobs(run.id).find(row => row.state === 'running');
  const ctx = f.context(job);
  f.service.begin(ctx);
  const stream = await openRoomStream(t, f.service, team.id);
  assert.match(await stream.readEvent(), /^event: team-channel/);
  f.service.end(ctx, { publicReply: 'All at once' });
  const finished = stream.parse(await stream.readEvent());
  const messageId = `tm_${job.id}`;
  assert.equal(finished.name, 'message.partial');
  assert.equal(finished.json, JSON.stringify({ messageId, botId: 'bot_1', seq: 1, text: 'All at once', delta: 'All at once', done: true }));
  const saved = stream.parse(await stream.readEvent());
  assert.equal(saved.name, 'team-channel');
  assert.equal(saved.data.messageId, messageId);
  assert.equal(f.service.channel(team.id).messages.find(row => row.id === messageId).content, 'All at once');
  await stream.cancel();
});

test('a passed turn clears a live draft and does not publish it', async t => {
  const f = journal(t, 2, { selectSpeakers() { return { speakers: ['bot_1'] }; } });
  const team = f.make(2);
  const run = f.service.message(team.id, { message: 'Hello', requestId: 'clear-draft' }).run;
  f.service.tick();
  const job = f.jobs(run.id).find(row => row.state === 'running');
  const ctx = f.context(job);
  f.service.begin(ctx);
  const stream = await openRoomStream(t, f.service, team.id);
  assert.match(await stream.readEvent(), /^event: team-channel/);
  f.service.noteRoomDelta(job.chatId, 'Secret draft');
  const live = stream.parse(await stream.readEvent());
  assert.equal(live.data.done, false);
  assert.equal(live.data.text, 'Secret draft');
  await f.service.execute('pass_team_turn', {}, ctx);
  assert.equal(stream.parse(await stream.readEvent()).name, 'team-channel');
  f.service.end(ctx, { publicReply: 'This pass must stay private' });
  const cleared = stream.parse(await stream.readEvent());
  const messageId = `tm_${job.id}`;
  assert.equal(cleared.name, 'message.partial');
  assert.equal(cleared.json, JSON.stringify({ messageId, botId: 'bot_1', seq: 2, text: '', delta: '', done: true }));
  assert.equal(f.service.channel(team.id).messages.some(row => row.id === messageId), false);
  await stream.cancel();
});

test('an empty selector for a plain greeting still answers once, and a later empty selection settles', async t => {
  const events = [];
  const f = journal(t, 3, { notify: (event, data) => events.push(event), selectSpeakers() { return { speakers: [] }; } });
  const team = f.make(3, { talkativeness: { bot_2: 100 } });
  const run = f.service.message(team.id, { message: 'Hi', requestId: 'plain-hi' }).run;
  f.service.tick();
  assert.equal(f.jobs(run.id).length, 0);
  f.service.tick();
  const job = f.jobs(run.id).find(row => row.state === 'running');
  assert.equal(job.botId, 'bot_2');
  const ctx = f.context(job);
  f.service.begin(ctx);
  f.service.end(ctx, { publicReply: 'Hi.' });
  f.service.tick();
  assert.equal(f.jobs(run.id).length, 1);
  assert.deepEqual(replies(f.service.channel(team.id)), ['Hi.']);
  assert.equal(f.service.detail(team.id, run.id).run.state, 'completed');
  assert.equal(events.includes('room.quiet'), false);
});

test('a room that cannot answer a human greeting emits room.quiet and does not start a turn', async t => {
  const events = [];
  const f = journal(t, 3, { notify: (event, data) => events.push({ event, data }), selectSpeakers() { return { speakers: [] }; } });
  const team = f.make(3, { talkativeness: { bot_0: 0, bot_1: 0, bot_2: 0 } });
  const run = f.service.message(team.id, { message: 'Hi', requestId: 'silent-hi' }).run;
  const stream = await openRoomStream(t, f.service, team.id);
  assert.match(await stream.readEvent(), /^event: team-channel/);
  f.service.tick();
  f.service.tick();
  assert.equal(f.jobs(run.id).length, 0);
  assert.equal(f.service.detail(team.id, run.id).run.state, 'completed');
  const quiet = events.find(row => row.event === 'room.quiet');
  const opening = f.service.channel(team.id).messages.find(row => row.author.type === 'user');
  assert.equal(quiet.data.teamId, team.id);
  assert.equal(quiet.data.runId, run.id);
  assert.equal(quiet.data.messageId, opening.id);
  let streamed = null;
  for (let i = 0; i < 8 && !streamed; i++) {
    const parsed = stream.parse(await stream.readEvent());
    if (parsed.name === 'room.quiet') streamed = parsed;
  }
  assert.equal(streamed.name, 'room.quiet');
  assert.equal(streamed.json, JSON.stringify({ teamId: team.id, runId: run.id, messageId: opening.id }));
  await stream.cancel();
});

test('selectorBotId is stored on the team and passed to the selector', async t => {
  const seen = [];
  const f = journal(t, 3, { selectSpeakers(input) { seen.push(input.selectorBotId ?? null); return { speakers: ['bot_1'] }; } });
  const team = f.make(3, { selectorBotId: 'bot_2' });
  assert.equal(team.selectorBotId, 'bot_2');
  assert.throws(() => f.service.update(team.id, { selectorBotId: 'bot_9' }), { status: 400 });
  const cleared = f.service.update(team.id, { selectorBotId: null }).team;
  assert.equal(Object.hasOwn(cleared, 'selectorBotId'), false);
  const chosen = f.service.update(cleared.id, { selectorBotId: 'bot_2' }).team;
  f.service.message(chosen.id, { message: 'Hello', requestId: 'picker-setting' });
  f.service.tick();
  assert.deepEqual(seen, ['bot_2']);
});

test('the model picker answers a plain greeting when it returns nobody, maps a name to an id, and prefers the coordinator', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-room-picker-'));
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(item => String(item)).join(' ')); };
  t.after(() => { console.log = original; });
  let chats;
  const connection = { id: 'inert', name: 'Inert', baseUrl: 'https://fixture.invalid/v1', protocol: 'openai-chat', models: [{ id: 'qwen' }, { id: 'lead-model' }] };
  const prompts = [];
  let useNames = false;
  const bots = createBots({
    directory, defaultWorkspace: () => directory, conversations: () => chats, tools: { definitions: () => [], finish() {} },
    modelProviders: { resolve: ({ modelId }) => ({ connection, model: connection.models.find(model => model.id === modelId) ?? connection.models[0] }), list: () => ({ connections: [connection] }) },
    modelRequest: async payload => {
      const content = payload.messages[0].content;
      prompts.push(content);
      const human = content.startsWith('The latest message is from the human');
      if (!human) return { text: '{"speakers":[]}' };
      return { text: useNames ? '{"speakers":["Pal"]}' : '{"speakers":[]}' };
    },
    runtime: { providers: async () => [], async run(input) { const text = `Hello from ${input.bot.name} ${input.message}`; input.onFrame({ type: 'delta', text }); input.onFrame({ type: 'done', publicReply: text }); }, async close() {} },
  });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), execute: input => bots.run(input), validateSelection: input => bots.validateSelection(input) });
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const profile = { provider: 'configured', workspace: directory, policy: 'bypass', capabilities: 'both', computerMode: 'host' };
  const coder = bots.create({ ...profile, name: 'Coder', modelSource: { connectionId: 'inert', model: 'qwen' } }).bot;
  const lead = bots.create({ ...profile, name: 'Lead', modelSource: { connectionId: 'inert', model: 'lead-model' } }).bot;
  const pal = bots.create({ name: 'Pal', provider: 'codex', workspace: directory, policy: 'bypass', capabilities: 'both', computerMode: 'host' }).bot;
  const team = bots.team.create({ name: 'Room', memberIds: [coder.id, lead.id, pal.id], coordinatorId: lead.id, enabled: true, talkativeness: { [pal.id]: 100 } }).team;
  const untilSettled = async runId => {
    for (let i = 0; i < 40; i++) {
      if (!['queued', 'running'].includes(bots.team.detail(team.id, runId).run.state)) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('The room did not settle');
  };
  const first = bots.team.message(team.id, { message: 'Hi', requestId: 'model-empty' }).run;
  await untilSettled(first.id);
  assert.deepEqual(replies(bots.team.channel(team.id)), ['Hello from Pal Hi']);
  assert.match(prompts[0], /The latest message is from the human/);
  assert.match(prompts[0], /greeting, @everyone, or @all needs 1 or 2 speakers/);
  const firstLog = lines.find(line => line.startsWith('room selection'));
  assert.match(firstLog, new RegExp(`run ${first.id}`));
  assert.match(firstLog, new RegExp(`picker ${lead.id} lead-model`));
  assert.match(firstLog, /\[\]/);
  assert.match(firstLog, new RegExp(`accepted ${pal.id}`));
  assert.equal(prompts.some(content => content.startsWith('The latest message is from a bot')), true);
  bots.team.update(team.id, { selectorBotId: coder.id });
  useNames = true;
  const second = bots.team.message(team.id, { message: 'Hello room', requestId: 'model-name' }).run;
  await untilSettled(second.id);
  assert.deepEqual(replies(bots.team.channel(team.id)), ['Hello from Pal Hi', 'Hello from Pal Hello room']);
  assert.ok(lines.some(line => line.startsWith('room selection') && line.includes(`picker ${coder.id} qwen`) && line.includes('Pal') && line.includes(`accepted ${pal.id}`)));
  assert.equal(bots.team.detail(team.id, second.id).run.state, 'completed');
  assert.equal(prompts.filter(content => content.startsWith('The latest message is from a bot')).length, 2);
});
