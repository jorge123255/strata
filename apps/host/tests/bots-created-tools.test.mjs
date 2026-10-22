import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createBotCreatedTools } from '../server/bots-created-tools.mjs';
import { createCreatedCommandTools, createdToolSchema, createdToolInput, createdToolCommand } from '../server/bots-runtime/created-tools.mjs';
import { createBotTools, runBotProcess } from '../server/bots-tools.mjs';
import { createBotExtensionRoutes } from '../server/bots-extension-store.mjs';
import { startWorker } from '../server/bots-runtime/ssh-worker.mjs';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { botWorkAuthorityFingerprint } from '../server/bots-work-authority.mjs';

const inputSchema = { type: 'object', properties: { text: { type: 'string', maxLength: 1000 } }, required: ['text'], additionalProperties: false };
const unpack = value => JSON.parse(value.content[0].text);
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-created-tools-')), workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const service = createBotCreatedTools({ directory, hasBot: id => ['bot_owner', 'bot_other'].includes(id), hasTeam: id => id === 'team_owned', ...options });
  const bot = { id: 'bot_owner', name: 'Builder', capabilities: 'code', policy: 'manual', execution: { kind: 'local' }, computerMode: 'host', workspace };
  const context = { bot, chatId: 'owned_chat', turnId: 'owned_turn', signal: new AbortController().signal, assertLive() { this.signal.throwIfAborted(); }, requestPermission: async () => true };
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const create = () => service.create({ name: 'Echo JSON', command: 'printf %s "$STRATA_TOOL_INPUT"', description: 'Echo only fixture data', inputSchema }).tool;
  const patch = (tool, changes) => service.update(tool.id, { expectedRevision: tool.revision, expectedDigest: tool.digest, ...changes }).tool;
  const freeze = () => { bot.extensionSnapshots = { createdTools: service.snapshot(bot) }; return context; };
  return { directory, workspace, service, bot, context, create, patch, freeze };
}
test('command drafts persist privately and require exact review before grants become callable', t => {
  const f = fixture(t), draft = f.create(); assert.equal(draft.status, 'draft'); assert.equal(statSync(join(f.directory, 'bots-created-tools.json')).mode & 0o777, 0o600);
  assert.deepEqual(f.service.snapshot(f.bot).assignments, []);
  assert.throws(() => f.service.update(draft.id, { status: 'enabled' }), { status: 409 });
  const enabled = f.patch(draft, { status: 'enabled', botIds: [f.bot.id] }); f.freeze();
  assert.equal(f.service.authorize({ mode: 'run', toolId: enabled.id, expectedDigest: enabled.digest, input: { text: 'ok' } }, f.context).tool.command, enabled.command);
  const restored = createBotCreatedTools({ directory: f.directory }); assert.deepEqual(restored.list(), f.service.list());
  const changed = f.patch(enabled, { command: 'printf changed' }); assert.equal(changed.status, 'draft');
  assert.throws(() => f.service.authorize({ mode: 'run', toolId: enabled.id, expectedDigest: enabled.digest, input: { text: 'ok' } }, f.context), /not assigned/);
  assert.throws(() => f.patch(enabled, { status: 'enabled' }), { status: 409 });
});
test('later grants never enter old chats and team access requires exact live membership', t => {
  let live = true; const f = fixture(t, { teamAccess: (team, bot, run) => live && team === 'team_owned' && bot === 'bot_owner' && run === 'run_owned' });
  f.freeze(); const enabled = f.patch(f.create(), { status: 'enabled', teamIds: ['team_owned'] });
  f.bot.teamContext = { teamId: 'team_owned', teamRunId: 'run_owned' };
  assert.throws(() => f.service.authorize({ mode: 'run', toolId: enabled.id, expectedDigest: enabled.digest, input: { text: 'x' } }, f.context), /not assigned/);
  f.freeze(); assert.equal(f.service.authorize({ mode: 'run', toolId: enabled.id, expectedDigest: enabled.digest, input: { text: 'x' } }, f.context).tool.id, enabled.id);
  live = false; assert.throws(() => f.service.authorize({ mode: 'run', toolId: enabled.id, expectedDigest: enabled.digest, input: { text: 'x' } }, f.context), /not assigned/);
});
test('revocation remains available after a previously granted bot or team was removed', t => {
  let exists = true; const f = fixture(t, { hasBot: () => exists, hasTeam: () => exists });
  const enabled = f.patch(f.create(), { status: 'enabled', botIds: ['bot_owner'], teamIds: ['team_owned'] }); exists = false;
  const revoked = f.patch(enabled, { status: 'draft' }); assert.equal(revoked.status, 'draft');
  const cleared = f.patch(revoked, { botIds: [], teamIds: [] }); assert.deepEqual(cleared.botIds, []); assert.deepEqual(cleared.teamIds, []);
  assert.throws(() => f.patch(cleared, { botIds: ['missing_bot'] }), { status: 404 });
});
test('bot drafting derives provenance, never executes, and Stop prevents writes after approval', async t => {
  const f = fixture(t); let calls = 0;
  f.context.requestPermission = async () => { calls++; return true; };
  const tool = unpack(await f.service.execute('draft_tool', { name: 'Own draft', command: 'DO_NOT_EXECUTE' }, f.context)).tool;
  assert.equal(calls, 1); assert.equal(tool.status, 'draft'); assert.deepEqual(tool.provenance, { botId: 'bot_owner' });
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'bots-created-tools.json'))).tools[0].provenance, { botId: 'bot_owner', chatId: 'owned_chat', turnId: 'owned_turn' });
  assert.equal(f.service.authorize({ mode: 'test', toolId: tool.id, expectedDigest: tool.digest, input: {} }, f.context).tool.id, tool.id);
  assert.throws(() => f.service.authorize({ mode: 'test', toolId: tool.id, expectedDigest: tool.digest, input: {} }, { ...f.context, bot: { ...f.bot, id: 'bot_other' } }), /not assigned/);
  const controller = new AbortController(); f.context.signal = controller.signal; f.context.requestPermission = async () => { controller.abort(); return true; };
  await assert.rejects(f.service.execute('draft_tool', { name: 'Late', command: 'DO_NOT_EXECUTE' }, f.context)); assert.equal(f.service.list().tools.length, 1);
});
test('flat schema checks field types, required keys, bounds, reserved names and nested schemas', () => {
  assert.deepEqual(createdToolInput(inputSchema, { text: 'safe' }), { text: 'safe' });
  for (const value of [{}, { text: 3 }, { text: 'x', extra: true }, { text: '\0' }]) assert.throws(() => createdToolInput(inputSchema, value));
  for (const properties of [{ field: { type: 'object' } }, { field: { type: 'string', $ref: '/tmp' } }, JSON.parse('{"__proto__":{"type":"string"}}')]) assert.throws(() => createdToolSchema({ type: 'object', properties, required: [], additionalProperties: false }));
  const bounded = { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 2 }, flag: { type: 'boolean', enum: [true] } }, required: ['count'], additionalProperties: false };
  assert.throws(() => createdToolInput(bounded, { count: 1.5 })); assert.throws(() => createdToolInput(bounded, { count: 3 })); assert.throws(() => createdToolInput(bounded, { count: 1, flag: false }));
});
test('saved malformed and linked tool stores fail closed without replacement', t => {
  const f = fixture(t), file = join(f.directory, 'bots-created-tools.json');
  writeFileSync(file, JSON.stringify({ version: 1, tools: [{ id: 'tool_bad', command: 'invalid' }] })); const original = readFileSync(file, 'utf8');
  assert.throws(() => createBotCreatedTools({ directory: f.directory }), /invalid/); assert.equal(readFileSync(file, 'utf8'), original);
  rmSync(file); symlinkSync(join(f.directory, 'missing'), file); assert.throws(() => createBotCreatedTools({ directory: f.directory }), /regular file/);
});
test('encoded command size is bounded before execution and honest failure is not a test result', () => {
  const tool = { command: 'printf %s "$STRATA_TOOL_INPUT"', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
  assert.throws(() => createdToolCommand(tool, { text: "'".repeat(10000) }), /32,000-character limit/);
  assert.match(createdToolCommand(tool, { text: "'$()`" }, { windows: true }), /\$env:STRATA_TOOL_INPUT = '/);
});
test('team recovery fingerprints ignore only the new run identity and retain exact tool grants', t => {
  const f = fixture(t, { teamAccess: () => true }), enabled = f.patch(f.create(), { status: 'enabled', teamIds: ['team_owned'] });
  const original = { ...f.bot, teamContext: { teamId: 'team_owned', teamRunId: 'old_run' } }, later = { ...f.bot, teamContext: { teamId: 'team_owned', teamRunId: 'new_run' } };
  original.extensionSnapshots = { createdTools: f.service.snapshot(original) }; later.extensionSnapshots = { createdTools: f.service.snapshot(later) };
  assert.equal(botWorkAuthorityFingerprint(original), botWorkAuthorityFingerprint(later));
  f.patch(enabled, { botIds: ['bot_other'] }); later.extensionSnapshots = { createdTools: f.service.snapshot(later) };
  assert.notEqual(botWorkAuthorityFingerprint(original), botWorkAuthorityFingerprint(later));
});
test('legacy recovery authority equals an empty optional tool library and never inherits later grants', t => {
  const f = fixture(t), legacy = { ...f.bot, extensionSnapshots: {} }, empty = { ...f.bot, extensionSnapshots: { createdTools: f.service.snapshot(f.bot) } };
  assert.equal(botWorkAuthorityFingerprint(legacy), botWorkAuthorityFingerprint(empty));
  f.patch(f.create(), { status: 'enabled', botIds: [f.bot.id] }); const granted = { ...f.bot, extensionSnapshots: { createdTools: f.service.snapshot(f.bot) } };
  assert.notEqual(botWorkAuthorityFingerprint(legacy), botWorkAuthorityFingerprint(granted));
});
test('discovery pages every tool compactly and exact selected definitions stay out of frozen chat metadata', async t => {
  const f = fixture(t), all = [];
  for (let i = 0; i < 56; i++) { const draft = f.service.create({ name: `Tool ${i}`, description: 'd'.repeat(2000), command: `printf PRIVATE_COMMAND_${i}`, inputSchema }).tool; all.push(f.patch(draft, { status: 'enabled', botIds: [f.bot.id] })); }
  f.freeze(); const snapshot = JSON.stringify(f.bot.extensionSnapshots.createdTools); assert.equal(snapshot.includes('PRIVATE_COMMAND'), false); assert.equal(snapshot.includes('inputSchema'), false);
  const seen = [], pages = []; let afterToolId;
  do { const page = unpack(await f.service.execute('list_created_tools', afterToolId ? { afterToolId } : {}, f.context)); pages.push(page.tools.length); seen.push(...page.tools); afterToolId = page.nextAfterToolId; } while (afterToolId);
  assert.deepEqual(pages, [25, 25, 6]); assert.equal(new Set(seen.map(tool => tool.id)).size, 56);
  assert.ok(seen.every(tool => Object.keys(tool).sort().join(',') === 'description,digest,id,name,revision,status' && tool.description.length === 500));
  assert.equal(JSON.stringify(seen).includes('PRIVATE_COMMAND'), false);
  const exact = unpack(await f.service.execute('read_created_tool', { toolId: all[30].id }, f.context)).tool; assert.equal(exact.command, 'printf PRIVATE_COMMAND_30'); assert.deepEqual(exact.inputSchema, inputSchema);
  f.service.handle('DELETE', new URL(`http://fixture/api/bots/tools/${seen[24].id}`), { expectedRevision: seen[24].revision, expectedDigest: seen[24].digest });
  await assert.rejects(f.service.execute('list_created_tools', { afterToolId: seen[24].id }, f.context), { status: 409 });
});
test('actual local command receives literal JSON data and cannot inject shell via inputs', async t => {
  const f = fixture(t), enabled = f.patch(f.create(), { status: 'enabled', botIds: [f.bot.id] }); f.freeze();
  const frames = [], base = createBotTools({ directory: f.directory }), tools = createCreatedCommandTools(base), sentinel = join(f.workspace, 'INJECTED');
  const value = `single' double" newline\n$(touch ${sentinel}); \`touch ${sentinel}\``;
  const options = { bot: f.bot, chatId: f.context.chatId, name: 'run_created_tool', args: { toolId: enabled.id, input: { text: value } }, toolCallId: 'literal', signal: f.context.signal, requestPermission: async () => true, authorizeCreatedTool: args => f.service.authorize(args, f.context), onFrame: frame => frames.push(frame) };
  const first = await tools.execute(options), duplicate = await tools.execute(options); assert.equal(first, duplicate); assert.equal(existsSync(sentinel), false);
  assert.equal(JSON.parse(first.content[0].text.slice('Exit 0\n'.length)).text, value);
  assert.equal(frames.filter(frame => frame.tool?.state === 'done').length, 1); assert.equal(frames.at(-1).tool.name, 'run_created_tool');
  await assert.rejects(tools.execute({ ...options, args: { ...options.args, input: { text: 'different' } } }), /identity/);
  await tools.finish(f.context.chatId); await tools.close();
});
test('revocation and Stop during command approval prevent execution; Plan has no command calls', async t => {
  const f = fixture(t), enabled = f.patch(f.create(), { status: 'enabled', botIds: [f.bot.id] }); f.freeze(); let executions = 0;
  const base = { definitions: () => [{ name: 'run_command' }], async execute(options) { if (await options.requestPermission({ id: 'approved', args: {} })) { executions++; } return { content: [] }; } };
  const tools = createCreatedCommandTools(base), options = { bot: f.bot, chatId: 'chat', name: 'run_created_tool', args: { toolId: enabled.id, input: { text: 'x' } }, authorizeCreatedTool: args => f.service.authorize(args, f.context), signal: f.context.signal };
  await assert.rejects(tools.execute({ ...options, toolCallId: 'revoke', requestPermission: async () => { f.patch(enabled, { status: 'draft' }); return true; } }), /not assigned/); assert.equal(executions, 0);
  assert.deepEqual(tools.definitions({ ...f.bot, policy: 'plan' }).map(tool => tool.name), ['run_command']);
  await assert.rejects(tools.execute({ ...options, toolCallId: 'plan', bot: { ...f.bot, policy: 'plan' } }), /unavailable/); assert.equal(executions, 0);
  await assert.rejects(tools.execute({ ...options, toolCallId: 'chat-only', bot: { ...f.bot, teamConversationOnly: true } }), /unavailable/);
  await assert.rejects(f.service.execute('draft_tool', { name: 'No chat mutation', command: 'DO_NOT_EXECUTE' }, { ...f.context, bot: { ...f.bot, teamConversationOnly: true } }), /conversation mode/);
  const controller = new AbortController(), current = f.patch(f.service.list().tools[0], { status: 'enabled' }); f.freeze(); f.context.signal = controller.signal;
  await assert.rejects(tools.execute({ ...options, toolCallId: 'stop', args: { toolId: current.id, input: { text: 'x' } }, signal: controller.signal, requestPermission: async () => { controller.abort(); return true; } })); assert.equal(executions, 0);
});
test('own new drafts can be tested before enable and remain unavailable for normal calls', async t => {
  const f = fixture(t), draft = unpack(await f.service.execute('draft_tool', { name: 'Test own draft', command: 'printf %s "$STRATA_TOOL_INPUT"', inputSchema }, f.context)).tool;
  f.freeze(); const tools = createCreatedCommandTools(createBotTools({ directory: f.directory }));
  const options = { bot: f.bot, chatId: 'own', name: 'test_created_tool', args: { toolId: draft.id, expectedDigest: draft.digest, input: { text: 'tested, still draft' } }, requestPermission: async () => true, authorizeCreatedTool: args => f.service.authorize(args, f.context) };
  assert.match((await tools.execute(options)).content[0].text, /Exit 0/); assert.equal(f.service.list().tools[0].status, 'draft');
  await assert.rejects(tools.execute({ ...options, name: 'run_created_tool', args: { toolId: draft.id, input: {} } }), /not assigned/);
  await tools.finish('own'); await tools.close();
});
test('denied draft testing and stopped running command retain real error state without output effects', async t => {
  const f = fixture(t), draft = unpack(await f.service.execute('draft_tool', { name: 'Wait for Stop', command: 'sleep 90; touch SHOULD_NOT_EXIST' }, f.context)).tool;
  const controller = new AbortController(), frames = []; let started = false;
  const tools = createCreatedCommandTools(createBotTools({ directory: f.directory, processRunner(command, args, options) { started = true; setTimeout(() => controller.abort(), 50); return runBotProcess(command, args, options); } }));
  const options = { bot: f.bot, chatId: 'stop-test', name: 'test_created_tool', args: { toolId: draft.id, expectedDigest: draft.digest, input: {} }, authorizeCreatedTool: args => f.service.authorize(args, f.context), onFrame: frame => frames.push(frame) };
  const denied = await tools.execute({ ...options, toolCallId: 'deny', requestPermission: async () => false }); assert.equal(denied.isError, true); assert.equal(started, false); assert.equal(frames.at(-1).tool.state, 'denied');
  await assert.rejects(tools.execute({ ...options, toolCallId: 'stop-real-command', signal: controller.signal, requestPermission: async () => true }), /stopped/);
  assert.equal(started, true); assert.equal(existsSync(join(f.workspace, 'SHOULD_NOT_EXIST')), false); assert.equal(frames.at(-1).tool.state, 'error'); assert.equal(f.service.list().tools[0].status, 'draft');
  await tools.finish('stop-test'); await tools.close();
});
class Reader extends EventEmitter { close() { this.emit('close'); } }
test('remote worker runs the reusable command on its selected host or CUA executor, never host RPC execution', async t => {
  for (const computerMode of ['host', 'cua']) {
    const f = fixture(t), enabled = f.patch(f.create(), { status: 'enabled', botIds: [f.bot.id] }); f.freeze();
    const reader = new Reader(), sent = [], executed = [];
    const factory = () => ({ definitions: () => [{ name: 'run_command' }], async execute(options) { if (options.bot.policy !== 'bypass') assert.equal(await options.requestPermission({ id: options.toolCallId, name: 'run_command', args: options.args }), true); executed.push(options); return { content: [{ type: 'text', text: 'remote fixture command' }] }; }, finish() {}, close() {} });
    await startWorker({ bot: { ...f.bot, computerMode, execution: { kind: 'ssh', host: 'fixture' }, createdTools: { assignments: [enabled] } }, sessionId: 'remote_created', message: 'inert fixture', hostTools: [{ name: 'authorize_created_tool', inputSchema: { type: 'object' } }] }, {
      reader, directory: join(f.directory, 'worker'), toolFactory: factory, cuaFactory: factory,
      send(message) { sent.push(message); if (message.type === 'permission') queueMicrotask(() => reader.emit('line', JSON.stringify({ type: 'reply', id: message.id, value: true }))); if (message.type === 'requestHostTool') { assert.equal(message.value.name, 'authorize_created_tool'); const value = f.service.authorize(message.value.args, f.context); queueMicrotask(() => reader.emit('line', JSON.stringify({ type: 'reply', id: message.id, value }))); } },
      runtimeFactory: () => ({ async run(input) { assert.ok(input.tools.some(tool => tool.name === 'run_created_tool')); await input.executeTool('run_created_tool', { toolId: enabled.id, input: { text: 'remote data' } }, 'remote_call'); return { text: 'done' }; }, close() {} }),
    });
    assert.equal(executed.length, 1); assert.equal(executed[0].bot.workspace, f.workspace); assert.equal(executed[0].bot.computerMode, computerMode); assert.equal(executed[0].bot.execution.kind, 'local'); assert.equal(executed[0].name, 'run_command'); assert.match(executed[0].args.command, /STRATA_TOOL_INPUT=/);
    assert.equal(sent.filter(message => message.type === 'requestHostTool').length, 2); assert.equal(sent.find(message => message.type === 'cleanup').confirmed, true);
  }
});
test('reusable tool configuration routes retain exact local-origin and stale-review checks', async t => {
  const f = fixture(t); let port; const route = createBotExtensionRoutes({ createdTools: f.service, port: () => port });
  const server = http.createServer((req, res) => route(req, res, new URL(req.url, `http://${req.headers.host}`))); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  t.after(() => { server.close(); server.closeAllConnections(); }); const url = `http://127.0.0.1:${port}/api/bots/tools`;
  assert.equal((await fetch(url, { headers: { origin: 'https://other.invalid' } })).status, 403);
  const created = await (await fetch(url, { method: 'POST', body: JSON.stringify({ name: 'Draft', command: 'DO_NOT_EXECUTE' }) })).json(); assert.equal(created.tool.status, 'draft');
  assert.equal((await fetch(`${url}/${created.tool.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'enabled' }) })).status, 409);
  assert.equal((await (await fetch(url)).json()).createdToolsSupported, true);
  assert.equal((await fetch(`${url}/${created.tool.id}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: 99, expectedDigest: created.tool.digest }) })).status, 409);
  assert.equal((await fetch(`${url}/${created.tool.id}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: created.tool.revision, expectedDigest: created.tool.digest }) })).status, 200);
  assert.equal(f.service.list().tools.length, 0);
});
test('actual bot conversation exposes draft/test tools while preserving shared command ledger and no enabled grant', async t => {
  const f = fixture(t); let bots, chats;
  const service = createBotCreatedTools({ directory: join(f.directory, 'actual'), hasBot: id => bots?.hasBot(id) });
  bots = createBots({ directory: join(f.directory, 'actual'), createdTools: service, conversations: () => chats, defaultWorkspace: () => f.workspace, tools: createBotTools({ directory: f.directory }), runtime: { providers: async () => [], models: async () => ({}), close() {}, async run(input) {
    assert.match(input.bot.instructions, /STRATA_TOOL_INPUT/); const draft = unpack(await input.executeTool('draft_tool', { name: 'Own real draft', command: 'printf fixture_result' }, 'draft-owned')).tool;
    const tested = await input.executeTool('test_created_tool', { toolId: draft.id, expectedDigest: draft.digest, input: {} }, 'test-owned'); assert.match(tested.content[0].text, /Exit 0\nfixture_result/); input.onFrame({ type: 'delta', text: 'Draft tested but remains disabled.' });
  } } });
  chats = createConversations({ directory: join(f.directory, 'actual'), enabled: () => true, validateSelection: selection => bots.validateSelection(selection), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: options => bots.approve(options), execute: args => bots.run(args) });
  const bot = bots.create({ name: 'Actual fixture', provider: 'codex', workspace: f.workspace, policy: 'bypass', capabilities: 'code' }).bot, chat = bots.createConversation(bot.id).conversation;
  chats.send(chat.id, 'Create a fixture tool'); for (let i = 0; i < 100 && chats.detail(chat.id).conversation.active; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const saved = chats.detail(chat.id).conversation; assert.equal(saved.active, false); assert.match(saved.messages.at(-1).content, /remains disabled/); assert.deepEqual(saved.messages.at(-1).tools.filter(tool => tool.state === 'done').map(tool => tool.name), ['draft_tool', 'test_created_tool']); assert.equal(service.list().tools[0].status, 'draft');
  await bots.close(); chats.close();
});
