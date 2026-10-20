import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, HostClient, publicComputer } from '../bridge.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=';
const frame = () => ({ available: true, computerName: 'Fixture isolated computer', detail: 'Ready', width: 1, height: 1,
  image: { mimeType: 'image/png', data: png }, control: { active: false, owned: false }, credentials: 'PRIVATE-CREDENTIAL', leaseToken: 'PRIVATE-TOKEN', url: 'PRIVATE-URL' });
const grant = () => ({ ...frame(), leaseToken: 'lease_fixture_0123456789', expiresAt: Date.now() + 60_000 });
function request(bridge, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', value => { text += value; }); res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t, responder, settings = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-computer-test-'));
  const calls = [];
  const bridge = await createBridge({ directory, host: { async json(path, options) { calls.push({ path, ...options }); return responder ? responder(path, options) : path.endsWith('/takeover') ? grant() : frame(); } },
    listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, ...settings });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, calls, ...bridge.authority.pair(bridge.authority.code, 'Computer fixture iPhone') };
}

test('host computer forwarding has exact routes, methods, fields and authenticated device header', async () => {
  const calls = [], deviceId = 'a'.repeat(32);
  const host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { calls.push({ url, ...options }); return new Response('{}'); } });
  await host.request('/api/bots/bot_fixture/computer?chatId=s_fixture', { deviceId });
  await host.request('/api/bots/bot_fixture/computer/start', { method: 'POST', body: { chatId: 's_fixture' }, deviceId });
  await host.request('/api/bots/bot_fixture/computer/control', { method: 'POST', body: { leaseToken: grant().leaseToken, action: 'click', x: 0, y: 0 }, deviceId });
  await host.request('/api/bots/bot_fixture/computer/stop', { method: 'POST', body: {}, deviceId });
  for (const call of calls) assert.equal(call.headers['x-strata-companion-device'], deviceId);
  for (const [path, method, body, owner = deviceId] of [
    ['/api/bots/bot_fixture/computer?chatId=s_fixture&secret=true', 'GET'],
    ['/api/bots/bot_fixture/computer?chatId=s_fixture&chatId=other', 'GET'],
    ['/api/bots/bot_fixture/computer?chatId=../private', 'GET'],
    ['/api/bots/bot_fixture/computer/start?chatId=s_fixture', 'POST', {}],
    ['/api/bots/bot_fixture/computer/prepare', 'POST', {}],
    ['/api/bots/bot_fixture/computer', 'POST', {}],
    ['/api/bots/bot_fixture/computer', 'GET', undefined, 'spoofed'],
    ['/api/bots/bot_fixture/computer/start', 'POST', { execution: { host: 'external' } }],
    ['/api/bots/bot_fixture/computer/control', 'POST', { leaseToken: grant().leaseToken, action: 'click', x: 0, y: 0, text: 'extra' }],
    ['/api/bots/bot_fixture/computer/control', 'POST', { leaseToken: grant().leaseToken, action: 'click', x: -1, y: 0 }],
    ['/api/bots/bot_fixture/computer/control', 'POST', { leaseToken: grant().leaseToken, action: 'key', key: 'shell;bad' }],
    ['/api/bots/bot_fixture/computer/control', 'POST', { leaseToken: grant().leaseToken, action: 'type', text: 'x'.repeat(4001) }],
  ]) await assert.rejects(host.request(path, { method, body, deviceId: owner }));
  assert.equal(calls.length, 4);
});

test('computer frame projection checks PNG dimensions and strips SDK, URLs and tokens', () => {
  const clean = publicComputer(frame());
  assert.equal(clean.image.data, png); assert.equal(clean.width, 1);
  for (const secret of ['PRIVATE-CREDENTIAL', 'PRIVATE-TOKEN', 'PRIVATE-URL']) assert.ok(!JSON.stringify(clean).includes(secret));
  for (const value of [{ ...frame(), width: 2 }, { ...frame(), width: 100000 }, { ...frame(), image: { mimeType: 'image/jpeg', data: png } },
    { ...frame(), image: { mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') } }]) assert.throws(() => publicComputer(value), { status: 502 });
});

test('read-only views require pairing and cannot start computers or use arbitrary query strings', async t => {
  const { bridge, token, session, calls } = await fixture(t);
  assert.equal((await request(bridge, '/v1/bots/bot_fixture/computer')).status, 401);
  const view = await request(bridge, '/v1/bots/bot_fixture/computer?chatId=s_fixture', { token });
  assert.equal(view.status, 200); assert.equal(view.json.image.data, png);
  assert.deepEqual(calls, [{ path: '/api/bots/bot_fixture/computer?chatId=s_fixture', method: 'GET', deviceId: session.id }]);
  for (const path of ['/v1/bots/bot_fixture/computer?include=secret', '/v1/bots/bot_fixture/computer?chatId=s_fixture&chatId=other', '/v1/bots/bot_fixture/computer/start?chatId=s_fixture']) assert.equal((await request(bridge, path, { token })).status, 404);
  assert.equal(calls.length, 1);
});

test('computer leases belong to one paired device, bot and frozen chat and release cannot resume bots', async t => {
  const { bridge, token, session, calls } = await fixture(t);
  await bridge.rotateInvitation();
  const other = bridge.authority.pair(bridge.authority.code, 'Other fixture iPhone');
  const base = '/v1/bots/bot_fixture/computer';
  const taken = await request(bridge, `${base}/takeover`, { token, method: 'POST', body: { chatId: 's_fixture' } });
  assert.equal(taken.status, 200);
  const control = { chatId: 's_fixture', leaseToken: taken.json.leaseToken, action: 'key', key: 'Enter' };
  assert.equal((await request(bridge, `${base}/control`, { token: other.token, method: 'POST', body: control })).status, 403);
  assert.equal((await request(bridge, `${base}/control`, { token, method: 'POST', body: { ...control, chatId: 's_other' } })).status, 403);
  assert.equal((await request(bridge, '/v1/bots/bot_other/computer/control', { token, method: 'POST', body: control })).status, 403);
  assert.equal((await request(bridge, `${base}/control`, { token, method: 'POST', body: control })).status, 200);
  assert.equal(calls.at(-1).deviceId, session.id);
  assert.equal((await request(bridge, `${base}/release`, { token, method: 'POST', body: { chatId: 's_fixture', leaseToken: taken.json.leaseToken } })).status, 200);
  assert.equal((await request(bridge, `${base}/control`, { token, method: 'POST', body: control })).status, 403);
  assert.deepEqual(calls.map(call => call.path), ['/api/bots/bot_fixture/computer/takeover', '/api/bots/bot_fixture/computer/control', '/api/bots/bot_fixture/computer/release']);
});

test('revocation during takeover releases the new host grant and never exports it', async t => {
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { resume = resolve; });
  const { bridge, token, session, calls } = await fixture(t, async path => { if (path.endsWith('/takeover')) { entered(); await blocked; return grant(); } return {}; });
  const taking = request(bridge, '/v1/bots/bot_fixture/computer/takeover', { token, method: 'POST', body: {} });
  await waiting; bridge.authority.revoke(session.id); resume();
  const result = await taking;
  assert.equal(result.status, 401); assert.ok(!result.text.includes(grant().leaseToken));
  assert.equal(calls.at(-1).path, '/api/bots/bot_fixture/computer/release'); assert.equal(calls.at(-1).deviceId, session.id);
});

test('unpair and bridge disable release owned leases; failures never expose raw diagnostics', async t => {
  const { bridge, token, calls } = await fixture(t);
  await request(bridge, '/v1/bots/bot_fixture/computer/takeover', { token, method: 'POST', body: {} });
  await request(bridge, '/v1/session', { token, method: 'DELETE' });
  assert.equal(calls.at(-1).path, '/api/bots/bot_fixture/computer/release');
  await bridge.rotateInvitation(); const second = bridge.authority.pair(bridge.authority.code, 'Second fixture iPhone');
  await request(bridge, '/v1/bots/bot_fixture/computer/takeover', { token: second.token, method: 'POST', body: {} });
  await bridge.close(); assert.equal(calls.at(-1).path, '/api/bots/bot_fixture/computer/release');
  const failing = await fixture(t, () => { throw Object.assign(new Error('PRIVATE-SDK-ERROR'), { status: 501 }); });
  const result = await request(failing.bridge, '/v1/bots/bot_fixture/computer', { token: failing.token });
  assert.equal(result.status, 501); assert.ok(!result.text.includes('PRIVATE-SDK-ERROR'));
});

test('avatar customization accepts legacy and character enum schemas while restricting appearance-only writes', async t => {
  const { bridge, token, calls } = await fixture(t, () => ({ saved: true }));
  const avatarConfig = { color: 'violet', eyes: 'happy', ears: 'small' };
  assert.equal((await request(bridge, '/v1/bots/bot_fixture/avatar', { token, method: 'POST', body: { avatarConfig } })).status, 200);
  assert.deepEqual(calls[0], { path: '/api/bots/bot_fixture', method: 'PATCH', body: { avatarConfig } });
  for (const kind of ['koala', 'fox', 'cat', 'robot']) {
    assert.equal((await request(bridge, '/v1/bots/bot_fixture/avatar', { token, method: 'POST', body: { avatarConfig: { ...avatarConfig, kind } } })).status, 200);
    assert.deepEqual(calls.at(-1).body.avatarConfig, { ...avatarConfig, kind });
  }
  for (const body of [{ avatarConfig: { ...avatarConfig, color: 'https://external' } }, { avatarConfig: { ...avatarConfig, credentials: 'secret' } }, { avatarConfig: { ...avatarConfig, kind: 'external' } }, { avatarConfig: { ...avatarConfig, kind: null } }, { avatarConfig, providerSettings: {} }]) {
    assert.equal((await request(bridge, '/v1/bots/bot_fixture/avatar', { token, method: 'POST', body })).status, 400);
  }
  assert.equal(calls.length, 5);
  const hostCalls = [];
  const host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { hostCalls.push({ url, ...options }); return new Response('{}'); } });
  await host.request('/api/bots/bot_fixture', { method: 'PATCH', body: { avatarConfig } });
  await assert.rejects(host.request('/api/bots/bot_fixture', { method: 'PATCH', body: { avatarConfig, policy: 'bypass' } }));
  assert.equal(hostCalls.length, 1);
});


test('accepted input renews only the bound lease expiry and prepared stopped computers retain running false', async t => {
  let time = Date.now();
  const { bridge, token, calls } = await fixture(t, path => {
    if (path.endsWith('/takeover')) return { ...grant(), expiresAt: time + 20_000 };
    if (path.endsWith('/control')) return { expiresAt: time + 60_000 };
    return { ...frame(), available: true, running: false, cleanupConfirmed: false, image: undefined };
  }, { now: () => time });
  const state = await request(bridge, '/v1/bots/bot_fixture/computer', { token });
  assert.equal(state.json.available, true); assert.equal(state.json.running, false); assert.equal(state.json.cleanupConfirmed, false);
  const taken = await request(bridge, '/v1/bots/bot_fixture/computer/takeover', { token, method: 'POST', body: {} });
  const input = { leaseToken: taken.json.leaseToken, action: 'key', key: 'Tab' };
  const first = await request(bridge, '/v1/bots/bot_fixture/computer/control', { token, method: 'POST', body: input });
  assert.equal(first.status, 200); assert.equal(first.json.expiresAt, time + 60_000);
  time += 30_000;
  assert.equal((await request(bridge, '/v1/bots/bot_fixture/computer/control', { token, method: 'POST', body: input })).status, 200);
  time += 61_000;
  const count = calls.length;
  assert.equal((await request(bridge, '/v1/bots/bot_fixture/computer/control', { token, method: 'POST', body: input })).status, 403);
  assert.equal(calls.length, count, 'expired leases cannot forward later input');
});

test('CUA new chats use the actual isolated workspace and catalog pause state remains public', async t => {
  const { bridge, token, calls } = await fixture(t, path => path === '/api/bots' ? {
    bots: [{ id: 'bot_fixture', name: 'Fixture', provider: 'codex', computerMode: 'cua', paused: true }], providers: [], computers: [], models: [],
  } : { conversation: { id: 's_fixture', title: 'Fixture', active: false, messages: [] }, pending: [] });
  const listed = await request(bridge, '/v1/bots', { token });
  assert.equal(listed.json.bots[0].paused, true);
  const wrong = await request(bridge, '/v1/bots/bot_fixture/conversations', { token, method: 'POST', body: { workspace: '/elsewhere' } });
  assert.equal(wrong.status, 400);
  assert.ok(!calls.some(call => call.path.endsWith('/conversations')));
  const correct = await request(bridge, '/v1/bots/bot_fixture/conversations', { token, method: 'POST', body: { workspace: '/workspace' } });
  assert.equal(correct.status, 201);
  assert.deepEqual(calls.at(-1).body, { workspace: '/workspace' });
});
