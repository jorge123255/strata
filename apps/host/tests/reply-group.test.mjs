import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

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

test('a live draft joins a replyGroupId stack and a lone draft stays out', () => {
  const saved = [
    message({ id: 'user', author: 'user', content: '@everyone look' }),
    message({ id: 'a', replyGroupId: 'user', content: 'On it' }),
  ];
  const partner = message({ id: 'draft-b', replyGroupId: 'user', content: 'Me too' });
  const alone = message({ id: 'draft-c', replyGroupId: 'other', content: 'Solo' });
  const plain = message({ id: 'draft-d', content: 'No group' });
  const joined = replies.withLiveReplyDrafts(saved, [partner, alone, plain]);
  assert.deepEqual(joined.map(row => row.id), ['user', 'a', 'draft-b']);
  const stacked = replies.groupRoomReplies(joined, members);
  assert.deepEqual(shape(stacked), ['user', 'group:user:a+draft-b']);
  const twoDrafts = replies.withLiveReplyDrafts([], [
    message({ id: 'draft-a', replyGroupId: 'tm_user', content: 'First' }),
    message({ id: 'draft-b', replyGroupId: 'tm_user', content: 'Second' }),
  ]);
  assert.deepEqual(shape(replies.groupRoomReplies(twoDrafts, members)), ['group:tm_user:draft-a+draft-b']);
});

test('the header counts the send-time roster and names who has not replied', () => {
  const trigger = { recipientIds: ['bot_c', 'bot_a', ' bot_b ', 'bot_a'] };
  assert.deepEqual(replies.replyGroupRoster(trigger, ['bot_x']), ['bot_c', 'bot_a', 'bot_b']);
  assert.deepEqual(replies.replyGroupRoster({ recipientIds: ['', '  '] }, members), members);
  assert.deepEqual(replies.replyGroupRoster(undefined, members), members);
  const rows = [{ author: { botId: 'bot_a' } }, { author: { botId: 'bot_a' } }, { author: { botId: 'bot_z' } }];
  assert.equal(replies.replyGroupRepliedCount(rows, ['bot_a', 'bot_b', 'bot_c']), 1);
  assert.deepEqual(replies.replyGroupGaps(rows, ['bot_a', 'bot_b', 'bot_c']), ['bot_b', 'bot_c']);
  assert.equal(replies.replyGroupLabel(1, 3), '1 of 3 bots replied');
  assert.equal(replies.replyGroupLabel(2, 4), '2 of 4 bots replied');
  assert.equal(replies.replyRoundIsLive({ triggerRunId: 'run_1', activeRunIds: ['run_1'], missingBotIds: ['bot_b'] }), true);
  assert.equal(replies.replyRoundIsLive({ triggerRunId: 'run_1', activeRunIds: [], missingBotIds: ['bot_b'], drafting: true }), true);
  assert.equal(replies.replyRoundIsLive({ triggerRunId: 'run_1', activeRunIds: [], missingBotIds: ['bot_b'], presence: [{ botId: 'bot_b', state: 'queued', runId: 'run_1' }] }), true);
  assert.equal(replies.replyRoundIsLive({ triggerRunId: 'run_1', activeRunIds: [], missingBotIds: ['bot_b'], presence: [{ botId: 'bot_a', state: 'working', runId: 'run_1' }] }), false);
  assert.equal(replies.replyRoundIsLive({ triggerRunId: 'run_1', activeRunIds: ['run_9'], missingBotIds: ['bot_b'] }), false);
  assert.equal(replies.memberReplyState({ hasReply: true, roundLive: true, passed: true }), 'replied');
  assert.equal(replies.memberReplyState({ hasReply: false, roundLive: true, passed: true }), 'passed');
  assert.equal(replies.memberReplyState({ hasReply: false, roundLive: true, passed: false }), 'working');
  assert.equal(replies.memberReplyState({ hasReply: false, roundLive: false, passed: false }), 'absent');
  assert.equal(replies.memberChoseToPass('bot_b', [{ author: { botId: 'bot_b' }, kind: 'message', content: '' }]), false);
  assert.equal(replies.memberChoseToPass('bot_b', []), false);
  assert.equal(replies.memberReplyLine('passed'), 'passed');
  assert.equal(replies.memberReplyLine('working'), 'Still working');
  assert.equal(replies.memberReplyLine('absent'), "didn't reply");
  assert.equal(replies.memberReplyLabel('Cleo', 'passed'), 'Cleo passed');
  assert.equal(replies.memberReplyLabel('Cleo', 'working'), 'Cleo. Still working');
  assert.equal(replies.memberReplyLabel('Dot', 'absent'), "Dot didn't reply");
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
  assert.match(channel, /withLiveReplyDrafts\(channel\.messages/);
  assert.match(channel, /groupRoomReplies\(roomMessages, team\.memberIds\)/);
  assert.match(channel, /applyChannelReplyGroup/);
  assert.match(channel, /ReplyGroupStack/);
  assert.match(channel, /replyGroupRoster/);
  assert.match(channel, /replyRoundIsLive/);
  assert.match(stack, /replyGroupLabel/);
  assert.match(stack, /memberReplyState/);
  assert.match(stack, /memberChoseToPass/);
  assert.match(stack, /memberReplyLine/);
  assert.match(stack, /is-missing/);
  assert.match(stack, /replyGroupPreview/);
  assert.match(stack, /replyGroupStaggerMs\(index\)/);
  assert.match(stack, /aria-expanded=\{open\}/);
  assert.match(stack, /REPLY_GROUP_PREVIEW/);
  assert.match(stack, /data-message-id=\{message\.id\}/);
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.match(css, /\.bot-room-reply-row\.is-missing/);
  assert.match(css, /\.bot-room-reply-group-header:focus-visible/);
  assert.match(model, /var replyGroupId: String\?/);
  assert.match(logic, /static let previewLimit = 5/);
  assert.match(logic, /static let staggerSeconds = 0\.06/);
  assert.match(logic, /of \\\(expected\) bots replied/);
  assert.match(logic, /func memberReplyState/);
  assert.match(logic, /func memberChoseToPass/);
  assert.match(logic, /case \.passed: return "passed"/);
  assert.match(logic, /Still working/);
  assert.match(logic, /didn't reply/);
  assert.match(phone, /memberReplyState/);
  assert.match(phone, /memberChoseToPass/);
  assert.match(phone, /state\.line/);
  assert.match(phone, /RoomReplyGroup\.label\(replied:/);
  assert.match(phone, /RoomReplyGroup\.group/);
  assert.match(phone, /RoomReplyGroup\.stagger/);
});

const executablePath = [process.env.STRATA_UI_BROWSER, '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => path && existsSync(path));
const src = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

test('a missing teammate is a muted row, and a live round says still working', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 90000 }, async t => {
  const bots = [
    { id: 'bot_a', name: 'Ada' },
    { id: 'bot_b', name: 'Bolt' },
    { id: 'bot_c', name: 'Cleo' },
    { id: 'bot_d', name: 'Dot' },
  ];
  const messages = [
    { id: 'a', sequence: 2, teamId: 'team', kind: 'message', author: { type: 'bot', botId: 'bot_a', name: 'Ada' }, content: 'On it.', createdAt: '' },
    { id: 'b', sequence: 3, teamId: 'team', kind: 'message', author: { type: 'bot', botId: 'bot_b', name: 'Bolt' }, content: 'Looking now.', createdAt: '' },
  ];
  const entry = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReplyGroupStack } from ${JSON.stringify(join(src, 'components/ReplyGroupStack.tsx'))};
import ${JSON.stringify(join(src, 'screens/BotTeamChannel.css'))};
const bots = ${JSON.stringify(bots)};
const messages = ${JSON.stringify(messages)};
const props = { messages, bots, entranceFor: () => undefined, disabled: false, onReply: () => {} };
function App() {
  return <main style={{ width: '420px', padding: '20px' }}>
    <ReplyGroupStack {...props} triggerId="done" roster={['bot_a', 'bot_b', 'bot_c', 'bot_d']} live={false}/>
    <ReplyGroupStack {...props} triggerId="live" roster={['bot_a', 'bot_b', 'bot_c']} live={true}/>
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
  const { outputFiles } = await build({ stdin: { contents: entry, resolveDir: src, loader: 'tsx' }, bundle: true, write: false, outfile: 'harness.js', format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' } });
  const js = outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(path => readFileSync(join(src, path), 'utf8')).join('\n') + '\n' + (outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '');
  const reply = (res, body, status, type) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') return reply(res, '<!doctype html><html data-theme="dark" data-motion="reduced"><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script src="/harness.js"></script>', 200, 'text/html');
    if (path === '/harness.js') return reply(res, js, 200, 'text/javascript');
    if (path === '/harness.css') return reply(res, css, 200, 'text/css');
    res.writeHead(204); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('region', { name: '2 of 4 bots replied' }).waitFor();
  await page.getByRole('region', { name: '2 of 3 bots replied' }).waitFor();
  const finished = page.getByRole('region', { name: '2 of 4 bots replied' });
  const running = page.getByRole('region', { name: '2 of 3 bots replied' });
  assert.equal(await finished.getByRole('article', { name: "Cleo didn't reply" }).count(), 1);
  assert.equal(await finished.getByRole('article', { name: "Dot didn't reply" }).count(), 1);
  assert.equal(await finished.locator('[data-missing] button').count(), 0);
  assert.equal(await finished.getByRole('button', { name: 'Reply to Ada' }).count(), 1);
  assert.equal(await running.getByRole('article', { name: 'Cleo. Still working' }).count(), 1);
  assert.equal(await running.locator('[data-reply-state="working"]').count(), 1);
  assert.equal(await finished.locator('[data-reply-state="absent"]').count(), 2);
  assert.equal(await page.locator('[data-reply-state="passed"]').count(), 0);
  assert.deepEqual(errors, []);
  const shots = '/opt/cursor/artifacts/screenshots';
  mkdirSync(shots, { recursive: true });
  await page.locator('main').screenshot({ path: join(shots, 'reply-group-missing.png') });
});
