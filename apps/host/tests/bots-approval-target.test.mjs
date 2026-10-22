import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botApprovalTarget } from '../server/bots-approval-target.mjs';
import { createBotTools } from '../server/bots-tools.mjs';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';

test('known file, command and browser targets stay useful without exposing contents or typed values', () => {
  assert.equal(botApprovalTarget('write_file', { path: 'src/greeting.mjs', content: 'PRIVATE_FILE_CONTENT' }), 'src/greeting.mjs');
  assert.equal(botApprovalTarget('run_command', { command: 'node --test greeting.test.mjs', timeoutSeconds: 30 }), 'node --test greeting.test.mjs');
  assert.equal(botApprovalTarget('browser_open', { url: 'https://example.invalid/review' }), 'https://example.invalid/review');
  assert.equal(botApprovalTarget('browser_click', { role: 'button', name: 'Continue', password: 'PRIVATE' }), 'button: Continue');
  assert.equal(botApprovalTarget('browser_type', { label: 'Password', text: 'PRIVATE_TYPED_PASSWORD' }), 'Field: Password');
  for (const name of ['call_tool', 'MCP · Send mail', 'run_created_tool', 'native shell', 'computer_type']) {
    assert.equal(botApprovalTarget(name, { path: 'PRIVATE_PATH', command: 'PRIVATE_COMMAND', url: 'https://private.invalid', token: 'PRIVATE_TOKEN', text: 'PRIVATE_TEXT' }), undefined);
  }
});

test('credential-bearing URLs and known secret forms are hidden; long Unicode targets are bounded honestly', () => {
  assert.equal(botApprovalTarget('browser_open', { url: 'https://user:PRIVATE_PASSWORD@example.invalid/review?anything=PRIVATE_TOKEN#PRIVATE_FRAGMENT' }), 'URL details hidden: https://example.invalid/review');
  const command = botApprovalTarget('run_command', { command: 'API_KEY=PRIVATE_API --password "PRIVATE_PASSWORD" curl -H "Authorization: Bearer PRIVATE_BEARER" https://example.invalid/?q=PRIVATE_QUERY' });
  for (const secret of ['PRIVATE_API', 'PRIVATE_PASSWORD', 'PRIVATE_BEARER', 'PRIVATE_QUERY']) assert.equal(command.includes(secret), false);
  assert.equal(botApprovalTarget('run_command', { command: 'TOKEN=HIDDEN PASSWORD=HIDDEN SECRET=HIDDEN command' }).includes('HIDDEN'), false);
  assert.equal(botApprovalTarget('write_file', { path: 'path-with-owned-key' }, { secrets: ['owned-key'] }), 'path-with-[redacted]');
  const long = botApprovalTarget('run_command', { command: '😀'.repeat(5000) });
  assert.ok(long.length <= 4000); assert.equal(long.isWellFormed(), true); assert.match(long, /truncated; request a shorter action/);
  assert.equal(botApprovalTarget('run_command', { command: '\ud800' }), undefined);
  assert.equal(botApprovalTarget('browser_open', { url: 'javascript:PRIVATE' }), undefined);
});

test('real manual file approval reaches shared tool and pending targets before the write; denial remains authoritative', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-approval-target-')); let chats, stage = 0;
  const runtime = { providers: async () => [], close() {}, async run(input) {
    await input.executeTool('write_file', { path: 'approved.txt', content: 'ONLY_AFTER_APPROVAL' }, 'fixture-write');
    stage = 1;
    await input.executeTool('run_command', { command: 'echo MUST_NOT_EXECUTE' }, 'fixture-command');
    input.onFrame({ type: 'done' });
  } };
  const tools = createBotTools({ directory, processRunner: async () => { throw new Error('Denied command must not dispatch.'); } });
  const bots = createBots({ directory, runtime, tools, defaultWorkspace: () => directory, conversations: () => chats });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), approve: value => bots.approve(value), validateSelection: value => bots.validateSelection(value), execute: value => bots.run(value) });
  t.after(async () => { await bots.close(); chats.close(); await rm(directory, { recursive: true, force: true }); });
  const bot = bots.create({ name: 'Approval fixture', provider: 'codex', workspace: directory, policy: 'manual', capabilities: 'code' }).bot;
  const chat = bots.createConversation(bot.id).conversation; chats.send(chat.id, 'Only the disposable fixture.');
  const wait = async predicate => { const at = Date.now(); while (!predicate()) { if (Date.now() - at > 3000) throw new Error('Fixture approval timed out.'); await new Promise(resolve => setTimeout(resolve, 5)); } };
  await wait(() => bots.pending(chat.id).some(row => row.callId === 'fixture-write'));
  let state = chats.detail(chat.id);
  assert.equal(state.pending[0].target, 'approved.txt');
  assert.equal(state.conversation.messages.at(-1).tools.find(row => row.id === 'fixture-write').target, 'approved.txt');
  assert.equal(state.pending[0].target.includes('ONLY_AFTER_APPROVAL'), false);
  await assert.rejects(readFile(join(directory, 'approved.txt')), { code: 'ENOENT' });
  await chats.approval(chat.id, 'fixture-write', 'approve');
  await wait(() => bots.pending(chat.id).some(row => row.callId === 'fixture-command'));
  assert.equal(stage, 1); assert.equal(await readFile(join(directory, 'approved.txt'), 'utf8'), 'ONLY_AFTER_APPROVAL');
  assert.equal(chats.detail(chat.id).conversation.messages.at(-1).tools.find(row => row.id === 'fixture-write').target, 'approved.txt');
  state = chats.detail(chat.id); assert.equal(state.pending[0].target, 'echo MUST_NOT_EXECUTE');
  assert.equal(state.conversation.messages.at(-1).tools.find(row => row.id === 'fixture-command').target, 'echo MUST_NOT_EXECUTE');
  await chats.approval(chat.id, 'fixture-command', 'deny');
  await wait(() => !chats.detail(chat.id).conversation.active);
  assert.equal(chats.detail(chat.id).conversation.messages.at(-1).tools.find(row => row.id === 'fixture-command').state, 'denied');
});
