/** Paired phone team roster editing through the real TLS bridge into a fake upstream. */
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, HostClient } from '../bridge.mjs';
import { botWorkspaceRequest, publicBotWorkspace } from '../bots-workspace.mjs';

const bots = [{ id: 'bot_one' }, { id: 'bot_two' }, { id: 'bot_three' }];
const editorPayload = state => ({
  team: { id: 'team_decaf00d', name: 'QA-TEST-Bridge team', memberIds: [...state.memberIds], coordinatorId: state.coordinatorId, revision: state.revision, privateProfile: 'PRIVATE_TEAM' },
  members: state.memberIds.map((id, index) => ({ id, name: `QA-TEST-Bot ${id}`, role: index === 0 ? 'Lead' : '', paused: false, available: true, providerSettings: { apiKey: 'PRIVATE_KEY' } })),
  roster: bots.map(bot => ({ id: bot.id, name: `QA-TEST-Bot ${bot.id}`, paused: false, execution: { secret: 'PRIVATE_SSH' } })),
});

function request(bridge, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text), text }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-members-'));
  const state = { memberIds: ['bot_one', 'bot_two'], coordinatorId: 'bot_one', revision: 4 };
  const calls = [];
  const host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options = {}) => {
    calls.push({ url, ...options });
    const path = new URL(url).pathname;
    const fail = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/bots') return fail(200, { bots });
    if (path === '/api/companion/teams/team_decaf00d/members') {
      if (!options.method || options.method === 'GET') return fail(200, editorPayload(state));
      if (options.method === 'PATCH') {
        const body = JSON.parse(options.body);
        if (body.expectedRevision !== undefined && body.expectedRevision !== state.revision) return fail(409, { error: 'This team changed on another device. Refresh and review your changes.', code: 'team_changed' });
        if (body.memberIds) state.memberIds = [...body.memberIds];
        if (body.coordinatorId) state.coordinatorId = body.coordinatorId;
        state.revision += 1;
        return fail(200, { team: { id: 'team_decaf00d', name: 'QA-TEST-Bridge team', memberIds: [...state.memberIds], coordinatorId: state.coordinatorId, enabled: true, revision: state.revision, secret: 'PRIVATE_TEAM' } });
      }
    }
    return fail(404, { error: 'QA-TEST unknown upstream path' });
  } });
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  const membersCalls = () => calls.filter(call => call.url.includes('/api/companion/teams/'));
  return { bridge, state, calls, membersCalls, ...bridge.authority.pair(bridge.authority.code, 'QA-TEST-Members phone') };
}

test('workspace parser admits the members route with a narrow PATCH body only', () => {
  const path = '/api/bots/teams/team_decaf00d/members';
  assert.deepEqual(botWorkspaceRequest(path, 'GET'), { kind: 'teamMembers', teamId: 'team_decaf00d' });
  assert.deepEqual(botWorkspaceRequest(path, 'PATCH', { memberIds: ['bot_one', 'bot_two'], coordinatorId: 'bot_two', expectedRevision: 4 }).kind, 'teamMembers');
  assert.equal(botWorkspaceRequest(`${path}/extra`, 'GET'), null);
  assert.equal(botWorkspaceRequest('/api/bots/teams/not-a-team/members', 'GET'), null);
  for (const [method, body] of [
    ['DELETE', undefined], ['POST', {}], ['PUT', {}],
    ['PATCH', {}], ['PATCH', { expectedRevision: 4 }], ['PATCH', { name: 'Rename' }],
    ['PATCH', { memberIds: ['bot_one'] }], ['PATCH', { memberIds: ['bot_one', 'bot_one'] }],
    ['PATCH', { memberIds: ['bot_one', 'bot_two'], coordinatorId: 'bot_three' }],
    ['PATCH', { coordinatorId: 'not a bot' }], ['PATCH', { coordinatorId: 'bot_one', expectedRevision: 0 }],
    ['PATCH', { coordinatorId: 'bot_one', expectedRevision: 1.5 }], ['GET', { coordinatorId: 'bot_one' }],
  ]) assert.throws(() => botWorkspaceRequest(path, method, body), { status: 403 }, `${method} ${JSON.stringify(body)}`);
  assert.throws(() => botWorkspaceRequest(`${path}?force=1`, 'GET'), { status: 403 });
});

test('members projection is bounded, roster-checked and never forwards private fields', () => {
  const state = { memberIds: ['bot_one', 'bot_two'], coordinatorId: 'bot_one', revision: 4 };
  const projected = publicBotWorkspace(editorPayload(state), { kind: 'teamMembers', teamId: 'team_decaf00d' });
  assert.deepEqual(projected.team, { id: 'team_decaf00d', name: 'QA-TEST-Bridge team', memberIds: ['bot_one', 'bot_two'], coordinatorId: 'bot_one', revision: 4 });
  assert.deepEqual(projected.members[0], { id: 'bot_one', name: 'QA-TEST-Bot bot_one', role: 'Lead', paused: false, available: true });
  assert.deepEqual(projected.roster.map(row => Object.keys(row).sort().join(',')), ['id,name,paused', 'id,name,paused', 'id,name,paused']);
  assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
  const saved = publicBotWorkspace({ team: { id: 'team_decaf00d', name: 'QA-TEST-Bridge team', memberIds: ['bot_one', 'bot_three'], coordinatorId: 'bot_three', enabled: true, revision: 5, secret: 'PRIVATE_TEAM' } }, { kind: 'teamMembers', teamId: 'team_decaf00d' });
  assert.equal(saved.team.revision, 5);
  assert.deepEqual(saved.team.memberIds, ['bot_one', 'bot_three']);
  assert.ok(!JSON.stringify(saved).includes('PRIVATE'));
  assert.throws(() => publicBotWorkspace(editorPayload({ ...state }), { kind: 'teamMembers', teamId: 'team_other' }), { status: 502 });
  assert.throws(() => publicBotWorkspace({ team: { id: 'team_decaf00d' }, members: 'PRIVATE', roster: [] }, { kind: 'teamMembers', teamId: 'team_decaf00d' }), { status: 502 });
});

test('HostClient admits the companion members route for GET/PATCH and rejects everything around it', async () => {
  const calls = [];
  const host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { calls.push({ url, ...options }); return new Response('{}'); } });
  const path = '/api/companion/teams/team_11111111-1111-1111-1111-111111111111/members';
  await host.request(path);
  await host.request(path, { method: 'PATCH', body: { coordinatorId: 'bot_two', expectedRevision: 4 } });
  await host.request(path, { method: 'PATCH', body: { memberIds: ['bot_one', 'bot_two'] } });
  for (const [p, method, body] of [
    [path, 'DELETE', undefined], [path, 'POST', {}], [path, 'PUT', {}],
    [path, 'PATCH', {}], [path, 'PATCH', { expectedRevision: 4 }], [path, 'PATCH', { coordinatorId: 'bot_two', enabled: false }],
    [path, 'PATCH', { memberIds: ['bot_one'] }], [path, 'PATCH', { memberIds: ['bot_one', 'bot_two'], coordinatorId: 'bot_three' }],
    [path, 'PATCH', { coordinatorId: 'bot_two', expectedRevision: 0 }], [path, 'GET', { coordinatorId: 'bot_two' }],
    [`${path}?force=1`, 'GET', undefined],
    ['/api/companion/teams/team_11111111-1111-1111-1111-111111111111', 'GET', undefined],
    ['/api/companion/teams', 'GET', undefined], ['/api/companion/start', 'POST', {}],
    ['/api/companion/teams/not_a_team/members', 'GET', undefined],
  ]) await assert.rejects(host.request(p, { method, body }), { status: 403 }, `${method} ${p}`);
  assert.equal(calls.length, 3);
});

test('paired phone reads and edits the roster through the bridge; revocation stops all dispatch', async t => {
  const { bridge, token, session, membersCalls } = await fixture(t);
  const endpoint = '/v1/bots/teams/team_decaf00d/members';
  assert.equal((await request(bridge, endpoint)).status, 401);
  assert.equal((await request(bridge, '/v1/companion/teams/team_decaf00d/members', { token })).status, 404);
  assert.equal(membersCalls().length, 0);
  const editor = await request(bridge, endpoint, { token });
  assert.equal(editor.status, 200);
  assert.deepEqual(editor.json.team, { id: 'team_decaf00d', name: 'QA-TEST-Bridge team', memberIds: ['bot_one', 'bot_two'], coordinatorId: 'bot_one', revision: 4 });
  assert.equal(editor.json.members.length, 2);
  assert.equal(editor.json.roster.length, 3);
  assert.ok(!editor.text.includes('PRIVATE'));
  assert.deepEqual(membersCalls().map(call => [call.method ?? 'GET', new URL(call.url).pathname]), [['GET', '/api/companion/teams/team_decaf00d/members']]);
  const saved = await request(bridge, endpoint, { token, method: 'PATCH', body: { memberIds: ['bot_one', 'bot_two', 'bot_three'], coordinatorId: 'bot_three', expectedRevision: editor.json.team.revision } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.team.revision, 5);
  assert.deepEqual(saved.json.team.memberIds, ['bot_one', 'bot_two', 'bot_three']);
  assert.equal(saved.json.team.coordinatorId, 'bot_three');
  assert.ok(!saved.text.includes('PRIVATE'));
  const dispatched = JSON.parse(membersCalls().at(-1).body);
  assert.deepEqual(dispatched, { memberIds: ['bot_one', 'bot_two', 'bot_three'], coordinatorId: 'bot_three', expectedRevision: 4 });
  const stale = await request(bridge, endpoint, { token, method: 'PATCH', body: { coordinatorId: 'bot_one', expectedRevision: 4 } });
  assert.equal(stale.status, 409);
  const unsupported = await request(bridge, endpoint, { token, method: 'PATCH', body: { memberIds: ['bot_one', 'bot_two'], enabled: false } });
  assert.equal(unsupported.status, 400);
  const before = membersCalls().length;
  await request(bridge, '/v1/session', { token, method: 'DELETE' });
  assert.equal((await request(bridge, endpoint, { token })).status, 401);
  assert.equal((await request(bridge, endpoint, { token, method: 'PATCH', body: { coordinatorId: 'bot_one', expectedRevision: 5 } })).status, 401);
  assert.equal(membersCalls().length, before, 'A revoked device must not reach the host.');
  assert.equal(bridge.authority.sessions.some(saved2 => saved2.id === session.id), false);
});
