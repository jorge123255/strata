import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBridge, HostClient } from '../bridge.mjs';
import { botWorkspaceRequest, publicBotWorkspace } from '../bots-workspace.mjs';

const teamId = 'team_fixture', botId = 'bot_fixture';
const team = { id: teamId, name: 'Room', memberIds: [botId, 'bot_peer'], coordinatorId: botId, enabled: true, limits: { maxParallel: 2, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 } };
const avatarConfig = { color: 'sky', eyes: 'round', ears: 'small', shape: 'orb' };
const message = { id: 'tm_fixture', sequence: 1, teamId, kind: 'message', author: { type: 'bot', botId, name: 'Builder', avatarConfig }, content: 'Hello team', createdAt: '2026-10-21T02:00:00.000Z', chatId: 's_fixture', runId: 'tr_fixture', state: 'done' };
const run = { id: 'tr_fixture', teamId, rootChatId: 's_fixture', rootBotId: botId, state: 'running', consumedTurns: 1 };
const snapshot = () => ({ teamId, supported: true, messages: [structuredClone(message)], activeRuns: [structuredClone(run)], nextSequence: 1, hasMore: false, hasMoreBefore: false });
const route = { kind: 'channel', teamId };
function request(bridge, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text), text }));
    }); req.on('error', reject); req.end(payload);
  });
}
async function fixture(t, intercept = () => undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-paired-team-channel-')), calls = [];
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options = {}) {
    calls.push({ path, ...options }); const result = await intercept(path, options); if (result !== undefined) return result;
    if (path === '/api/bots/teams') return { teams: [team], runs: [], channelsSupported: true };
    if (path.startsWith(`/api/bots/teams/${teamId}/channel`)) return snapshot();
    if (path === `/api/bots/teams/${teamId}/messages`) return { channel: snapshot(), run, conversation: { private: 'PRIVATE_CONVERSATION' } };
    throw Object.assign(Error('PRIVATE_HOST_DIAGNOSTIC'), { status: 404 });
  } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, calls, ...bridge.authority.pair(bridge.authority.code, 'Channel fixture') };
}

test('team channel host admission allows only bounded cursors and public message fields', async () => {
  const calls = [], host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { calls.push({ url, ...options }); return new Response('{}'); } });
  for (const suffix of ['', '?after=0', '?before=100']) await host.request(`/api/bots/teams/${teamId}/channel${suffix}`);
  await host.request(`/api/bots/teams/${teamId}/messages`, { method: 'POST', body: { message: 'Hi everyone', requestId: 'request_room', recipientIds: [botId], replyToId: 'tm_previous' } });
  for (const suffix of ['?after=-1', '?before=1.5', '?after=01', '?after=1e2', '?after=9007199254740992', '?after=1&before=2', '?after=1&after=2', '?limit=1000', '?include=secrets']) await assert.rejects(host.request(`/api/bots/teams/${teamId}/channel${suffix}`), { status: 403 });
  for (const body of [{ message: 'Hi' }, { message: '', requestId: 'r1' }, { message: 'Hi', requestId: 'r1', policy: 'bypass' }, { message: 'Hi', requestId: 'r1', author: { type: 'bot', botId } }, { message: 'Hi', requestId: 'r1', teamConversationOnly: false }, { message: 'Hi', requestId: 'r1', recipientIds: [] }, { message: 'Hi', requestId: 'r1', recipientIds: [botId, botId] }, { message: 'Hi', requestId: 'r1', replyToId: '../private' }]) await assert.rejects(host.request(`/api/bots/teams/${teamId}/messages`, { method: 'POST', body }), { status: 403 });
  assert.equal(calls.length, 4);
});

test('channel projection retains source attribution and geometric faces while omitting internal profiles', () => {
  const raw = snapshot(); raw.secret = 'PRIVATE_TOP'; raw.activeRuns[0].private = 'PRIVATE_RUN'; raw.messages[0].author.credentials = 'PRIVATE_KEY'; raw.messages[0].checkpoint = 'PRIVATE_NATIVE_SESSION';
  const clean = publicBotWorkspace(raw, route);
  assert.equal(clean.messages[0].author.botId, botId); assert.deepEqual(clean.messages[0].author.avatarConfig, avatarConfig); assert.equal(clean.firstSequence, 1);
  assert.ok(!JSON.stringify(clean).includes('PRIVATE_'));
  raw.messages[0].author.avatarConfig = { ...avatarConfig, url: 'https://PRIVATE_IMAGE' };
  assert.equal(publicBotWorkspace(raw, route).messages[0].author.avatarConfig, undefined);
  assert.ok(!JSON.stringify(publicBotWorkspace(raw, route)).includes('PRIVATE_IMAGE'));
});

test('malformed or cross-team ordering is rejected rather than silently advancing the history cursor', () => {
  const cases = [v => { v.teamId = 'team_other'; }, v => { v.messages[0].sequence = 0; }, v => { v.messages.push(v.messages[0]); }, v => { v.nextSequence = 9; }, v => { v.activeRuns[0].teamId = 'team_other'; }, v => { v.messages[0].author.botId = undefined; }, v => { v.messages[0].content = { secret: true }; }, v => { v.messages[0].replyToId = '../private'; }, v => { v.messages[0].createdAt = { secret: true }; }];
  for (const mutate of cases) { const raw = snapshot(); mutate(raw); assert.throws(() => publicBotWorkspace(raw, route), { status: 502 }); }
});

test('paired channel read is authenticated and starts no work; explicit send preserves request/reply identity', async t => {
  const { bridge, token, calls } = await fixture(t);
  assert.equal((await request(bridge, `/v1/bots/teams/${teamId}/channel`)).status, 401);
  const read = await request(bridge, `/v1/bots/teams/${teamId}/channel?after=0`, { token });
  assert.equal(read.status, 200); assert.equal(read.json.messages[0].content, 'Hello team');
  assert.equal(calls.some(v => v.method === 'POST'), false);
  const body = { message: 'Hi everyone', requestId: 'request_send', recipientIds: [botId], replyToId: 'tm_fixture' };
  const sent = await request(bridge, `/v1/bots/teams/${teamId}/messages`, { token, method: 'POST', body });
  assert.equal(sent.status, 200); assert.equal(sent.json.channel.messages[0].sequence, 1); assert.equal(sent.json.run.id, run.id); assert.equal(sent.json.conversation, undefined); assert.ok(!sent.text.includes('PRIVATE_CONVERSATION'));
  assert.deepEqual(calls.at(-1).body, body);
  assert.ok(calls.at(-1).deviceId);
  const catalog = await request(bridge, '/v1/bots/teams', { token }); assert.equal(catalog.json.channelsSupported, true);
});

test('fresh team membership blocks invalid recipients and revoked pairing cannot send after its lookup', async t => {
  let enter, release;
  const entered = new Promise(r => enter = r), held = new Promise(r => release = r);
  const f = await fixture(t, async path => { if (path === '/api/bots/teams') { enter(); await held; } });
  const pending = request(f.bridge, `/v1/bots/teams/${teamId}/messages`, { token: f.token, method: 'POST', body: { message: 'Hi', requestId: 'request_revoked' } });
  await entered; f.bridge.authority.revoke(f.session.id); release();
  assert.equal((await pending).status, 401); assert.equal(f.calls.some(c => c.path.endsWith('/messages')), false);
  const g = await fixture(t);
  const invalid = await request(g.bridge, `/v1/bots/teams/${teamId}/messages`, { token: g.token, method: 'POST', body: { message: 'Hi', requestId: 'request_outside', recipientIds: ['bot_outside'] } });
  assert.equal(invalid.status, 409); assert.equal(g.calls.some(c => c.path.endsWith('/messages')), false);
});

test('only unsupported old hosts get a read-only upgrade fallback; transient and send errors stay errors', async t => {
  for (const status of [404, 405, 501, 500]) {
    const f = await fixture(t, path => { if (path.includes('/channel') || path.endsWith('/messages')) throw Object.assign(Error('PRIVATE_RAW_ERROR'), { status }); });
    const read = await request(f.bridge, `/v1/bots/teams/${teamId}/channel`, { token: f.token });
    if (status === 500) assert.equal(read.status, 503);
    else { assert.equal(read.status, 200); assert.equal(read.json.supported, false); assert.equal(read.json.teamId, teamId); assert.deepEqual(read.json.messages, []); }
    assert.ok(!read.text.includes('PRIVATE_RAW_ERROR'));
    const send = await request(f.bridge, `/v1/bots/teams/${teamId}/messages`, { token: f.token, method: 'POST', body: { message: 'Hi', requestId: 'request_old' } });
    assert.notEqual(send.status, 200); assert.equal(send.json.supported, undefined); assert.ok(!send.text.includes('PRIVATE_RAW_ERROR'));
  }
});

test('a paused recovery keeps the host text and continue, and the choice posts only that id', async t => {
  const jobId = 'tj_0123456789abcdef', runId = 'tr_0123456789abcdef';
  const summary = 'I finished inspect. The rest of this request is still left.';
  const recovery = { kind: 'paused', jobId, runId, text: summary, question: 'Keep going?', options: [{ id: 'continue', label: 'Keep going' }] };
  const raw = snapshot();
  raw.messages[0].recovery = { ...recovery, note: 'PRIVATE_RECOVERY' };
  raw.messages[0].recovery.options[0] = { ...recovery.options[0], secret: 'PRIVATE_OPTION' };
  const clean = publicBotWorkspace(raw, route);
  assert.deepEqual(clean.messages[0].recovery, { ...recovery, options: [{ id: 'continue', label: 'Keep going', style: 'primary' }] });
  assert.ok(!JSON.stringify(clean).includes('PRIVATE_'));
  const classic = snapshot();
  classic.messages[0].recovery = { jobId, runId, question: 'What should I do next?', options: [{ id: 'retry', label: 'Try again' }, { id: 'skip', label: 'Skip this' }, { id: 'different', label: 'Try a different way' }] };
  assert.deepEqual(publicBotWorkspace(classic, route).messages[0].recovery, classic.messages[0].recovery);
  const broken = snapshot();
  broken.messages[0].recovery = { jobId: 'job_secret', text: 'PRIVATE_PAUSE' };
  const hidden = publicBotWorkspace(broken, route);
  assert.equal(hidden.messages[0].recovery, undefined);
  assert.equal(hidden.messages[0].content, 'Hello team');
  assert.ok(!JSON.stringify(hidden).includes('PRIVATE_PAUSE'));
  const saved = { ...message, recovery: { ...recovery, options: [{ id: 'continue', label: 'Keep going', style: 'primary' }], choice: 'continue' } };
  const posted = publicBotWorkspace({ accepted: true, choice: 'continue', message: saved, secret: 'PRIVATE_CHOICE' }, { kind: 'channelChoice', teamId, messageId: message.id });
  assert.equal(posted.accepted, true);
  assert.equal(posted.choice, 'continue');
  assert.equal(posted.message.recovery.text, summary);
  assert.equal(posted.message.recovery.choice, 'continue');
  assert.ok(!JSON.stringify(posted).includes('PRIVATE_CHOICE'));
  assert.equal(botWorkspaceRequest(`/api/bots/teams/${teamId}/messages/${message.id}/choice`, 'POST', { choice: 'continue' }).kind, 'channelChoice');
  assert.throws(() => botWorkspaceRequest(`/api/bots/teams/${teamId}/messages/${message.id}/choice`, 'POST', { choice: 'resume' }), { status: 403 });
  assert.throws(() => botWorkspaceRequest(`/api/bots/teams/${teamId}/messages/${message.id}/choice`, 'POST', { choice: 'continue', note: 'x' }), { status: 403 });
  const f = await fixture(t, (path, options) => {
    if (path === `/api/bots/teams/${teamId}/messages/${message.id}/choice` && options?.body?.choice === 'continue') return { accepted: true, choice: 'continue', message: saved };
  });
  const result = await request(f.bridge, `/v1/bots/teams/${teamId}/messages/${message.id}/choice`, { token: f.token, method: 'POST', body: { choice: 'continue' } });
  assert.equal(result.status, 200);
  assert.equal(result.json.choice, 'continue');
  assert.equal(result.json.message.recovery.text, summary);
  assert.deepEqual(f.calls.at(-1).body, { choice: 'continue' });
  assert.equal(f.calls.at(-1).path, `/api/bots/teams/${teamId}/messages/${message.id}/choice`);
  const rejected = await request(f.bridge, `/v1/bots/teams/${teamId}/messages/${message.id}/choice`, { token: f.token, method: 'POST', body: { choice: 'resume' } });
  assert.equal(rejected.status, 400);
  assert.equal(f.calls.filter(call => call.path.endsWith('/choice')).length, 1);
});

test('wrong methods and GET bodies never reach the channel host', async t => {
  const f = await fixture(t);
  for (const [method, suffix, body] of [['POST', 'channel', {}], ['GET', 'messages', undefined], ['DELETE', 'messages', undefined], ['GET', 'channel', { unknown: true }]]) {
    const result = await request(f.bridge, `/v1/bots/teams/${teamId}/${suffix}`, { token: f.token, method, body });
    assert.ok(result.status >= 400);
  }
  assert.equal(f.calls.length, 0);
});
