import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBridge, HostClient } from '../bridge.mjs';
import { botWorkspaceRequest, publicBotWorkspace } from '../bots-workspace.mjs';

const roster = count => Array.from({ length: count }, (_, i) => `bot_member_${i}`);
const budgets = { maxParallel: 0, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600_000 };
const team = members => ({ id: 'team_large', name: 'Whole team', memberIds: members, coordinatorId: members[0], enabled: true, limits: budgets });
const briefing = members => ({ instructions: 'Coordinate here.', members: members.map(botId => ({ botId, role: 'Peer', instructions: 'Report results.' })) });
const bodyFor = members => ({ name: 'Whole team', memberIds: members, coordinatorId: members[0], limits: budgets, briefing: briefing(members) });
const snapshot = (members, count = 1) => ({ teamId: 'team_large', supported: true, messages: [{ id: 'tm_large', teamId: 'team_large', sequence: 1, kind: 'message', author: { type: 'user', name: 'You' }, content: 'Hello everyone', recipientIds: members, createdAt: '2026-10-21T20:00:00.000Z' }], activeRuns: Array.from({ length: count }, (_, i) => ({ id: `run_${i}`, teamId: 'team_large', state: 'running', limits: budgets })), nextSequence: 1, hasMore: false, hasMoreBefore: false });
function request(bridge, path, { token, method = 'GET', body } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', part => raw += part); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw), raw }));
    }); req.on('error', reject); req.end(payload);
  });
}
async function fixture(t, members = roster(14), legacy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-unrestricted-')), calls = [];
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options = {}) {
    calls.push({ path, ...options });
    if (path === '/api/bots') return { bots: members.map(id => ({ id, name: id, provider: 'codex', model: 'fixture', capabilities: 'code', policy: 'manual', execution: { kind: 'ssh', host: 'PRIVATE_SSH', identity: 'PRIVATE_KEY' }, providerSettings: { apiKey: 'PRIVATE_API' } })), providers: [], computers: [], models: [] };
    if (path === '/api/bots/teams' && options.method === 'POST') {
      if (legacy && options.body.limits?.maxParallel === 0) throw Object.assign(Error('PRIVATE_LEGACY_DIAGNOSTIC'), { status: 400 });
      return { team: { ...team(members), ...options.body } };
    }
    if (path === '/api/bots/teams') return { teams: [team(members)], runs: [], teamInstructionsSupported: true, ...(legacy ? {} : { teamUnrestrictedSupported: true }) };
    if (path.endsWith('/messages')) return { channel: snapshot(members) };
    throw Object.assign(Error('PRIVATE_FIXTURE'), { status: 404 });
  } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, calls, members, ...bridge.authority.pair(bridge.authority.code, 'Large team fixture') };
}

test('host admission accepts fourteen-plus rosters, briefing roles, recipients and safe legacy parallel values', async () => {
  const calls = [], host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { calls.push({ url, ...options }); return Response.json({}); } });
  for (const members of [roster(14), roster(601)]) {
    for (const maxParallel of [0, 9, 601, Number.MAX_SAFE_INTEGER]) {
      const body = { ...bodyFor(members), limits: { ...budgets, maxParallel } };
      await host.request('/api/bots/teams', { method: 'POST', body }); assert.deepEqual(JSON.parse(calls.at(-1).body), body);
    }
    await host.request('/api/bots/teams/team_large/messages', { method: 'POST', body: { message: 'Hi everyone', requestId: 'request_all', recipientIds: members } });
  }
  assert.equal(calls.length, 10);
});

test('parallel limits reject negative, fractional, nonfinite and unsafe numbers while retaining other budgets', () => {
  for (const maxParallel of [-1, 0.5, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '0', null, true]) assert.throws(() => botWorkspaceRequest('/api/bots/teams', 'POST', { ...bodyFor(roster(2)), limits: { maxParallel } }), { status: 403 });
  for (const limits of [{ maxDepth: 0 }, { maxDepth: 5 }, { maxHops: 33 }, { maxTurns: 101 }, { maxDurationMs: 59_999 }, { maxDurationMs: 3_600_001 }, { arbitrary: 1 }]) assert.throws(() => botWorkspaceRequest('/api/bots/teams', 'POST', { ...bodyFor(roster(2)), limits }), { status: 403 });
});

test('large team projections preserve complete rosters, roles, zero parallelism and closed capability', () => {
  const members = roster(601), original = { ...team(members), briefing: briefing(members), privateProfile: 'PRIVATE_PROFILE' };
  for (const capability of [true, false, undefined, 1, 'true', { private: 'PRIVATE_CAPABILITY' }]) {
    const clean = publicBotWorkspace({ teams: [original], runs: [{ id: 'run_large', teamId: original.id, state: 'running', limits: budgets }], teamUnrestrictedSupported: capability, private: 'PRIVATE_TOP' }, { kind: 'teams' });
    assert.deepEqual(clean.teams[0].memberIds, members); assert.deepEqual(clean.teams[0].briefing, original.briefing); assert.deepEqual(clean.teams[0].limits, budgets); assert.deepEqual(clean.runs[0].limits, budgets);
    assert.equal(clean.teamUnrestrictedSupported, capability === true ? true : undefined); assert.ok(!JSON.stringify(clean).includes('PRIVATE_'));
  }
  assert.equal(publicBotWorkspace({ team: { ...original, limits: { ...budgets, maxParallel: 42 } } }, { kind: 'team' }).team.limits.maxParallel, 42);
});

test('channel projection preserves complete recipient lists and active runs without a roster-count cap', () => {
  const raw = snapshot(roster(601), 201), clean = publicBotWorkspace(raw, { kind: 'channel', teamId: raw.teamId });
  assert.deepEqual(clean.messages[0].recipientIds, raw.messages[0].recipientIds); assert.equal(clean.activeRuns.length, 201); assert.ok(clean.activeRuns.every(run => run.limits.maxParallel === 0));
  raw.messages[0].recipientIds.push(raw.messages[0].recipientIds[0]); assert.throws(() => publicBotWorkspace(raw, { kind: 'channel', teamId: raw.teamId }), { status: 502 });
});

test('invalid projected rosters fail closed and unsafe parallel values never reach clients', () => {
  const members = roster(14);
  for (const memberIds of [[...members, members[0]], [...members, '../private'], [...members, 1]]) assert.throws(() => publicBotWorkspace({ team: { ...team(members), memberIds } }, { kind: 'team' }), { status: 502 });
  for (const maxParallel of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
    const clean = publicBotWorkspace({ team: { ...team(members), limits: { ...budgets, maxParallel } } }, { kind: 'team' });
    assert.equal(clean.team.limits.maxParallel, undefined); assert.equal(clean.team.limits.maxTurns, budgets.maxTurns);
  }
});

test('paired large-team create and send retain exact bodies and fresh membership authority', async t => {
  const f = await fixture(t, roster(601));
  assert.equal((await request(f.bridge, '/v1/bots/teams', { method: 'POST', body: bodyFor(f.members) })).status, 401); assert.equal(f.calls.length, 0);
  const listed = await request(f.bridge, '/v1/bots/teams', { token: f.token }); assert.equal(listed.json.teamUnrestrictedSupported, true); assert.deepEqual(listed.json.teams[0].memberIds, f.members);
  const created = await request(f.bridge, '/v1/bots/teams', { token: f.token, method: 'POST', body: bodyFor(f.members) });
  assert.equal(created.status, 200); assert.deepEqual(created.json.team.memberIds, f.members); assert.deepEqual(created.json.team.briefing, briefing(f.members)); assert.equal(created.json.team.limits.maxParallel, 0); assert.deepEqual(f.calls.find(c => c.method === 'POST').body, bodyFor(f.members));
  const body = { message: 'Hi everyone', requestId: 'request_all', recipientIds: f.members };
  const sent = await request(f.bridge, '/v1/bots/teams/team_large/messages', { token: f.token, method: 'POST', body }); assert.equal(sent.status, 200); assert.deepEqual(sent.json.channel.messages[0].recipientIds, f.members); assert.deepEqual(f.calls.at(-1).body, body);
  const count = f.calls.filter(c => c.method === 'POST').length;
  for (const invalid of [{ ...bodyFor(f.members), memberIds: [...f.members, f.members[0]] }, { ...bodyFor(f.members), memberIds: [...f.members, 'bot_missing'] }, { ...bodyFor(f.members), briefing: { instructions: '', members: [briefing(f.members).members[0], briefing(f.members).members[0]] } }]) assert.ok([400, 409].includes((await request(f.bridge, '/v1/bots/teams', { token: f.token, method: 'POST', body: invalid })).status));
  for (const recipientIds of [[...f.members, f.members[0]], [...f.members, 'bot_missing']]) assert.ok([400, 409].includes((await request(f.bridge, '/v1/bots/teams/team_large/messages', { token: f.token, method: 'POST', body: { ...body, recipientIds } })).status));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, count);
});

test('legacy hosts omit unrestricted capability and can reject zero without bridge rewriting limits', async t => {
  const f = await fixture(t, roster(14), true);
  const listed = await request(f.bridge, '/v1/bots/teams', { token: f.token }); assert.equal(listed.json.teamUnrestrictedSupported, undefined);
  const result = await request(f.bridge, '/v1/bots/teams', { token: f.token, method: 'POST', body: bodyFor(f.members) }); assert.equal(result.status, 400); assert.ok(!result.raw.includes('PRIVATE_LEGACY_DIAGNOSTIC')); assert.equal(f.calls.find(c => c.method === 'POST').body.limits.maxParallel, 0);
});

test('existing payload byte and briefing-text budgets still reject oversized requests before host mutation', async t => {
  const f = await fixture(t), many = Array.from({ length: 2001 }, (_, i) => `bot_${i}_${'x'.repeat(110)}`);
  const result = await request(f.bridge, '/v1/bots/teams', { token: f.token, method: 'POST', body: { name: 'Oversized', memberIds: many, coordinatorId: many[0] } }); assert.equal(result.status, 413); assert.equal(f.calls.length, 0);
  assert.throws(() => botWorkspaceRequest('/api/bots/teams', 'POST', { ...bodyFor(roster(14)), briefing: { instructions: 'a'.repeat(8000), members: roster(14).map(botId => ({ botId, role: '', instructions: 'b'.repeat(2000) })) } }), { status: 403 });
});

test('run projection retains total turns and exports only a valid bounded initial roster allowance', () => {
  const raw = { id: 'run_large', teamId: 'team_large', state: 'running', limits: budgets, consumedTurns: 51, rosterFanoutTurns: 49, privateCounter: 'PRIVATE_COUNTER' };
  const project = value => publicBotWorkspace({ run: value }, { kind: 'run' }).run;
  const clean = project(raw); assert.equal(clean.consumedTurns, 51); assert.equal(clean.rosterFanoutTurns, 49); assert.ok(!JSON.stringify(clean).includes('PRIVATE_COUNTER'));
  assert.equal(project({ ...raw, consumedTurns: 0, rosterFanoutTurns: 0 }).rosterFanoutTurns, 0);
  for (const rosterFanoutTurns of [undefined, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 52, '49', null, true, { private: 'PRIVATE_COUNTER' }]) {
    const value = project({ ...raw, rosterFanoutTurns }); assert.equal(value.consumedTurns, 51); assert.equal(Object.hasOwn(value, 'rosterFanoutTurns'), false);
  }
  for (const consumedTurns of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '51', null]) assert.equal(Object.hasOwn(project({ ...raw, consumedTurns, rosterFanoutTurns: 0 }), 'rosterFanoutTurns'), false);
  const channel = snapshot(roster(14)); channel.activeRuns[0] = raw;
  assert.equal(publicBotWorkspace(channel, { kind: 'channel', teamId: 'team_large' }).activeRuns[0].rosterFanoutTurns, 49);
});

test('team list preserves every live run beyond historical and generic row caps for Stop controls', () => {
  const members = roster(14);
  for (const liveCount of [205, 1005]) {
    const live = Array.from({ length: liveCount }, (_, index) => ({ id: `run_live_${index}`, teamId: 'team_large', rootChatId: `s_live_${index}`, state: ['queued', 'running', 'stopping', 'cleanup_pending'][index % 4], limits: budgets, consumedTurns: 1, private: 'PRIVATE_JOB' }));
    const terminal = Array.from({ length: 200 }, (_, index) => ({ id: `run_done_${index}`, teamId: 'team_large', state: 'completed', limits: budgets, consumedTurns: 1 }));
    const projected = publicBotWorkspace({ teams: [team(members)], runs: [...terminal, ...live] }, { kind: 'teams' });
    assert.equal(projected.runs.length, terminal.length + live.length);
    assert.deepEqual(projected.runs.filter(run => ['queued', 'running', 'stopping', 'cleanup_pending'].includes(run.state)).map(run => run.id), live.map(run => run.id));
    assert.equal(projected.runs.at(-1).rootChatId, live.at(-1).rootChatId); assert.ok(!JSON.stringify(projected).includes('PRIVATE_JOB'));
  }
});

test('actual paired catalog route preserves every profile needed for large-roster editing without secrets', async t => {
  const f = await fixture(t, roster(601));
  assert.equal((await request(f.bridge, '/v1/bots')).status, 401); assert.equal(f.calls.length, 0);
  const result = await request(f.bridge, '/v1/bots', { token: f.token }); assert.equal(result.status, 200);
  assert.deepEqual(result.json.bots.map(bot => bot.id), f.members); assert.equal(result.json.bots.at(-1).id, 'bot_member_600');
  assert.deepEqual(result.json.bots.at(-1).execution, { kind: 'ssh' }); assert.ok(!result.raw.includes('PRIVATE_'));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/bots');
  f.bridge.authority.revoke(f.session.id);
  assert.equal((await request(f.bridge, '/v1/bots', { token: f.token })).status, 401); assert.equal(f.calls.length, 1);
});
