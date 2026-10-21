import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, HostClient } from '../bridge.mjs';
import { notificationRequest, notificationResponse } from '../notifications.mjs';
import { createBotNotifications, createBotNotificationRoutes } from '../../host/server/bot-notifications.mjs';

const owner = 'a'.repeat(32);
test('bridge request allowlist rejects foreign scope, arbitrary routes, duplicated query and push topic control', () => {
  assert.equal(notificationRequest('/api/bots/notifications?after=2&journalId=nj_test', 'GET', undefined, owner).action, undefined);
  for (const [path, method, body, device] of [
    ['/api/bots/notifications', 'GET', undefined, 'foreign'],
    ['/api/bots/notifications?after=2&after=3', 'GET', undefined, owner],
    ['/api/bots/notifications?clientId=other', 'GET', undefined, owner],
    ['/api/bots/notifications/settings', 'POST', { enabled: true, clientId: 'foreign' }, owner],
    ['/api/bots/notifications/registration', 'POST', { token: 'a'.repeat(64), environment: 'sandbox', topic: 'other.app' }, owner],
    ['/api/bots/notifications/registration', 'DELETE', { deviceId: 'foreign' }, owner],
  ]) assert.throws(() => notificationRequest(path, method, body, device));
  assert.equal(notificationRequest('/api/bots/notifications/deliver', 'POST', {}, owner), null);
});

test('wire projector strips registration bytes, private fields, desktop capability and internal team mute identity', () => {
  const value = { supported: true, journalId: 'nj_test', cursor: 1, nextCursor: 1, hasMore: false, settings: { enabled: true, replies: true, teams: true, work: true, approvals: true, previews: false, sound: true, muted: [], private: 'PRIVATE_SETTINGS' }, push: { configured: false, registered: false, detail: 'Not configured', token: 'PRIVATE_DEVICE_TOKEN' }, desktop: { secret: 'PRIVATE_SHELL' }, events: [{ id: 'nt_event', sequence: 1, kind: 'approval', createdAt: '2026-10-21T10:00:00.000Z', title: 'Approval needed', body: 'Open Strata to review the action.', destination: { type: 'chat', id: 's_private_worker', token: 'PRIVATE_DESTINATION' }, teamId: 'PRIVATE_TEAM_LINK', args: { key: 'PRIVATE_ARGUMENTS' }, reasoning: 'PRIVATE_THINKING' }] };
  assert.ok(!JSON.stringify(notificationResponse(value)).includes('PRIVATE_'));
  assert.deepEqual(notificationResponse({ registered: true, configured: false, detail: 'Not configured', token: 'PRIVATE_REGISTRATION' }, true), { registered: true, configured: false, detail: 'Not configured' });
  assert.throws(() => notificationResponse({ ...value, nextCursor: 0 }), /cursor/);
});

test('actual pinned TLS bridge enforces authentication, trusted device scope, private feed and immediate revocation', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-notifications-wire-')), stateDir = join(directory, 'owner'), pairDir = join(directory, 'pair'); mkdirSync(stateDir);
  let bridge, server, notifications, port, reads = 0;
  const snapshot = { conversations: [{ id: 's_actual', createdAt: '2026-10-20T01:00:00.000Z', messages: [] }], teams: [], approvals: [] };
  notifications = createBotNotifications({ directory: stateDir, start: false, sources: () => structuredClone(snapshot), native: { status: async () => ({ available: false, authorization: 'unavailable', detail: 'Fixture' }) }, apns: { status: () => ({ configured: false, detail: 'No Apple transport in fixture' }) } });
  const route = createBotNotificationRoutes({ notifications, port: () => port });
  server = http.createServer((req, res) => { reads++; void route(req, res, new URL(req.url, `http://${req.headers.host}`)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  bridge = await createBridge({ directory: pairDir, host: new HostClient({ upstream: `http://127.0.0.1:${port}` }), listen: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, adminPort: 0, qr: false });
  t.after(async () => { notifications.close(); await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const ca = readFileSync(join(pairDir, 'server-cert.pem'));
  const request = (path, token, method = 'GET', body) => new Promise((resolve, reject) => { const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, ca, agent: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, response => { let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text), text })); }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined); });
  assert.equal((await request('/v1/notifications')).status, 401); assert.equal(reads, 0);
  const first = bridge.authority.pair(bridge.authority.code, 'First fixture phone'); bridge.authority.rotate(); const second = bridge.authority.pair(bridge.authority.code, 'Second fixture phone');
  assert.equal((await request('/v1/notifications/settings', first.token, 'POST', { enabled: true })).status, 200);
  const baseline = (await request('/v1/notifications', first.token)).body;
  snapshot.conversations[0].messages.push({ id: 'm_actual', role: 'assistant', streaming: false, hasContent: true, content: 'PRIVATE_PROMPT_KEY_PATH', reasoning: 'PRIVATE_THINKING' });
  const query = `/v1/notifications?after=${baseline.nextCursor}&journalId=${baseline.journalId}`;
  const result = await request(query, first.token); assert.equal(result.status, 200); assert.equal(result.body.events.length, 1); assert.equal(result.body.events[0].destination.id, 's_actual'); assert.ok(!result.text.includes('PRIVATE_')); assert.equal(result.body.desktop, undefined);
  assert.equal((await request(query, second.token)).body.events.length, 0);
  const registration = await request('/v1/notifications/registration', first.token, 'POST', { token: 'd'.repeat(64), environment: 'sandbox' }); assert.equal(registration.status, 200); assert.equal(registration.body.registered, true); assert.ok(!registration.text.includes('d'.repeat(64)));
  assert.equal((await request('/v1/notifications/settings', first.token, 'POST', { enabled: true, clientId: second.session.id })).status, 400);
  assert.equal((await request('/v1/notifications/permission', first.token, 'POST', {})).status, 404);
  assert.equal((await request('/v1/session', first.token, 'DELETE')).status, 200);
  assert.equal((await request(query, first.token)).status, 401);
  assert.equal((await notifications.feed(first.session.id)).push.registered, false);
});
