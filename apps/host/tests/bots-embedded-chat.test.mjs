import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const { code } = await transform(await readFile(new URL('../src/lib/chat-context.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { selectedChat } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const control = await transform(await readFile(new URL('../src/lib/bot-computer-control.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { releaseAfterComputerAction, acceptsComputerResponse } = await import(`data:text/javascript;base64,${Buffer.from(control.code).toString('base64')}`);

test('embedded bot conversations resolve the exact shared conversation identity', () => {
  const sessions = [{ id: 'maya-chat' }, { id: 'bot-a-chat' }, { id: 'bot-b-chat' }];
  assert.equal(selectedChat(sessions, 'bot-b-chat', true), sessions[2]);
  assert.equal(selectedChat([...sessions].reverse(), 'bot-a-chat', true), sessions[1]);
});

test('a removed or delayed embedded chat never opens another bot or Maya chat', () => {
  const sessions = [{ id: 'maya-chat' }, { id: 'other-bot-chat' }];
  assert.equal(selectedChat(sessions, 'removed-chat', true), null);
  assert.equal(selectedChat(sessions, undefined, true), null);
  assert.equal(selectedChat([], 'not-loaded-yet', true), null);
});

test('ordinary chat retains its existing landing fallback', () => {
  const sessions = [{ id: 'first' }, { id: 'second' }];
  assert.equal(selectedChat(sessions, 'second'), sessions[1]);
  assert.equal(selectedChat(sessions, 'missing'), sessions[0]);
  assert.equal(selectedChat([], undefined), null);
});

test('hiding a computer during input waits for server acknowledgement before release', async () => {
  const events = [];
  let acknowledge;
  const input = new Promise(resolve => { acknowledge = resolve; });
  const closing = releaseAfterComputerAction(input, async () => { events.push('release'); });
  await Promise.resolve();
  assert.deepEqual(events, []);
  events.push('input ended'); acknowledge();
  await closing;
  assert.deepEqual(events, ['input ended', 'release']);
});

test('a failed input still releases its captured lease after completion', async () => {
  let released = false;
  await releaseAfterComputerAction(Promise.reject(new Error('input failed')), async () => { released = true; });
  assert.equal(released, true);
});

test('hiding and returning before a delayed takeover completes cannot revive its grant', async () => {
  let generation = 0, visible = true, complete;
  const requested = generation;
  const response = new Promise(resolve => { complete = resolve; });
  const accepted = response.then(() => acceptsComputerResponse(requested, generation, true, visible));
  visible = false; generation++;
  visible = true;
  complete();
  assert.equal(await accepted, false);
  assert.equal(acceptsComputerResponse(generation, generation, true, true), true);
  assert.equal(acceptsComputerResponse(generation, generation, false, true), false);
});
