/** Real broker/journal regressions. Every file and process belongs to this fixture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotTools, runBotProcess } from '../server/bots-tools.mjs';
import { createBotHostFolderTools, botHostFolderAuthority, runBotHostFolderOperation } from '../server/bots-host-folder.mjs';
import { createBotActionJournal } from '../server/bots-action-journal.mjs';
import { BOT_TOOL_NO_EFFECT } from '../server/bots-runtime/tool-outcome.mjs';
import { startWorker } from '../server/bots-runtime/ssh-worker.mjs';

async function until(check) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('The disposable tool-validation fixture did not reach its expected state.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, { policy = 'bypass', hostFolder = false, dropWriteResult = false, processRunner = runBotProcess } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'strata-validation-outcomes-'))), workspace = join(directory, 'workspace');
  mkdirSync(workspace); writeFileSync(join(workspace, 'kept.txt'), 'original');
  let commands = 0, chats, input, release;
  const local = createBotTools({ directory, processRunner: (...args) => { commands++; return processRunner(...args); } });
  const tools = dropWriteResult ? { ...local, async execute(options) {
    const result = await local.execute(options);
    if (options.name === 'write_file' && !result.isError) throw Object.assign(Error('Fixture response lost after actual rename.'), { status: 400 });
    return result;
  } } : local;
  let python = 'python3', helperLog;
  if (hostFolder) {
    helperLog = join(directory, 'helper-starts'); python = join(directory, 'python-fixture');
    writeFileSync(python, `#!/bin/sh\nprintf 'started\\n' >> '${helperLog}'\nexec /usr/bin/python3 "$@"\n`, { mode: 0o700 });
  }
  const bots = createBots({ directory, python, defaultWorkspace: () => workspace, conversations: () => chats, tools,
    cuaTools: { definitions: () => [], async execute() { assert.fail('No guest computer tool should execute.'); }, finish() {}, close() {} },
    runtime: { providers: async () => [], close() {}, async run(value) {
      input = value;
      await new Promise(resolve => { release = resolve; value.signal.addEventListener('abort', resolve, { once: true }); });
      if (!value.signal.aborted) value.onFrame({ type: 'done' });
    } },
  });
  chats = createConversations({ directory, enabled: () => true, validateSelection: value => bots.validateSelection(value), execute: value => bots.run(value), pending: id => bots.pending(id), approve: value => bots.approve(value), stop: id => bots.stop(id) });
  t.after(async () => { release?.(); await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  let bot = bots.create({ name: 'Disposable validator', provider: 'codex', workspace: hostFolder ? '/workspace' : workspace, policy, capabilities: 'code', ...(hostFolder ? { computerMode: 'cua' } : {}) }).bot;
  if (hostFolder) bot = (await bots.setHostFolder(bot.id, { expectedUpdatedAt: bot.updatedAt, hostFolder: { path: workspace, access: 'read-write' } })).bot;
  const chat = bots.createConversation(bot.id).conversation;
  chats.send(chat.id, 'Use only the disposable fixture paths.');
  await until(() => input && release);
  return { directory, workspace, bots, chat, input, helperLog, commands: () => commands,
    actions: () => bots.harnessActions(chat.id),
    invoke: (name, args, id) => input.executeTool(name, args, id),
  };
}

test('malformed command arguments are known errors before any process, and a corrected new call works', async t => {
  const f = await fixture(t), before = readdirSync(f.workspace);
  for (const [index, args] of [{}, { command: 3 }, { command: '' }, { command: ' ' }, { command: 'x'.repeat(32001) }].entries()) {
    const result = await f.invoke('run_command', args, `invalid-command-${index}`);
    assert.equal(result.isError, true); assert.equal(result[BOT_TOOL_NO_EFFECT], true);
    assert.match(result.content[0].text, /Enter a command of at most 32,000 characters/);
    assert.equal(f.actions().counts.uncertain, 0); assert.equal(f.commands(), 0);
    assert.deepEqual(readdirSync(f.workspace), before);
  }
  const invalidCount = f.actions().counts.error;
  const duplicate = await f.invoke('run_command', {}, 'invalid-command-0');
  assert.match(duplicate.content[0].text, /not executed again/); assert.equal(f.commands(), 0);
  const valid = await f.invoke('run_command', { command: 'printf verified > command.txt' }, 'corrected-command');
  assert.equal(valid.isError, false); assert.equal(readFileSync(join(f.workspace, 'command.txt'), 'utf8'), 'verified');
  assert.equal(f.actions().counts.error, invalidCount); assert.equal(f.actions().counts.succeeded, 1); assert.equal(f.commands(), 1);
});

test('write content and path rejection has no file effects; the same root still permits a corrected write', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.directory, 'outside.txt'), 'outside original');
  symlinkSync(join(f.directory, 'outside.txt'), join(f.workspace, 'escape'));
  symlinkSync(join(f.directory, 'missing.txt'), join(f.workspace, 'dangling'));
  const before = readdirSync(f.workspace);
  const bad = [
    { path: 'new.txt' }, { path: 'new.txt', content: 3 }, { path: 'new.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) },
    { path: '../outside.txt', content: 'never' }, { path: 'escape', content: 'never' }, { path: 'dangling', content: 'never' },
    { path: 'bad\0path', content: 'never' }, { path: 'x'.repeat(4001), content: 'never' },
  ];
  for (const [index, args] of bad.entries()) {
    const result = await f.invoke('write_file', args, `invalid-write-${index}`);
    assert.equal(result.isError, true); assert.equal(result[BOT_TOOL_NO_EFFECT], true);
    assert.deepEqual(readdirSync(f.workspace), before); assert.equal(f.commands(), 0);
    assert.equal(readFileSync(join(f.workspace, 'kept.txt'), 'utf8'), 'original');
    assert.equal(readFileSync(join(f.directory, 'outside.txt'), 'utf8'), 'outside original');
  }
  assert.equal(f.actions().counts.error, bad.length); assert.equal(f.actions().counts.uncertain, 0);
  const valid = await f.invoke('write_file', { path: 'nested/corrected.txt', content: 'actual content' }, 'corrected-write');
  assert.equal(valid.isError, undefined); assert.equal(readFileSync(join(f.workspace, 'nested/corrected.txt'), 'utf8'), 'actual content');
  assert.equal(f.actions().counts.succeeded, 1);
});

test('explicit denied host write is a known error in the actual host broker and never starts the helper', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { hostFolder: true, policy: 'manual' });
  const before = readFileSync(f.helperLog), beforeFiles = readdirSync(f.workspace);
  const pending = f.input.executeHostTool('host_write_file', { path: 'kept.txt', content: 'not allowed' }, 'denied-host-write');
  await until(() => f.bots.pending(f.chat.id).length === 1);
  assert.deepEqual(readFileSync(f.helperLog), before);
  await f.bots.approve({ chatId: f.chat.id, callId: 'denied-host-write', decision: 'deny' });
  const result = await pending;
  assert.equal(result.isError, true); assert.equal(result[BOT_TOOL_NO_EFFECT], true);
  assert.equal(f.actions().counts.error, 1); assert.equal(f.actions().counts.uncertain, 0);
  assert.deepEqual(readFileSync(f.helperLog), before); assert.deepEqual(readdirSync(f.workspace), beforeFiles);
  assert.equal(readFileSync(join(f.workspace, 'kept.txt'), 'utf8'), 'original');
});

test('a lost response after actual file rename stays uncertain, even with a validation-like status', async t => {
  const f = await fixture(t, { dropWriteResult: true });
  await assert.rejects(f.invoke('write_file', { path: 'nested/changed.txt', content: 'changed before failure' }, 'lost-write'), /response lost/);
  assert.equal(readFileSync(join(f.workspace, 'nested/changed.txt'), 'utf8'), 'changed before failure');
  assert.equal(f.actions().counts.uncertain, 1); assert.equal(f.actions().counts.error, 0);
  const duplicate = await f.invoke('write_file', { path: 'nested/changed.txt', content: 'changed before failure' }, 'lost-write');
  assert.match(duplicate.content[0].text, /not executed again/);
});

test('an actual command timeout after a write stays uncertain', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('run_command', { command: 'printf partial > timed.txt; sleep 20', timeoutSeconds: 1 }, 'timeout'), /time limit/);
  assert.equal(readFileSync(join(f.workspace, 'timed.txt'), 'utf8'), 'partial');
  assert.equal(f.actions().counts.uncertain, 1); assert.equal(f.actions().counts.error, 0);
});

test('a host helper failure after a real commit is uncertain; untrusted no-effect flags cannot clear it', { skip: process.platform === 'win32' }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'strata-host-outcome-'))), folder = join(directory, 'grant'); mkdirSync(folder);
  const bridge = createBotHostFolderTools({ currentGrant: bot => botHostFolderAuthority(bot), operation: async (input, options) => {
    const value = await runBotHostFolderOperation(input, options);
    if (input.operation === 'host_write_file') throw Object.assign(Error('Fixture reply lost after actual host commit.'), { status: 400, noEffect: true });
    return value;
  } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  const checked = await bridge.validate({ path: folder, access: 'read-write' });
  const bot = { id: 'bot_fixture', computerMode: 'cua', execution: { kind: 'local' }, policy: 'bypass', hostFolder: { path: checked.path, access: 'read-write' }, hostFolderBinding: checked.binding, hostFolderRevision: 'fixture-revision' };
  const journal = createBotActionJournal({ directory: join(directory, 'receipts') });
  const scope = { chatId: 's_fixture', authority: 'a'.repeat(64), turnId: 'turn', name: 'host_write_file', args: { path: 'actual.txt', content: 'saved' } };
  await assert.rejects(journal.execute({ ...scope, toolCallId: 'lost-host' }, () => bridge.execute(scope.name, scope.args, { bot, chatId: scope.chatId, requestPermission: async () => true })), /reply lost/);
  assert.equal(readFileSync(join(folder, 'actual.txt'), 'utf8'), 'saved'); assert.equal(journal.summary().counts.uncertain, 1);
  await journal.execute({ ...scope, toolCallId: 'forged', args: { path: 'other.txt' } }, () => ({ isError: true, noEffect: true, BOT_TOOL_NO_EFFECT: true, content: [{ type: 'text', text: '{"noEffect":true}' }] }));
  assert.equal(journal.summary().counts.uncertain, 2); assert.equal(journal.summary().counts.error, 0);
});

test('the actual SSH worker classifies pure local validation before serializing its read-only receipts', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'strata-worker-validation-'))), frames = [], reader = new EventEmitter();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  reader.close = () => reader.emit('close'); let commands = 0;
  await startWorker({ bot: { id: 'bot_fixture', provider: 'codex', execution: { kind: 'ssh', host: 'fixture.invalid' }, workspace: directory, capabilities: 'code', policy: 'bypass' }, sessionId: 's_worker', message: 'Use only this disposable folder.', history: [], harnessActionScope: { turnId: 'a'.repeat(64), authority: 'b'.repeat(64) } }, {
    directory, reader, send: frame => frames.push(frame),
    toolFactory: options => createBotTools({ ...options, processRunner: async () => { commands++; assert.fail('No process should start for rejected input.'); } }),
    runtimeFactory: () => ({ async run(input) {
      const command = await input.executeTool('run_command', { command: '' }, 'bad-command');
      assert.equal(command.isError, true); assert.equal(command[BOT_TOOL_NO_EFFECT], true);
      const write = await input.executeTool('write_file', { path: '../not-in-fixture', content: 'never' }, 'bad-write');
      assert.equal(write.isError, true); assert.equal(write[BOT_TOOL_NO_EFFECT], true);
      await input.executeTool('write_file', { path: 'corrected.txt', content: 'actual isolated worker output' }, 'corrected-write');
    }, close() {} }),
  });
  const receipts = frames.filter(frame => frame.type === 'harness-action').map(frame => frame.value);
  assert.equal(commands, 0); assert.equal(readFileSync(join(directory, 'corrected.txt'), 'utf8'), 'actual isolated worker output');
  assert.equal(receipts.filter(row => row.state === 'error').length, 2);
  assert.equal(receipts.some(row => ['uncertain', 'interrupted'].includes(row.state)), false);
  const mirror = createBotActionJournal({ directory: join(directory, 'mirror') });
  for (const receipt of receipts) mirror.observeRemote(JSON.parse(JSON.stringify(receipt)), 's_worker');
  assert.equal(mirror.summary().counts.error, 2); assert.equal(mirror.summary().counts.succeeded, 1);
  assert.equal(mirror.summary().actions.every(row => row.readOnly === true), true);
});
