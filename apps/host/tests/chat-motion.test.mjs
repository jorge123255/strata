import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/lib/chat-motion.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, write: false, format: 'esm', platform: 'node' });
const motion = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const frame = (seq, text, extra = {}) => ({ teamId: 'team_1', messageId: 'tm_job', botId: 'bot_1', seq, text, delta: text, done: false, ...extra });

test('message.partial keeps the full text, starts at seq 1, and drops a cleared draft', () => {
  const first = motion.applyMessagePartial([], frame(1, 'Hi'), 'team_1');
  assert.deepEqual(first, [{ messageId: 'tm_job', botId: 'bot_1', seq: 1, text: 'Hi', done: false }]);
  const second = motion.applyMessagePartial(first, frame(2, 'Hi there', { delta: ' there' }), 'team_1');
  assert.equal(second[0].text, 'Hi there');
  assert.equal(second[0].seq, 2);
  assert.equal(motion.applyMessagePartial(second, frame(2, 'Hi there, stale'), 'team_1')[0].text, 'Hi there');
  assert.equal(motion.applyMessagePartial(second, frame(0, 'nope'), 'team_1')[0].text, 'Hi there');
  assert.equal(motion.applyMessagePartial(second, frame(1.5, 'nope'), 'team_1')[0].text, 'Hi there');
  assert.equal(motion.applyMessagePartial(second, frame(3, 'elsewhere', { teamId: 'team_2' }), 'team_1')[0].text, 'Hi there');
  const done = motion.applyMessagePartial(second, frame(3, 'Hi there!', { delta: '!', done: true }), 'team_1');
  assert.equal(done[0].text, 'Hi there!');
  assert.equal(done[0].done, true);
  assert.deepEqual(motion.applyMessagePartial(done, frame(4, '', { done: true }), 'team_1'), []);
  assert.equal(first[0].text, 'Hi', 'A partial update copies the list instead of editing it.');
});

test('streaming reveals whole words at a steady pace and snaps when motion is reduced', () => {
  const waiting = motion.advanceStream('', 'Hi there', 50, 0, false, false);
  assert.equal(waiting.shown, '');
  assert.ok(waiting.carry > 1);
  const firstWord = motion.advanceStream(waiting.shown, 'Hi there', 50, waiting.carry, false, false);
  assert.equal(firstWord.shown, 'Hi ');
  let step = firstWord;
  let hops = 0;
  while (step.shown !== 'Hi there' && hops < 8) {
    assert.ok(step.shown === '' || step.shown === 'Hi ' || step.shown === 'Hi there');
    step = motion.advanceStream(step.shown, 'Hi there', 80, step.carry, false, false);
    hops += 1;
  }
  assert.equal(step.shown, 'Hi there');
  assert.ok(hops > 1, 'A multi-word reply is not dumped in one step.');
  assert.equal(motion.advanceStream('Hel', 'Hello', 16, 0, true, false).shown, 'Hello');
  assert.equal(motion.advanceStream('Hello', 'Nope', 16, 0, false, false).shown, 'Nope');
  const slow = motion.advanceStream('', 'a'.repeat(10), 1000, 0, false, false);
  const fast = motion.advanceStream('', 'a'.repeat(400), 1000, 0, false, false);
  assert.ok(fast.shown.length > slow.shown.length);
  const coasting = motion.advanceStream('', 'Hello there friend', 80, 0, false, false);
  const finishing = motion.advanceStream('', 'Hello there friend', 80, 0, false, true);
  assert.ok(finishing.shown.length > coasting.shown.length);
  assert.deepEqual(motion.splitStreamTail('Hi there'), { prefix: 'Hi ', word: 'there' });
  assert.deepEqual(motion.splitStreamTail('Hi '), { prefix: '', word: 'Hi ' });
});

test('only messages after the first ready snapshot animate, with a faster own message and a bot stagger', () => {
  const loading = motion.planEntrances(new Set(), [{ id: 'm1', own: true }], false, false);
  assert.equal(loading.primed, false);
  assert.equal(loading.entrances.length, 0);
  const history = motion.planEntrances(loading.seen, [{ id: 'm1', own: true }, { id: 'm2', own: false }], false, true);
  assert.equal(history.primed, true);
  assert.deepEqual(history.entrances, []);
  const own = motion.planEntrances(history.seen, [{ id: 'm1', own: true }, { id: 'm2', own: false }, { id: 'm3', own: true }], true, true);
  assert.deepEqual(own.entrances, [{ id: 'm3', ms: 180, delay: 0 }]);
  const burst = motion.planEntrances(own.seen, [
    { id: 'm1', own: true }, { id: 'm2', own: false }, { id: 'm3', own: true },
    { id: 'b1', own: false }, { id: 'b2', own: false },
  ], true, true);
  assert.deepEqual(burst.entrances, [{ id: 'b1', ms: 220, delay: 0 }, { id: 'b2', ms: 220, delay: 40 }]);
  const earlier = motion.planEntrances(burst.seen, [{ id: 'old', own: false }, { id: 'm1', own: true }], true, true);
  assert.deepEqual(earlier.entrances, []);
  assert.ok(earlier.seen.has('old'));
  const alone = motion.planEntrances(earlier.seen, [...earlier.seen].map(id => ({ id, own: false })).concat([{ id: 'solo', own: false }]), true, true);
  assert.deepEqual(alone.entrances, [{ id: 'solo', ms: 220, delay: 0 }]);
  const seen = new Set(['m1', 'm2']);
  const mixed = motion.planEntrances(seen, [
    { id: 'm1', own: true }, { id: 'stale', own: false }, { id: 'm2', own: false }, { id: 'm3', own: true },
  ], true, true);
  assert.deepEqual(mixed.entrances, [{ id: 'm3', ms: 180, delay: 0 }]);
  assert.ok(mixed.seen.has('stale'));
  assert.equal(mixed.entrances.some(row => row.id === 'stale'), false);
  const replaced = motion.planEntrances(new Set(['m1']), [{ id: 'x', own: true }, { id: 'y', own: false }], true, true);
  assert.deepEqual(replaced.entrances, []);
  assert.ok(replaced.seen.has('y'));
});

test('a newly appended own message follows the bottom, and older rows do not', () => {
  const previous = ['m1', 'm2'];
  assert.equal(motion.shouldFollowOwnMessage(previous, [
    { id: 'm1', own: true }, { id: 'm2', own: false }, { id: 'm3', own: true },
  ]), true);
  assert.equal(motion.shouldFollowOwnMessage(previous, [
    { id: 'old', own: false }, { id: 'm1', own: true }, { id: 'm2', own: false },
  ]), false);
  assert.equal(motion.shouldFollowOwnMessage(previous, [
    { id: 'm1', own: true }, { id: 'stale', own: false }, { id: 'm2', own: false }, { id: 'm3', own: true },
  ]), true);
  assert.equal(motion.shouldFollowOwnMessage(['m3'], [
    { id: 'm1', own: true }, { id: 'm3', own: true },
  ]), false);
  assert.equal(motion.shouldFollowOwnMessage(previous, [
    { id: 'm1', own: true }, { id: 'm2', own: false }, { id: 'b1', own: false },
  ]), false);
});

test('bottom following eases out over 200ms', () => {
  assert.equal(motion.followOffset(0, 80, 0, 200), 0);
  assert.equal(motion.followOffset(0, 100, 100, 200), 87.5);
  assert.equal(motion.followOffset(0, 100, 200, 200), 100);
  assert.ok(motion.followOffset(0, 100, 100, 200) > 50);
});

test('the chat motion stylesheet carries the coucou timings and pauses loops', async () => {
  const css = await readFile(new URL('../src/styles/chat-motion.css', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(main, /chat-motion\.css/);
  assert.match(css, /@keyframes msgIn/);
  assert.match(css, /translateY\(8px\)/);
  assert.match(css, /scale\(0\.98\)/);
  assert.match(css, /220ms/);
  assert.match(css, /scale\(0\.6\)/);
  assert.match(css, /scale\(1\.2\)/);
  assert.match(css, /0\.9s/);
  assert.match(css, /0\.14s/);
  assert.match(css, /2\.2s/);
  assert.match(css, /animation-play-state:\s*paused/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /data-motion='reduced'/);
  assert.match(css, /cubic-bezier\(\.3,\s*1\.2,\s*\.4,\s*1\)/);
  assert.match(css, /cubic-bezier\(\.45,\s*0,\s*\.2,\s*1\)/);
  assert.match(css, /120ms/);
  const channel = await readFile(new URL('../src/screens/BotTeamChannel.tsx', import.meta.url), 'utf8');
  const channelCss = await readFile(new URL('../src/screens/BotTeamChannel.css', import.meta.url), 'utf8');
  const botsCss = await readFile(new URL('../src/screens/Bots.css', import.meta.url), 'utf8');
  assert.match(channel, /shouldFollowOwnMessage/);
  assert.match(channelCss, /\.bot-room-work-mode p \{[^}]*min-width:\s*0/);
  assert.match(botsCss, /container-name:\s*bots/);
  assert.match(botsCss, /@container bots \(max-width: 920px\)/);
  assert.match(botsCss, /@container bots \(max-width: 640px\)/);
  assert.match(botsCss, /\.bots-workspace-page \{[^}]*min-width:\s*0/);
});
