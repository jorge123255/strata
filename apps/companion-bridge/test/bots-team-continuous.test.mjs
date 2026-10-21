import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBridge } from '../bridge.mjs';
import { botWorkspaceRequest, publicBotWorkspace, handleBotWorkspace } from '../bots-workspace.mjs';

const zero = { maxParallel: 0, maxDepth: 0, maxHops: 0, maxTurns: 0, maxDurationMs: 0 };
const legacy = { maxParallel: 0, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 };
const members = ['bot_one', 'bot_two'];
const row = { id: 'team_fixture', name: 'Continuous', memberIds: members, coordinatorId: members[0], enabled: false, revision: 1, limits: zero };
const body = { name: row.name, memberIds: members, coordinatorId: members[0], limits: zero, briefing: { instructions: 'Work together.', members: [] } };

test('continuous team admission accepts only complete zero shape or existing legacy numeric bounds', () => {
  for (const limits of [zero, legacy, { maxTurns: 24 }, { maxParallel: 0 }]) assert.equal(botWorkspaceRequest('/api/bots/teams', 'POST', { ...body, limits }).kind, 'teams');
  for (const limits of [{ maxTurns: 0 }, { ...zero, maxHops: 1 }, { ...legacy, maxDepth: 0 }, { ...zero, maxTurns: -1 }, { ...zero, maxTurns: '0' }, { ...zero, maxTurns: false }, { ...zero, maxTurns: Number.NaN }, { ...zero, maxTurns: Number.MAX_SAFE_INTEGER + 1 }, { ...zero, private: 0 }]) assert.throws(() => botWorkspaceRequest('/api/bots/teams', 'POST', { ...body, limits }), { status: 403 });
});

test('continuous capability is literal true, distinct from unrestricted, and full zero limits survive every response', () => {
  const rawRun = { id: 'run_fixture', teamId: row.id, state: 'running', limits: zero, consumedTurns: 137, rosterFanoutTurns: 25 };
  for (const capability of [true, false, undefined, 1, 'true', null, [], {}]) {
    const clean = publicBotWorkspace({ teams: [row], runs: [rawRun], teamUnrestrictedSupported: true, teamContinuousSupported: capability, secret: 'PRIVATE' }, { kind: 'teams' });
    assert.equal(clean.teamContinuousSupported, capability === true ? true : undefined);
    assert.equal(clean.teamUnrestrictedSupported, true);
    assert.deepEqual(clean.teams[0].limits, zero); assert.deepEqual(clean.runs[0].limits, zero);
    assert.equal(clean.runs[0].consumedTurns, 137); assert.equal(clean.runs[0].rosterFanoutTurns, 25);
    assert.ok(!JSON.stringify(clean).includes('PRIVATE'));
  }
  assert.deepEqual(publicBotWorkspace({ team: row }, { kind: 'team' }).team.limits, zero);
  assert.deepEqual(publicBotWorkspace({ run: rawRun }, { kind: 'run' }).run.limits, zero);
  const channel = { teamId: row.id, supported: true, messages: [], activeRuns: [rawRun], nextSequence: 0, hasMore: false, hasMoreBefore: false };
  assert.deepEqual(publicBotWorkspace(channel, { kind: 'channel', teamId: row.id }).activeRuns[0].limits, zero);
  const old = publicBotWorkspace({ teams: [{ ...row, limits: legacy }], runs: [], teamUnrestrictedSupported: true }, { kind: 'teams' });
  assert.equal(old.teamContinuousSupported, undefined); assert.deepEqual(old.teams[0].limits, legacy);
});

test('continuous writes require fresh exact host capability and share the existing briefing catalog read', async () => {
  for (const supported of [true, false, undefined, 1, 'true']) {
    const calls = []; let response;
    const host = { async json(path, options) { calls.push({ path, ...options }); if (options) return { team: row }; return path === '/api/bots/teams' ? { teams: [row], teamContinuousSupported: supported, teamUnrestrictedSupported: true, teamInstructionsSupported: true } : { bots: members.map(id => ({ id })) }; } };
    const invoke = () => handleBotWorkspace({ path: '/v1/bots/teams', method: 'POST', req: { headers: {} }, res: {}, session: { id: 'fixture' }, host, readBody: async () => body, sendJSON: (_r, _s, value) => { response = value; }, requireCurrentSession() {} });
    if (supported === true) { assert.equal(await invoke(), true); assert.deepEqual(response.team.limits, zero); assert.deepEqual(calls.at(-1).body, body); }
    else { await assert.rejects(invoke(), { status: 409 }); assert.ok(!calls.some(call => call.method)); }
    assert.equal(calls.filter(call => call.path === '/api/bots/teams' && !call.method).length, 1);
  }
});

test('revocation while continuous capability is being read prevents a later mutation', async () => {
  let active = true, mutations = 0;
  const host = { async json(_path, options) { if (options) { mutations++; return { team: row }; } active = false; return { teamContinuousSupported: true }; } };
  await assert.rejects(() => handleBotWorkspace({ path: '/v1/bots/teams', method: 'POST', req: { headers: {} }, res: {}, session: { id: 'fixture' }, host, readBody: async () => body, sendJSON() {}, requireCurrentSession() { if (!active) throw Object.assign(Error('Revoked'), { status: 401 }); } }));
  assert.equal(mutations, 0);
});

test('actual authenticated pinned TLS continuous save preserves exact zero body and rejects older host or revoked device', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-continuous-')); let supported = true; const calls = [];
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options = {}) { calls.push({ path, ...options }); if (options.method) return { team: { ...row, ...options.body } }; return path === '/api/bots/teams' ? { teams: [row], runs: [], teamContinuousSupported: supported, teamUnrestrictedSupported: true, teamInstructionsSupported: true } : { bots: members.map(id => ({ id })) }; } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  const ca = readFileSync(join(directory, 'server-cert.pem'));
  const request = (token, path = '/v1/bots/teams', method = 'POST', payload = body) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, ca, agent: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) } }, res => { let raw = ''; res.on('data', part => { raw += part; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) })); }); req.on('error', reject); req.end(payload ? JSON.stringify(payload) : undefined);
  });
  assert.equal((await request()).status, 401); assert.equal(calls.length, 0);
  const paired = bridge.authority.pair(bridge.authority.code, 'Continuous fixture');
  const saved = await request(paired.token); assert.equal(saved.status, 200); assert.deepEqual(saved.json.team.limits, zero); assert.deepEqual(calls.find(call => call.method === 'POST').body, body);
  supported = false; assert.equal((await request(paired.token)).status, 409); assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  bridge.authority.revoke(paired.session.id); const before = calls.length;
  assert.equal((await request(paired.token)).status, 401); assert.equal(calls.length, before);
});
