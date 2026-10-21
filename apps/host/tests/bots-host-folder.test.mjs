import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, rename, stat, chmod, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createBotHostFolderTools, botHostFolderAuthority, normalizeBotHostFolder, runBotHostFolderOperation } from '../server/bots-host-folder.mjs';
import { hostFolderOperation, botHostFolderRemoteIdentity } from '../server/bots-host-folder-worker.mjs';
import { activeRemoteRuns } from '../server/bots-runtime/ssh-worker.mjs';
import { EventEmitter } from 'node:events';

const scratch = await mkdtemp(join(tmpdir(), 'strata-host-folder-'));
test.after(() => rm(scratch, { recursive: true, force: true }));
async function fixture(t, { access = 'read-write', policy = 'manual', operation } = {}) {
  const folder = await mkdtemp(join(scratch, 'grant-')); await writeFile(join(folder, 'hello.txt'), 'hello host');
  let current;
  const bridge = createBotHostFolderTools({ operation, currentGrant: () => current });
  const verified = await bridge.validate({ path: folder, access });
  const bot = { id: 'bot_owner', computerMode: 'cua', execution: { kind: 'local' }, policy, hostFolder: { path: verified.path, access }, hostFolderBinding: verified.binding, hostFolderRevision: 'rev-1' };
  current = botHostFolderAuthority(bot);
  const frames = [], context = { bot, chatId: 'chat_fixture', requestPermission: async () => true, onFrame: frame => frames.push(frame) };
  return { folder, verified, bot, bridge, context, frames, revoke: () => { current = null; }, current: value => { current = value; } };
}
const value = output => output.content[0].text;

test('default isolation exposes no host tools and grant input accepts no internal authority', () => {
  const bridge = createBotHostFolderTools();
  assert.deepEqual(bridge.tools({ computerMode: 'cua' }), []);
  assert.deepEqual(bridge.tools({ computerMode: 'host', hostFolder: { path: '/fixture', access: 'read-write' } }), []);
  assert.equal(normalizeBotHostFolder(null), null);
  for (const input of [{ path: '/', access: 'read' }, { path: 'relative', access: 'read' }, { path: '/fixture', access: 'write' }, { path: '/fixture', access: 'read', binding: {} }, { path: '/fixture\0x', access: 'read' }]) assert.throws(() => normalizeBotHostFolder(input));
});
test('real descriptor helper lists and reads only the selected directory without modifying it', async t => {
  const f = await fixture(t); const before = await readdir(f.folder);
  assert.equal(value(await f.bridge.execute('host_read_file', { path: 'hello.txt' }, f.context)), 'hello host');
  assert.equal(value(await f.bridge.execute('host_list_files', {}, f.context)), 'file\thello.txt');
  assert.deepEqual(await readdir(f.folder), before);
  assert.equal(f.frames.at(-1).tool.state, 'done');
});
test('manual writes require approval, replace atomically, preserve regular file mode and create contained children', async t => {
  const f = await fixture(t); let approvals = 0; f.context.requestPermission = async request => { approvals++; assert.match(request.reason, /granted host folder/); return true; };
  await chmod(join(f.folder, 'hello.txt'), 0o640);
  const original = await stat(join(f.folder, 'hello.txt'));
  await f.bridge.execute('host_write_file', { path: 'hello.txt', content: 'updated ✓' }, f.context);
  assert.equal(await readFile(join(f.folder, 'hello.txt'), 'utf8'), 'updated ✓');
  assert.notEqual((await stat(join(f.folder, 'hello.txt'))).ino, original.ino);
  assert.equal((await stat(join(f.folder, 'hello.txt'))).mode & 0o777, 0o640);
  await f.bridge.execute('host_write_file', { path: 'nested/project/new.txt', content: 'new' }, f.context);
  assert.equal(await readFile(join(f.folder, 'nested/project/new.txt'), 'utf8'), 'new');
  assert.equal(approvals, 2); assert.equal((await readdir(f.folder)).some(name => name.startsWith('.strata-host-folder-')), false);
});
test('read-only, Plan, denied permission and bypass retain independent authority limits', async t => {
  const ro = await fixture(t, { access: 'read', policy: 'bypass' });
  assert.deepEqual(ro.bridge.tools(ro.bot).map(row => row.name), ['host_list_files', 'host_read_file']);
  await assert.rejects(ro.bridge.execute('host_write_file', { path: 'hello.txt', content: 'no' }, ro.context), /not enabled/);
  const plan = await fixture(t, { policy: 'plan' });
  await assert.rejects(plan.bridge.execute('host_write_file', { path: 'hello.txt', content: 'no' }, plan.context), /not enabled/);
  const denied = await fixture(t); denied.context.requestPermission = async () => false;
  assert.equal((await denied.bridge.execute('host_write_file', { path: 'hello.txt', content: 'no' }, denied.context)).isError, true);
  assert.equal(await readFile(join(denied.folder, 'hello.txt'), 'utf8'), 'hello host');
  denied.bot.policy = 'bypass'; denied.context.requestPermission = () => assert.fail('Bypass must not prompt');
  await denied.bridge.execute('host_write_file', { path: 'hello.txt', content: 'yes' }, denied.context);
  denied.revoke(); await assert.rejects(denied.bridge.execute('host_read_file', { path: 'hello.txt' }, denied.context), /revoked/);
});
test('traversal, absolute paths, unexpected arguments and symlinks cannot escape the grant', async t => {
  const f = await fixture(t), outside = await mkdtemp(join(scratch, 'outside-')); await writeFile(join(outside, 'secret.txt'), 'untouched');
  await symlink(outside, join(f.folder, 'escape')); await symlink(join(outside, 'secret.txt'), join(f.folder, 'secret-link'));
  await symlink(join(outside, 'missing.txt'), join(f.folder, 'dangling'));
  for (const path of ['../outside', '/etc/passwd', 'a/../../x', 'a\\b', 'a//b', 'a/./b', 'escape/secret.txt', 'secret-link', 'dangling']) {
    await assert.rejects(f.bridge.execute('host_read_file', { path }, f.context));
    await assert.rejects(f.bridge.execute('host_write_file', { path, content: 'bad' }, f.context));
  }
  await assert.rejects(f.bridge.execute('host_read_file', { path: 'hello.txt', root: outside }, f.context), /valid host folder/);
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'untouched');
  await assert.rejects(readFile(join(outside, 'missing.txt')), { code: 'ENOENT' });
});
test('a root replaced after grant cannot silently inherit the old authority', async t => {
  const f = await fixture(t); await rename(f.folder, `${f.folder}-original`); await mkdir(f.folder); await writeFile(join(f.folder, 'hello.txt'), 'replacement');
  await assert.rejects(f.bridge.execute('host_write_file', { path: 'hello.txt', content: 'no' }, f.context), /moved or replaced/);
  assert.equal(await readFile(join(f.folder, 'hello.txt'), 'utf8'), 'replacement');
});
test('ancestor symlink swapped at helper authorization fails closed without touching outside', async t => {
  let swap;
  const f = await fixture(t, { operation: (input, options) => runBotHostFolderOperation(input, { ...options, authorize: async () => { if (swap) await swap(); return options.authorize(); } }) });
  const outside = await mkdtemp(join(scratch, 'race-outside-')); await writeFile(join(outside, 'secret.txt'), 'untouched'); await mkdir(join(f.folder, 'nested'));
  swap = async () => { await rename(join(f.folder, 'nested'), join(f.folder, 'saved')); await symlink(outside, join(f.folder, 'nested')); };
  await assert.rejects(f.bridge.execute('host_write_file', { path: 'nested/secret.txt', content: 'bad' }, f.context), /Symbolic links/);
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'untouched');
});
test('revocation and same-path regrant invalidate frozen chats, including a late approval', async t => {
  const f = await fixture(t); let approve, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.context.requestPermission = () => { entered(); return new Promise(resolve => { approve = resolve; }); };
  const pending = f.bridge.execute('host_write_file', { path: 'hello.txt', content: 'late' }, f.context);
  await waiting; f.revoke(); approve(true); await assert.rejects(pending, /revoked/);
  f.current({ ...botHostFolderAuthority(f.bot), revision: 'rev-2' });
  await assert.rejects(f.bridge.execute('host_read_file', { path: 'hello.txt' }, f.context), /revoked/);
  assert.equal(await readFile(join(f.folder, 'hello.txt'), 'utf8'), 'hello host');
});
test('team shared guest uses only the anchor owner grant and exact execution account', async t => {
  const f = await fixture(t); f.bot.id = 'bot_teammate'; f.bot.computerOwnerId = 'bot_owner';
  assert.equal(value(await f.bridge.execute('host_read_file', { path: 'hello.txt' }, f.context)), 'hello host');
  f.current({ ...botHostFolderAuthority(f.bot), ownerId: 'bot_other' });
  await assert.rejects(f.bridge.execute('host_read_file', { path: 'hello.txt' }, f.context), /revoked/);
  f.current({ ...botHostFolderAuthority(f.bot), execution: { kind: 'ssh', host: 'other', user: 'root' }, remoteIdentity: 'a'.repeat(64) });
  await assert.rejects(f.bridge.execute('host_read_file', { path: 'hello.txt' }, f.context), /revoked/);
});
test('Stop cancels pending approval and ignores its eventual positive response', async t => {
  const f = await fixture(t), controller = new AbortController(); f.context.signal = controller.signal;
  let approve, entered; const waiting = new Promise(resolve => { entered = resolve; });
  f.context.requestPermission = () => { entered(); return new Promise(resolve => { approve = resolve; }); };
  const pending = f.bridge.execute('host_write_file', { path: 'hello.txt', content: 'late' }, f.context);
  await waiting; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); approve(true);
  assert.equal(await readFile(join(f.folder, 'hello.txt'), 'utf8'), 'hello host');
});
test('bounded text rejects large, binary and special files without blocking', async t => {
  const f = await fixture(t); await writeFile(join(f.folder, 'binary'), Buffer.from([0xff, 0xfe])); await writeFile(join(f.folder, 'large'), ''); await truncate(join(f.folder, 'large'), 1024 * 1024 + 1);
  await assert.rejects(f.bridge.execute('host_read_file', { path: 'binary' }, f.context), /UTF-8/);
  await assert.rejects(f.bridge.execute('host_read_file', { path: 'large' }, f.context), /at most 1 MB/);
  await assert.rejects(f.bridge.execute('host_write_file', { path: 'large', content: 'x'.repeat(2 * 1024 * 1024 + 1) }, f.context), /at most 2 MB/);
  const child = spawn('/usr/bin/mkfifo', [join(f.folder, 'pipe')]); assert.equal(await new Promise(resolve => child.on('close', resolve)), 0);
  await assert.rejects(f.bridge.execute('host_read_file', { path: 'pipe' }, f.context), /regular files/);
});
test('directory listing is bounded and does not follow listed links', async t => {
  const f = await fixture(t); await mkdir(join(f.folder, 'large'));
  await Promise.all(Array.from({ length: 1001 }, (_, i) => writeFile(join(f.folder, 'large', String(i)), '')));
  await assert.rejects(f.bridge.execute('host_list_files', { path: 'large' }, f.context), /1,000 entries/);
});
test('remote grants never fall back to an identical local path without an updated worker', async () => {
  const bridge = createBotHostFolderTools();
  await assert.rejects(bridge.validate({ path: scratch, access: 'read' }, { execution: { kind: 'ssh', host: 'fixture', user: 'operator' } }), /updated Bots worker/);
});
class Reader extends EventEmitter { close() { this.emit('close'); } }
test('remote folder handler binds machine/account before file access and has no provider/VM side effect', async t => {
  const f = await fixture(t), reader = new Reader(), sent = [];
  await hostFolderOperation({ operation: 'host_read_file', grant: f.bot.hostFolder, binding: f.verified.binding, args: { path: 'hello.txt' }, expectedIdentity: 'a'.repeat(64) }, { reader, directory: join(f.folder, 'registry'), send: message => sent.push(message), operation: () => assert.fail('Changed identity must not access files') });
  assert.match(sent.find(message => message.type === 'failure').message, /different computer or account/);
  assert.equal(sent.find(message => message.type === 'cleanup').confirmed, true);
  assert.match(botHostFolderRemoteIdentity(), /^[a-f0-9]{64}$/);
});
test('remote handler waits for fresh host authority, and EOF cancels before a write', async t => {
  const f = await fixture(t), reader = new Reader(), sent = [];
  await hostFolderOperation({ operation: 'host_write_file', grant: f.bot.hostFolder, binding: f.verified.binding, args: { path: 'hello.txt', content: 'late' }, expectedIdentity: botHostFolderRemoteIdentity() }, { reader, directory: join(f.folder, 'registry'), send: message => { sent.push(message); if (message.type === 'folder-authorize') setTimeout(() => reader.close(), 0); } });
  assert.equal(await readFile(join(f.folder, 'hello.txt'), 'utf8'), 'hello host');
  assert.equal(sent.find(message => message.type === 'result').value.cancelled, true);
  assert.equal(sent.find(message => message.type === 'cleanup').confirmed, true);
});

test('revocation before atomic commit cancels staged data and finish waits for helper close', async t => {
  let phases = 0, revoke;
  const f = await fixture(t, { operation: (input, options) => runBotHostFolderOperation(input, { ...options, authorize: async () => { phases++; if (phases === 2) revoke(); return options.authorize(); } }) });
  revoke = f.revoke;
  const pending = f.bridge.execute('host_write_file', { path: 'hello.txt', content: 'must not commit' }, f.context);
  await assert.rejects(pending, /revoked/); await f.bridge.finish(f.context.chatId);
  assert.equal(await readFile(join(f.folder, 'hello.txt'), 'utf8'), 'hello host');
  assert.equal((await readdir(f.folder)).some(name => name.startsWith('.strata-host-folder-')), false);
});
test('explicit revoke aborts owned pending calls and leaves another owner independent', async t => {
  const f = await fixture(t); let waiting; const entered = new Promise(resolve => { waiting = resolve; });
  f.context.requestPermission = () => { waiting(); return new Promise(() => {}); };
  const pending = f.bridge.execute('host_write_file', { path: 'hello.txt', content: 'never' }, f.context);
  await entered; await f.bridge.revoke('bot_unrelated');
  await f.bridge.revoke('bot_owner'); await assert.rejects(pending, { name: 'AbortError' });
  await f.bridge.close(); assert.equal(await readFile(join(f.folder, 'hello.txt'), 'utf8'), 'hello host');
  await assert.rejects(f.bridge.execute('host_read_file', { path: 'hello.txt' }, f.context), /closed/);
});
test('late rejected helper authorization cannot signal a completed or recycled process group', async () => {
  const { PassThrough } = await import('node:stream');
  const originalKill = process.kill, signals = []; let rejectAuthority, child;
  process.kill = (pid, signal) => { assert.equal(pid, -987654321); signals.push(signal); setTimeout(() => child.emit('close', -1), 0); return true; };
  try {
    const pending = runBotHostFolderOperation({ operation: 'host_read_file' }, { timeoutMs: 10, authorize: () => new Promise((_resolve, reject) => { rejectAuthority = reject; }), spawnProcess: () => {
      child = new EventEmitter(); child.pid = 987654321; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setTimeout(() => child.stdout.write('{"ready":true,"phase":"access"}\n'), 0); return child;
    } });
    await assert.rejects(pending, /timed out/); const count = signals.length; rejectAuthority(new Error('late denial'));
    await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(signals.length, count);
  } finally { process.kill = originalKill; }
});

test('detached SSH cleanup uncertainty survives settlement and propagates through finish, revoke and close', async () => {
  const execution = { kind: 'ssh', host: 'saved-alias' }, binding = { device: '1', inode: '2' };
  const bot = { id: 'bot_remote', computerMode: 'cua', execution, policy: 'manual', hostFolder: { path: '/remote/project', access: 'read' }, hostFolderBinding: binding, hostFolderRevision: 'r1', hostFolderRemoteIdentity: 'a'.repeat(64) };
  const failure = Object.assign(new Error('Remote cleanup was not confirmed.'), { code: 'ssh_cleanup_unconfirmed' });
  const bridge = createBotHostFolderTools({ currentGrant: () => botHostFolderAuthority(bot), remoteSSH: { hostFolder: async () => { throw failure; } } });
  await assert.rejects(bridge.execute('host_read_file', { path: 'file.txt' }, { bot, chatId: 'detached' }), { code: 'ssh_cleanup_unconfirmed' });
  await assert.rejects(bridge.finish('detached'), { code: 'ssh_cleanup_unconfirmed' });
  await assert.rejects(bridge.revoke(bot.id), { code: 'ssh_cleanup_unconfirmed' });
  await assert.rejects(bridge.close(), { code: 'ssh_cleanup_unconfirmed' });
});

test('remote probes see a held folder worker until cancellation confirms helper exit', async t => {
  const f = await fixture(t), directory = join(f.folder, 'registry'), reader = new Reader(); let ready;
  const entered = new Promise(resolve => { ready = resolve; }), sent = [];
  const running = hostFolderOperation({ operation: 'host_read_file', grant: f.bot.hostFolder, binding: f.verified.binding, args: { path: 'hello.txt' }, expectedIdentity: botHostFolderRemoteIdentity() }, { directory, reader, send: message => { sent.push(message); if (message.type === 'folder-authorize') ready(); } });
  await entered; assert.equal(await activeRemoteRuns(directory), 1);
  reader.close(); await running; assert.equal(await activeRemoteRuns(directory), 0);
  assert.equal(sent.find(message => message.type === 'cleanup').confirmed, true);
});

test('a parent moved outside the grant during commit cannot receive the staged write', async t => {
  let phases = 0, move;
  const f = await fixture(t, { operation: (input, options) => runBotHostFolderOperation(input, { ...options, authorize: async () => { phases++; if (phases === 2) await move(); return options.authorize(); } }) });
  await mkdir(join(f.folder, 'nested')); await writeFile(join(f.folder, 'nested', 'file.txt'), 'original');
  const outside = join(scratch, 'moved-outside');
  move = async () => { await rename(join(f.folder, 'nested'), outside); await mkdir(join(f.folder, 'nested')); };
  await assert.rejects(f.bridge.execute('host_write_file', { path: 'nested/file.txt', content: 'must not write outside' }, f.context), /parent folder moved/);
  assert.equal(await readFile(join(outside, 'file.txt'), 'utf8'), 'original');
  assert.equal((await readdir(outside)).some(name => name.startsWith('.strata-host-folder-')), false);
  assert.deepEqual(await readdir(join(f.folder, 'nested')), []);
});

test('host folder paths reject C0 and DEL while preserving emoji with a ZWJ', async () => {
  for (const character of ['\u0001', '\t', '\n', '\u001f', '\u007f']) assert.throws(() => normalizeBotHostFolder({ path: `/tmp/bad${character}folder`, access: 'read' }));
  const folder = join(scratch, 'project-👩‍💻'); await mkdir(folder); await writeFile(join(folder, 'file.txt'), 'emoji folder');
  const bridge = createBotHostFolderTools({ currentGrant: bot => botHostFolderAuthority(bot) });
  const verified = await bridge.validate({ path: folder, access: 'read' });
  const bot = { id: 'bot_unicode', computerMode: 'cua', execution: { kind: 'local' }, policy: 'plan', hostFolder: { path: verified.path, access: verified.access }, hostFolderBinding: verified.binding, hostFolderRevision: 'r1' };
  assert.equal(value(await bridge.execute('host_read_file', { path: 'file.txt' }, { bot, chatId: 'unicode' })), 'emoji folder');
  await assert.rejects(bridge.execute('host_read_file', { path: 'bad\u0001name' }, { bot, chatId: 'unicode' }), /relative path/);
});
test('cleanup recovery requires an exact ready idle account, clears only that target, and lets the same chat retry', async () => {
  const execution = { kind: 'ssh', host: 'saved-alias' }, binding = { device: '1', inode: '2' };
  const base = { computerMode: 'cua', policy: 'manual', hostFolder: { path: '/remote/project', access: 'read' }, hostFolderBinding: binding, hostFolderRevision: 'r1', hostFolderRemoteIdentity: 'a'.repeat(64) };
  const bot = { ...base, id: 'bot_remote', execution }, other = { ...base, id: 'bot_other', execution: { ...execution, user: 'another' } };
  let fails = true;
  const bridge = createBotHostFolderTools({ currentGrant: bot => botHostFolderAuthority(bot), remoteSSH: { hostFolder: async () => { if (fails) throw Object.assign(new Error('Unknown cleanup'), { code: 'ssh_cleanup_unconfirmed' }); return { text: 'recovered read' }; } } });
  for (const selected of [bot, other]) await assert.rejects(bridge.execute('host_read_file', { path: 'file.txt' }, { bot: selected, chatId: selected.id }), { code: 'ssh_cleanup_unconfirmed' });
  const ready = { available: true, prepared: true, activeRuns: 0, identity: 'a'.repeat(64) };
  for (const status of [{ ...ready, prepared: false }, { ...ready, activeRuns: 1 }, { ...ready, identity: 'b'.repeat(64) }, { ...ready, activeRuns: undefined }]) assert.throws(() => bridge.recover(execution, status));
  await assert.rejects(bridge.finish(bot.id), { code: 'ssh_cleanup_unconfirmed' });
  assert.deepEqual(bridge.recover(execution, ready), { recovered: 1 }); await bridge.finish(bot.id);
  await assert.rejects(bridge.finish(other.id), { code: 'ssh_cleanup_unconfirmed' });
  fails = false; assert.equal(value(await bridge.execute('host_read_file', { path: 'file.txt' }, { bot, chatId: bot.id })), 'recovered read');
  bridge.recover(other.execution, ready); await bridge.close();
});
test('local cleanup check rejects active actions or an unknown local helper instead of claiming recovery', async t => {
  const f = await fixture(t); let entered; const waiting = new Promise(resolve => { entered = resolve; });
  f.context.requestPermission = () => { entered(); return new Promise(() => {}); };
  const pending = f.bridge.execute('host_write_file', { path: 'hello.txt', content: 'no' }, f.context);
  await waiting; assert.throws(() => f.bridge.recover({ kind: 'local' }, { available: true }), /Finish/);
  await f.bridge.revoke(f.bot.id); await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(f.bridge.recover({ kind: 'local' }, { available: true }), { recovered: 0 });
  const unknown = await fixture(t, { operation: (input, options) => input.operation === 'validate' ? runBotHostFolderOperation(input, options) : Promise.reject(Object.assign(new Error('Unknown local cleanup'), { cleanupUnconfirmed: true })) });
  await assert.rejects(unknown.bridge.execute('host_read_file', { path: 'hello.txt' }, unknown.context), /Unknown local/);
  assert.throws(() => unknown.bridge.recover({ kind: 'local' }, { available: true }), /Local host folder cleanup remains unconfirmed/);
});

test('an unknown remote helper quarantines subsequent calls immediately until exact idle recovery', async () => {
  const bot = { id: 'bot_retry', computerMode: 'cua', execution: { kind: 'ssh', host: 'saved-alias' }, policy: 'manual', hostFolder: { path: '/remote/project', access: 'read' }, hostFolderBinding: { device: '1', inode: '2' }, hostFolderRevision: 'r1', hostFolderRemoteIdentity: 'a'.repeat(64) };
  let calls = 0;
  const bridge = createBotHostFolderTools({ currentGrant: bot => botHostFolderAuthority(bot), remoteSSH: { hostFolder: async () => { calls++; if (calls === 1) throw Object.assign(new Error('Unknown cleanup'), { code: 'ssh_cleanup_unconfirmed' }); return { text: 'recovered' }; } } });
  await assert.rejects(bridge.execute('host_read_file', { path: 'file.txt' }, { bot, chatId: 'same-turn' }), { code: 'ssh_cleanup_unconfirmed' });
  await assert.rejects(bridge.execute('host_read_file', { path: 'file.txt' }, { bot, chatId: 'same-turn' }), { code: 'ssh_cleanup_unconfirmed' });
  const teammate = { ...bot, id: 'bot_teammate' };
  await assert.rejects(bridge.execute('host_read_file', { path: 'file.txt' }, { bot: teammate, chatId: 'other-chat' }), { code: 'ssh_cleanup_unconfirmed' });
  assert.equal(calls, 1);
  assert.deepEqual(bridge.recover(bot.execution, { available: true, prepared: true, activeRuns: 0, identity: bot.hostFolderRemoteIdentity }), { recovered: 1 });
  assert.equal(value(await bridge.execute('host_read_file', { path: 'file.txt' }, { bot, chatId: 'same-turn' })), 'recovered'); assert.equal(calls, 2);
  await bridge.close();
});

test('default legacy computer probes need no new identity when there is no folder uncertainty', () => {
  const bridge = createBotHostFolderTools();
  for (const status of [undefined, { available: true }, { available: true, prepared: true, activeRuns: 0 }]) assert.deepEqual(bridge.recover({ kind: 'ssh', host: 'saved-alias' }, status), { recovered: 0 });
  assert.deepEqual(bridge.recover({ kind: 'local' }, { available: true }), { recovered: 0 });
});
