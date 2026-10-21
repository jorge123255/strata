import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companionSettings, companionSnapshot, createBotCompanionRoutes, createNativeBotCompanion } from '../server/bot-companion.mjs';
import { createBots } from '../server/bots.mjs';

const token = 'a'.repeat(64), screen = '12345678-ABCD-1234-ABCD-123456789012';
const avatar = { kind: 'fox', color: 'sky', eyes: 'round', ears: 'small' };
const profile = { id: 'bot_fixture', name: '👩‍💻 Pip', avatarConfig: avatar, providerSettings: { apiKey: 'PRIVATE-KEY' }, workspace: 'PRIVATE-FOLDER' };
const row = (id = 's_exact', patch = {}) => ({ id, botId: profile.id, name: profile.name, title: '👨‍👩‍👧‍👦 Browser research', state: 'approval', approvalCount: 1, updatedAt: new Date().toISOString(), ...patch });
const snapshot = (sessions = [row()]) => ({ supported: true, sessions, counts: { waiting: 1, working: 0, completed: 0, errors: 0 }, hasMore: false, updatedAt: new Date().toISOString() });
const status = () => ({ available: true, settings: { enabled: false, screen: 'main' }, screens: [{ id: screen, name: 'Studio Display' }], visible: false, expanded: false });

test('companion projection retains exact state, identity, joined emoji and saved face without private work data', () => {
  const source = snapshot([row('s_exact', { args: { key: 'PRIVATE-ARGS' }, transcript: 'PRIVATE-TRANSCRIPT', requestId: 'PRIVATE-REQUEST', computerName: 'Fixture Mac', toolName: 'browser_click' }), row('s_nonbot', { botId: 'Maya' })]);
  const before = structuredClone(source), result = companionSnapshot(source, [profile]);
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].id, 's_exact');
  assert.equal(result.sessions[0].name, profile.name); assert.equal(result.sessions[0].title, '👨‍👩‍👧‍👦 Browser research');
  assert.equal(result.sessions[0].state, 'approval'); assert.deepEqual(result.sessions[0].avatarConfig, avatar);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.deepEqual(source, before);
  assert.deepEqual(Object.keys(result.sessions[0]).sort(), ['id','botId','name','title','state','approvalCount','avatarConfig','computerName','toolName','updatedAt'].sort());
});

test('actual encoded feed stays within 8192 bytes and six rows even with worst-case escaped text', () => {
  const sessions = Array.from({ length: 200 }, (_, index) => row(`s_${index}`, { name: '👩‍💻'.repeat(120), title: '\\"'.repeat(300), toolName: '\\"'.repeat(120), computerName: '\\"'.repeat(120) }));
  const result = companionSnapshot(snapshot(sessions), [profile]);
  assert.ok(result.sessions.length > 0 && result.sessions.length <= 6); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.equal(result.hasMore, true);
  for (const item of result.sessions) { assert.ok(Buffer.byteLength(item.name) <= 64); assert.ok(Buffer.byteLength(item.title) <= 120); }
  const clean = companionSnapshot(snapshot([row('s_clean', { name: 'A\u0000\u0085B 👩‍💻', title: 'x\u009f y' })]), [profile]);
  assert.equal(clean.sessions[0].name, 'A  B 👩‍💻'); assert.equal(clean.sessions[0].title, 'x  y');
  const blank = companionSnapshot(snapshot([row('s_blank', { name: '\u0000\u0085 ', title: '\u0000 ', toolName: '\u0085', computerName: '\u0000' })]), [profile]).sessions[0];
  assert.equal(blank.name, profile.name); assert.equal(blank.title, 'Conversation');
  assert.equal(Object.hasOwn(blank, 'toolName'), false); assert.equal(Object.hasOwn(blank, 'computerName'), false);
  assert.equal(companionSnapshot(snapshot([row('s_blank', { name: '' })]), [{ ...profile, name: '' }]).sessions[0].name, 'Bot');
  assert.throws(() => companionSnapshot({ ...snapshot(), counts: { waiting: -1 } }, [profile]));
});

test('legacy default colors match the existing native/React Unicode scalar palette', () => {
  for (const name of ['Ada', '👩‍💻', 'Maya']) {
    const result = companionSnapshot(snapshot(), [{ ...profile, name, avatarConfig: undefined }]);
    const sum = Array.from(name).reduce((total, point) => total + point.codePointAt(0), 0);
    assert.equal(result.sessions[0].avatarConfig.color, ['violet','orange','sky','cloud','slate','graphite'][sum % 6]);
  }
});

test('settings take only explicit enable/display changes, with no actions, URLs or credentials', () => {
  assert.deepEqual(companionSettings({ enabled: false, screen }), { enabled: false, screen });
  assert.deepEqual(companionSettings({ screen: 'main' }), { screen: 'main' });
  for (const value of [{}, [], null, { enabled: 1 }, { screen: screen.toLowerCase() }, { enabled: true, approve: true }, { screen: 'https://other.invalid' }, { token }]) assert.throws(() => companionSettings(value), error => error.status === 400);
});

async function serve(t, bots, native, env = { STRATA_COMPANION_FEED_TOKEN: token }) {
  let port;
  const handler = createBotCompanionRoutes({ bots, port: () => port, native, env });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, `http://${req.headers.host}`)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${port}/api/bots/companion`;
}

test('native feed requires this launch credential and exact local read-only no-input shape', async t => {
  let reads = 0, settings = 0;
  const url = await serve(t, { supervision: () => { reads++; return snapshot(); }, supervisionProfiles: () => [profile], list: async () => { throw new Error('Never discover providers.'); } }, { status, settings: async () => { settings++; return status(); } });
  for (const value of [undefined, 'b'.repeat(64), 'ø'.repeat(64)]) assert.equal((await fetch(url + '/snapshot', { headers: value ? { 'x-strata-companion': value } : {} })).status, 401);
  assert.equal((await fetch(url + '/snapshot', { headers: { 'x-strata-companion': token, origin: 'https://foreign.invalid' } })).status, 403);
  const headers = { 'x-strata-companion': token };
  const response = await fetch(url + '/snapshot', { headers }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).sessions[0].name, profile.name); assert.equal(reads, 1);
  for (const method of ['POST','PATCH','DELETE']) assert.equal((await fetch(url + '/snapshot', { method, headers })).status, 405);
  assert.equal((await fetch(url + '/snapshot?approve=all', { headers })).status, 405);
  const request = await new Promise((resolve, reject) => {
    const value = http.request(url + '/snapshot', { method: 'GET', headers: { ...headers, 'content-length': 2 } }, response => { response.resume(); resolve(response.statusCode); });
    value.on('error', reject); value.end('{}');
  });
  assert.equal(request, 405); assert.equal(reads, 1); assert.equal(settings, 0);
  assert.equal((await fetch(url)).status, 200);
  for (const body of [{ approve: true }, { screen: 'http://example.test' }, { enabled: 'yes' }, { enabled: false, extra: 'x'.repeat(1100) }]) assert.equal((await fetch(url + '/settings', { method: 'POST', body: JSON.stringify(body) })).status, 400);
  assert.equal((await fetch(url + '/settings', { method: 'POST', headers: { origin: 'https://foreign.invalid' }, body: '{"enabled":true}' })).status, 403);
  assert.equal(settings, 0);
  assert.equal((await fetch(url + '/settings', { method: 'POST', body: '{"enabled":false}' })).status, 200); assert.equal(settings, 1);
});

test('actual bot service accessor is synchronous and feed never calls list/provider/account discovery or modifies files', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-companion-native-')); let providerCalls = 0, listCalls = 0, sources = [];
  const conversations = { list: () => ({ conversations: [] }), supervisionSources: () => sources };
  const bots = createBots({ directory, conversations: () => conversations, defaultWorkspace: () => directory,
    runtime: { async providers() { providerCalls++; throw new Error('No account checks.'); }, async run() { throw new Error('No execution.'); }, close() {} },
    tools: { definitions: () => [], execute() { throw new Error('No tools.'); }, close() {} } });
  t.after(async () => { await bots.close(); rmSync(directory, { recursive: true, force: true }); });
  const bot = bots.create({ name: profile.name, provider: 'codex', workspace: directory, avatarConfig: avatar }).bot;
  sources = [{ id: 's_real', title: 'Existing work', active: true, updatedAt: new Date().toISOString(), preferences: { botId: bot.id }, messages: [] }];
  bots.list = async () => { listCalls++; throw new Error('Never read full profiles or discover providers.'); };
  const before = readFileSync(join(directory, 'bots.json'), 'utf8');
  const profiles = bots.supervisionProfiles(); assert.equal(typeof profiles.then, 'undefined');
  assert.deepEqual(profiles, [{ id: bot.id, name: profile.name, avatarConfig: avatar }]); profiles[0].avatarConfig.color = 'orange';
  assert.equal(bots.supervisionProfiles()[0].avatarConfig.color, 'sky');
  const url = await serve(t, bots, { status }); const response = await fetch(url + '/snapshot', { headers: { 'x-strata-companion': token } });
  assert.equal(response.status, 200); assert.equal((await response.json()).sessions[0].state, 'thinking');
  assert.equal(providerCalls, 0); assert.equal(listCalls, 0); assert.equal(readFileSync(join(directory, 'bots.json'), 'utf8'), before);
});

test('native status proxy never follows redirects or reveals unknown fields/bridge secrets', async () => {
  const calls = [], env = { STRATA_SHELL_BRIDGE: 'http://127.0.0.1:12345', STRATA_SHELL_TOKEN: token };
  const client = createNativeBotCompanion({ env, fetcher: async (url, options) => { calls.push({ url, options }); return Response.json({ ...status(), token: 'PRIVATE', path: 'PRIVATE' }); } });
  const output = await client.status(); assert.equal(output.available, true); assert.equal(JSON.stringify(output).includes('PRIVATE'), false);
  await client.settings({ enabled: true });
  assert.deepEqual(calls.map(row => [row.url, row.options.method, row.options.redirect]), [['http://127.0.0.1:12345/companion/status','GET','error'],['http://127.0.0.1:12345/companion/settings','POST','error']]);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`); assert.equal(JSON.stringify(output).includes(token), false);
  for (const base of ['https://other.invalid', 'http://127.0.0.1:99999', 'http://127.0.0.1:12/else', 'http://user@127.0.0.1:12']) {
    let fetched = false; const bad = createNativeBotCompanion({ env: { ...env, STRATA_SHELL_BRIDGE: base }, fetcher: () => { fetched = true; throw new Error(); } });
    assert.equal((await bad.status()).available, false); assert.equal(fetched, false);
  }
});

test('native status stream is cancelled on declared or streamed overrun and never echoes upstream errors', async () => {
  const env = { STRATA_SHELL_BRIDGE: 'http://127.0.0.1:12345', STRATA_SHELL_TOKEN: token };
  for (const declared of [false, true]) {
    let cancelled = false;
    const client = createNativeBotCompanion({ env, fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20000)); }, cancel() { cancelled = true; } }), { headers: declared ? { 'content-length': '20000' } : {} }) });
    const result = await client.status(); assert.equal(result.available, false); assert.equal(cancelled, true);
  }
  const client = createNativeBotCompanion({ env, fetcher: async () => { throw new Error('PRIVATE-KEY-IN-UPSTREAM-ERROR'); } });
  assert.equal(JSON.stringify(await client.status()).includes('PRIVATE'), false);
});
