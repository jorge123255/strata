import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/lib/room-choice.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, write: false, format: 'esm', platform: 'node' });
const choice = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const options = [
  { id: 'retry', label: 'Try again' },
  { id: 'skip', label: 'Skip this' },
  { id: 'different', label: 'Try a different way' },
];
const text = 'This stopped because the connection dropped before it finished. What should I do next?';

function message(recovery, content = text) {
  return { id: 'tm_1', teamId: 'team_1', content, recovery };
}

test('a saved recovery field uses the host sentence and option labels', () => {
  const resolved = choice.recoveryFromMessage(message({ jobId: 'tj_1', runId: 'tr_1', question: 'What should I do next?', options }));
  assert.equal(resolved.messageId, 'tm_1');
  assert.equal(resolved.text, text);
  assert.equal(resolved.question, 'What should I do next?');
  assert.deepEqual(resolved.options.map(option => option.label), ['Try again', 'Skip this', 'Try a different way']);
  assert.equal(resolved.choice, undefined);
  assert.equal(JSON.stringify(resolved).includes('implement_fix'), false);
  const chosen = choice.recoveryFromMessage(message({ jobId: 'tj_1', runId: 'tr_1', question: 'What should I do next?', options, choice: 'skip' }));
  assert.equal(chosen.choice, 'skip');
  assert.equal(choice.recoveryFromMessage(message({ jobId: 'tj_1', runId: 'tr_1', question: 'What should I do next?', options, choice: 'resume' })).choice, undefined);
  assert.equal(choice.recoveryFromMessage({ id: 'tm_1', teamId: 'team_1', content: text }), null);
});

test('the live event and the web event use the same shape, and text is the body', () => {
  const event = {
    teamId: 'team_1', messageId: 'tm_1', jobId: 'tj_1', runId: 'tr_1',
    text, question: 'What should I do next?', options,
  };
  assert.deepEqual(choice.recoveryFromEvent(event), { ...event, options });
  const live = choice.presentRecovery(message(undefined, 'older line'), event);
  assert.equal(live.text, text);
  assert.equal(live.choice, undefined);
  const saved = choice.presentRecovery(message({ jobId: 'tj_1', runId: 'tr_1', question: 'What should I do next?', options, choice: 'retry' }), event);
  assert.equal(saved.choice, 'retry');
  assert.equal(saved.text, text);
  assert.equal(choice.recoveryFromEvent({ ...event, messageId: '' }), null);
  assert.equal(choice.recoveryFromEvent(null), null);
});

test('a button posts retry, skip, different, or continue', () => {
  assert.deepEqual(choice.choicePayload('retry'), { choice: 'retry' });
  assert.deepEqual(choice.choicePayload('skip'), { choice: 'skip' });
  assert.deepEqual(choice.choicePayload('different'), { choice: 'different' });
  assert.deepEqual(choice.choicePayload('continue'), { choice: 'continue' });
  assert.equal(choice.choicePayload('other'), null);
  assert.equal(choice.choicePayload('different-approach'), null);
  assert.equal(choice.choicePayload('resume'), null);
  assert.equal(choice.choicePayload('Try again'), null);
});

test('a paused recovery shows the host text and a primary continue button', () => {
  const summary = 'I finished inspect. The rest of this request is still left.';
  const paused = choice.recoveryFromMessage(message({
    kind: 'paused', jobId: 'tj_1', runId: 'tr_1', text: summary, question: 'Keep going?',
    options: [{ id: 'continue', label: 'Keep going' }],
  }, 'older line'));
  assert.equal(paused.kind, 'paused');
  assert.equal(paused.text, summary);
  assert.equal(paused.question, 'Keep going?');
  assert.deepEqual(paused.options, [{ id: 'continue', label: 'Keep going', style: 'primary' }]);
  const live = choice.recoveryFromEvent({
    teamId: 'team_1', messageId: 'tm_1', jobId: 'tj_1', runId: 'tr_1', kind: 'paused',
    text: summary, question: 'Keep going?', options: [{ id: 'continue', label: 'Keep going' }],
  });
  assert.equal(live.kind, 'paused');
  assert.equal(live.text, summary);
  assert.equal(live.options[0].style, 'primary');
  assert.equal(live.options[0].label, 'Keep going');
  const nested = choice.recoveryFromEvent({
    teamId: 'team_1', messageId: 'tm_1', jobId: 'tj_1', runId: 'tr_1',
    recovery: { kind: 'paused', text: summary, question: 'Keep going?', options: [{ id: 'continue', label: 'Keep going' }] },
  });
  assert.equal(nested.kind, 'paused');
  assert.equal(nested.text, summary);
});

test('the room card renders host labels, marks a saved choice, and retries a failed post', async () => {
  const [card, channel, css, client, store] = await Promise.all([
    readFile(new URL('../src/components/RoomChoiceCard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/BotTeamChannel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/BotTeamChannel.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/store.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(card, /data-kind=\{paused \? 'paused' : undefined\}/);
  assert.match(card, /\{body\}/);
  assert.match(card, /option\.label/);
  assert.match(card, /aria-pressed=\{selected\}/);
  assert.match(card, /onRetry/);
  assert.doesNotMatch(card, /Try again|Skip this|Skip it|A different approach|implement_fix/);
  assert.match(channel, /recoveryFromEvent/);
  assert.match(channel, /presentRecovery/);
  assert.match(channel, /strata:task-recovery/);
  assert.match(channel, /\/messages\/\$\{encodeURIComponent\(card\.messageId\)\}\/choice/);
  assert.match(channel, /choicePayload/);
  assert.doesNotMatch(channel, /\/jobs\/\$\{encodeURIComponent|\/resume/);
  assert.match(css, /\.bot-room-choice-actions button\[aria-pressed='true'\]/);
  assert.match(css, /\.bot-room-choice-error/);
  assert.match(client, /'task\.recovery'/);
  assert.match(store, /case 'task\.recovery':/);
  assert.match(store, /strata:task-recovery/);
});
