import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { botWorkspacePath, createBotTools, runBotProcess } from '../server/bots-tools.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bot-tools-')), workspace = join(directory, 'project'); mkdirSync(workspace);
  const tools = createBotTools({ directory, ...options });
  const bot = { id: 'test-bot', name: 'Builder', workspace, capabilities: 'both', policy: 'manual', execution: { kind: 'local' } };
  t.after(async () => { await tools.close(); rmSync(directory, { recursive: true, force: true }); });
  const execute = (name, args, overrides = {}) => tools.execute({ bot, chatId: 'chat-a', name, args, requestPermission: async () => true, ...overrides });
  return { directory, workspace, tools, bot, execute };
}

test('file tools refuse traversal, outside symlinks and dangling write links', async t => {
  const { directory, workspace } = fixture(t);
  writeFileSync(join(directory, 'private.txt'), 'private');
  symlinkSync(join(directory, 'private.txt'), join(workspace, 'escape'));
  symlinkSync(join(directory, 'missing.txt'), join(workspace, 'dangling'));
  symlinkSync(directory, join(workspace, 'outside'));
  await assert.rejects(botWorkspacePath(workspace, '../private.txt'), /outside/);
  await assert.rejects(botWorkspacePath(workspace, 'escape'), /outside/);
  await assert.rejects(botWorkspacePath(workspace, 'dangling', { writing: true }), /regular file/);
  await assert.rejects(botWorkspacePath(workspace, 'outside/new.txt', { writing: true }), /outside/);
});

test('manual file mutation waits for approval and denial leaves disk unchanged', async t => {
  const { workspace, execute } = fixture(t);
  writeFileSync(join(workspace, 'file.txt'), 'before');
  let approve;
  const promise = execute('write_file', { path: 'file.txt', content: 'after' }, { requestPermission: () => new Promise(resolve => { approve = resolve; }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readFileSync(join(workspace, 'file.txt'), 'utf8'), 'before');
  approve(false); assert.equal((await promise).isError, true);
  assert.equal(readFileSync(join(workspace, 'file.txt'), 'utf8'), 'before');
  await execute('write_file', { path: 'nested/file.txt', content: 'saved' });
  assert.equal(readFileSync(join(workspace, 'nested/file.txt'), 'utf8'), 'saved');
});

test('capabilities and Plan are enforced by execution, beyond tool visibility', async t => {
  const { bot, tools, execute } = fixture(t);
  assert.equal(tools.definitions({ ...bot, capabilities: 'computer' }).some(t => t.name === 'run_command'), false);
  assert.equal(tools.definitions({ ...bot, capabilities: 'code' }).some(t => t.name === 'browser_open'), false);
  await assert.rejects(execute('run_command', { command: 'touch should-not-run' }, { bot: { ...bot, policy: 'plan' } }), /not enabled/);
  await assert.rejects(execute('write_file', { path: 'x', content: 'x' }, { bot: { ...bot, capabilities: 'computer' } }), /not enabled/);
});

test('browser tools use separate bot browser and retain shared resource owner until turn finish', async t => {
  let launches = 0, clicks = 0;
  const page = { goto: async () => {}, url: () => 'https://example.test', screenshot: async () => Buffer.from('image'), locator: () => ({ innerText: async () => 'Visible page' }), getByRole: () => ({ click: async () => { clicks++; } }) };
  const { bot, tools, execute } = fixture(t, { browserProbe: () => ({ found: true, path: '/fixture/browser' }), browserFactory: async () => { launches++; return { page, close: async () => {} }; } });
  const result = await execute('browser_open', { url: 'https://example.test' });
  assert.equal(result.content[1].type, 'image'); assert.match(result.content[0].text, /Visible page/);
  await assert.rejects(execute('browser_click', { role: 'button', name: 'Go' }, { chatId: 'chat-b' }), /Another bot/);
  assert.equal(clicks, 0);
  await tools.finish('chat-a'); await execute('browser_click', { role: 'button', name: 'Go' }, { chatId: 'chat-b' });
  assert.equal(clicks, 1); assert.equal(launches, 1);
  await tools.execute({ bot: { ...bot, id: 'other-bot' }, chatId: 'chat-c', name: 'browser_snapshot', requestPermission: async () => true });
  assert.equal(launches, 2);
});

test('browser denial neither opens page nor starts a browser', async t => {
  let launches = 0;
  const { execute } = fixture(t, { browserFactory: async () => { launches++; throw new Error('must not launch'); } });
  await execute('browser_open', { url: 'https://example.test' }, { requestPermission: async () => false });
  assert.equal(launches, 0);
});

test('physical desktop lease is lazy, approved, turn-owned and independent of files and bot browsers', async t => {
  let acquired = 0, released = 0, actions = 0;
  const page = { goto: async () => {}, url: () => 'https://example.test', screenshot: async () => Buffer.from('image'), locator: () => ({ innerText: async () => 'Fixture' }) };
  const { execute, tools, bot, workspace } = fixture(t, {
    platform: 'darwin', browserProbe: () => ({ found: true }), browserFactory: async () => ({ page, close: async () => {} }),
    acquireDesktopLease: async () => { acquired++; return async () => { released++; }; },
    processRunner: async command => { if (command !== '/usr/bin/swiftc') actions++; return { code: 0, stdout: 'fixture', stderr: '' }; },
  });
  await execute('write_file', { path: 'independent.txt', content: 'files do not own a desktop' });
  await execute('browser_open', { url: 'https://example.test' });
  await execute('computer_click', { x: 1, y: 1 }, { requestPermission: async () => false });
  assert.equal(acquired, 0);
  await execute('computer_click', { x: 1, y: 1 });
  await execute('computer_key', { key: 'Return' });
  assert.equal(acquired, 1); assert.equal(actions, 2); assert.equal(released, 0);
  await assert.rejects(execute('computer_click', { x: 2, y: 2 }, { chatId: 'chat-b' }), /Another bot/);
  await execute('write_file', { path: 'other.txt', content: 'still independent' }, { chatId: 'chat-b' });
  await execute('browser_open', { url: 'https://example.test' }, { chatId: 'chat-b', bot: { ...bot, id: 'another-bot' } });
  assert.equal(readFileSync(join(workspace, 'other.txt'), 'utf8'), 'still independent');
  await Promise.all([tools.finish('chat-a'), tools.finish('chat-a')]);
  assert.equal(released, 1);
  await execute('computer_click', { x: 2, y: 2 }, { chatId: 'chat-b' });
  assert.equal(acquired, 2); assert.equal(actions, 3);
  await tools.finish('chat-b'); assert.equal(released, 2);
});

test('Stop during desktop admission never runs the action and still releases its eventual claim', async t => {
  let admit, admitted, releases = 0, processes = 0;
  const started = new Promise(resolve => { admitted = resolve; }), controller = new AbortController();
  const { execute, tools } = fixture(t, {
    platform: 'darwin', acquireDesktopLease: () => { admitted(); return new Promise(resolve => { admit = resolve; }); },
    processRunner: async () => { processes++; return { code: 0, stdout: '', stderr: '' }; },
  });
  const action = execute('computer_click', { x: 1, y: 1 }, { signal: controller.signal });
  await started; controller.abort();
  const finishing = tools.finish('chat-a');
  admit(async () => { releases++; });
  await assert.rejects(action, /stopped/); await finishing;
  assert.equal(processes, 0); assert.equal(releases, 1);
});

test('failed desktop admission does not poison a turn and failed release remains exclusive until cleanup succeeds', async t => {
  let attempts = 0, releases = 0, failRelease = true;
  const { execute, tools } = fixture(t, {
    platform: 'darwin', acquireDesktopLease: async () => { if (++attempts === 1) throw Error('fixture desktop busy'); return async () => { releases++; if (failRelease) throw Error('fixture release uncertain'); }; },
    processRunner: async () => ({ code: 0, stdout: 'fixture', stderr: '' }),
  });
  await assert.rejects(execute('computer_click', { x: 1, y: 1 }), /fixture desktop busy/);
  await execute('computer_click', { x: 1, y: 1 });
  await assert.rejects(tools.finish('chat-a'), /release uncertain/);
  await assert.rejects(execute('computer_click', { x: 1, y: 1 }, { chatId: 'chat-b' }), /Another bot/);
  failRelease = false; await tools.finish('chat-a'); assert.equal(releases, 2);
  await execute('computer_click', { x: 1, y: 1 }, { chatId: 'chat-b' }); await tools.finish('chat-b');
});

test('Stop closes the owned browser and waits for pending input to be cancelled', async t => {
  let rejectClick, clicked = false, closed = false;
  const controller = new AbortController();
  const page = { getByRole: () => ({ click: () => new Promise((resolve, reject) => { rejectClick = reject; }) }) };
  const { execute, tools } = fixture(t, { browserProbe: () => ({ found: true }), browserFactory: async () => ({ page, close: async () => { closed = true; rejectClick?.(new Error('Browser closed')); } }) });
  const running = execute('browser_click', { role: 'button', name: 'Submit' }, { signal: controller.signal }).then(() => { clicked = true; });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(running, /Browser closed/); await tools.finish('chat-a');
  assert.equal(closed, true); assert.equal(clicked, false);
});

test('Plan can snapshot an existing bot browser but never launches one', async t => {
  let launches = 0;
  const page = { goto: async () => {}, url: () => 'https://example.test', screenshot: async () => Buffer.from('image'), locator: () => ({ innerText: async () => 'Visible' }) };
  const { bot, tools, execute } = fixture(t, { browserProbe: () => ({ found: true }), browserFactory: async () => { launches++; return { page, close: async () => {} }; } });
  await assert.rejects(execute('browser_snapshot', {}, { bot: { ...bot, policy: 'plan' } }), /existing bot browser/);
  assert.equal(launches, 0);
  await tools.finish('chat-a'); await execute('browser_open', { url: 'https://example.test' }); await tools.finish('chat-a');
  await execute('browser_snapshot', {}, { bot: { ...bot, policy: 'plan' }, requestPermission: async () => { throw new Error('must not ask'); } });
  assert.equal(launches, 1);
});

test('desktop calls on unsupported platform fail honestly without executing anything', async t => {
  let calls = 0;
  const { execute } = fixture(t, { platform: 'linux', processRunner: async () => { calls++; return { code: 0 }; } });
  await assert.rejects(execute('computer_click', { x: 1, y: 1 }), /supported on macOS/);
  assert.equal(calls, 0);
});

test('shell command runs only after approval and abort ends only its owned process group', async t => {
  const { workspace, execute } = fixture(t);
  await execute('run_command', { command: 'printf tool-ok' });
  const result = await runBotProcess(process.execPath, ['-e', 'console.log("ok")'], { cwd: workspace });
  assert.equal(result.stdout.trim(), 'ok');
  const controller = new AbortController();
  const running = runBotProcess(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { cwd: workspace, signal: controller.signal });
  controller.abort(); await assert.rejects(running, /stopped/);
});
