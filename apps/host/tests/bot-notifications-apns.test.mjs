import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApnsSender, notificationPayload, postApns, APNS_TOPIC } from '../server/bot-notifications-apns.mjs';
import { createNativeNotifications } from '../server/bot-notifications-native.mjs';
const event = { id: 'nt_fixture', kind: 'approval', title: 'Approval needed', body: 'Open Strata to review it.', destination: { type: 'chat', id: 's_fixture' }, private: 'PRIVATE_TOOL_ARGUMENTS' };
const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const env = { STRATA_APNS_TEAM_ID: 'TEAM123456', STRATA_APNS_KEY_ID: 'KEY1234567', STRATA_APNS_KEY_PATH: '/fixture-only-provider-key' };
const readKey = () => keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });

test('provider config is explicit, missing/bad keys stay disabled without exposing key paths or material', () => {
  assert.equal(createApnsSender({ env: {} }).status().configured, false);
  const bad = createApnsSender({ env, readKey: () => { throw Error('PRIVATE_KEY_CONTENT_AND_PATH'); } }).status(); assert.equal(bad.configured, false); assert.ok(!JSON.stringify(bad).includes('PRIVATE_'));
});
test('Finder-launched provider accepts only bounded private configuration exact keys and absolute external key path', t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-apns-config-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'apns-provider.json');
  writeFileSync(file, JSON.stringify({ teamId: env.STRATA_APNS_TEAM_ID, keyId: env.STRATA_APNS_KEY_ID, keyPath: env.STRATA_APNS_KEY_PATH }), { mode: 0o600 });
  assert.equal(createApnsSender({ directory, env: {}, readKey }).status().configured, true);
  for (const value of [{ teamId: 'TEAM123456', keyId: 'KEY1234567', keyPath: '/fixture', topic: 'wrong.topic' }, { teamId: 'TEAM123456', keyId: 'KEY1234567', keyPath: 'relative.p8' }]) { writeFileSync(file, JSON.stringify(value)); assert.equal(createApnsSender({ directory, env: {}, readKey }).status().configured, false); }
  writeFileSync(file, ' '.repeat(5000)); assert.equal(createApnsSender({ directory, env: {}, readKey }).status().configured, false);
});
test('APNs uses exact Apple origin/topic, ES256 P1363, safe generic envelope, journal identity and stable collapse', async () => {
  const calls = []; const sender = createApnsSender({ env, readKey, now: () => 1800000000000, post: async (...args) => { calls.push(args); return { status: 200, body: '' }; } });
  const registration = { token: 'a'.repeat(64), environment: 'sandbox' };
  assert.equal((await sender.send(registration, event, 'nj_fixture', false)).ok, true); await sender.send({ ...registration, environment: 'production' }, event, 'nj_fixture', true);
  assert.equal(calls[0][0], 'https://api.sandbox.push.apple.com'); assert.equal(calls[1][0], 'https://api.push.apple.com');
  assert.equal(calls[0][2]['apns-topic'], APNS_TOPIC); assert.equal(calls[0][2]['apns-collapse-id'], calls[1][2]['apns-collapse-id']);
  const token = calls[0][2].authorization.slice(7), parts = token.split('.'); assert.equal(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: keyPair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), true);
  const payload = JSON.parse(calls[0][3]); assert.equal(payload.journalId, 'nj_fixture'); assert.equal(payload.eventId, event.id); assert.deepEqual(payload.destination, event.destination); assert.equal(payload.aps.sound, undefined); assert.ok(!JSON.stringify(payload).includes('PRIVATE_'));
});
test('APNs rejects invalid origins/tokens and prunes 410/invalid topic tokens without returning server bodies', async () => {
  const sender = createApnsSender({ env, readKey, post: async () => ({ status: 410, body: '{"reason":"Unregistered","secret":"PRIVATE_RESPONSE"}' }) });
  await assert.rejects(sender.send({ token: 'x', environment: 'https://evil.invalid' }, event, 'nj_fixture'), /Invalid Apple/);
  assert.deepEqual(await sender.send({ token: 'a'.repeat(64), environment: 'sandbox' }, event, 'nj_fixture'), { ok: false, invalidToken: true, status: 410 });
});
test('authority is rechecked after provider preparation before any network request', async () => {
  let posts = 0; const sender = createApnsSender({ env, readKey, post: async () => { posts++; return { status: 200, body: '' }; } });
  assert.equal((await sender.send({ token: 'a'.repeat(64), environment: 'sandbox' }, event, 'nj_fixture', false, () => false)).ok, false); assert.equal(posts, 0);
});
test('bounded HTTP/2 timeout destroys a stalled private transport without live Apple contact', async () => {
  let destroyed = false;
  const session = new EventEmitter(); session.destroy = () => { destroyed = true; }; session.request = () => { const req = new EventEmitter(); req.setEncoding = () => {}; req.end = () => {}; return req; };
  await assert.rejects(postApns('https://api.sandbox.push.apple.com', '/fixture', {}, Buffer.from('{}'), { timeoutMs: 10, connectClient: () => session }), /timed out/); assert.equal(destroyed, true);
});
test('native adapter authenticates only fixed loopback shell bridge and preserves handled suppression', async () => {
  let call; const adapter = createNativeNotifications({ env: { STRATA_SHELL_BRIDGE: 'http://127.0.0.1:12345', STRATA_SHELL_TOKEN: 'x'.repeat(32) }, fetcher: async (url, options) => { call = { url, options }; return { ok: true, json: async () => ({ delivered: false, handled: true }) }; } });
  assert.equal((await adapter.deliver({ id: event.id })).handled, true); assert.equal(call.url, 'http://127.0.0.1:12345/notifications/deliver'); assert.equal(call.options.headers.authorization, `Bearer ${'x'.repeat(32)}`);
  assert.throws(() => adapter.setBridge({ url: 'https://evil.invalid', token: 'x'.repeat(32) }), /Invalid native/);
  assert.equal(notificationPayload(event, 'nj_fixture').aps.category, 'STRATA_BOT_UPDATE');
});
