import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, HostClient } from '../bridge.mjs';
import { botWorkspaceRequest, publicBotWorkspace } from '../bots-workspace.mjs';

const limits = { maxParallel: 2, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 };
const team = { id: 'team_fixture', name: 'Review team', memberIds: ['bot_coder', 'bot_reviewer'], coordinatorId: 'bot_coder', enabled: false, limits };
const run = { id: 'run_fixture', teamId: team.id, rootChatId: 's_shared', rootBotId: 'bot_coder', state: 'running', limits, consumedTurns: 1 };
const skill = { id: 'skill_fixture', name: 'Review', description: 'Review changes', body: 'Check the diff.', triggers: ['review'], source: 'draft', status: 'enabled', revision: 2, digest: 'abc', botIds: [] };
const connection = { id: 'mcpc_fixture', name: 'Saved tools', transport: 'stdio', inventoryDigest: 'a'.repeat(64), command: '/PRIVATE/PROGRAM', args: ['PRIVATE-ARGS'], env: { TOKEN: 'SECRET-ENV' }, envKeys: ['TOKEN'], apiKey: 'SECRET-KEY', apiKeySet: true, url: 'https://SECRET-URL', status: 'starting', checkedAt: '2026-10-20T22:00:00.000Z', detail: 'Checking connection…', botIds: ['bot_coder'], enabledToolIds: ['tool_read'], readOnlyToolIds: ['tool_read'], tools: [{ id: 'tool_read', name: 'Read', description: 'Read files', readOnly: true, inputSchema: { default: 'SECRET-DEFAULT' } }, { id: 'tool_write', name: 'Write', description: 'Write files', readOnly: false }] };
function request(bridge, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text), text }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t, handler) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-workspace-')); const calls = [];
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options) {
    calls.push({ path, ...options });
    if (handler) { const value = await handler(path, options); if (value !== undefined) return value; }
    if (path === '/api/bots') return { bots: [{ id: 'bot_coder' }, { id: 'bot_reviewer' }] };
    if (path === '/api/bots/teams') return options?.method === 'POST' ? { team } : { teams: [team], runs: [run] };
    if (path.endsWith('/runs')) return { run, conversation: { secret: 'PRIVATE-PROFILE' } };
    if (path.endsWith('/stop')) return { run: { ...run, state: 'cancelled' } };
    if (path.startsWith('/api/bots/skills')) return options?.method === 'POST' && path.endsWith('/skills') ? { skill: { ...skill, status: 'draft' } } : { skills: [skill, { ...skill, id: 'library.review', source: 'library', revision: 'library-hash' }], assignments: [] };
    if (path === '/api/bots/connections') return { connections: [connection] };
    if (path.startsWith('/api/bots/connections/')) return { connection };
    throw Object.assign(new Error('PRIVATE-UPSTREAM-ERROR'), { status: 404 });
  } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, calls, ...bridge.authority.pair(bridge.authority.code, 'Workspace fixture') };
}

test('workspace host admission rejects arbitrary methods, programs, OAuth client secrets, policy and queries', async () => {
  const calls = []; const host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { calls.push({ url, ...options }); return new Response('{}'); } });
  await host.request('/api/bots/teams'); await host.request('/api/bots/skills?botId=bot_coder'); await host.request('/api/bots/provider-models?provider=codex');
  await host.request('/api/bots/provider-models?provider=devin');
  await host.request('/api/bots/teams', { method: 'POST', body: { name: team.name, memberIds: team.memberIds, coordinatorId: team.coordinatorId, enabled: false, limits } });
  for (const [path, method, body] of [
    ['/api/bots/connections', 'POST', { command: '/bin/sh' }], ['/api/bots/connections/mcpc_fixture', 'PATCH', { oauthClientSecret: 'SECRET' }],
    ['/api/bots/connections/mcpc_fixture', 'PATCH', { command: '/bin/sh' }], ['/api/bots/teams', 'POST', { ...team, provider: 'codex' }],
    ['/api/bots/teams/team_fixture/runs', 'POST', { message: 'Task', policy: 'bypass' }], ['/api/bots/skills', 'POST', { name: 'X', description: '', body: 'Y', status: 'enabled' }],
    ['/api/bots/activity?include=secrets', 'GET'], ['/api/bots/skills?botId=bot_coder&botId=bot_reviewer', 'GET'], ['/api/bots/provider-models?provider=evil', 'GET'],
    ['/api/bots/connections/mcpc_fixture/call', 'POST', {}], ['/api/bots/teams/../skills', 'GET'],
  ]) await assert.rejects(host.request(path, { method, body }), { status: 403 });
  assert.equal(calls.length, 5);
});

test('strict public projections retain library revisions and checking status without programs or secrets', () => {
  const clean = publicBotWorkspace({ connections: [connection] }, { kind: 'connections' }), encoded = JSON.stringify(clean);
  assert.equal(clean.connections[0].status, 'starting'); assert.equal(clean.connections[0].checkedAt, connection.checkedAt);
  for (const secret of ['PRIVATE/PROGRAM', 'PRIVATE-ARGS', 'SECRET-ENV', 'SECRET-KEY', 'SECRET-URL', 'SECRET-DEFAULT', 'envKeys', 'inputSchema']) assert.ok(!encoded.includes(secret), secret);
  const skills = publicBotWorkspace({ skills: [{ ...skill, id: 'library.review', revision: 'digest' }], assignments: [{ botId: 'bot_coder', skillIds: ['library.review'] }] }, { kind: 'skills' });
  assert.equal(skills.skills[0].revision, 'digest'); assert.deepEqual(skills.assignments[0].skillIds, ['library.review']);
  const dates = publicBotWorkspace({ teams: [{ ...team, createdAt: { secret: 'PRIVATE-TIME' } }], runs: [] }, { kind: 'teams' });
  assert.ok(!JSON.stringify(dates).includes('PRIVATE-TIME'));
});

test('paired team catalog and creation never start work; only explicit task request starts a run', async t => {
  const { bridge, token, calls } = await fixture(t);
  assert.equal((await request(bridge, '/v1/bots/teams')).status, 401);
  assert.equal((await request(bridge, '/v1/bots/teams', { token })).json.teams[0].id, team.id);
  const created = await request(bridge, '/v1/bots/teams', { token, method: 'POST', body: { name: team.name, memberIds: team.memberIds, coordinatorId: team.coordinatorId, limits } });
  assert.equal(created.status, 200); assert.equal(created.json.team.enabled, false);
  assert.ok(!calls.some(c => /runs|messages|serving|native/.test(c.path)));
  const started = await request(bridge, '/v1/bots/teams/team_fixture/runs', { token, method: 'POST', body: { message: 'Review this fixture', requestId: 'request_123' } });
  assert.equal(started.status, 200); assert.equal(started.json.run.rootChatId, 's_shared'); assert.equal(started.json.conversation, undefined);
  assert.ok(!started.text.includes('PRIVATE-PROFILE'));
  const stopped = await request(bridge, '/v1/bots/teams/team_fixture/runs/run_fixture/stop', { token, method: 'POST', body: {} });
  assert.equal(stopped.json.run.state, 'cancelled');
  assert.deepEqual(calls.at(-1).body, {});
});

test('skill drafts and exact fresh assignments keep library IDs; no auto-enabling or prompt', async t => {
  const { bridge, token, calls } = await fixture(t);
  const created = await request(bridge, '/v1/bots/skills', { token, method: 'POST', body: { name: 'New draft', description: '', body: 'Review me', triggers: [] } });
  assert.equal(created.json.skill.status, 'draft');
  const assigned = await request(bridge, '/v1/bots/skills/assign', { token, method: 'POST', body: { botId: 'bot_coder', skillIds: ['library.review', 'skill_fixture'] } });
  assert.equal(assigned.status, 200); assert.equal(assigned.json.saved, true);
  assert.ok(calls.some(c => c.path === '/api/bots/skills' && !c.method));
  assert.equal((await request(bridge, '/v1/bots/skills/assign', { token, method: 'POST', body: { botId: 'bot_coder', skillIds: ['missing'] } })).status, 409);
  assert.ok(!calls.some(c => /messages|serving|native|chat\//.test(c.path)));
});

test('phone MCP access can retain existing read-only policy but cannot classify new tools or set credentials', async t => {
  const { bridge, token, calls } = await fixture(t);
  const saved = await request(bridge, '/v1/bots/connections/mcpc_fixture', { token, method: 'PATCH', body: { botIds: ['bot_reviewer'], enabledToolIds: ['tool_read', 'tool_write'], readOnlyToolIds: ['tool_read'], expectedInventoryDigest: connection.inventoryDigest } });
  assert.equal(saved.status, 200);
  const count = calls.filter(c => c.method === 'PATCH').length;
  for (const body of [{ apiKey: 'SECRET' }, { command: '/bin/sh' }, { botIds: ['missing'] }, { enabledToolIds: ['missing'] }, { enabledToolIds: ['tool_write'], readOnlyToolIds: ['tool_write'] }]) {
    const result = await request(bridge, '/v1/bots/connections/mcpc_fixture', { token, method: 'PATCH', body });
    assert.ok([400, 409].includes(result.status));
  }
  assert.equal(calls.filter(c => c.method === 'PATCH').length, count);
  assert.equal((await request(bridge, '/v1/bots/connections/mcpc_fixture/check', { token, method: 'POST', body: {} })).status, 200);
  assert.equal(calls.at(-1).path, '/api/bots/connections/mcpc_fixture/check');
});

test('revoking the device during fresh connection lookup prevents mutation and output', async t => {
  let enter, finish; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { finish = r; });
  const { bridge, token, session, calls } = await fixture(t, async path => { if (path === '/api/bots/connections') { enter(); await held; return { connections: [connection] }; } });
  const pending = request(bridge, '/v1/bots/connections/mcpc_fixture', { token, method: 'PATCH', body: { enabledToolIds: ['tool_read'], expectedInventoryDigest: connection.inventoryDigest } });
  await entered; bridge.authority.revoke(session.id); finish();
  const response = await pending; assert.equal(response.status, 401); assert.ok(!response.text.includes('Saved tools'));
  assert.ok(!calls.some(c => c.method === 'PATCH'));
});

test('old hosts return explicit upgrade reasons for all four read-only destinations; errors export no raw diagnostics', async t => {
  const { bridge, token } = await fixture(t, () => { throw Object.assign(new Error('PRIVATE-UPSTREAM-ERROR'), { status: 404 }); });
  for (const path of ['/v1/bots/teams', '/v1/bots/activity', '/v1/bots/skills', '/v1/bots/connections', '/v1/bots/provider-models?provider=codex']) {
    const result = await request(bridge, path, { token }); assert.equal(result.status, 200); assert.match(result.json.reason, /Update Strata/); assert.ok(!result.text.includes('PRIVATE-UPSTREAM-ERROR'));
  }
  const failed = await request(bridge, '/v1/bots/teams/team_fixture/runs', { token, method: 'POST', body: { message: 'Task' } });
  assert.equal(failed.status, 404); assert.ok(!failed.text.includes('PRIVATE-UPSTREAM-ERROR'));
});

test('team limits and skill size boundaries match host validation', () => {
  const valid = { name: 'Team', memberIds: team.memberIds, coordinatorId: team.coordinatorId, limits };
  for (const body of [{ ...valid, memberIds: ['bot_coder'] }, { ...valid, name: 'x'.repeat(81) }, { ...valid, limits: { maxParallel: 9 } }, { ...valid, limits: { maxDepth: 0 } }]) assert.throws(() => botWorkspaceRequest('/api/bots/teams', 'POST', body), { status: 403 });
  assert.throws(() => botWorkspaceRequest('/api/bots/skills', 'POST', { name: 'x'.repeat(121), description: '', body: 'x' }), { status: 403 });
  assert.throws(() => botWorkspaceRequest('/api/bots/skills', 'POST', { name: 'x', description: '', body: 'x', triggers: ['x'.repeat(161)] }), { status: 403 });
});

test('effort uses fresh exact native model capabilities; explicit default clears instead of guessing', async t => {
  const native = { bots: [{ id: 'bot_coder', name: 'Coder', provider: 'codex', model: 'known-model', capabilities: 'code', policy: 'manual', execution: { kind: 'local' } }], providers: [], computers: [], models: [] };
  const { bridge, token, calls } = await fixture(t, path => {
    if (path === '/api/bots') return native;
    if (path === '/api/bots/provider-models?provider=codex') return { provider: 'codex', models: [{ id: 'known-model', name: 'Known model', efforts: ['low', 'high'] }] };
    if (path.endsWith('/conversations')) return { conversation: { id: 's_shared', title: 'Shared', active: false, messages: [], preferences: { botId: 'bot_coder', botEffort: 'high', teamId: 'team_fixture', teamRunId: 'run_fixture', parentChatId: 's_parent' } }, pending: [] };
  });
  const selected = await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body: { effort: 'high' } });
  assert.equal(selected.status, 201); assert.equal(selected.json.conversation.botEffort, 'high'); assert.equal(selected.json.conversation.teamRunId, 'run_fixture');
  const count = calls.filter(c => c.path.endsWith('/conversations')).length;
  assert.equal((await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body: { effort: 'invented' } })).status, 409);
  assert.equal(calls.filter(c => c.path.endsWith('/conversations')).length, count);
  const cleared = await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body: { effort: '' } });
  assert.equal(cleared.status, 201); assert.equal(calls.at(-1).body.effort, '');
});

test('skill enable and edits require the displayed review proof and reject newer unseen content', async t => {
  const { bridge, token, calls } = await fixture(t);
  for (const body of [{ status: 'enabled' }, { status: 'enabled', expectedRevision: 1, expectedDigest: skill.digest }, { body: 'My edit', expectedRevision: 2, expectedDigest: 'old-digest' }]) {
    const result = await request(bridge, '/v1/bots/skills/skill_fixture', { token, method: 'PATCH', body });
    assert.ok([400, 409].includes(result.status));
  }
  assert.ok(!calls.some(call => call.method === 'PATCH'), 'Unseen skill revisions must not be enabled or overwritten.');
});

test('changed MCP inventory cannot receive stale tool grants', async t => {
  const { bridge, token, calls } = await fixture(t);
  for (const expectedInventoryDigest of [undefined, 'b'.repeat(64)]) {
    const result = await request(bridge, '/v1/bots/connections/mcpc_fixture', { token, method: 'PATCH', body: { enabledToolIds: ['tool_write'], ...(expectedInventoryDigest ? { expectedInventoryDigest } : {}) } });
    assert.ok([400, 409].includes(result.status));
  }
  assert.ok(!calls.some(call => call.method === 'PATCH'));
});

test('removing one edited draft retains other assigned drafts without granting a new draft', async t => {
  const drafts = ['skill_remove', 'skill_retain', 'skill_new'].map(id => ({ ...skill, id, status: 'draft' }));
  const { bridge, token, calls } = await fixture(t, path => path === '/api/bots/skills' ? { skills: drafts, assignments: [{ botId: 'bot_coder', skillIds: ['skill_remove', 'skill_retain'] }] } : undefined);
  const removed = await request(bridge, '/v1/bots/skills/assign', { token, method: 'POST', body: { botId: 'bot_coder', skillIds: ['skill_retain'] } });
  assert.equal(removed.status, 200); assert.equal(removed.json.saved, true);
  assert.deepEqual(calls.find(call => call.path.endsWith('/assign')).body.skillIds, ['skill_retain']);
  const before = calls.filter(call => call.path.endsWith('/assign')).length;
  const added = await request(bridge, '/v1/bots/skills/assign', { token, method: 'POST', body: { botId: 'bot_coder', skillIds: ['skill_retain', 'skill_new'] } });
  assert.equal(added.status, 409); assert.equal(calls.filter(call => call.path.endsWith('/assign')).length, before);
});
