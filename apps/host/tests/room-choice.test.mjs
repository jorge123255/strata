import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/lib/room-choice.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, write: false, format: 'esm', platform: 'node' });
const choice = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const question = 'The work stopped partway through. Want me to try again?';

function task(overrides = {}) {
  return {
    id: 'job_fix',
    teamId: 'team_1',
    runId: 'run_1',
    title: 'implement_fix',
    state: 'error',
    updatedAt: '2026-10-22T12:00:00.000Z',
    work: { status: 'blocked', revision: 3 },
    ...overrides,
  };
}

test('a stalled task becomes a plain choice and hides internal ids', () => {
  const resolved = choice.resolveRoomChoice({ roomTeamId: 'team_1', tasks: [task()] });
  assert.equal(resolved.source, 'recovery');
  assert.equal(resolved.jobId, 'job_fix');
  assert.equal(resolved.choice.question, question);
  assert.deepEqual(resolved.choice.options, [
    { id: 'retry', label: 'Try again', style: 'primary' },
    { id: 'skip', label: 'Skip it', style: 'neutral' },
    { id: 'other', label: 'A different approach', style: 'neutral' },
  ]);
  const text = JSON.stringify(resolved.choice);
  assert.equal(text.includes('implement_fix'), false);
  assert.equal(text.includes('Recovery'), false);
  assert.equal(text.includes('Activity'), false);
  assert.equal(choice.resolveRoomChoice({ roomTeamId: 'team_1', tasks: [task({ work: { status: 'interrupted', revision: 2 } })] }).jobId, 'job_fix');
});

test('ready, verified, continued, legacy, and still-running work stay out of the card', () => {
  const hidden = [
    task({ work: { status: 'ready_for_review', revision: 1 } }),
    task({ work: { status: 'verified', revision: 1 } }),
    task({ work: { status: 'working', revision: 1 } }),
    task({ work: { status: 'blocked', revision: 1, recoveryJobId: 'job_next' } }),
    task({ work: { status: 'blocked', revision: 1, legacy: true } }),
    task({ work: { status: 'blocked', revision: 1 }, state: 'running' }),
    task({ id: 'job_active', work: { status: 'interrupted', revision: 1 } }),
    task({ work: undefined, state: 'error' }),
  ];
  for (const row of hidden) {
    const active = row.id === 'job_active' ? ['run_1'] : [];
    assert.equal(choice.resolveRoomChoice({ roomTeamId: 'team_1', tasks: [row], activeRunIds: active }), null);
  }
  const newest = choice.resolveRoomChoice({
    roomTeamId: 'team_1',
    tasks: [task({ id: 'older', updatedAt: '2026-10-21T00:00:00.000Z' }), task({ id: 'newer', updatedAt: '2026-10-23T00:00:00.000Z' })],
  });
  assert.equal(newest.jobId, 'newer');
  assert.equal(choice.resolveRoomChoice({ roomTeamId: 'team_1', tasks: [task()], dismissedIds: ['job:job_fix'] }), null);
});

test('a needs-choice event drives the same card and known ids map to recovery actions', () => {
  const event = {
    type: 'needs-choice',
    id: 'choice_1',
    teamId: 'team_1',
    jobId: 'job_fix',
    runId: 'run_1',
    question: 'Try a different folder?',
    options: [
      { id: 'retry', label: 'Retry', style: 'primary' },
      { id: 'skip', label: 'Skip' },
      { id: 'different-approach', label: 'Another way', style: 'weird' },
    ],
  };
  const resolved = choice.resolveRoomChoice({ roomTeamId: 'team_1', event, tasks: [task({ title: 'should not win' })] });
  assert.equal(resolved.source, 'event');
  assert.equal(resolved.key, 'choice_1');
  assert.equal(resolved.choice.question, 'Try a different folder?');
  assert.equal(resolved.choice.options[2].style, undefined);
  assert.equal(choice.resolveRoomChoice({ roomTeamId: 'team_1', event, tasks: [task()], dismissedIds: ['choice_1'] }).source, 'recovery');
  assert.equal(choice.resolveRoomChoice({ roomTeamId: 'team_9', event: { type: 'needs-choice', question: '  ', options: [] }, tasks: [task()] }).jobId, 'job_fix');
  const context = { teamId: 'team_1', jobId: 'job_fix', runId: 'run_1', revision: 3 };
  assert.deepEqual(choice.choiceAction('retry', context), { kind: 'resume', teamId: 'team_1', jobId: 'job_fix', revision: 3 });
  assert.deepEqual(choice.choiceAction('try-again', context).kind, 'resume');
  assert.deepEqual(choice.choiceAction('skip', context), { kind: 'skip' });
  assert.deepEqual(choice.choiceAction('different-approach', context), { kind: 'different' });
  assert.deepEqual(choice.choiceAction('other', context), { kind: 'different' });
  assert.deepEqual(choice.choiceAction('stop', context), { kind: 'stop', teamId: 'team_1', runId: 'run_1' });
  assert.equal(choice.choiceAction('retry', { teamId: 'team_1' }), null);
  assert.equal(choice.choiceAction('stop', { teamId: 'team_1', jobId: 'job_fix' }), null);
  assert.equal(choice.choiceAction('invent', context), null);
});

test('the chat card is generic and the room renders it with the coucou spring', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [card, channel, css, motion, review] = await Promise.all([
    readFile(new URL('../src/components/RoomChoiceCard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/BotTeamChannel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/BotTeamChannel.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/chat-motion.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/BotTaskReview.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(card, /question/);
  assert.match(card, /options/);
  assert.match(card, /data-style/);
  assert.doesNotMatch(card, /implement_fix|Recovery action|\/recovery|\/resume/);
  assert.match(channel, /RoomChoiceCard/);
  assert.match(channel, /resolveRoomChoice/);
  assert.match(channel, /choiceAction/);
  assert.match(css, /\.bot-room-choice[\s\S]*var\(--ease-pop\)/);
  assert.match(motion, /\.bot-room-choice/);
  assert.equal(review.includes('Review recovery'), false);
  assert.equal(root.length > 0, true);
});
