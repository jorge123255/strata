/** Inert team journals. No model, network, or computer is contacted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBotTeams, transientRetryDelayMs } from '../server/bots-team.mjs';
import { createBotRoutes } from '../server/bots.mjs';
import { createTeamChannels } from '../server/bots-team-channel.mjs';

const TIMEOUT = new Error('connect ETIMEDOUT SECRET_TOKEN_91');
const LIMIT = new Error('The configured model API returned HTTP 429.');
const BILLING = new Error('The configured model API returned HTTP 402. Check its credentials and tool support in Models.');
const BUSY = new Error('another teammate is using the shared computer');
const GEORGE = 'If you\'d like, open implement_fix in Activity and pick a Recovery action (or tell me a different next step), and the team can pick the fix work back up. Nothing else needs attention from me right now.';
const OPTIONS = [
  { id: 'retry', label: 'Try again' },
  { id: 'skip', label: 'Skip this' },
  { id: 'different', label: 'Try a different way' },
];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-failure-'));
  const profiles = new Map(['a', 'b'].map(id => [id, { id, name: id === 'a' ? 'Coordinator' : 'Builder', policy: 'bypass' }]));
  const chats = new Map(), sent = [], events = [];
  let clock = Date.parse('2026-10-23T00:00:00Z'), service;
  const options = {
    directory, now: () => clock, schedule: () => {}, delay: () => {},
    requireBot: id => { if (!profiles.has(id)) throw Object.assign(new Error('Unknown bot'), { status: 400 }); return profiles.get(id); },
    conversations: () => ({ send: (chatId, message) => sent.push({ chatId, message }), stop: async () => {}, isRunning: () => false, detail: id => ({ conversation: chats.get(id) }) }),
    createConversation(botId) { const conversation = { id: `s_${chats.size + 1}`, botId, messages: [] }; chats.set(conversation.id, conversation); return { conversation }; },
    discardConversation: id => chats.delete(id), stopDirect: async () => {},
    notify: (event, data) => { events.push({ event, data }); },
    workAuthority: () => ({ fingerprint: 'same-authority', target: { botName: 'Builder', provider: 'codex', model: 'same', computerLabel: 'Fixture', workspace: directory } }),
  };
  service = createBotTeams(options);
  const team = service.create({ name: 'Fixers', memberIds: ['a', 'b'], coordinatorId: 'a', enabled: true, limits: { maxParallel: 1 } }).team;
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const jobs = runId => JSON.parse(readFileSync(join(directory, 'bot-teams.json'))).jobs.filter(job => job.runId === runId);
  const context = job => ({ bot: profiles.get(job.botId), chatId: job.chatId, turnId: `turn_${job.id}`, toolCallId: `call_${job.id}`, assertLive() {}, requestPermission: async () => true, requestTeamPermission: async () => true });
  return {
    directory, sent, events, team, jobs, context, chats,
    get service() { return service; },
    advance(ms) { clock += ms; },
    channel: () => service.channel(team.id),
    start() {
      const run = service.message(team.id, { message: 'Fix the build', requestId: `req_${sent.length}_${clock}`, workMode: 'work' }).run;
      service.tick();
      return run;
    },
  };
}

function failTask(f, run, error) {
  const job = f.jobs(run.id).find(row => row.state === 'running');
  assert.ok(job, 'a team task should be running');
  const ctx = f.context(job);
  f.service.begin(ctx);
  f.service.end(ctx, { error });
  return job;
}

async function assignChild(f, run) {
  const root = f.jobs(run.id).find(row => row.state === 'running' && row.botId === 'a');
  const ctx = f.context(root);
  f.service.begin(ctx);
  await f.service.execute('assign_team_task', { botId: 'b', message: 'Fix the failing check' }, { ...ctx, toolCallId: 'assign_fix' });
  f.service.end(ctx, { publicReply: 'Builder, please take the fix.' });
  f.service.tick();
  return f.jobs(run.id).find(row => row.botId === 'b' && row.state === 'running');
}

test('a transient team task retries twice with backoff before any chat line', async t => {
  const f = fixture(t), run = f.start();
  const child = await assignChild(f, run);
  const before = f.channel().messages.length;
  const secret = () => JSON.stringify(f.channel()).includes('SECRET_TOKEN_91') || f.events.some(row => JSON.stringify(row).includes('SECRET_TOKEN_91'));
  failTask(f, run, TIMEOUT);
  f.service.tick();
  assert.equal(f.channel().messages.length, before);
  assert.equal(f.events.some(row => row.event === 'task.recovery'), false);
  assert.equal(secret(), false);
  assert.equal(f.jobs(run.id).find(row => row.id === child.id).state, 'queued');
  f.advance(transientRetryDelayMs(1) - 1); f.service.tick();
  assert.equal(f.jobs(run.id).find(row => row.id === child.id).state, 'queued');
  assert.equal(f.sent.filter(row => row.chatId === child.chatId).length, 1);
  f.advance(1); f.service.tick();
  assert.equal(f.jobs(run.id).find(row => row.id === child.id).state, 'running');
  failTask(f, run, LIMIT);
  f.service.tick();
  assert.equal(f.events.some(row => row.event === 'task.recovery'), false);
  f.advance(transientRetryDelayMs(2) - 1); f.service.tick();
  assert.equal(f.sent.filter(row => row.chatId === child.chatId).length, 2);
  f.advance(1); f.service.tick();
  failTask(f, run, BUSY);
  const asked = f.channel().messages.filter(row => row.recovery);
  assert.equal(asked.length, 1);
  assert.equal(f.sent.filter(row => row.chatId === child.chatId).length, 3);
  assert.equal(secret(), false);
  assert.match(asked[0].content, /computer it needs is in use/);
  assert.match(asked[0].content, /What should I do next\?$/);
  assert.equal(asked[0].content.includes('implement_fix'), false);
  assert.equal(asked[0].content.includes('Activity'), false);
  assert.equal(/recovery/i.test(asked[0].content), false);
  assert.equal(asked[0].content.includes(child.id), false);
  assert.deepEqual(asked[0].recovery.options, OPTIONS);
  assert.equal(asked[0].recovery.question, 'What should I do next?');
  assert.equal(asked[0].recovery.jobId, child.id);
  assert.equal(asked[0].recovery.runId, run.id);
  const event = f.events.filter(row => row.event === 'task.recovery');
  assert.equal(event.length, 1);
  assert.deepEqual(event[0].data, { teamId: f.team.id, messageId: asked[0].id, jobId: child.id, runId: run.id, text: asked[0].content, question: asked[0].recovery.question, options: OPTIONS });
});

test('a billing failure asks once, keeps Activity recovery, and does not retry or add filler', async t => {
  const f = fixture(t), run = f.start();
  const job = failTask(f, run, BILLING);
  f.advance(transientRetryDelayMs(1) + transientRetryDelayMs(2)); f.service.tick();
  assert.equal(f.sent.filter(row => row.chatId === job.chatId).length, 1);
  const asked = f.channel().messages.find(row => row.recovery);
  assert.ok(asked);
  assert.match(asked.content, /billing or credits/);
  assert.match(asked.content, /What should I do next\?$/);
  assert.equal(asked.content.includes('HTTP 402'), false);
  assert.equal(/nothing else needs attention/i.test(JSON.stringify(f.channel().messages.map(row => row.content))), false);
  const plan = f.service.recoveryPlan(f.team.id, job.id);
  assert.equal(plan.plan.jobId, job.id);
  assert.equal(plan.plan.canResume, true);
  assert.ok(plan.plan.steps.length);
});

test('the coordinator is not posted when it only points at Activity, and a useful line keeps its point', async t => {
  const f = fixture(t), run = f.start();
  await assignChild(f, run);
  failTask(f, run, BILLING);
  f.service.tick();
  const follow = f.jobs(run.id).find(row => row.state === 'running');
  assert.ok(follow);
  const ctx = f.context(follow);
  f.service.begin(ctx);
  assert.match(f.service.instructions(ctx), /end silently/);
  assert.match(f.service.instructions(ctx), /Never tell the owner that nothing else needs attention/);
  assert.doesNotMatch(f.service.instructions(ctx), /select its Recovery action/);
  assert.doesNotMatch(f.service.instructions(ctx), /Recovery action in the app/);
  f.service.end(ctx, { publicReply: GEORGE });
  const text = f.channel().messages.map(row => row.content).join('\n');
  assert.equal(text.includes('implement_fix'), false);
  assert.equal(text.includes('Activity'), false);
  assert.equal(/recovery action/i.test(text), false);
  assert.equal(/nothing else needs attention/i.test(text), false);
  const root = f.start();
  const running = f.jobs(root.id).find(row => row.state === 'running');
  const reply = f.context(running);
  f.service.begin(reply);
  f.service.end(reply, { publicReply: 'The notes are in the shared folder. Nothing else needs attention from me right now.' });
  assert.ok(f.channel().messages.some(row => row.content === 'The notes are in the shared folder.'));
  assert.equal(f.channel().messages.some(row => /nothing else needs attention/i.test(row.content)), false);
});

test('recovery choices retry, skip, or record another approach without a second lecture', async t => {
  const f = fixture(t), run = f.start();
  const job = failTask(f, run, BILLING);
  const message = f.channel().messages.find(row => row.recovery);
  const skipped = f.service.chooseTaskRecovery(f.team.id, message.id, { choice: 'skip' });
  assert.equal(skipped.choice, 'skip');
  assert.equal(f.channel().messages.filter(row => row.content === 'Skipped.').length, 1);
  assert.equal(f.service.chooseTaskRecovery(f.team.id, message.id, { choice: 'skip' }).message.recovery.choice, 'skip');
  assert.equal(f.channel().messages.filter(row => row.content === 'Skipped.').length, 1);
  const again = f.start();
  const other = failTask(f, again, new Error('socket hang up'));
  f.advance(transientRetryDelayMs(1)); f.service.tick();
  failTask(f, again, new Error('socket hang up'));
  f.advance(transientRetryDelayMs(2)); f.service.tick();
  failTask(f, again, new Error('socket hang up'));
  const prompt = f.channel().messages.find(row => row.recovery?.jobId === other.id);
  assert.match(prompt.content, /connection dropped/);
  const different = f.service.chooseTaskRecovery(f.team.id, prompt.id, { choice: 'different' });
  assert.equal(different.choice, 'different');
  assert.equal(f.channel().messages.filter(row => row.id !== prompt.id && /different/i.test(row.content)).length, 0);
  const third = f.start();
  const retryJob = failTask(f, third, BILLING);
  const retryMessage = f.channel().messages.find(row => row.recovery?.jobId === retryJob.id);
  const before = f.sent.filter(row => row.chatId === retryJob.chatId).length;
  const retried = f.service.chooseTaskRecovery(f.team.id, retryMessage.id, { choice: 'retry' });
  assert.equal(retried.choice, 'retry');
  f.service.tick();
  assert.equal(f.jobs(third.id).find(row => row.id === retryJob.id).state, 'running');
  assert.equal(f.sent.filter(row => row.chatId === retryJob.chatId).length, before + 1);
  assert.equal(job.id !== retryJob.id, true);
});

test('the room stream emits task.recovery and the choice route accepts a button', async t => {
  const f = fixture(t), run = f.start();
  const server = http.createServer((req, res) => { routes(req, res, new URL(req.url, `http://127.0.0.1:${server.address().port}`)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const routes = createBotRoutes({ bots: { team: f.service }, port });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${origin}/api/bots/teams/${f.team.id}/channel/stream`, { headers: { Origin: origin }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const readEvent = async () => {
    while (!buffer.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Room stream ended');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const split = buffer.indexOf('\n\n');
    const event = buffer.slice(0, split);
    buffer = buffer.slice(split + 2);
    return event;
  };
  assert.match(await readEvent(), /^event: team-channel/);
  const job = failTask(f, run, BILLING);
  let recovery;
  for (let i = 0; i < 8 && !recovery; i++) {
    const raw = await readEvent();
    if (raw.startsWith('event: task.recovery')) recovery = JSON.parse(raw.slice(raw.indexOf('data: ') + 6));
  }
  assert.ok(recovery);
  assert.equal(recovery.jobId, job.id);
  assert.deepEqual(recovery.options, OPTIONS);
  assert.equal(recovery.text.includes('Activity'), false);
  const posted = await fetch(`${origin}/api/bots/teams/${f.team.id}/messages/${recovery.messageId}/choice`, {
    method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'different' }),
  });
  assert.equal(posted.status, 200);
  const body = await posted.json();
  assert.equal(body.choice, 'different');
  assert.equal(body.message.recovery.choice, 'different');
  await reader.cancel();
});

test('a saved recovery choice reloads and a broken one is left unread', t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-recovery-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const teamId = 'team_saved';
  const channels = createTeamChannels({ directory });
  const saved = channels.append(teamId, {
    kind: 'status', author: { type: 'system', name: 'Strata' }, content: 'This stopped because the connection dropped. What should I do next?',
    recovery: { jobId: 'tj_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', runId: 'tr_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', question: 'What should I do next?', options: OPTIONS },
  });
  assert.deepEqual(createTeamChannels({ directory }).find(teamId, saved.id).recovery.options, OPTIONS);
  const file = join(directory, 'bot-team-channels.json');
  const broken = JSON.parse(readFileSync(file, 'utf8'));
  broken.channels[0].messages[0].recovery = { question: 'open implement_fix in Activity' };
  writeFileSync(file, JSON.stringify(broken));
  assert.throws(() => createTeamChannels({ directory }), /recovery choice/);
});
