import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../bridge.mjs';
import { botWorkspaceRequest, publicBotWorkspace } from '../bots-workspace.mjs';
const snapshot = { supported: true, sessions: [{ id: 's_fixture', botId: 'bot_fixture', name: 'Builder', title: 'Synthetic work', state: 'approval', approvalCount: 1, teamId: 'team_fixture', parentChatId: 's_parent', computerName: 'Saved computer', updatedAt: '2026-10-21T17:00:00Z', args: 'PRIVATE-ARGS', command: 'PRIVATE-COMMAND', pending: [{ id: 'PRIVATE-APPROVAL-ID' }], messages: 'PRIVATE-TRANSCRIPT', apiKey: 'PRIVATE-KEY' }], counts: { waiting: 1, working: 0, completed: 0, errors: 0 }, hasMore: false };
function request(bridge, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method: options.method ?? 'GET', agent: false, rejectUnauthorized: false, headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text), text }));
    }); req.on('error', reject); req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}
test('paired supervision projects public display fields only; malformed future states never become actionable cards', () => {
  const result = publicBotWorkspace(snapshot, { kind: 'supervision' });
  assert.equal(result.sessions[0].id, 's_fixture'); assert.equal(result.sessions[0].parentChatId, 's_parent');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  for (const patch of [{ state: 'future' }, { botId: 'unsafe/bot' }, { state: 'approval', approvalCount: 0 }]) assert.deepEqual(publicBotWorkspace({ ...snapshot, sessions: [{ ...snapshot.sessions[0], ...patch }] }, { kind: 'supervision' }).sessions, []);
  const bounded = publicBotWorkspace({ ...snapshot, sessions: Array.from({ length: 250 }, (_, index) => ({ ...snapshot.sessions[0], id: 's_' + index, name: 'x'.repeat(200), toolName: 't'.repeat(200) })), counts: { waiting: -1, working: Infinity, completed: 2_000_000, errors: '1' } }, { kind: 'supervision' });
  assert.equal(bounded.sessions.length, 200); assert.equal(bounded.sessions[0].name.length, 120); assert.equal(bounded.sessions[0].toolName.length, 120);
  assert.deepEqual(bounded.counts, { waiting: 0, working: 0, completed: 1_000_000, errors: 0 });
});
test('workspace supervision refuses every mutation, query and GET body', () => {
  assert.equal(botWorkspaceRequest('/api/bots/supervision', 'GET').kind, 'supervision');
  for (const method of ['POST','PATCH','DELETE']) assert.throws(() => botWorkspaceRequest('/api/bots/supervision', method, {}), { status: 403 });
  assert.throws(() => botWorkspaceRequest('/api/bots/supervision?botId=bot_fixture', 'GET'), { status: 403 });
  assert.throws(() => botWorkspaceRequest('/api/bots/supervision', 'GET', { approve: true }), { status: 403 });
});
test('real paired HTTPS route is authenticated, read-only, revocable, and compatible with older hosts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-supervision-bridge-')), calls = []; let legacy = false;
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options) { calls.push({ path, ...options }); if (legacy) throw Object.assign(new Error('Private upstream error'), { status: 404 }); assert.equal(path, '/api/bots/supervision'); return snapshot; } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  const pair = bridge.authority.pair(bridge.authority.code, 'Synthetic supervision client');
  assert.equal((await request(bridge, '/v1/bots/supervision')).status, 401); assert.equal(calls.length, 0);
  const result = await request(bridge, '/v1/bots/supervision', { token: pair.token });
  assert.equal(result.status, 200); assert.equal(result.json.sessions[0].state, 'approval'); assert.equal(result.text.includes('PRIVATE'), false);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
  for (const method of ['POST','PATCH','DELETE']) assert.notEqual((await request(bridge, '/v1/bots/supervision', { token: pair.token, method, body: {} })).status, 200);
  assert.equal(calls.length, 1);
  legacy = true;
  const older = await request(bridge, '/v1/bots/supervision', { token: pair.token });
  assert.equal(older.status, 200); assert.equal(older.json.supported, false); assert.deepEqual(older.json.sessions, []); assert.match(older.json.reason, /Update Strata/);
  bridge.authority.revoke(pair.session.id);
  assert.equal((await request(bridge, '/v1/bots/supervision', { token: pair.token })).status, 401);
});
