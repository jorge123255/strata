import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createBotCreatedTools } from '../server/bots-created-tools.mjs';
import { extensionHash } from '../server/bots-extension-store.mjs';
import { createCreatedCommandTools, createdToolCommand, createdToolRequirements } from '../server/bots-runtime/created-tools.mjs';
import { createBotTools } from '../server/bots-tools.mjs';
import { createBotCUATools } from '../server/bots-cua.mjs';
import { startWorker } from '../server/bots-runtime/ssh-worker.mjs';

const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const unpack = value => JSON.parse(value.content[0].text);
const readiness = value => JSON.parse(value.content[0].text.split('\n')[1]);
function fixture(t, content = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-readiness-')), workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const service = createBotCreatedTools({ directory, hasBot: () => true });
  const bot = { id: 'bot_builder', name: 'Fixture', policy: 'manual', computerMode: 'host', execution: { kind: 'local' }, capabilities: 'code', workspace };
  const context = { bot, chatId: 'fixture_chat', turnId: 'fixture_turn', assertLive() {}, requestPermission: async () => true };
  const draft = service.create({ name: 'Readiness fixture', command: 'printf BODY', inputSchema: schema, ...content }).tool;
  const patch = (tool, changes) => service.update(tool.id, { expectedRevision: tool.revision, expectedDigest: tool.digest, ...changes }).tool;
  let tool = patch(draft, { status: 'enabled', botIds: [bot.id] });
  bot.extensionSnapshots = { createdTools: service.snapshot(bot) };
  const calls = [], base = createBotTools({ directory });
  const tools = createCreatedCommandTools({ ...base, execute(options) { calls.push(options); return base.execute(options); } });
  const options = (name, args = {}) => ({ bot, chatId: context.chatId, name, args: { toolId: tool.id, ...args }, requestPermission: async () => true, authorizeCreatedTool: args => service.authorize(args, context) });
  t.after(async () => { await tools.finish(context.chatId); await tools.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace, service, bot, context, tool, patch, tools, options, calls };
}

test('requirements are bounded declarative presence checks and reject probe scripts, traversal and executable arguments', () => {
  assert.equal(createdToolRequirements({ platforms: [], executables: [], workspaceFiles: [] }), undefined);
  const good = { platforms: ['darwin', 'linux', 'win32'], executables: ['python3', 'clang++', 'my-app.exe'], workspaceFiles: ["nested/it's $(safe) `data`.txt"] };
  assert.deepEqual(createdToolRequirements(good), good);
  for (const value of [null, [], { probe: 'touch BAD' }, { platforms: ['mac'] }, { platforms: ['linux', 'linux'] }, { executables: ['node --version'] }, { executables: ['/bin/sh'] }, { executables: ['-x'] }, { executables: ['$(touch BAD)'] }, { executables: Array.from({ length: 17 }, (_, i) => `x${i}`) }, { workspaceFiles: ['/etc/passwd'] }, { workspaceFiles: ['a/../b'] }, { workspaceFiles: ['./a'] }, { workspaceFiles: ['a//b'] }, { workspaceFiles: ['C:foo'] }, { workspaceFiles: ['a\\b'] }, { workspaceFiles: ['a\nb'] }, { workspaceFiles: ['x'.repeat(241)] }]) assert.throws(() => createdToolRequirements(value));
});

test('legacy definitions keep their exact proof, encoded command and on-disk bytes without migration', t => {
  const f = fixture(t), file = join(f.directory, 'bots-created-tools.json'), before = readFileSync(file);
  const legacyProof = extensionHash([f.tool.id, f.tool.revision, f.tool.name, f.tool.description, f.tool.command, f.tool.inputSchema, f.tool.timeoutSeconds, f.tool.status, f.tool.botIds, f.tool.teamIds]);
  assert.equal(f.tool.digest, legacyProof); assert.equal(Object.hasOwn(f.tool, 'requirements'), false);
  assert.equal(createdToolCommand(f.tool, { text: 'literal' }), 'STRATA_TOOL_INPUT=\'{"text":"literal"}\' /bin/sh -c \'printf BODY\'');
  const reopened = createBotCreatedTools({ directory: f.directory }); assert.equal(reopened.list().tools[0].digest, legacyProof); assert.deepEqual(readFileSync(file), before);
});

test('requirements are part of reviewed authority, edits revoke old snapshots, and clearing requires a new review', t => {
  const f = fixture(t), enabled = f.tool;
  const changed = f.patch(enabled, { requirements: { executables: ['node'] }, status: 'enabled' });
  assert.equal(changed.status, 'draft'); assert.notEqual(changed.digest, enabled.digest);
  assert.throws(() => f.service.authorize({ mode: 'run', toolId: enabled.id, expectedDigest: enabled.digest, input: { text: 'x' } }, f.context), /not assigned/);
  assert.throws(() => f.patch(enabled, { requirements: {} }), { status: 409 });
  const enabledAgain = f.patch(changed, { status: 'enabled' }), cleared = f.patch(enabledAgain, { requirements: {} });
  assert.equal(cleared.status, 'draft'); assert.equal(Object.hasOwn(cleared, 'requirements'), false);
  assert.equal(f.service.list().createdToolReadinessSupported, true);
  assert.throws(() => f.patch(cleared, { requirements: null }), { status: 400 });
});

test('actual local readiness checks report presence, never execute saved bodies, and preserve exact quoted file names', async t => {
  const name = "it's $(touch INJECTED) `touch INJECTED`.txt";
  const f = fixture(t, { command: 'touch BODY_WAS_RUN', requirements: { platforms: [process.platform], executables: ['node'], workspaceFiles: [name] } });
  writeFileSync(join(f.workspace, name), 'fixture data');
  const frames = [], result = await f.tools.execute({ ...f.options('check_created_tool'), toolCallId: 'check_safe', onFrame: frame => frames.push(frame) });
  assert.equal(result.isError, false); const report = readiness(result);
  assert.equal(report.ready, true); assert.equal(report.platform, process.platform); assert.equal(report.digest, f.tool.digest);
  assert.deepEqual(report.checks.map(c => c.kind), ['platform', 'executable', 'workspaceFile']);
  assert.equal(report.checks[2].name, name); assert.equal(existsSync(join(f.workspace, 'INJECTED')), false); assert.equal(existsSync(join(f.workspace, 'BODY_WAS_RUN')), false);
  assert.equal(frames.at(-1).tool.name, 'check_created_tool'); assert.equal(frames.at(-1).tool.state, 'done');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].bot.workspace, f.workspace); assert.equal(f.service.list().tools[0].status, 'enabled');
});

test('missing programs, files and unsupported platforms block the real command with an honest structured report', async t => {
  for (const requirements of [{ executables: ['strata_fixture_missing_binary_9d375'] }, { workspaceFiles: ['missing/script.js'] }, { platforms: [process.platform === 'darwin' ? 'linux' : 'darwin'] }]) {
    const f = fixture(t, { command: 'touch BODY_WAS_RUN', requirements });
    const check = await f.tools.execute({ ...f.options('check_created_tool'), toolCallId: 'check_missing' });
    assert.equal(check.isError, true); assert.equal(readiness(check).ready, false); assert.equal(readiness(check).checks[0].available, false);
    const run = await f.tools.execute({ ...f.options('run_created_tool', { input: { text: 'unused' } }), toolCallId: 'run_missing' });
    assert.equal(run.isError, true); assert.match(run.content[0].text, /^Exit 78\n/); assert.equal(existsSync(join(f.workspace, 'BODY_WAS_RUN')), false);
  }
});

test('readiness is checked after approval on every actual invocation rather than trusted from an earlier success', async t => {
  const f = fixture(t, { command: 'touch BODY_WAS_RUN', requirements: { workspaceFiles: ['required.txt'] } });
  writeFileSync(join(f.workspace, 'required.txt'), 'present');
  assert.equal(readiness(await f.tools.execute({ ...f.options('check_created_tool'), toolCallId: 'first_presence' })).ready, true);
  const result = await f.tools.execute({ ...f.options('run_created_tool', { input: { text: 'unused' } }), toolCallId: 'changed_during_approval', requestPermission: async request => {
    assert.equal(request.args.requirements.workspaceFiles[0], 'required.txt'); rmSync(join(f.workspace, 'required.txt')); return true;
  } });
  assert.equal(result.isError, true); assert.equal(readiness(result).ready, false); assert.equal(existsSync(join(f.workspace, 'BODY_WAS_RUN')), false);
});

test('successful required tools still receive literal JSON inputs on the actual selected command executor', async t => {
  const f = fixture(t, { command: 'printf %s "$STRATA_TOOL_INPUT"', requirements: { executables: ['node'] } });
  const value = "quote' $(touch INJECTED) `touch INJECTED`\nsecond line";
  const result = await f.tools.execute({ ...f.options('run_created_tool', { input: { text: value } }), toolCallId: 'run_ready' });
  assert.equal(result.isError, false); assert.equal(readiness(result).ready, true);
  assert.deepEqual(JSON.parse(result.content[0].text.split('\n').slice(2).join('\n')), { text: value });
  assert.equal(existsSync(join(f.workspace, 'INJECTED')), false);
});

test('creator may check their exact draft without command input, but cannot check another bot draft or silently enable it', async t => {
  const f = fixture(t), draft = unpack(await f.service.execute('draft_tool', { name: 'Own readiness', command: 'touch SHOULD_NOT_RUN', inputSchema: schema, requirements: { executables: ['node'] } }, f.context)).tool;
  const result = await f.tools.execute({ ...f.options('check_created_tool', { toolId: draft.id, expectedDigest: draft.digest }), toolCallId: 'own_check' });
  assert.equal(readiness(result).ready, true); assert.equal(f.service.list().tools.find(tool => tool.id === draft.id).status, 'draft'); assert.equal(existsSync(join(f.workspace, 'SHOULD_NOT_RUN')), false);
  assert.throws(() => f.service.authorize({ mode: 'check', toolId: draft.id, expectedDigest: draft.digest }, { ...f.context, bot: { ...f.bot, id: 'other' } }), /not assigned/);
  assert.throws(() => f.service.authorize({ mode: 'check', toolId: draft.id, expectedDigest: draft.digest, input: {} }, f.context), { status: 400 });
});

test('normal approval, Stop, frozen grants, Plan, Chat-only and missing command capabilities apply to checks', async t => {
  const f = fixture(t), denied = await f.tools.execute({ ...f.options('check_created_tool'), toolCallId: 'denied', requestPermission: async () => false });
  assert.equal(denied.isError, true);
  for (const bot of [{ ...f.bot, policy: 'plan' }, { ...f.bot, teamConversationOnly: true }, { ...f.bot, capabilities: 'computer' }]) {
    assert.equal(f.tools.definitions(bot).some(t => t.name === 'check_created_tool'), false);
    await assert.rejects(f.tools.execute({ ...f.options('check_created_tool'), toolCallId: `blocked_${JSON.stringify(bot)}`, bot }), /unavailable/);
  }
  const controller = new AbortController();
  await assert.rejects(f.tools.execute({ ...f.options('check_created_tool'), toolCallId: 'stop', signal: controller.signal, requestPermission: async () => { controller.abort(); return true; } }));
  await assert.rejects(f.tools.execute({ ...f.options('check_created_tool'), toolCallId: 'revoke', requestPermission: async () => { f.patch(f.tool, { status: 'draft' }); return true; } }), /not assigned/);
});

class Reader extends EventEmitter { close() { this.emit('close'); } }
test('SSH workers and CUA guest paths check using only their selected executor, including guest OS detection', async t => {
  for (const computerMode of ['host', 'cua']) {
    const f = fixture(t, { requirements: { platforms: ['linux'], executables: ['node'], workspaceFiles: ['script.js'] } }), reader = new Reader(), executed = [], sent = [];
    let hostFactories = 0, cuaFactories = 0;
    const factory = () => ({ definitions: () => [{ name: 'run_command' }], async execute(options) { assert.equal(await options.requestPermission({ id: options.toolCallId, name: 'run_command', args: options.args }), true); executed.push(options); return { content: [{ type: 'text', text: 'Exit 0\n{"ready":true,"platform":"linux"}\n' }] }; }, finish() {}, close() {} });
    await startWorker({ bot: { ...f.bot, computerMode, execution: { kind: 'ssh', host: 'fixture.invalid' }, createdTools: { assignments: [{ id: f.tool.id, digest: f.tool.digest }] } }, sessionId: `remote_check_${computerMode}`, message: 'inert fixture', hostTools: [{ name: 'authorize_created_tool', inputSchema: { type: 'object' } }] }, {
      reader, directory: join(f.directory, 'worker'), toolFactory: () => { hostFactories++; return factory(); }, cuaFactory: () => { cuaFactories++; return factory(); },
      send(message) { sent.push(message); if (message.type === 'permission') queueMicrotask(() => reader.emit('line', JSON.stringify({ type: 'reply', id: message.id, value: true }))); if (message.type === 'requestHostTool') { assert.equal(message.value.name, 'authorize_created_tool'); assert.equal(message.value.args.mode, 'check'); const value = f.service.authorize(message.value.args, f.context); queueMicrotask(() => reader.emit('line', JSON.stringify({ type: 'reply', id: message.id, value }))); } },
      runtimeFactory: () => ({ async run(input) { assert.ok(input.tools.some(tool => tool.name === 'check_created_tool')); await input.executeTool('check_created_tool', { toolId: f.tool.id }, 'remote_readiness'); return { text: 'fixture done' }; }, close() {} }),
    });
    assert.equal(executed.length, 1); assert.equal(hostFactories, computerMode === 'host' ? 1 : 0); assert.equal(cuaFactories, computerMode === 'cua' ? 1 : 0);
    assert.equal(executed[0].bot.computerMode, computerMode); assert.equal(executed[0].bot.workspace, f.workspace); assert.equal(executed[0].bot.execution.kind, 'local');
    assert.match(executed[0].args.command, /uname -s/); assert.equal(executed[0].args.command.includes('printf BODY'), false); assert.equal(sent.filter(message => message.type === 'requestHostTool').length, 2);
  }
});

test('Windows checks use literal program/file arguments, report readiness and fail before saved body', () => {
  const command = createdToolCommand({ id: 'tool_fixture', digest: 'f'.repeat(64), command: 'Write-Output SHOULD_NOT_RUN', inputSchema: schema, requirements: { platforms: ['win32'], executables: ['node.exe'], workspaceFiles: ["a/it's $(data).txt"] } }, {}, { windows: true, checkOnly: true });
  assert.match(command, /Get-Command -Name/); assert.match(command, /-CommandType Application/); assert.match(command, /Test-Path -LiteralPath/); assert.match(command, /exit 78/); assert.equal(command.includes('SHOULD_NOT_RUN'), false); assert.equal(command.includes('Install-'), false);
});

test('actual CUA adapter sends only readiness to its owned guest and missing runtime cannot fall back to the host', async t => {
  const f = fixture(t, { requirements: { platforms: ['linux'], workspaceFiles: ['guest.txt'] } }); f.bot.computerMode = 'cua'; f.bot.workspace = '/workspace/project';
  const unavailable = createCreatedCommandTools(createBotCUATools({ directory: join(f.directory, 'unprepared'), processRunner() { throw new Error('No preparation or host process allowed.'); }, bridge() { throw new Error('Missing CUA must not execute.'); } }));
  await assert.rejects(unavailable.execute({ ...f.options('check_created_tool'), toolCallId: 'unprepared' }), /Prepare CUA/);
  await unavailable.finish(f.context.chatId); await unavailable.close();
  const directory = join(f.directory, 'prepared'), python = join(directory, 'cua-runtime', 'venv', 'bin'); mkdirSync(python, { recursive: true }); writeFileSync(join(python, 'python'), 'fixture');
  const requests = [], tools = createCreatedCommandTools(createBotCUATools({ directory, processRunner() { throw new Error('No host process allowed.'); }, async bridge(_python, _helper, request) {
    requests.push(request); return { content: [{ type: 'text', text: 'Exit 0\n{"type":"created-tool-readiness","platform":"linux","checks":[],"ready":true}\n' }] };
  } }));
  const result = await tools.execute({ ...f.options('check_created_tool'), toolCallId: 'prepared_guest' });
  assert.equal(readiness(result).platform, 'linux'); assert.equal(requests.length, 1); assert.equal(requests[0].workspace, '/workspace/project');
  assert.equal(requests[0].operation, 'tool'); assert.equal(requests[0].name, 'run_command'); assert.match(requests[0].args.command, /uname -s/); assert.equal(requests[0].args.command.includes('printf BODY'), false);
  await tools.finish(f.context.chatId); await tools.close();
});
