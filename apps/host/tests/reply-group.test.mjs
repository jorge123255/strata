import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/lib/reply-group.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, write: false, format: 'esm', platform: 'node' });
const replies = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const members = ['bot_a', 'bot_b', 'bot_c'];

function message(partial) {
  return {
    id: partial.id,
    kind: partial.kind ?? 'message',
    author: { type: partial.author ?? 'bot' },
    content: partial.content ?? 'Ready.',
    replyToId: partial.replyToId,
    replyGroupId: partial.replyGroupId,
    recipientIds: partial.recipientIds,
    recovery: partial.recovery,
  };
}

function shape(items) {
  return items.map(item => item.kind === 'message' ? item.message.id : `group:${item.group.triggerId}:${item.group.messages.map(row => row.id).join('+')}`);
}

test('replyGroupId stacks every matching bot reply at the first one', () => {
  const items = replies.groupRoomReplies([
    message({ id: 'user', author: 'user', content: 'Please look' }),
    message({ id: 'a', replyGroupId: 'user', content: 'On it' }),
    message({ id: 'side', author: 'user', content: 'A side note' }),
    message({ id: 'b', replyGroupId: ' user ', content: 'Me too' }),
    message({ id: 'c', replyGroupId: 'other' }),
  ], members);
  assert.deepEqual(shape(items), ['user', 'group:user:a+b', 'side', 'c']);
  assert.equal(items[1].group.id, 'a');
});

test('one replyGroupId stays a normal message and does not join a neighboring run', () => {
  const after = replies.groupRoomReplies([
    message({ id: 'user', author: 'user', content: '@everyone hi', recipientIds: members }),
    message({ id: 'a' }),
    message({ id: 'b' }),
    message({ id: 'solo', replyGroupId: 'user' }),
  ], members);
  assert.deepEqual(shape(after), ['user', 'group:user:a+b', 'solo']);
  const between = replies.groupRoomReplies([
    message({ id: 'user', author: 'user', content: '@everyone hi' }),
    message({ id: 'a' }),
    message({ id: 'solo', replyGroupId: 'user' }),
    message({ id: 'b' }),
  ], members);
  assert.deepEqual(shape(between), ['user', 'a', 'solo', 'b']);
});

test('assignments, reports, and recovery cards stay outside the stack', () => {
  const recovery = { jobId: 'tj', runId: 'tr', question: 'What should I do next?', options: [] };
  const items = replies.groupRoomReplies([
    message({ id: 'a', replyGroupId: 'user' }),
    message({ id: 'task', kind: 'assignment', replyGroupId: 'user', content: 'Do the task' }),
    message({ id: 'report', kind: 'report', replyGroupId: 'user', content: 'Done' }),
    message({ id: 'ask', replyGroupId: 'user', recovery, content: 'What should I do next?' }),
    message({ id: 'b', replyGroupId: 'user' }),
  ], members);
  assert.deepEqual(shape(items), ['group:user:a+b', 'task', 'report', 'ask']);
});

test('without replyGroupId, consecutive replies to an everyone message stack', () => {
  const items = replies.groupRoomReplies([
    message({ id: 'user', author: 'user', content: 'Please @all look' }),
    message({ id: 'later', author: 'user', content: 'after' }),
    message({ id: 'a', replyToId: 'user' }),
    message({ id: 'b', replyToId: 'user' }),
    message({ id: 'status', kind: 'status', replyToId: 'user' }),
    message({ id: 'c', replyToId: 'user' }),
  ], members);
  assert.deepEqual(shape(items), ['user', 'later', 'group:user:a+b', 'status', 'c']);
});

test('without replyGroupId, bots directly under an everyone user message stack', () => {
  const items = replies.groupRoomReplies([
    message({ id: 'user', author: 'user', content: 'Hello', recipientIds: ['bot_c', 'bot_a', 'bot_b'] }),
    message({ id: 'a', content: 'Hi from A' }),
    message({ id: 'b', content: 'Hi from B' }),
    message({ id: 'plain', author: 'user', content: 'Thanks' }),
    message({ id: 'c' }),
    message({ id: 'd' }),
  ], members);
  assert.deepEqual(shape(items), ['user', 'group:user:a+b', 'plain', 'c', 'd']);
});

test('two bots answering one person stay separate, and a typed address that is not @everyone does too', () => {
  const directed = replies.groupRoomReplies([
    message({ id: 'user', author: 'user', content: '@Ada can you look?' }),
    message({ id: 'a', replyToId: 'user' }),
    message({ id: 'b', replyToId: 'user' }),
  ], members);
  assert.deepEqual(shape(directed), ['user', 'a', 'b']);
  const email = replies.groupRoomReplies([
    message({ id: 'user', author: 'user', content: 'mail me at email@everyone' }),
    message({ id: 'a' }),
    message({ id: 'b' }),
  ], members);
  assert.deepEqual(shape(email), ['user', 'a', 'b']);
});

test('the header counts replies, the preview stays on the first line, and the stagger is 60ms', () => {
  assert.equal(replies.replyGroupLabel(1), '1 bot replied');
  assert.equal(replies.replyGroupLabel(6), '6 bots replied');
  assert.equal(replies.REPLY_GROUP_PREVIEW, 5);
  assert.equal(replies.replyGroupStaggerMs(0), 0);
  assert.equal(replies.replyGroupStaggerMs(3), 180);
  const line = 'x'.repeat(160);
  assert.equal(replies.replyGroupPreview(`${line}\nsecond`), line);
  assert.equal(replies.replyGroupPreview(`${line}y\nsecond`), `${line}…`);
  assert.equal(replies.replyGroupPreview('\n\n  Hello there  \nmore'), 'Hello there');
});

test('the room renders the stack, collapses past five, and the phone uses the same field', async () => {
  const [channel, stack, css, bots, model, logic, phone] = await Promise.all([
    readFile(new URL('../src/screens/BotTeamChannel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ReplyGroupStack.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/BotTeamChannel.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/bots.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../ios/StrataMobile/Models/BotWorkspaceModels.swift', import.meta.url), 'utf8'),
    readFile(new URL('../../ios/StrataMobile/Views/Components.swift', import.meta.url), 'utf8'),
    readFile(new URL('../../ios/StrataMobile/Views/BotWorkspaceViews.swift', import.meta.url), 'utf8'),
  ]);
  assert.match(bots, /replyGroupId\?: string/);
  assert.match(channel, /groupRoomReplies\(channel\.messages, team\.memberIds\)/);
  assert.match(channel, /ReplyGroupStack/);
  assert.match(stack, /replyGroupLabel/);
  assert.match(stack, /replyGroupPreview/);
  assert.match(stack, /replyGroupStaggerMs\(index\)/);
  assert.match(stack, /aria-expanded=\{open\}/);
  assert.match(stack, /REPLY_GROUP_PREVIEW/);
  assert.match(stack, /data-message-id=\{message\.id\}/);
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.match(css, /\.bot-room-reply-group-header:focus-visible/);
  assert.match(model, /var replyGroupId: String\?/);
  assert.match(logic, /static let previewLimit = 5/);
  assert.match(logic, /static let staggerSeconds = 0\.06/);
  assert.match(logic, /bots replied/);
  assert.match(phone, /RoomReplyGroup\.group/);
  assert.match(phone, /RoomReplyGroup\.stagger/);
});
