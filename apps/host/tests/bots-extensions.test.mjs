import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createBotSkills } from '../server/bots-skills.mjs';
import { createBotMcp } from '../server/bots-mcp.mjs';
import { createBotExtensionRoutes, privateExtensionStore } from '../server/bots-extension-store.mjs';
const id = 'bot_1234-abcd', other = 'bot_5678-abcd';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-extensions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, hasBot: key => [id, other].includes(key) };
}
function context(service, which, changes = {}) { const bot = { id, policy: 'manual', workspace: '/workspace', extensionSnapshots: {} }; bot.extensionSnapshots[which] = service.snapshot(bot); return { bot, chatId: 'chat-owned', turnId: 'turn-owned', signal: new AbortController().signal, assertLive() {}, requestPermission: async () => true, ...changes }; }
const unpack = result => JSON.parse(result.content[0].text);
function reviewAndEnable(service, id) { const skill = service.list().skills.find(s => s.id === id); return service.update(id, { status: 'enabled', expectedRevision: skill.revision, expectedDigest: skill.digest }); }
function updateAccess(service, id, input) { const connection = service.list().connections.find(c => c.id === id); return service.update(id, { ...input, expectedInventoryDigest: connection.inventoryDigest }); }

test('skill drafts require review and assignment, retain versions and do not mutate the shared library', async t => {
  const f = fixture(t), library = [{ id: 'review', name: 'Review', body: 'Inspect actual changes.', onlyIn: 'workspace_1234', enabled: false }], before = JSON.stringify(library);
  const service = createBotSkills({ ...f, library: () => library, workspacePath: key => key === 'workspace_1234' ? '/workspace' : null });
  const { skill } = service.create({ name: 'New instructions', body: 'Check the observed result.' });
  assert.throws(() => service.assign({ botId: id, skillIds: [skill.id] }), /Review and enable/);
  assert.deepEqual(service.snapshot({ id, workspace: '/workspace' }).assignments, []);
  reviewAndEnable(service, skill.id); service.assign({ botId: id, skillIds: [skill.id, 'library.review'] });
  const frozen = context(service, 'skills'); assert.equal(frozen.bot.extensionSnapshots.skills.assignments.length, 2);
  service.update(skill.id, { body: 'New revision needing review.' });
  assert.equal(service.list().skills.find(s => s.id === skill.id).status, 'draft');
  assert.equal(service.snapshot({ id, workspace: '/workspace' }).assignments.length, 1);
  assert.equal(unpack(await service.execute('read_skill', { id: skill.id }, frozen)).body, 'Check the observed result.');
  assert.equal(JSON.stringify(library), before);
  assert.equal(service.snapshot({ id, workspace: '/other' }).assignments.length, 0);
  assert.equal(service.list().skills.find(s => s.id === 'library.review').mainChatEnabled, false);
  assert.equal(statSync(join(f.directory, 'bots-skills.json')).mode & 0o777, 0o600);
  const restored = createBotSkills({ ...f, library: () => library }); assert.deepEqual(restored.list(), service.list());
});
test('skill provenance is derived from the live owner and Stop during permission prevents drafts', async t => {
  const service = createBotSkills(fixture(t)); let stopped = false;
  const c = context(service, 'skills', { assertLive() { if (stopped) throw new Error('Stopped'); }, requestPermission: async () => { stopped = true; return true; } });
  await assert.rejects(service.execute('draft_skill', { name: 'Denied', body: 'No write.' }, c), /Stopped/); assert.equal(service.list().skills.length, 0);
  stopped = false; c.requestPermission = async () => true;
  const result = unpack(await service.execute('draft_skill', { name: 'Useful', body: 'Review me.' }, c));
  assert.deepEqual(result.skill.provenance, { botId: id, chatId: 'chat-owned', turnId: 'turn-owned' });
  await assert.rejects(service.execute('read_skill', { id: result.skill.id }, context(service, 'skills')), /not assigned/);
  await assert.rejects(service.execute('draft_skill', { name: 'Escape', body: 'X', path: '../outside' }, c), /unsupported field/);
});
test('enabling a draft requires the exact reviewed revision and digest across devices', t => {
  const service = createBotSkills(fixture(t)), reviewed = service.create({ name: 'Procedure', body: 'Reviewed original.' }).skill;
  assert.throws(() => service.update(reviewed.id, { status: 'enabled' }), error => error.status === 409);
  service.update(reviewed.id, { body: 'Unseen replacement from another device.' });
  assert.throws(() => service.update(reviewed.id, { status: 'enabled', expectedRevision: reviewed.revision, expectedDigest: reviewed.digest }), error => error.status === 409);
  assert.equal(service.list().skills[0].status, 'draft'); assert.throws(() => service.assign({ botId: id, skillIds: [reviewed.id] }), /Review and enable/);
  const current = service.list().skills[0]; service.update(current.id, { status: 'enabled', expectedRevision: current.revision, expectedDigest: current.digest });
  assert.equal(service.list().skills[0].status, 'enabled');
  assert.throws(() => service.update(current.id, { body: 'Stale editor overwrite', expectedRevision: reviewed.revision, expectedDigest: reviewed.digest }), error => error.status === 409);
});
test('edited drafts can be revoked without enabling new instructions or dropping another retained draft', t => {
  const service = createBotSkills(fixture(t)), a = service.create({ name: 'First', body: 'Original first.' }).skill, b = service.create({ name: 'Second', body: 'Original second.' }).skill;
  reviewAndEnable(service, a.id); reviewAndEnable(service, b.id); service.assign({ botId: id, skillIds: [a.id, b.id] });
  service.update(a.id, { body: 'Unreviewed first.' }); service.update(b.id, { body: 'Unreviewed second.' });
  service.assign({ botId: id, skillIds: [b.id] }); assert.deepEqual(service.list(id).assignments[0].skillIds, [b.id]);
  assert.equal(service.list().skills.find(s => s.id === b.id).status, 'draft'); assert.deepEqual(service.snapshot({ id, workspace: '/workspace' }).assignments, []);
  assert.throws(() => service.assign({ botId: id, skillIds: [a.id, b.id] }), /Review and enable/);
  const c = service.create({ name: 'Third', body: 'Reviewed third.' }).skill; reviewAndEnable(service, c.id); service.assign({ botId: id, skillIds: [b.id, c.id] });
  assert.deepEqual(service.list(id).assignments[0].skillIds, [b.id, c.id]);
});
test('larger approved skill revisions cannot overflow a new chat or prevent access reduction', t => {
  const service = createBotSkills(fixture(t)), ids = [];
  for (let i = 0; i < 3; i++) { const s = service.create({ name: `Procedure ${i}`, body: 'x'.repeat(42000) }).skill; reviewAndEnable(service, s.id); ids.push(s.id); }
  service.assign({ botId: id, skillIds: ids });
  for (const sid of ids) { service.update(sid, { body: 'y'.repeat(64000) }); reviewAndEnable(service, sid); }
  assert.throws(() => service.snapshot({ id, workspace: '/workspace' }), error => error.status === 409);
  service.assign({ botId: id, skillIds: ids.slice(1) }); assert.equal(service.snapshot({ id, workspace: '/workspace' }).assignments.length, 2);
});
test('private extension stores reject malformed versions and both live and dangling symlinks', t => {
  const f = fixture(t), sentinel = join(f.directory, 'sentinel'); writeFileSync(sentinel, 'unchanged');
  symlinkSync(sentinel, join(f.directory, 'bots-skills.json')); assert.throws(() => createBotSkills(f), /regular file/); assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
  symlinkSync(join(f.directory, 'absent'), join(f.directory, 'bots-mcp.json')); assert.throws(() => createBotMcp(f), /regular file/);
  writeFileSync(join(f.directory, 'bad.json'), '{"version":2}'); assert.throws(() => privateExtensionStore(f.directory, 'bad.json', { version: 1 }), /version/);
});
test('MCP checks inventory only; explicit assignment and frozen authority constrain calls and credentials', async t => {
  const f = fixture(t), calls = [], permissions = []; let closed = 0;
  const clientFactory = async c => { assert.equal(c.apiKey, 'private-test-key'); return { listTools: async () => ({ tools: [{ name: 'lookup', description: 'Untrusted description', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }), callTool: async input => { calls.push(input); return { content: [{ type: 'text', text: 'Verified fixture' }] }; }, close: async () => { closed++; } }; };
  const service = createBotMcp({ ...f, clientFactory });
  const { connection } = service.create({ name: 'Fixture', transport: 'http', url: 'https://example.invalid/mcp', apiKey: 'private-test-key', botIds: [id] });
  assert.equal(JSON.stringify(service.list()).includes('private-test-key'), false);
  const checked = (await service.check(connection.id)).connection; assert.equal(calls.length, 0); assert.equal(closed, 1); assert.equal(checked.tools[0].readOnly, false); assert.deepEqual(checked.enabledToolIds, []);
  updateAccess(service, connection.id, { apiKey: '', enabledToolIds: [checked.tools[0].id] });
  const c = context(service, 'mcp', { requestPermission: async request => { permissions.push(request); return true; } });
  assert.equal(unpack(await service.execute('search_tools', {}, c)).tools.length, 1);
  await service.execute('call_tool', { toolId: checked.tools[0].id, arguments: { query: 'test' } }, c);
  assert.equal(calls.length, 1); assert.equal(permissions.length, 1); assert.equal(closed, 2);
  updateAccess(service, connection.id, { enabledToolIds: [] });
  await assert.rejects(service.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, c), /not assigned/); assert.equal(calls.length, 1);
  assert.equal(statSync(join(f.directory, 'bots-mcp.json')).mode & 0o777, 0o600);
});
test('MCP authority added later is not inherited; changed inventories revoke enabled and read-only selections', async t => {
  const f = fixture(t); let description = 'Original';
  const service = createBotMcp({ ...f, clientFactory: async () => ({ listTools: async () => ({ tools: [{ name: 'tool', description, inputSchema: { type: 'object' } }] }), close: async () => {} }) });
  const { connection } = service.create({ name: 'Fixture', transport: 'http', url: 'https://example.invalid/mcp', botIds: [id] }); await service.check(connection.id);
  const c = context(service, 'mcp'), tool = service.list().connections[0].tools[0]; updateAccess(service, connection.id, { enabledToolIds: [tool.id], readOnlyToolIds: [tool.id] });
  assert.deepEqual(unpack(await service.execute('search_tools', {}, c)).tools, []);
  const enabled = context(service, 'mcp'); assert.equal(unpack(await service.execute('search_tools', {}, enabled)).tools.length, 1);
  description = 'Changed action'; await service.check(connection.id);
  assert.deepEqual(service.list().connections[0].enabledToolIds, []); assert.deepEqual(service.list().connections[0].readOnlyToolIds, []);
  assert.deepEqual(unpack(await service.execute('search_tools', {}, enabled)).tools, []);
});
test('stale MCP access editors cannot regrant changed tools or undo a newer revocation', async t => {
  let description = 'Reviewed read';
  const service = createBotMcp({ ...fixture(t), clientFactory: async () => ({ listTools: async () => ({ tools: [{ name: 'same_name', description, inputSchema: { type: 'object' } }] }), close: async () => {} }) });
  const { connection } = service.create({ name: 'Review fixture', transport: 'http', url: 'https://example.invalid/mcp', botIds: [id] }); await service.check(connection.id);
  const reviewed = service.list().connections[0], tool = reviewed.tools[0];
  assert.throws(() => service.update(connection.id, { enabledToolIds: [tool.id] }), error => error.status === 409);
  description = 'Unseen changed effect'; await service.check(connection.id);
  assert.throws(() => service.update(connection.id, { enabledToolIds: [tool.id], expectedInventoryDigest: reviewed.inventoryDigest }), error => error.status === 409);
  assert.deepEqual(service.list().connections[0].enabledToolIds, []);
  updateAccess(service, connection.id, { enabledToolIds: [tool.id] }); const oldEditor = service.list().connections[0];
  updateAccess(service, connection.id, { enabledToolIds: [] });
  assert.throws(() => service.update(connection.id, { enabledToolIds: [tool.id], expectedInventoryDigest: oldEditor.inventoryDigest }), error => error.status === 409);
  assert.deepEqual(service.list().connections[0].enabledToolIds, []);
  const current = service.list().connections[0]; await service.check(connection.id); assert.equal(service.list().connections[0].inventoryDigest, current.inventoryDigest, 'Unchanged checks retain the reviewed proof.');
});
test('MCP Stop and revocation while awaiting approval prevents invocation; failures never expose SDK secrets', async t => {
  const f = fixture(t); let calls = 0, stopped = false;
  const service = createBotMcp({ ...f, clientFactory: async () => ({ listTools: async () => ({ tools: [{ name: 'change', inputSchema: { type: 'object' } }] }), callTool: async () => { calls++; throw new Error('Bearer SECRET_TEST_KEY api-secret'); }, close: async () => {} }) });
  const { connection } = service.create({ name: 'Fixture', transport: 'http', url: 'https://example.invalid/mcp', botIds: [id] }); await service.check(connection.id);
  const tool = service.list().connections[0].tools[0]; updateAccess(service, connection.id, { enabledToolIds: [tool.id] });
  const c = context(service, 'mcp', { assertLive() { if (stopped) throw new Error('Stopped'); }, requestPermission: async () => { stopped = true; return true; } });
  await assert.rejects(service.execute('call_tool', { toolId: tool.id, arguments: {} }, c), /Stopped/); assert.equal(calls, 0);
  stopped = false; c.requestPermission = async () => { updateAccess(service, connection.id, { botIds: [] }); return true; };
  await assert.rejects(service.execute('call_tool', { toolId: tool.id, arguments: {} }, c), /removed/); assert.equal(calls, 0);
  updateAccess(service, connection.id, { botIds: [id] }); c.requestPermission = async () => true;
  await assert.rejects(service.execute('call_tool', { toolId: tool.id, arguments: {} }, c), e => !e.message.includes('SECRET_TEST_KEY') && /unavailable/.test(e.message)); assert.equal(calls, 1);
});
test('Plan calls only tools explicitly classified read-only by the owner, never MCP annotations', async t => {
  let calls = 0, permissionCalls = 0;
  const service = createBotMcp({ ...fixture(t), clientFactory: async () => ({ listTools: async () => ({ tools: [{ name: 'fixture', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }), callTool: async () => { calls++; return { content: [{ type: 'text', text: 'read' }] }; }, close: async () => {} }) });
  const { connection } = service.create({ name: 'Plan fixture', transport: 'http', url: 'https://example.invalid/mcp', botIds: [id] }); await service.check(connection.id); const tool = service.list().connections[0].tools[0];
  updateAccess(service, connection.id, { enabledToolIds: [tool.id] }); const c = context(service, 'mcp', { requestPermission: async () => { permissionCalls++; return false; } }); c.bot.policy = 'plan';
  await assert.rejects(service.execute('call_tool', { toolId: tool.id, arguments: {} }, c), /not assigned/); assert.equal(calls, 0);
  updateAccess(service, connection.id, { readOnlyToolIds: [tool.id] }); const approved = context(service, 'mcp', { requestPermission: c.requestPermission }); approved.bot.policy = 'plan';
  await service.execute('call_tool', { toolId: tool.id, arguments: {} }, approved); assert.equal(calls, 1); assert.equal(permissionCalls, 0);
  updateAccess(service, connection.id, { readOnlyToolIds: [] }); await assert.rejects(service.execute('call_tool', { toolId: tool.id, arguments: {} }, approved), /not assigned/); assert.equal(calls, 1);
});
test('MCP cleanup uncertainty remains visible and blocks further operations', async t => {
  const f = fixture(t), service = createBotMcp({ ...f, clientFactory: async () => ({ listTools: async () => ({ tools: [] }), close: async () => { throw new Error('descendant still running'); } }) });
  const { connection } = service.create({ name: 'Fixture', transport: 'stdio', command: '/not-started-fixture' });
  await assert.rejects(service.check(connection.id), /cleanup is unconfirmed/); assert.equal(service.list().connections[0].status, 'unavailable');
  await assert.rejects(service.check(connection.id), /cleanup is unconfirmed/);
  const restored = createBotMcp(f); assert.equal(restored.list().connections[0].status, 'unavailable'); await assert.rejects(restored.check(connection.id), /cleanup is unconfirmed/);
});
test('MCP rejects credentials in URLs, unknown hosts and invalid selections without starting a program', t => {
  const service = createBotMcp(fixture(t));
  for (const url of ['http://example.com/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/?key=secret']) assert.throws(() => service.create({ name: 'Bad', transport: 'http', url }));
  assert.throws(() => service.create({ name: 'Bad', transport: 'stdio', command: 'program', botIds: ['missing'] }), /still exist/);
  assert.throws(() => service.create({ name: 'Bad', transport: 'stdio', command: 'program', enabledToolIds: ['invented'] }), /current inventory/);
});
test('extension routes enforce exact local origin and size/field limits', async t => {
  const f = fixture(t), skills = createBotSkills(f), mcp = createBotMcp(f); let port;
  const route = createBotExtensionRoutes({ skills, mcp, port: () => port });
  const server = http.createServer((req, res) => route(req, res, new URL(req.url, `http://${req.headers.host}`))); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port; t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${port}/api/bots/skills`;
  assert.equal((await fetch(url, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(url)).status, 200);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X', body: 'Y', path: '../outside' }) }); assert.equal(response.status, 400);
  assert.equal((await fetch(url, { method: 'POST', body: 'bad JSON' })).status, 400);
});

test('real MCP SDK stdio handshake, inventory and approved call use a credential-free owned program', async t => {
  const f = fixture(t), service = createBotMcp(f), script = fileURLToPath(new URL('./fixtures/bots-external-mcp.mjs', import.meta.url));
  const prior = process.env.STRATA_MCP_PARENT_SECRET; process.env.STRATA_MCP_PARENT_SECRET = 'must-never-inherit';
  t.after(() => { if (prior === undefined) delete process.env.STRATA_MCP_PARENT_SECRET; else process.env.STRATA_MCP_PARENT_SECRET = prior; });
  const { connection } = service.create({ name: 'Actual protocol fixture', transport: 'stdio', command: process.execPath, args: [script], env: { STRATA_MCP_FIXTURE: 'explicit' }, botIds: [id] });
  const checked = (await service.check(connection.id)).connection;
  assert.equal(checked.status, 'connected'); assert.equal(checked.tools.length, 1); assert.deepEqual(checked.enabledToolIds, []);
  updateAccess(service, connection.id, { enabledToolIds: [checked.tools[0].id] });
  const result = await service.execute('call_tool', { toolId: checked.tools[0].id, arguments: { marker: 'STRATA_MCP_FIXTURE_OK' } }, context(service, 'mcp'));
  assert.deepEqual(unpack(result), { marker: 'STRATA_MCP_FIXTURE_OK', explicitEnvironment: true, leakedParentSecret: false });
  await service.close();
});
test('real MCP Check cleans up a TERM-resistant descendant after its server leader exits', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), service = createBotMcp(f), pidFile = join(f.directory, 'descendant.pid'), script = fileURLToPath(new URL('./fixtures/bots-external-mcp.mjs', import.meta.url));
  const { connection } = service.create({ name: 'Owned descendant fixture', transport: 'stdio', command: process.execPath, args: [script, pidFile] });
  assert.equal((await service.check(connection.id)).connection.status, 'connected');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  let state = ''; try { state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  assert.ok(!state || state.startsWith('Z'), 'Owned descendant must be gone or reaped to a zombie, never live.');
});

async function httpFixture(t, behavior = {}) {
  const seen = [], server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const message = JSON.parse(Buffer.concat(chunks));
    seen.push({ method: message.method, authorization: req.headers.authorization });
    if (behavior.redirect) { res.writeHead(307, { location: behavior.redirect }); res.end(); return; }
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture-http', version: '1' } } : message.method === 'tools/list' ? { tools: [{ name: 'http_echo', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'HTTP_FIXTURE_OK' }] };
    if (message.method === 'tools/call' && behavior.onCall) await behavior.onCall();
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  return { seen, url: `http://127.0.0.1:${server.address().port}/mcp` };
}
test('real MCP Streamable HTTP supports discovery and approved calls without forwarding a bearer across redirects', async t => {
  const local = await httpFixture(t), service = createBotMcp(fixture(t));
  const { connection } = service.create({ name: 'Local HTTP fixture', transport: 'http', url: local.url, apiKey: 'synthetic-http-bearer', botIds: [id] });
  const checked = (await service.check(connection.id)).connection; updateAccess(service, connection.id, { enabledToolIds: [checked.tools[0].id] });
  const result = await service.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, context(service, 'mcp')); assert.equal(result.content[0].text, 'HTTP_FIXTURE_OK');
  assert.ok(local.seen.some(request => request.method === 'tools/call')); assert.ok(local.seen.every(request => request.authorization === 'Bearer synthetic-http-bearer'));
  const redirected = await httpFixture(t, { redirect: local.url }), redirect = service.create({ name: 'Redirect fixture', transport: 'http', url: redirected.url, apiKey: 'must-not-forward' }).connection;
  const previous = local.seen.length; await assert.rejects(service.check(redirect.id), /unavailable/); assert.equal(local.seen.length, previous);
});
test('real MCP HTTP cancellation rejects the result and never retries a submitted tool mutation', async t => {
  let submitted; const began = new Promise(resolve => { submitted = resolve; });
  const local = await httpFixture(t, { onCall: async () => { submitted(); await new Promise(resolve => setTimeout(resolve, 250)); } }), service = createBotMcp(fixture(t));
  const { connection } = service.create({ name: 'Cancellation fixture', transport: 'http', url: local.url, botIds: [id] });
  const checked = (await service.check(connection.id)).connection; updateAccess(service, connection.id, { enabledToolIds: [checked.tools[0].id] });
  const controller = new AbortController(), c = context(service, 'mcp', { signal: controller.signal, assertLive() { controller.signal.throwIfAborted(); } });
  const operation = service.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, c); await began; controller.abort();
  await assert.rejects(operation, /stopped|abort/i); assert.equal(local.seen.filter(r => r.method === 'tools/call').length, 1);
  await service.close();
});
