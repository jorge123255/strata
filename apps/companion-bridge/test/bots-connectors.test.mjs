import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, HostClient } from '../bridge.mjs';
import { publicBotWorkspace } from '../bots-workspace.mjs';

const features = { catalog: true, httpCreation: true, teamAccess: true, oauth: true };
const connection = { id: 'mcpc_fixture', name: 'Project service', transport: 'http', url: 'https://service.invalid/mcp', apiKey: 'PRIVATE-BEARER', apiKeySet: true, oauthClientId: 'PRIVATE-CLIENT', oauthClientSecret: 'PRIVATE-SECRET', oauthTokens: { access_token: 'PRIVATE-TOKEN' }, authType: 'oauth', botIds: [], teamIds: ['team_fixture'], inventoryDigest: 'a'.repeat(64), enabledToolIds: [], readOnlyToolIds: [], tools: [{ id: 'tool_read', name: 'read', inputSchema: { default: 'PRIVATE-SCHEMA' } }], auth: { status: 'waiting', detail: 'Finish sign-in on the Mac.', authorizationURL: 'https://accounts.invalid/authorize?state=fixture', redirectURL: 'http://127.0.0.1:40000/callback', codeVerifier: 'PRIVATE-VERIFIER', refresh_token: 'PRIVATE-REFRESH' } };
function request(bridge, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text), text }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t, { legacy = false, handler } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-connector-bridge-')), calls = [];
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options) {
    calls.push({ path, ...options });
    if (handler) { const value = await handler(path, options); if (value !== undefined) return value; }
    if (path === '/api/bots') return { bots: [{ id: 'bot_fixture' }] };
    if (path === '/api/bots/teams') return { teams: [{ id: 'team_fixture' }], runs: [] };
    if (path === '/api/bots/connectors/catalog') return { connectors: [{ id: 'custom-http', name: 'Custom', description: 'A synthetic connector', transport: 'http', authTypes: ['none', 'bearer', 'oauth'], apiKey: 'PRIVATE-CATALOG' }], connectorFeatures: features };
    if (path === '/api/bots/connections' && !options?.method) return { connections: [connection], ...(legacy ? {} : { connectorFeatures: features }) };
    if (path.startsWith('/api/bots/connections')) return { connection, auth: connection.auth };
    throw Object.assign(new Error('PRIVATE-UPSTREAM'), { status: 404 });
  } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, calls, ...bridge.authority.pair(bridge.authority.code, 'Connector fixture') };
}

test('paired connector catalog, HTTP creation and exact team grants never expose credentials or start work', async t => {
  const { bridge, token, calls } = await fixture(t);
  assert.equal((await request(bridge, '/v1/bots/connectors/catalog')).status, 401);
  const catalog = await request(bridge, '/v1/bots/connectors/catalog', { token });
  assert.equal(catalog.json.connectorFeatures.httpCreation, true);
  assert.equal(catalog.text.includes('PRIVATE'), false);
  const draft = { name: 'New connector', transport: 'http', catalogId: 'custom-http', url: 'https://service.invalid/mcp', authType: 'bearer', apiKey: 'SYNTHETIC-INPUT-SECRET', botIds: ['bot_fixture'], teamIds: ['team_fixture'], enabledToolIds: [] };
  const created = await request(bridge, '/v1/bots/connections', { token, method: 'POST', body: draft });
  assert.equal(created.status, 200); assert.equal(created.json.connection.url, draft.url);
  assert.deepEqual(created.json.connection.teamIds, ['team_fixture']);
  assert.equal(created.text.includes('PRIVATE'), false); assert.equal(created.text.includes(draft.apiKey), false);
  assert.deepEqual(calls.at(-1).body, draft);
  const edit = { teamIds: ['team_fixture'], botIds: [], customInstructions: 'Use only this project.', enabled: true, enabledToolIds: ['tool_read'], expectedInventoryDigest: connection.inventoryDigest };
  assert.equal((await request(bridge, `/v1/bots/connections/${connection.id}`, { token, method: 'PATCH', body: edit })).status, 200);
  assert.deepEqual(calls.at(-1).body, edit);
  const before = calls.filter(call => call.method === 'PATCH').length;
  for (const body of [{ ...edit, teamIds: ['missing'] }, { ...edit, expectedInventoryDigest: 'b'.repeat(64) }, { ...edit, readOnlyToolIds: ['tool_read'] }]) assert.equal((await request(bridge, `/v1/bots/connections/${connection.id}`, { token, method: 'PATCH', body })).status, 409);
  assert.equal(calls.filter(call => call.method === 'PATCH').length, before);
  assert.equal(calls.some(call => /messages|runs|native|serving/.test(call.path)), false);
});

test('phone OAuth operations retain only public status and require the current exact Mac callback', async t => {
  const { bridge, token, calls } = await fixture(t);
  const path = `/v1/bots/connections/${connection.id}/auth`;
  for (const method of ['GET', 'POST', 'DELETE']) {
    const result = await request(bridge, path, { token, method, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(result.status, 200); assert.equal(result.json.auth.status, 'waiting');
    assert.equal(result.json.auth.authorizationURL, connection.auth.authorizationURL);
    assert.equal(result.text.includes('PRIVATE'), false);
  }
  const callbackURL = `${connection.auth.redirectURL}?state=fixture&code=synthetic`;
  assert.equal((await request(bridge, `${path}/complete`, { token, method: 'POST', body: { callbackURL } })).status, 200);
  assert.deepEqual(calls.at(-1).body, { callbackURL });
  const mutations = calls.filter(call => call.method === 'POST').length;
  for (const callback of ['https://unrelated.invalid/callback?code=synthetic', 'http://127.0.0.1:40001/callback?code=synthetic', 'http://127.0.0.1:40000/other?code=synthetic']) assert.ok([400, 409].includes((await request(bridge, `${path}/complete`, { token, method: 'POST', body: { callbackURL: callback } })).status));
  assert.equal(calls.filter(call => call.method === 'POST').length, mutations);
});

test('older hosts cannot receive new connector setup or team grants', async t => {
  const { bridge, token, calls } = await fixture(t, { legacy: true });
  const draft = { name: 'New', transport: 'http', url: 'https://service.invalid/mcp' };
  assert.equal((await request(bridge, '/v1/bots/connections', { token, method: 'POST', body: draft })).status, 409);
  assert.equal((await request(bridge, `/v1/bots/connections/${connection.id}`, { token, method: 'PATCH', body: { teamIds: [], expectedInventoryDigest: connection.inventoryDigest } })).status, 409);
  assert.equal((await request(bridge, `/v1/bots/connections/${connection.id}/auth`, { token, method: 'POST', body: {} })).status, 409);
  assert.equal(calls.some(call => call.method === 'POST' || call.method === 'PATCH'), false);
});

test('HTTP setup edits use the editor revision and cannot overwrite a newer account setup', async t => {
  const { bridge, token, calls } = await fixture(t);
  const path = `/v1/bots/connections/${connection.id}`;
  const setup = { name: 'Updated service', transport: 'http', url: 'https://service.invalid/mcp', authType: 'bearer', apiKey: 'NEW-SYNTHETIC-KEY', expectedInventoryDigest: connection.inventoryDigest };
  const saved = await request(bridge, path, { token, method: 'PATCH', body: setup });
  assert.equal(saved.status, 200); assert.deepEqual(calls.at(-1).body, setup);
  assert.equal(saved.text.includes(setup.apiKey), false);
  const mutations = calls.filter(call => call.method === 'PATCH').length;
  const { expectedInventoryDigest, ...unreviewed } = setup;
  assert.equal((await request(bridge, path, { token, method: 'PATCH', body: unreviewed })).status, 400);
  assert.equal((await request(bridge, path, { token, method: 'PATCH', body: { ...setup, expectedInventoryDigest: 'b'.repeat(64) } })).status, 409);
  assert.equal(calls.filter(call => call.method === 'PATCH').length, mutations);
});

test('host admission and public projection exclude local programs, OAuth client secrets and hostile sign-in URLs', async () => {
  const calls = [], host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { calls.push({ url, options }); return new Response('{}'); } });
  for (const body of [{ name: 'X', transport: 'stdio', command: '/bin/sh' }, { name: 'X', transport: 'http', url: 'https://service.invalid/mcp', oauthClientSecret: 'SECRET' }, { name: 'X', transport: 'http', url: 'https://user:SECRET@service.invalid/mcp' }, { name: 'X', transport: 'http', url: 'https://service.invalid/mcp?token=SECRET' }]) await assert.rejects(host.request('/api/bots/connections', { method: 'POST', body }), { status: 403 });
  assert.equal(calls.length, 0);
  const projected = publicBotWorkspace({ connection: { ...connection, transport: 'stdio', command: '/PRIVATE/PROGRAM', auth: { ...connection.auth, authorizationURL: 'javascript:alert(1)', redirectURL: 'https://unrelated.invalid/callback' } } }, { kind: 'connectionAuth' });
  assert.equal(projected.connection.url, undefined); assert.equal(projected.connection.auth.authorizationURL, undefined); assert.equal(projected.connection.auth.redirectURL, undefined);
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
});

test('revoked pairing during connector lookup prevents OAuth initiation', async t => {
  let entered, release;
  const began = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const { bridge, token, session, calls } = await fixture(t, { handler: async path => { if (path === '/api/bots/connections') { entered(); await held; return { connections: [connection], connectorFeatures: features }; } } });
  const started = request(bridge, `/v1/bots/connections/${connection.id}/auth`, { token, method: 'POST', body: {} });
  await began; bridge.authority.revoke(session.id); release();
  assert.equal((await started).status, 401);
  assert.equal(calls.some(call => call.method === 'POST'), false);
});
