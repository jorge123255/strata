/** Disposable journals only. No owner models, files or computers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBotTeams, DEFAULT_TEAM_LIMITS, MAX_TEAM_MEMBERS } from '../server/bots-team.mjs';
import { createBotRoutes } from '../server/bots.mjs';

function journal(t, count = 4) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-room-'));
  const bots = new Map(Array.from({ length: count }, (_, i) => [`bot_${i}`, { id: `bot_${i}`, name: `Member ${i}`, policy: 'bypass' }]));
  const chats = new Map(), sent = [];
  let n = 0, clock = Date.parse('2026-10-23T00:00:00Z');
  const options = {
    directory, now: () => clock,
    requireBot(id) { if (!bots.has(id)) throw Object.assign(new Error('Unknown current bot'), { status: 400 }); return bots.get(id); },
    conversations: () => ({ detail: id => ({ conversation: chats.get(id) }), send(id) { sent.push(id); }, stop: async () => {} }),
    createConversation(botId) { const conversation = { id: `s_${++n}`, botId, messages: [] }; chats.set(conversation.id, conversation); return { conversation }; },
    discardConversation: id => chats.delete(id), stopDirect: async () => {}, schedule: () => {},
  };
  const service = createBotTeams(options), file = join(directory, 'bot-teams.json');
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const snapshot = () => JSON.parse(readFileSync(file));
  const make = (memberCount = count, extra = {}) => {
    const memberIds = [...bots.keys()].slice(0, memberCount);
    return service.create({ name: 'Room', memberIds, coordinatorId: memberIds[0], enabled: true, ...extra }).team;
  };
  const jobs = runId => snapshot().jobs.filter(job => job.runId === runId);
  const context = job => ({ bot: bots.get(job.botId), chatId: job.chatId, turnId: `turn_${job.id}`, toolCallId: `call_${job.id}`, assertLive() {}, requestPermission: async () => true, requestTeamPermission: async () => true });
  return { bots, sent, service, snapshot, make, jobs, context, advance: delta => { clock += delta; } };
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

test('everyone is explicit, a leading @everyone still wakes the room, and ordinary greetings do not', async t => {
  const f = journal(t), team = f.make();
  f.bots.get('bot_3').paused = true;
  const plain = f.service.message(team.id, { message: 'Hi everyone', requestId: 'plain-hi' }).run;
  assert.equal(plain.directDelivery, undefined);
  assert.deepEqual(f.jobs(plain.id).map(job => ({ botId: job.botId, channelMode: job.channelMode })), [{ botId: 'bot_0', channelMode: 'routing' }]);
  const flagged = f.service.message(team.id, { message: 'Hi everyone', requestId: 'flagged', everyone: true }).run;
  assert.equal(flagged.directDelivery, true);
  assert.deepEqual(flagged.requestedRecipientIds, ['bot_0', 'bot_1', 'bot_2', 'bot_3']);
  assert.deepEqual(f.jobs(flagged.id).map(job => job.botId), ['bot_0', 'bot_1', 'bot_2']);
  assert.ok(f.jobs(flagged.id).every(job => job.channelMode === 'conversation'));
  const legacy = f.service.message(team.id, { message: '@all hello', requestId: 'legacy-at' }).run;
  assert.equal(legacy.directDelivery, true);
  assert.equal(f.jobs(legacy.id).length, 3);
  const suppressed = f.service.message(team.id, { message: '@everyone hello', requestId: 'suppressed', everyone: false }).run;
  assert.equal(suppressed.directDelivery, undefined);
  assert.deepEqual(f.jobs(suppressed.id).map(job => job.botId), ['bot_0']);
  assert.throws(() => f.service.message(team.id, { message: 'Hello', requestId: 'bad-flag', everyone: 'yes' }), { status: 400 });
  const retry = f.service.message(team.id, { message: 'Hi everyone', requestId: 'flagged', everyone: true });
  assert.equal(retry.run.id, flagged.id);
  assert.equal(f.jobs(flagged.id).length, 3);
});

test('a room starts at most two speakers, publishes replies in order, and a pass publishes nothing', async t => {
  const f = journal(t), team = f.make();
  const events = [];
  const stop = f.service.subscribe((event, data) => { if (event === 'team-channel' && data.teamId === team.id) events.push(data.presence.map(row => row.state)); });
  t.after(stop);
  const run = f.service.message(team.id, { message: '@everyone hello', requestId: 'ordered' }).run;
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.service.channel(team.id).presence.map(row => row.state), ['queued', 'queued', 'queued', 'queued']);
  f.service.tick();
  assert.equal(f.sent.length, 2);
  const running = f.jobs(run.id).filter(job => job.state === 'running').sort((a, b) => a.roomOrder - b.roomOrder);
  assert.equal(running.length, 2);
  assert.equal(f.jobs(run.id).filter(job => job.state === 'queued').length, 2);
  assert.ok(f.service.channel(team.id).presence.some(row => row.state === 'working'));
  const later = f.context(running[1]);
  f.service.begin(later); f.service.end(later, { publicReply: 'Second speaker' });
  assert.equal(f.service.channel(team.id).messages.some(row => row.content === 'Second speaker'), false);
  const earlier = f.context(running[0]);
  f.service.begin(earlier); f.service.end(earlier, { publicReply: 'First speaker' });
  assert.deepEqual(replies(f.service.channel(team.id)), ['First speaker', 'Second speaker']);
  f.service.tick();
  const next = f.jobs(run.id).filter(job => job.state === 'running').sort((a, b) => a.roomOrder - b.roomOrder);
  assert.equal(next.length, 2);
  const passing = f.context(next[0]);
  f.service.begin(passing);
  assert.deepEqual(await f.service.execute('pass_team_turn', {}, passing), { passed: true, notice: 'You passed. Nothing will be published for this turn.' });
  f.service.end(passing, { publicReply: 'This pass must stay private' });
  const answering = f.context(next[1]);
  f.service.begin(answering); f.service.end(answering, { publicReply: 'Third speaker' });
  assert.deepEqual(replies(f.service.channel(team.id)), ['First speaker', 'Second speaker', 'Third speaker']);
  assert.equal(f.service.detail(team.id, run.id).run.state, 'completed');
  assert.ok(events.some(states => states.every(state => state === 'queued')));
  assert.ok(events.some(states => states.includes('working')));
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
  const payload = JSON.parse(second.slice(second.indexOf('data: ') + 6));
  assert.equal(payload.teamId, team.id);
  assert.equal(payload.presence.length, 2);
  assert.ok(payload.presence.every(row => row.state === 'queued'));
  await reader.cancel();
});
