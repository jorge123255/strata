import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, HostClient } from '../bridge.mjs';
import { botWorkspaceRequest, publicBotWorkspace } from '../bots-workspace.mjs';

const schema = { type: 'object', properties: { query: { type: 'string', maxLength: 500 } }, required: ['query'], additionalProperties: false };
const tool = { id: 'tool_11111111-1111-4111-8111-111111111111', name: 'Inspect build', description: 'Read the selected project.', command: 'python3 inspect.py', inputSchema: schema, timeoutSeconds: 30, status: 'draft', revision: 1, digest: 'a'.repeat(64), botIds: [], teamIds: [], createdAt: '2026-10-22T03:00:00Z', updatedAt: '2026-10-22T03:00:00Z', provenance: { botId: 'bot_builder', chatId: 'PRIVATE-CHAT', turnId: 'PRIVATE-TURN' }, apiKey: 'PRIVATE-KEY' };
const create = { name: tool.name, description: tool.description, command: tool.command, inputSchema: schema, timeoutSeconds: 30 };
function request(bridge, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(body)) } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text), text }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t, handler) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-created-tools-')), calls = [];
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options) {
    calls.push({ path, ...options });
    if (handler) { const v = await handler(path, options); if (v !== undefined) return v; }
    if (path === '/api/bots/tools') return options?.method === 'POST' ? { tool } : { createdToolsSupported: true, tools: [tool] };
    if (path === '/api/bots/tools/' + tool.id) return options?.method === 'DELETE' ? { removed: true } : { tool: { ...tool, ...options?.body, revision: 2 } };
    if (path === '/api/bots') return { bots: [{ id: 'bot_builder' }] };
    if (path === '/api/bots/teams') return { teams: [{ id: 'team_project' }] };
    throw Object.assign(new Error('PRIVATE-UPSTREAM'), { status: 404 });
  } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, calls, ...bridge.authority.pair(bridge.authority.code, 'Tools fixture') };
}

test('tool configuration allows reviewed drafts and exact revisions, but no execution endpoint or authority field', async () => {
  const calls = [], host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { calls.push({ url, ...options }); return new Response('{}'); } });
  await host.request('/api/bots/tools');
  await host.request('/api/bots/tools', { method: 'POST', body: create });
  await host.request('/api/bots/tools/' + tool.id, { method: 'PATCH', body: { status: 'enabled', botIds: ['bot_builder'], teamIds: ['team_project'], expectedRevision: 1, expectedDigest: tool.digest } });
  for (const [path, method, body] of [
    ['/api/bots/tools/' + tool.id + '/run', 'POST', {}], ['/api/bots/tools/' + tool.id + '/test', 'POST', {}],
    ['/api/bots/tools', 'POST', { ...create, policy: 'bypass' }], ['/api/bots/tools', 'POST', { ...create, execution: { kind: 'local' } }],
    ['/api/bots/tools', 'POST', { ...create, status: 'enabled' }], ['/api/bots/tools/' + tool.id, 'PATCH', { status: 'enabled' }],
    ['/api/bots/tools?botId=bot_builder', 'GET'], ['/api/bots/tools/' + tool.id, 'GET'],
  ]) await assert.rejects(host.request(path, { method, ...(body !== undefined ? { body } : {}) }), { status: 403 });
  assert.equal(calls.length, 3);
});

test('phone projection preserves exact reviewable command/schema but excludes private provenance and unknown fields', () => {
  const body = publicBotWorkspace({ tools: [tool], createdToolsSupported: true }, { kind: 'createdTools' });
  assert.equal(body.createdToolsSupported, true); assert.equal(body.tools[0].command, tool.command); assert.deepEqual(body.tools[0].inputSchema, schema);
  for (const word of ['PRIVATE-CHAT', 'PRIVATE-TURN', 'PRIVATE-KEY']) assert.ok(!JSON.stringify(body).includes(word));
  assert.throws(() => publicBotWorkspace({ tool: { ...tool, id: 'tool_deadbeef' } }, { kind: 'createdTool', toolId: tool.id }), { status: 502 });
  assert.throws(() => publicBotWorkspace({ team: { id: 'team_wrong' } }, { kind: 'createdTool', toolId: tool.id }), { status: 502 });
});

test('paired phone can create, review, enable/share and delete without starting any work', async t => {
  const { bridge, token, calls } = await fixture(t);
  assert.equal((await request(bridge, '/v1/bots/tools')).status, 401);
  assert.equal((await request(bridge, '/v1/bots/tools', { token })).json.tools[0].id, tool.id);
  assert.equal((await request(bridge, '/v1/bots/tools', { token, method: 'POST', body: create })).json.tool.status, 'draft');
  const body = { status: 'enabled', botIds: ['bot_builder'], teamIds: ['team_project'], expectedRevision: 1, expectedDigest: tool.digest };
  const saved = await request(bridge, '/v1/bots/tools/' + tool.id, { token, method: 'PATCH', body });
  assert.equal(saved.status, 200); assert.equal(saved.json.tool.status, 'enabled');
  assert.equal((await request(bridge, '/v1/bots/tools/' + tool.id, { token, method: 'DELETE', body: { expectedRevision: 1, expectedDigest: tool.digest } })).json.deleted, true);
  assert.ok(!calls.some(c => /messages|native|serving|\/run|\/test/.test(c.path)));
});

test('stale revision or missing current bot/team blocks saving before any mutation', async t => {
  const { bridge, token, calls } = await fixture(t);
  for (const extra of [{ expectedRevision: 2 }, { expectedDigest: 'b'.repeat(64) }, { botIds: ['missing'] }, { teamIds: ['missing'] }]) {
    const r = await request(bridge, '/v1/bots/tools/' + tool.id, { token, method: 'PATCH', body: { status: 'enabled', expectedRevision: 1, expectedDigest: tool.digest, ...extra } });
    assert.equal(r.status, 409);
  }
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 0);
});

test('revoked phone cannot finish a held tool mutation', async t => {
  let enter, finish; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { finish = r; });
  const { bridge, token, session, calls } = await fixture(t, async (path, options) => { if (path === '/api/bots/tools' && !options) { enter(); await held; return { tools: [tool], createdToolsSupported: true }; } });
  const pending = request(bridge, '/v1/bots/tools/' + tool.id, { token, method: 'DELETE', body: { expectedRevision: 1, expectedDigest: tool.digest } });
  await entered; bridge.authority.revoke(session.id); finish();
  assert.equal((await pending).status, 401); assert.ok(!calls.some(c => c.method === 'DELETE'));
});

test('old Mac reports upgrade and schemas reject nesting, references, extra inputs and inconsistent bounds', async t => {
  const { bridge, token } = await fixture(t, () => { throw Object.assign(new Error('PRIVATE-UPSTREAM'), { status: 404 }); });
  const r = await request(bridge, '/v1/bots/tools', { token });
  assert.equal(r.status, 200); assert.equal(r.json.createdToolsSupported, false); assert.deepEqual(r.json.tools, []); assert.match(r.json.reason, /Update Strata/);
  for (const inputSchema of [{ ...schema, $ref: '/private' }, { ...schema, properties: { x: { type: 'object', properties: {} } } }, { ...schema, required: ['missing'] }, { ...schema, properties: { x: { type: 'number', minimum: 2, maximum: 1 } } }]) assert.throws(() => botWorkspaceRequest('/api/bots/tools', 'POST', { ...create, inputSchema }), { status: 403 });
});
