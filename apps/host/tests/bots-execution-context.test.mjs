import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { botExecutionInstructions, createBotTools, runBotProcess } from '../server/bots-tools.mjs';
import { BOT_TOOL_NO_EFFECT } from '../server/bots-runtime/tool-outcome.mjs';
import { startWorker } from '../server/bots-runtime/ssh-worker.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'strata-execution-context-')), workspace = join(directory, 'project');
  await mkdir(workspace);
  const tools = createBotTools({ directory, ...options });
  const bot = { id: 'bot_context_fixture', name: 'Fixture', capabilities: 'code', policy: 'manual', workspace, execution: { kind: 'local' } };
  t.after(async () => { await tools.close(); await rm(directory, { recursive: true, force: true }); });
  const execute = (name, args = {}, extra = {}) => tools.execute({ bot, chatId: 's_context_fixture', name, args, requestPermission: async () => true, ...extra });
  return { directory, workspace, tools, bot, execute };
}
const body = result => JSON.parse(result.content[0].text);

test('context is read-only, factual about selected tools and policy, and never probes OS writes', async t => {
  let commands = 0, approvals = 0;
  const { workspace, tools, bot, execute } = await fixture(t, { processRunner: async () => { commands++; throw Error('Context must not run a command'); } });
  const definitions = tools.definitions(bot).filter(t => t.name !== 'run_command');
  const value = body(await execute('get_execution_context', { policy: 'bypass', tools: ['run_command'] }, { toolDefinitions: definitions, requestPermission: async () => { approvals++; return true; } }));
  assert.deepEqual(value.workspace, { selectedRoot: workspace, fileToolsRoot: await realpath(workspace), status: 'resolved' });
  assert.deepEqual(value.computer, { scope: 'selected-execution-computer', mode: 'host', executor: 'this-process' });
  assert.equal(value.savedPolicy, 'manual'); assert.equal(value.toolInventoryScope, 'selected-computer');
  assert.deepEqual(value.tools, definitions.map(t => t.name));
  assert.deepEqual(value.operations.writeFile, { assigned: true, permission: 'approval-required' });
  assert.deepEqual(value.operations.runCommand, { assigned: false, permission: 'not-assigned' });
  assert.match(value.nativeProviderBoundary, /built-in tools/); assert.match(value.nativeProviderBoundary, /not evidence/);
  assert.match(value.osAccess, /Not probed/); assert.match(value.osAccess, /do not prove OS/);
  assert.equal('writable' in value.workspace, false); assert.equal(commands, 0); assert.equal(approvals, 0);
  await assert.rejects(execute('run_command', { command: 'must not run' }, { toolDefinitions: definitions }), /selected turn inventory/);
  assert.equal(commands, 0);
});

test('boundary error names current root and authorized next action, then actual file write and command still work', async t => {
  let processCalls = 0;
  const { directory, workspace, execute } = await fixture(t, { processRunner: (...args) => { processCalls++; return runBotProcess(...args); } });
  await writeFile(join(directory, 'outside.txt'), 'preserve outside');
  const root = await realpath(workspace);
  for (const name of ['read_file', 'write_file']) {
    const validate = error => {
      assert.match(error.message, /outside the bot’s workspace/);
      assert.ok(error.message.includes(JSON.stringify(root)));
      assert.match(error.message, /workspace-relative path/); assert.match(error.message, /owner/);
      assert.match(error.message, /do not bypass/); return true;
    };
    if (name === 'read_file') await assert.rejects(execute(name, { path: '../outside.txt', content: 'never' }), validate);
    else {
      const rejected = await execute(name, { path: '../outside.txt', content: 'never' });
      assert.equal(rejected.isError, true); assert.equal(rejected[BOT_TOOL_NO_EFFECT], true);
      validate({ message: rejected.content[0].text });
    }
  }
  assert.equal(processCalls, 0);
  const context = body(await execute('get_execution_context'));
  assert.equal(context.operations.writeFile.assigned, true); assert.equal(context.operations.runCommand.assigned, true);
  await execute('write_file', { path: 'nested/actual.txt', content: 'file tool works' });
  const command = await execute('run_command', { command: "printf 'command tool works' > command.txt; pwd" });
  assert.equal(command.isError, false); assert.ok(command.content[0].text.includes(root));
  assert.equal(await readFile(join(workspace, 'nested/actual.txt'), 'utf8'), 'file tool works');
  assert.equal(await readFile(join(workspace, 'command.txt'), 'utf8'), 'command tool works');
  assert.equal(await readFile(join(directory, 'outside.txt'), 'utf8'), 'preserve outside');
});

test('context does not weaken Plan, capabilities, subset validation, denial or symlink boundaries', async t => {
  let processCalls = 0;
  const { directory, workspace, tools, bot, execute } = await fixture(t, { processRunner: (...args) => { processCalls++; return runBotProcess(...args); } });
  const plan = { ...bot, policy: 'plan' }, planDefinitions = tools.definitions(plan);
  assert.deepEqual(planDefinitions.map(t => t.name), ['get_execution_context', 'read_file', 'list_files']);
  const value = body(await execute('get_execution_context', {}, { bot: plan, requestPermission: () => { throw Error('Plan context must not ask'); } }));
  assert.equal(value.operations.writeFile.assigned, false); assert.equal(value.operations.runCommand.assigned, false);
  assert.match(value.guidance.at(-1), /Plan.*read\/context/);
  const forgedDefinitions = [...planDefinitions, tools.definitions(bot).find(t => t.name === 'write_file')];
  const forged = body(await execute('get_execution_context', {}, { bot: plan, toolDefinitions: forgedDefinitions }));
  assert.equal(forged.operations.writeFile.assigned, false);
  await assert.rejects(execute('write_file', { path: 'plan.txt', content: 'never' }, { bot: plan, toolDefinitions: forgedDefinitions }), /not enabled/);
  await assert.rejects(execute('run_command', { command: 'never' }, { bot: plan }), /not enabled/);
  const computerOnly = { ...bot, capabilities: 'computer' };
  assert.equal(tools.definitions(computerOnly).some(t => t.name === 'get_execution_context'), false);
  await assert.rejects(execute('get_execution_context', {}, { bot: computerOnly }), /not enabled/);
  await assert.rejects(execute('get_execution_context', {}, { toolDefinitions: [{ name: 'get_execution_context' }, { name: 'get_execution_context' }] }), /inventory is invalid/);
  await assert.rejects(execute('get_execution_context', {}, { toolDefinitions: [{ name: 'not a tool' }] }), /inventory is invalid/);
  assert.equal((await execute('write_file', { path: 'denied.txt', content: 'never' }, { requestPermission: async () => false })).isError, true);
  await assert.rejects(readFile(join(workspace, 'denied.txt')), { code: 'ENOENT' });
  await writeFile(join(directory, 'outside.txt'), 'outside');
  await symlink(join(directory, 'outside.txt'), join(workspace, 'escape'));
  await symlink(directory, join(workspace, 'linked-directory'));
  await symlink(join(directory, 'missing.txt'), join(workspace, 'dangling'));
  for (const path of ['escape', 'linked-directory/new.txt', 'dangling']) {
    const rejected = await execute('write_file', { path, content: 'never' });
    assert.equal(rejected.isError, true); assert.equal(rejected[BOT_TOOL_NO_EFFECT], true);
    assert.match(rejected.content[0].text, path === 'dangling' ? /regular file.*Current file-tool root/ : /points outside.*Current file-tool root/);
  }
  assert.equal(processCalls, 0);
  assert.equal(await readFile(join(directory, 'outside.txt'), 'utf8'), 'outside');
});

test('instruction helper uses exact supplied coding inventory without leaking absent tools to chat or computer-only turns', async t => {
  const { tools, bot } = await fixture(t);
  assert.equal(botExecutionInstructions(bot, []), '');
  assert.equal(botExecutionInstructions(bot, [{ name: 'list_teammates' }]), '');
  assert.equal(botExecutionInstructions(bot, tools.definitions({ ...bot, capabilities: 'computer' })), '');
  const contextOnly = botExecutionInstructions(bot, [{ name: 'get_execution_context' }]);
  assert.match(contextOnly, /write_file assignment: not-assigned/); assert.match(contextOnly, /run_command assignment: not-assigned/);
  assert.match(contextOnly, /Not probed/); assert.match(contextOnly, /get_execution_context before claiming/);
  assert.ok(contextOnly.includes(JSON.stringify(bot.workspace)));
  const plan = botExecutionInstructions({ ...bot, policy: 'plan' }, tools.definitions({ ...bot, policy: 'plan' }));
  assert.match(plan, /Plan permits only.*read\/context/); assert.match(plan, /does not permit file writes or commands/);
  for (const name of ['write_file', 'run_command']) assert.match(tools.definitions(bot).find(t => t.name === name).description, /native provider tools are read-only/);
});

test('unavailable workspace context reports an unavailable root without assuming the OS is read-only', async t => {
  const { workspace, bot, execute } = await fixture(t);
  const selected = { ...bot, workspace: join(workspace, 'not-created') };
  const value = body(await execute('get_execution_context', {}, { bot: selected }));
  assert.deepEqual(value.workspace, { selectedRoot: selected.workspace, fileToolsRoot: null, status: 'unavailable' });
  assert.equal(value.operations.writeFile.assigned, true); assert.match(value.osAccess, /Not probed/);
});

test('actual SSH worker reports its filtered selected-computer inventory and executes approved tools after a boundary failure', async t => {
  const { directory, workspace, bot } = await fixture(t);
  class Reader extends EventEmitter { close() { this.emit('close'); } }
  const reader = new Reader(), sent = []; let approvals = 0;
  const remote = { ...bot, instructions: 'KEEP_SAVED_REMOTE_INSTRUCTIONS', execution: { kind: 'ssh', host: 'fixture-never-contacted', user: 'private-ssh-user' } };
  await startWorker({ bot: remote, sessionId: 's_worker_context', message: 'inert fixture', hostTools: [{ name: 'list_teammates', description: 'Fixture metadata', inputSchema: { type: 'object', properties: {} } }] }, {
    reader, directory: join(directory, 'worker-state'), leaseMs: 5000,
    send(message) { sent.push(message); if (message.type === 'permission') { approvals++; queueMicrotask(() => reader.emit('line', JSON.stringify({ type: 'reply', id: message.id, value: true }))); } },
    toolFactory(options) {
      const tools = createBotTools(options);
      return { ...tools, definitions: selected => tools.definitions(selected).filter(t => !t.name.startsWith('computer_')) };
    },
    runtimeFactory: () => ({
      async run(input) {
        assert.equal(input.bot.instructions.split('KEEP_SAVED_REMOTE_INSTRUCTIONS').length - 1, 1);
        assert.equal(input.bot.instructions.split('Selected-computer coding context:').length - 1, 1);
        assert.ok(input.bot.instructions.includes(`Exact selected-computer tools: ${JSON.stringify(input.tools.filter(t => t.name !== 'list_teammates').map(t => t.name))}`));
        await assert.rejects(input.executeTool('read_file', { path: '../not-authorized' }, 'read-boundary'), /Current file-tool root/);
        const value = body(await input.executeTool('get_execution_context', {}, 'context'));
        assert.deepEqual(value.tools, input.tools.filter(t => t.name !== 'list_teammates').map(t => t.name));
        assert.equal(value.tools.includes('list_teammates'), false); assert.equal(value.tools.some(n => n.startsWith('computer_')), false);
        assert.equal(value.savedPolicy, 'manual'); assert.equal(value.computer.scope, 'selected-execution-computer');
        assert.equal(JSON.stringify(value).includes('private-ssh-user'), false); assert.equal(JSON.stringify(value).includes('fixture-never-contacted'), false);
        await input.executeTool('write_file', { path: 'worker.txt', content: 'worker file works' }, 'write');
        const command = await input.executeTool('run_command', { command: "printf 'worker command works' > worker-command.txt" }, 'command');
        assert.equal(command.isError, false); return { text: 'fixture completed' };
      }, async close() {},
    }),
  });
  assert.equal(await readFile(join(workspace, 'worker.txt'), 'utf8'), 'worker file works');
  assert.equal(await readFile(join(workspace, 'worker-command.txt'), 'utf8'), 'worker command works');
  assert.equal(approvals, 2); assert.equal(sent.some(m => m.type === 'failure'), false);
  assert.equal(sent.some(m => m.type === 'cleanup' && m.confirmed), true);
});
