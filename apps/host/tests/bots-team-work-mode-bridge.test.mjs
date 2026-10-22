/** Paired Work intent is explicit and capability checked before any host write. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { botWorkspaceRequest, publicBotWorkspace, handleBotWorkspace } from '../../companion-bridge/bots-workspace.mjs';

const teamId = 'team_fixture', path = `/api/bots/teams/${teamId}/messages`;
const message = { message: 'Inspect the selected workspace.', requestId: 'request_one' };
const snapshot = (mode, author = { type: 'user', name: 'You' }) => ({ teamId, supported: true,
  messages: [{ id: 'tm_one', sequence: 1, teamId, kind: 'message', author, content: message.message,
    createdAt: '2026-10-22T00:00:00Z', ...(mode === undefined ? {} : { workMode: mode }) }],
  activeRuns: [], nextSequence: 1, hasMore: false, hasMoreBefore: false });

test('paired Work intent accepts only the explicit enum and preserves older request bytes', () => {
  const old = structuredClone(message);
  assert.equal(botWorkspaceRequest(path, 'POST', old).kind, 'channelMessage');
  assert.deepEqual(old, message);
  for (const mode of ['chat', 'work']) assert.equal(botWorkspaceRequest(path, 'POST', { ...message, workMode: mode }).kind, 'channelMessage');
  for (const mode of [true, false, 0, null, {}, [], '', 'Work', 'task', 'bypass'])
    assert.throws(() => botWorkspaceRequest(path, 'POST', { ...message, workMode: mode }), /Chat or Work/);
  assert.throws(() => botWorkspaceRequest(path, 'POST', { ...message, workMode: 'work', policy: 'bypass' }));
});

test('capability is literal true and public Work labels belong only to human requests', () => {
  for (const capability of [undefined, false, null, 1, 'true', true]) {
    const projected = publicBotWorkspace({ teams: [], runs: [], teamCoordinatorWorkToolsSupported: capability }, { kind: 'teams' });
    assert.equal(projected.teamCoordinatorWorkToolsSupported, capability === true ? true : undefined);
  }
  const route = { kind: 'channel', teamId };
  assert.equal(publicBotWorkspace(snapshot('work'), route).messages[0].workMode, 'work');
  assert.equal(publicBotWorkspace(snapshot(undefined), route).messages[0].workMode, undefined);
  for (const mode of [true, 1, null, 'task']) assert.throws(() => publicBotWorkspace(snapshot(mode), route));
  assert.throws(() => publicBotWorkspace(snapshot('work', { type: 'bot', name: 'Peer', botId: 'bot_peer' }), route));
});

async function forward(body, capability, options = {}) {
  const calls = [], response = {}, catalog = { teams: [{ id: teamId, enabled: options.enabled !== false,
    memberIds: ['bot_coordinator', 'bot_peer'] }], teamCoordinatorWorkToolsSupported: capability };
  let current = true;
  const host = { json: async (url, init) => {
    calls.push({ url, ...(init ? { init: structuredClone(init) } : {}) });
    if (url === '/api/bots/teams') { if (options.revokeAfterRead) current = false; return catalog; }
    return { channel: snapshot(body.workMode) };
  } };
  const execute = () => handleBotWorkspace({ path: path.replace('/api/', '/v1/'), method: 'POST',
    req: { headers: {} }, res: {}, session: {}, host, readBody: async () => structuredClone(body),
    sendJSON: (_res, status, value) => { response.status = status; response.value = value; },
    requireCurrentSession: () => { if (!current) throw Object.assign(new Error('Pairing was revoked.'), { status: 403 }); } });
  return { calls, response, execute };
}

test('unsupported or nonliteral hosts reject supplied Chat and Work with zero upstream writes', async () => {
  for (const capability of [undefined, false, 1, 'true']) for (const workMode of ['chat', 'work']) {
    const f = await forward({ ...message, workMode }, capability);
    await assert.rejects(f.execute(), { status: 409 });
    assert.deepEqual(f.calls.map(call => call.url), ['/api/bots/teams']);
    assert.equal(f.calls.some(call => call.init), false);
  }
  const old = await forward(message, undefined); await old.execute();
  assert.deepEqual(old.calls.at(-1).init.body, message);
});

test('capable paired writes preserve exact mode, recipients, reply and request identity', async () => {
  for (const workMode of ['chat', 'work']) {
    const body = { ...message, workMode, recipientIds: ['bot_peer'], replyToId: 'tm_previous' };
    const f = await forward(body, true); await f.execute();
    assert.deepEqual(f.calls.at(-1).init.body, body);
    assert.equal(f.calls.at(-1).init.method, 'POST');
    assert.equal(f.response.value.channel.messages[0].workMode, workMode);
  }
});

test('revoked pairing and disabled teams cannot forward even valid Work intent', async () => {
  for (const options of [{ revokeAfterRead: true }, { enabled: false }]) {
    const f = await forward({ ...message, workMode: 'work' }, true, options);
    await assert.rejects(f.execute()); assert.equal(f.calls.some(call => call.init), false);
  }
});
