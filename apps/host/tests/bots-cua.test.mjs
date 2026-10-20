import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createBotCUATools, runCUABridge, cuaSandboxName, CUA_IMAGE } from '../server/bots-cua.mjs';

const bot = { id: 'bot-owned', name: 'Builder', computerMode: 'cua', capabilities: 'both', policy: 'manual', workspace: '/host/private/project', execution: { kind: 'local' } };
const fixtureEnvironment = { PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '0' };
const pythonAvailable = spawnSync('python3', ['-I', '-B', '-c', 'pass'], { env: fixtureEnvironment, timeout: 5000, stdio: 'ignore' }).status === 0;

test('isolated bridge imports a sibling helper without adding or replacing bytecode in its sealed-like tree', { skip: !pythonAvailable, timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-cua-sealed-helper-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = join(directory, 'bridge.py'), cache = join(directory, '__pycache__'), retained = join(cache, 'existing.pyc');
  await mkdir(cache); await writeFile(retained, 'retained sealed cache'); await writeFile(join(directory, 'sibling.py'), 'value = "sibling-imported"\n');
  await writeFile(helper, 'import importlib.util,json,pathlib,sys\np=pathlib.Path(__file__).with_name("sibling.py")\ns=importlib.util.spec_from_file_location("sibling",p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nrequest=json.load(sys.stdin)\nprint(json.dumps({"value":m.value,"isolated":sys.flags.isolated,"noBytecode":sys.dont_write_bytecode,"operation":request["operation"]}))\n');
  const before = (await readdir(directory, { recursive: true })).sort();
  const result = await runCUABridge('python3', helper, { operation: 'owned-fixture' }, { env: fixtureEnvironment, timeout: 5000 });
  assert.deepEqual(result, { value: 'sibling-imported', isolated: 1, noBytecode: true, operation: 'owned-fixture' });
  assert.deepEqual((await readdir(directory, { recursive: true })).sort(), before); assert.equal(await readFile(retained, 'utf8'), 'retained sealed cache');
});
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'strata-cua-test-'));
  const path = join(directory, 'cua-runtime', 'venv', 'bin'); await mkdir(path, { recursive: true }); await writeFile(join(path, 'python'), '');
  const calls = [];
  const tools = createBotCUATools({ directory, bridge: async (...args) => { calls.push(args); return options.reply ? options.reply(...args) : { content: [{ type: 'text', text: 'sandbox result' }] }; }, processRunner: async () => { throw new Error('No host process should run in tool tests.'); } });
  t.after(async () => { await tools.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  return { tools, calls, directory };
}

test('CUA tools preserve provider-independent capabilities and use coordinate screenshots', async t => {
  const { tools } = await fixture(t);
  assert.deepEqual(tools.definitions({ ...bot, capabilities: 'code' }).map(t => t.name), ['read_file', 'list_files', 'write_file', 'run_command']);
  assert.ok(tools.definitions({ ...bot, capabilities: 'computer' }).every(t => t.name.startsWith('browser_') || t.name.startsWith('computer_')));
  assert.deepEqual(tools.definitions({ ...bot, policy: 'plan' }).map(t => t.name), ['read_file', 'list_files', 'browser_snapshot', 'computer_screenshot']);
  const click = tools.definitions(bot).find(t => t.name === 'browser_click');
  assert.deepEqual(click.inputSchema.required, ['x', 'y']);
});

test('reading never starts a sandbox; denied writes never reach SDK or host', async t => {
  const { tools, calls } = await fixture(t);
  await tools.execute({ bot, chatId: 'c1', name: 'read_file', args: { path: 'README.md' } });
  assert.equal(calls[0][2].start, false);
  const denied = await tools.execute({ bot, chatId: 'c1', name: 'write_file', args: { path: 'a', content: 'b' }, requestPermission: async () => false });
  assert.equal(denied.isError, true); assert.equal(calls.length, 1);
  await assert.rejects(tools.execute({ bot: { ...bot, policy: 'plan' }, chatId: 'c1', name: 'run_command', args: { command: 'touch /HOST_SENTINEL' } }), /not available/);
});

test('approved mutations carry only owned sandbox identity and use private credential-free environment', async t => {
  const { tools, calls, directory } = await fixture(t); const frames = [];
  await tools.execute({ bot, chatId: 'c1', name: 'run_command', args: { command: 'pwd' }, toolCallId: 'owned-call', requestPermission: async () => true, onFrame: frame => frames.push(frame) });
  const [, , request, options] = calls[0];
  assert.equal(request.operation, 'tool'); assert.equal(request.start, true); assert.equal(request.image, CUA_IMAGE); assert.equal(request.sandbox, cuaSandboxName(bot));
  assert.equal(request.workspace, undefined); assert.equal(JSON.stringify(request).includes(bot.workspace), false);
  assert.equal(options.env.HOME, join(directory, 'cua-runtime', 'home'));
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'CUA_API_KEY']) assert.equal(options.env[key], undefined);
  assert.equal(options.env.CUA_SPACES_AGENT_CREDENTIALS_HOME, 'none');
  assert.deepEqual(frames.map(f => [f.type, f.tool.id, f.tool.state]), [['agent-tool', 'owned-call', 'running'], ['agent-tool', 'owned-call', 'done']]);
});

test('viewer state is read-only and control cannot override image, state directory or sandbox', async t => {
  const { tools, calls } = await fixture(t);
  await tools.state({ bot }); assert.equal(calls[0][2].operation, 'state'); assert.equal(calls[0][2].start, undefined);
  await tools.control({ bot, action: 'click', x: 20, y: 30, operation: 'start', directory: '/host', image: 'malicious', sandbox: 'other' });
  assert.equal(calls[1][2].operation, 'control'); assert.notEqual(calls[1][2].directory, '/host'); assert.equal(calls[1][2].image, CUA_IMAGE); assert.equal(calls[1][2].sandbox, cuaSandboxName(bot));
  await assert.rejects(async () => tools.control({ bot, action: 'shell' }), /supported/);
  await tools.start({ bot }); assert.equal(calls[2][2].operation, 'start');
});

test('aborted approval and competing chat cannot run a CUA action', async t => {
  const { tools, calls } = await fixture(t); const abort = new AbortController();
  await assert.rejects(tools.execute({ bot, chatId: 'c1', name: 'computer_type', args: { text: 'late' }, signal: abort.signal, requestPermission: async () => { abort.abort(); return true; } }), /stopped/);
  assert.equal(calls.length, 0);
  await tools.execute({ bot, chatId: 'c1', name: 'read_file', args: { path: 'a' } });
  await assert.rejects(tools.execute({ bot, chatId: 'c2', name: 'read_file', args: { path: 'a' } }), /Another conversation/);
  await tools.finish('c1'); await tools.execute({ bot, chatId: 'c2', name: 'read_file', args: { path: 'a' } });
});

test('unconfirmed guest cancellation fails finish and close instead of reporting successful Stop', async t => {
  const error = Object.assign(new Error('guest cleanup uncertain'), { cleanupUnconfirmed: true });
  const { tools } = await fixture(t, { reply: () => { throw error; } });
  await assert.rejects(tools.execute({ bot: { ...bot, policy: 'bypass' }, chatId: 'c1', name: 'run_command', args: { command: 'sleep 90' } }), /uncertain/);
  await assert.rejects(tools.finish('c1'), error => error.cleanupUnconfirmed === true);
  await assert.rejects(tools.close(), error => error.cleanupUnconfirmed === true);
});

test('probe never installs missing runtime and wrong execution mode cannot fall back', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-cua-empty-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = createBotCUATools({ directory, processRunner: () => { throw Error('Unexpected install'); }, bridge: () => { throw Error('Unexpected SDK call'); } });
  assert.equal((await tools.probe()).available, false);
  await assert.rejects(tools.state({ bot }), /Prepare CUA/);
  await assert.rejects(tools.state({ bot: { ...bot, execution: { kind: 'ssh', host: 'other' } } }), /this execution/);
  await assert.rejects(tools.execute({ bot: { ...bot, computerMode: 'host' }, chatId: 'c1', name: 'read_file', args: { path: '/etc/passwd' } }), /this execution/);
});

test('Linux preparation uses only the private SDK helper and scopes QEMU wrappers to its environment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-cua-prepare-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const venv = join(directory, 'cua-runtime', 'venv', 'bin'); await mkdir(venv, { recursive: true }); await writeFile(join(venv, 'python'), '');
  const processes = [], tools = createBotCUATools({ directory, platform: 'linux', processRunner: async (command, args, options) => { processes.push({ command, args, options }); return { code: 0, stdout: args.includes('-c') ? '0.5.0\n' : '{"prepared":true}' }; }, bridge: async () => ({ available: true, prepared: true }) });
  assert.equal((await tools.prepare()).available, true); assert.equal(processes.length, 2);
  assert.ok(processes[1].args[2].endsWith('/bots-runtime/cua-qemu-prepare.py')); assert.equal(processes[1].args[3], join(directory, 'cua-runtime/home/.cua'));
  for (const call of processes) assert.deepEqual(call.args.slice(0, 2), ['-I', '-B']);
  assert.equal(processes[1].options.env.PATH.split(':')[0], join(directory, 'cua-runtime/home/.cua/bin'));
  assert.equal(processes[1].command, join(venv, 'python')); await tools.close();
});

test('Mac preparation replaces an unloadable signed-Python venv with an existing independent interpreter and retains the failed runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-cua-mac-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'cua-runtime'), venv = join(root, 'venv'), executable = join(venv, 'bin/python'), independent = join(directory, 'independent-python'), invalid = join(directory, 'not-executable');
  await mkdir(join(venv, 'bin'), { recursive: true }); await writeFile(executable, 'signed interpreter'); await writeFile(independent, 'existing interpreter'); await writeFile(invalid, 'not an executable');
  const processes = []; let replaced = false;
  const tools = createBotCUATools({ directory, platform: 'darwin', python: '/bundled/signed/python', pythonCandidates: [join(directory, 'missing'), invalid, independent], processRunner: async (command, args, options) => {
    processes.push({ command, args, options });
    if (command === invalid || command === executable && args.includes('-c') && !replaced) throw Object.assign(Error('Cannot execute this interpreter'), { code: 'EACCES' });
    if (command === executable && args.includes('-c')) return { code: 0, stdout: '0.5.0\n' };
    if (args.includes('venv')) { assert.equal(command, independent); await mkdir(join(venv, 'bin'), { recursive: true }); await writeFile(executable, 'independent interpreter'); replaced = true; }
    return { code: 0, stdout: '' };
  }, bridge: async () => ({ available: true, prepared: true }) });
  assert.equal((await tools.prepare()).available, true);
  const backup = (await readdir(root)).find(name => name.startsWith('venv-unavailable-')); assert.ok(backup);
  assert.equal(await readFile(join(root, backup, 'bin/python'), 'utf8'), 'signed interpreter');
  assert.ok(processes.some(p => p.args.includes('pip'))); assert.ok(processes.every(p => p.options.env.HOME === join(root, 'home')));
  for (const call of processes) assert.deepEqual(call.args.slice(0, 2), ['-I', '-B']);
  assert.ok(processes.every(p => p.command !== '/bundled/signed/python'));
  await tools.close();
});

test('Mac preparation reuses a working private SDK after restart without selecting another interpreter', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-cua-mac-reuse-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'cua-runtime/venv/bin'); await mkdir(bin, { recursive: true }); await writeFile(join(bin, 'python'), 'working');
  const calls = [], tools = createBotCUATools({ directory, platform: 'darwin', pythonCandidates: [], processRunner: async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: '0.5.0\n' }; }, bridge: async () => ({ available: true }) });
  await tools.prepare(); assert.equal(calls.length, 1); assert.match(calls[0].args[3], /import cua/); assert.deepEqual(calls[0].args.slice(0, 2), ['-I', '-B']); assert.deepEqual(await readdir(join(directory, 'cua-runtime')), ['home', 'venv']); await tools.close();
});

test('Mac preparation with no compatible independent interpreter leaves the failed venv intact and gives an actionable error', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-cua-mac-missing-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'cua-runtime/venv/bin'); await mkdir(bin, { recursive: true }); await writeFile(join(bin, 'python'), 'retained');
  const tools = createBotCUATools({ directory, platform: 'darwin', pythonCandidates: [], processRunner: async () => ({ code: 1, stdout: '' }), bridge: async () => { throw Error('must not call SDK'); } });
  await assert.rejects(tools.prepare(), /independent Python 3.10/); assert.equal(await readFile(join(bin, 'python'), 'utf8'), 'retained'); assert.deepEqual(await readdir(join(directory, 'cua-runtime')), ['home', 'venv']); await tools.close();
});
