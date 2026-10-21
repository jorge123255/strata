import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBotMcp } from '../server/bots-mcp.mjs';
import { botConnectorFetch, createBotConnectorAuth, openConnectorBrowser, registeredConnectorCallback } from '../server/bots-connector-auth.mjs';

const botId = 'bot_fixture', teamId = 'team_fixture', runId = 'run_fixture';
const url = path => new URL(`http://127.0.0.1${path}`);
const unpack = result => JSON.parse(result.content[0].text);
function directory(t) { const result = mkdtempSync(join(tmpdir(), 'strata-connectors-')); t.after(() => rmSync(result, { recursive: true, force: true })); return result; }
function service(t, options = {}) { const result = createBotMcp({ directory: directory(t), hasBot: id => id === botId, hasTeam: id => id === teamId, ...options }); t.after(() => result.close()); return result; }
const latest = (mcp, id) => mcp.list().connections.find(connection => connection.id === id);
const update = (mcp, id, input) => mcp.update(id, { ...input, expectedInventoryDigest: latest(mcp, id).inventoryDigest }).connection;
function context(mcp, changes = {}) { const bot = { id: botId, policy: 'manual', ...changes }; bot.extensionSnapshots = { mcp: mcp.snapshot(bot) }; return { bot, chatId: 'chat_fixture', turnId: 'turn_fixture', signal: new AbortController().signal, assertLive() {}, requestPermission: async () => true }; }
const inert = async () => ({ listTools: async () => ({ tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] }), callTool: async () => ({ content: [{ type: 'text', text: 'FIXTURE' }] }), close: async () => {} });

async function oauthFixture(t, behavior = {}) {
  const seen = [], expected = {}, tokenRequests = [], messages = [];
  let origin, rejectOldAccess = false;
  const server = createServer(async (req, res) => {
    const target = new URL(req.url, origin);
    const body = []; for await (const chunk of req) body.push(chunk);
    const raw = Buffer.concat(body).toString('utf8');
    seen.push({ path: target.pathname, method: req.method, authorization: req.headers.authorization });
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (target.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      if (behavior.metadataRedirect) { res.writeHead(302, { location: behavior.metadataRedirect }); res.end(); return; }
      if (behavior.noResourceMetadata) { res.writeHead(404); res.end(); return; }
      send({ resource: behavior.resource || `${origin}/mcp`, authorization_servers: [origin] }); return;
    }
    if (target.pathname === '/.well-known/oauth-authorization-server') { send({ issuer: behavior.issuer || origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: behavior.tokenEndpoint || `${origin}/token`, ...(!behavior.staticClient ? { registration_endpoint: `${origin}/register` } : {}), response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: behavior.staticClient ? ['client_secret_post'] : ['none'], code_challenge_methods_supported: ['S256'] }); return; }
    if (target.pathname === '/register') { const metadata = JSON.parse(raw); expected.redirect = metadata.redirect_uris[0]; send({ ...metadata, client_id: 'fixture-client' }, 201); return; }
    if (target.pathname === '/token') {
      const params = new URLSearchParams(raw); tokenRequests.push(Object.fromEntries(params));
      if (behavior.staticClient) { assert.equal(params.get('client_id'), 'fixture-static-client'); assert.equal(params.get('client_secret'), 'PRIVATE_STATIC_CLIENT_SECRET'); }
      if (behavior.tokenError) { send({ error: 'invalid_grant', error_description: 'PRIVATE_TOKEN_ERROR_SENTINEL' }, 400); return; }
      assert.equal(params.get('resource'), `${origin}/mcp`);
      if (params.get('grant_type') === 'authorization_code') { assert.equal(params.get('code'), 'fixture-code'); assert.equal(params.get('redirect_uri'), expected.redirect); assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), expected.challenge); }
      else { assert.equal(params.get('grant_type'), 'refresh_token'); assert.equal(params.get('refresh_token'), 'PRIVATE_REFRESH_TOKEN_SENTINEL'); }
      if (behavior.beforeToken) await behavior.beforeToken(params);
      send({ access_token: params.get('grant_type') === 'refresh_token' ? 'PRIVATE_REFRESHED_ACCESS_SENTINEL' : 'PRIVATE_ACCESS_TOKEN_SENTINEL', refresh_token: 'PRIVATE_REFRESH_TOKEN_SENTINEL', token_type: 'Bearer', expires_in: 3600 }); return;
    }
    if (target.pathname === '/mcp') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      if (!req.headers.authorization || rejectOldAccess && req.headers.authorization === 'Bearer PRIVATE_ACCESS_TOKEN_SENTINEL') { res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }); res.end(); return; }
      const message = JSON.parse(raw); messages.push(message.method);
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      const echoed = `${req.headers.authorization} PRIVATE_ACCESS_TOKEN_SENTINEL PRIVATE_REFRESH_TOKEN_SENTINEL`;
      const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1' } } : message.method === 'tools/list' ? { tools: [{ name: 'fixture_read', ...(behavior.echoCredentials ? { description: echoed } : {}), inputSchema: { type: 'object', ...(behavior.echoCredentials ? { description: echoed } : {}) } }] } : behavior.echoCredentials ? { content: [{ type: 'text', text: echoed }], structuredContent: { nested: [echoed, { PRIVATE_REFRESH_TOKEN_SENTINEL: echoed }], count: 3, enabled: true }, isError: true } : { content: [{ type: 'text', text: 'OAUTH_FIXTURE_OK' }] };
      send({ jsonrpc: '2.0', id: message.id, result }); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { origin, url: `${origin}/mcp`, seen, tokenRequests, messages, expected, rejectOld() { rejectOldAccess = true; } };
}
async function begin(mcp, fixture, id) { const started = await mcp.handle('POST', url(`/api/bots/connections/${id}/auth`), {}); const authorization = new URL(started.auth.authorizationURL); fixture.expected.challenge = authorization.searchParams.get('code_challenge'); fixture.expected.redirect ||= started.auth.redirectURL; return { started, authorization, callback: `${started.auth.redirectURL}?state=${authorization.searchParams.get('state')}&code=fixture-code` }; }
const finish = (mcp, id, callbackURL) => mcp.handle('POST', url(`/api/bots/connections/${id}/auth/complete`), { callbackURL });

test('registered OAuth clients use their supplied credentials without registration and retain SDK PKCE, audience and refresh', async t => {
  assert.equal(registeredConnectorCallback, 'http://127.0.0.1:47841/callback');
  const fixture = await oauthFixture(t, { staticClient: true });
  const mcp = service(t, { authOptions: { registeredCallbackPort: 0 } });
  const c = mcp.create({ name: 'Registered account', transport: 'http', url: fixture.url, authType: 'oauth', oauthClientId: 'fixture-static-client', oauthClientSecret: 'PRIVATE_STATIC_CLIENT_SECRET' }).connection;
  const flow = await begin(mcp, fixture, c.id);
  assert.equal(flow.authorization.searchParams.get('client_id'), 'fixture-static-client');
  assert.equal(flow.authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.authorization.searchParams.get('resource'), fixture.url);
  assert.equal(fixture.seen.some(request => request.path === '/register'), false);
  assert.equal((await finish(mcp, c.id, flow.callback)).auth.status, 'connected');
  await mcp.check(c.id); fixture.rejectOld(); await mcp.check(c.id);
  assert.equal(fixture.tokenRequests.at(-1).grant_type, 'refresh_token');
  assert.equal(JSON.stringify(mcp.list()).includes('PRIVATE_STATIC_CLIENT_SECRET'), false);
});

test('Google Workspace authorization requests consent and offline access only for its exact supported service hosts', async t => {
  // Network-free provider contract test; the real SDK static-client exchange is covered above.
  for (const [host, offline] of [['gmailmcp.googleapis.com', true], ['calendarmcp.googleapis.com', true], ['drivemcp.googleapis.com', true], ['gmailmcp.googleapis.com.attacker.invalid', false], ['other.invalid', false]]) {
    const c = { id: 'mcpc_fixture', enabled: true, transport: 'http', url: `https://${host}/mcp/v1`, authType: 'oauth', oauthClientId: 'fixture-static-client' };
    const auth = createBotConnectorAuth({ directory: directory(t), connectionFor: () => c, registeredCallbackPort: 0,
      fetchImpl: () => assert.fail('No network request is allowed in this contract test'),
      discoverResource: async () => ({ authorization_servers: ['https://accounts.invalid'] }),
      authorize: async provider => {
        provider.saveCodeVerifier('v'.repeat(64));
        const target = new URL('https://accounts.invalid/authorize');
        for (const [key, value] of Object.entries({ state: provider.state(), redirect_uri: provider.redirectUrl, code_challenge_method: 'S256', code_challenge: 'fixture-protected-challenge' })) target.searchParams.set(key, value);
        provider.redirectToAuthorization(target); return 'REDIRECT';
      } });
    t.after(() => auth.close());
    const started = await auth.start(c), target = new URL(started.auth.authorizationURL);
    assert.equal(target.searchParams.get('access_type'), offline ? 'offline' : null);
    assert.equal(target.searchParams.get('prompt'), offline ? 'consent' : null);
    auth.close();
  }
});

test('catalog presets are inert, official, feature-gated and never enable or connect tools', t => {
  let clients = 0;
  const mcp = service(t, { clientFactory: async () => { clients++; return inert(); } });
  const catalog = mcp.handle('GET', url('/api/bots/connectors/catalog'), {});
  assert.deepEqual(catalog.connectorFeatures, { catalog: true, httpCreation: true, teamAccess: true, oauth: true, iphoneOAuth: true });
  assert.ok(catalog.connectors.some(c => c.id === 'github' && c.url === 'https://api.githubcopilot.com/mcp/'));
  assert.ok(catalog.connectors.some(c => c.id === 'linear' && c.authTypes.includes('oauth')));
  const created = mcp.create({ catalogId: 'github', apiKey: 'PRIVATE_BEARER_SENTINEL', accountLabel: 'Work', botIds: [botId], teamIds: [teamId] }).connection;
  assert.equal(created.transport, 'http'); assert.equal(created.authType, 'bearer'); assert.equal(created.accountLabel, 'Work'); assert.deepEqual(created.teamIds, [teamId]); assert.deepEqual(created.enabledToolIds, []); assert.equal(clients, 0);
  assert.throws(() => mcp.create({ catalogId: 'github', transport: 'stdio', command: 'ignored' }), /server URL/);
  assert.throws(() => mcp.create({ catalogId: 'github', url: 'https://other.invalid/mcp' }), /official URL/);
  assert.throws(() => mcp.create({ catalogId: 'slack', authType: 'oauth' }), /sign-in method/);
  assert.throws(() => mcp.create({ catalogId: 'nonexistent' }), /current catalog/);
  assert.throws(() => mcp.create({ catalogId: 'linear', teamIds: ['team_absent'] }), /still exist/);
  assert.equal(JSON.stringify(mcp.list()).includes('PRIVATE_BEARER_SENTINEL'), false);
});

test('setup-only directory services cannot create runnable accounts and registered services require explicit Mac setup', async t => {
  const mcp = service(t), catalog = mcp.handle('GET', url('/api/bots/connectors/catalog'), {}).connectors;
  for (const preset of catalog.filter(entry => entry.setupState === 'managed' || entry.setupState === 'unavailable' || entry.setupState === 'configuration' && !entry.url)) {
    assert.throws(() => mcp.create({ catalogId: preset.id, url: 'https://invented.invalid/mcp', authType: 'none' }), { status: 409 }, preset.name);
  }
  const gmail = catalog.find(entry => entry.name === 'Gmail');
  assert.equal(gmail.setupState, 'configuration'); assert.equal(gmail.phoneSignIn, false);
  const c = mcp.create({ catalogId: gmail.id }).connection;
  assert.deepEqual(c.botIds, []); assert.deepEqual(c.teamIds, []); assert.deepEqual(c.enabledToolIds, []);
  assert.throws(() => mcp.handle('POST', url(`/api/bots/connections/${c.id}/auth`), {}), { status: 409 });
  assert.throws(() => mcp.handle('POST', url(`/api/bots/connections/${c.id}/auth`), { callbackTarget: 'iphone' }, { deviceId: 'a'.repeat(32) }), { status: 409 });
  const revised = update(mcp, c.id, { enabled: false }); assert.equal(revised.enabled, false);
});

test('iPhone browser sign-in binds the fixed native callback, PKCE and completion to its initiating paired device', async t => {
  const fixture = await oauthFixture(t), mcp = service(t);
  const c = mcp.create({ name: 'Phone account', transport: 'http', url: fixture.url, authType: 'oauth' }).connection;
  const path = url(`/api/bots/connections/${c.id}/auth`), deviceId = 'a'.repeat(32);
  await assert.rejects(mcp.handle('POST', path, { callbackTarget: 'iphone' }), { status: 403 });
  await assert.rejects(mcp.handle('POST', path, { callbackTarget: 'https://other.invalid/callback' }, { deviceId }), { status: 400 });
  assert.equal(fixture.seen.length, 0);
  const started = await mcp.handle('POST', path, { callbackTarget: 'iphone' }, { deviceId });
  assert.equal(started.auth.callbackTarget, 'iphone'); assert.equal(started.auth.redirectURL, 'strata://connector-oauth/callback');
  const authorization = new URL(started.auth.authorizationURL);
  fixture.expected.challenge = authorization.searchParams.get('code_challenge');
  const callbackURL = `${started.auth.redirectURL}?state=${authorization.searchParams.get('state')}&code=fixture-code`;
  for (const options of [{}, { deviceId: 'b'.repeat(32) }]) await assert.rejects(mcp.handle('POST', url(path.pathname + '/complete'), { callbackURL }, options), { status: 403 });
  for (const bad of [callbackURL.replace('strata:', 'other:'), callbackURL.replace('connector-oauth', 'other'), callbackURL.replace('/callback?', '/other?'), callbackURL.replace('/callback?', ':42/callback?'), callbackURL + '#fragment', callbackURL + '&state=extra']) await assert.rejects(mcp.handle('POST', url(path.pathname + '/complete'), { callbackURL: bad }, { deviceId }), { status: 400 });
  assert.equal(fixture.tokenRequests.length, 0);
  const finished = await mcp.handle('POST', url(path.pathname + '/complete'), { callbackURL }, { deviceId });
  assert.equal(finished.auth.status, 'connected'); assert.equal(fixture.tokenRequests.length, 1);
  assert.deepEqual(finished.connection.botIds, []); assert.deepEqual(finished.connection.teamIds, []); assert.deepEqual(finished.connection.enabledToolIds, []);
  assert.ok(!JSON.stringify(finished).includes('PRIVATE_')); assert.ok(!JSON.stringify(finished).includes(deviceId));
  await assert.rejects(mcp.handle('POST', url(path.pathname + '/complete'), { callbackURL }, { deviceId }), { status: 409 });
  const checked = await mcp.check(c.id); assert.equal(checked.connection.status, 'connected');
  fixture.rejectOld(); await mcp.check(c.id); assert.equal(fixture.tokenRequests.at(-1).grant_type, 'refresh_token');
});

test('cancelled or expired native sign-ins cannot later exchange a code; Mac sign-in stays a loopback flow', async t => {
  let now = Date.now(); const fixture = await oauthFixture(t), mcp = service(t, { authOptions: { now: () => now } });
  const c = mcp.create({ name: 'Native lifetime', transport: 'http', url: fixture.url, authType: 'oauth' }).connection;
  const path = url(`/api/bots/connections/${c.id}/auth`), options = { deviceId: 'a'.repeat(32) };
  let started = await mcp.handle('POST', path, { callbackTarget: 'iphone' }, options);
  let callbackURL = `${started.auth.redirectURL}?state=${new URL(started.auth.authorizationURL).searchParams.get('state')}&code=fixture-code`;
  mcp.handle('DELETE', path, {}); await assert.rejects(mcp.handle('POST', url(path.pathname + '/complete'), { callbackURL }, options), { status: 409 });
  started = await mcp.handle('POST', path, { callbackTarget: 'iphone' }, options);
  callbackURL = `${started.auth.redirectURL}?state=${new URL(started.auth.authorizationURL).searchParams.get('state')}&code=fixture-code`;
  now += 11 * 60 * 1000;
  await assert.rejects(mcp.handle('POST', url(path.pathname + '/complete'), { callbackURL }, options), { status: 409 });
  assert.equal(fixture.tokenRequests.length, 0);
  started = await mcp.handle('POST', path, {});
  assert.equal(started.auth.callbackTarget, 'mac'); assert.match(started.auth.redirectURL, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
});

test('pending sign-in cancellation is device- and state-bound and never deletes a connected account', async t => {
  const fixture = await oauthFixture(t), dir = directory(t), mcp = service(t, { directory: dir }), options = { deviceId: 'a'.repeat(32) };
  const c = mcp.create({ name: 'Cancel', transport: 'http', url: fixture.url, authType: 'oauth' }).connection;
  const path = url(`/api/bots/connections/${c.id}/auth`), cancel = url(path.pathname + '/cancel');
  const native = await mcp.handle('POST', path, { callbackTarget: 'iphone' }, options);
  const body = { expectedState: new URL(native.auth.authorizationURL).searchParams.get('state') };
  assert.throws(() => mcp.handle('POST', cancel, {}, options), { status: 400 });
  assert.throws(() => mcp.handle('POST', cancel, body, { deviceId: 'b'.repeat(32) }), { status: 403 });
  assert.throws(() => mcp.handle('POST', cancel, { expectedState: 'f'.repeat(64) }, options), { status: 409 });
  assert.equal((await mcp.handle('POST', cancel, body, options)).auth.status, 'not_connected');
  const newer = await mcp.handle('POST', path, { callbackTarget: 'iphone' }, options);
  assert.throws(() => mcp.handle('POST', cancel, body, options), { status: 409 }, 'A delayed cancel cannot stop the newer same-device flow.');
  assert.equal(latest(mcp, c.id).auth.authorizationURL, newer.auth.authorizationURL);
  const newerBody = { expectedState: new URL(newer.auth.authorizationURL).searchParams.get('state') };
  assert.equal((await mcp.handle('POST', cancel, newerBody)).auth.status, 'not_connected', 'The local Mac can cancel this exact pending phone flow.');
  const flow = await begin(mcp, fixture, c.id);
  const macBody = { expectedState: flow.authorization.searchParams.get('state') };
  assert.throws(() => mcp.handle('POST', cancel, macBody, options), { status: 403 });
  await finish(mcp, c.id, flow.callback);
  const before = readFileSync(join(dir, 'bots-connector-auth.json'), 'utf8');
  assert.equal((await mcp.handle('POST', cancel, macBody, options)).auth.status, 'connected');
  assert.equal(readFileSync(join(dir, 'bots-connector-auth.json'), 'utf8'), before);
  await mcp.check(c.id); assert.equal(fixture.tokenRequests.length, 1);
});

test('the Mac browser action opens only its stored pending authorization URL and accepts no caller URL', async t => {
  const fixture = await oauthFixture(t), opened = [], mcp = service(t, { authOptions: { openBrowser: async target => { opened.push(target); return true; } } });
  const c = mcp.create({ name: 'Open browser', transport: 'http', url: fixture.url, authType: 'oauth' }).connection;
  const path = url(`/api/bots/connections/${c.id}/auth`), open = url(path.pathname + '/open');
  await assert.rejects(mcp.handle('POST', open, {}), { status: 409 });
  const flow = await begin(mcp, fixture, c.id);
  assert.throws(() => mcp.handle('POST', open, { url: 'https://other.invalid/' }), { status: 400 });
  assert.throws(() => mcp.handle('POST', open, {}, { deviceId: 'a'.repeat(32) }), { status: 403 });
  const openedResult = await mcp.handle('POST', open, {});
  assert.equal(openedResult.auth.status, 'waiting'); assert.deepEqual(opened, [flow.started.auth.authorizationURL]);
  assert.equal(fixture.tokenRequests.length, 0);
  await mcp.handle('POST', url(path.pathname + '/cancel'), { expectedState: flow.authorization.searchParams.get('state') });
  await mcp.handle('POST', path, { callbackTarget: 'iphone' }, { deviceId: 'a'.repeat(32) });
  await assert.rejects(mcp.handle('POST', open, {}), { status: 409 }); assert.equal(opened.length, 1);
});

test('system browser launch uses a fixed platform command and one safe URL argument without a shell', async () => {
  const target = 'https://accounts.invalid/authorize?state=fixture&literal=%24%28touch%20never%29';
  for (const [platform, command, prefix] of [['darwin', '/usr/bin/open', []], ['linux', 'xdg-open', []], ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler']]]) {
    const calls = []; assert.equal(await openConnectorBrowser(target, { platform, start: async (...args) => { calls.push(args); return true; } }), true);
    assert.deepEqual(calls, [[command, [...prefix, target]]]);
  }
  for (const target of ['file:///private/data', 'javascript:alert(1)', 'https://user:secret@service.invalid/', 'https://service.invalid/#fragment', 'http://outside.invalid/']) await assert.rejects(openConnectorBrowser(target, { start: async () => assert.fail('Unsafe URL was launched') }));
});

test('account labels stay independent; secrets and environment values never enter public projections or frozen instructions', async t => {
  const dir = directory(t), mcp = service(t, { directory: dir, clientFactory: inert });
  const a = mcp.create({ catalogId: 'linear', accountLabel: 'Home', oauthClientId: 'PRIVATE_CLIENT_ID_SENTINEL', oauthClientSecret: 'PRIVATE_CLIENT_SECRET_SENTINEL' }).connection;
  const b = mcp.create({ catalogId: 'linear', authType: 'bearer', accountLabel: 'Work', apiKey: 'PRIVATE_BEARER_SENTINEL' }).connection;
  const program = mcp.create({ name: 'Program', transport: 'stdio', command: '/not-launched', env: { PRIVATE_ENV: 'PRIVATE_ENV_VALUE_SENTINEL' } }).connection;
  assert.notEqual(a.id, b.id); assert.equal(a.oauthClientIdSet, true); assert.equal(a.oauthClientSecretSet, true); assert.deepEqual(program.envKeys, ['PRIVATE_ENV']);
  for (const value of ['PRIVATE_CLIENT_ID_SENTINEL', 'PRIVATE_CLIENT_SECRET_SENTINEL', 'PRIVATE_BEARER_SENTINEL', 'PRIVATE_ENV_VALUE_SENTINEL']) { assert.ok(!JSON.stringify(mcp.list()).includes(value)); assert.ok(!JSON.stringify(mcp.snapshot({ id: botId })).includes(value)); }
  assert.equal(statSync(join(dir, 'bots-mcp.json')).mode & 0o777, 0o600);
  assert.deepEqual(createBotMcp({ directory: dir }).list(), mcp.list());
});

test('team connector authority is frozen, bound to a live team run, revoked during approval and separate from direct grants', async t => {
  let member = true, currentRun = runId, calls = 0;
  const mcp = service(t, { teamAccess: (team, bot, run) => team === teamId && bot === botId && member && run === currentRun, clientFactory: async () => ({ ...await inert(), callTool: async () => { calls++; return { content: [] }; } }) });
  const connection = mcp.create({ name: 'Team', transport: 'http', url: 'https://fixture.invalid/mcp', teamIds: [teamId], customInstructions: 'Use project issues for this team.' }).connection;
  await mcp.check(connection.id); const tool = latest(mcp, connection.id).tools[0]; update(mcp, connection.id, { enabledToolIds: [tool.id] });
  const privateChat = context(mcp), teamChat = context(mcp, { teamContext: { teamId, teamRunId: runId } });
  assert.deepEqual(unpack(await mcp.execute('search_tools', {}, privateChat)).tools, []);
  assert.ok(teamChat.bot.extensionSnapshots.mcp.instructions.includes('Use project issues'));
  assert.equal(unpack(await mcp.execute('search_tools', {}, teamChat)).tools.length, 1);
  teamChat.requestPermission = async () => { member = false; return true; };
  await assert.rejects(mcp.execute('call_tool', { toolId: tool.id, arguments: {} }, teamChat), /removed/); assert.equal(calls, 0);
  member = true; currentRun = 'other_run'; assert.deepEqual(unpack(await mcp.execute('search_tools', {}, teamChat)).tools, []);
  update(mcp, connection.id, { botIds: [botId] }); assert.deepEqual(unpack(await mcp.execute('search_tools', {}, privateChat)).tools, []);
  const direct = context(mcp); assert.equal(unpack(await mcp.execute('search_tools', {}, direct)).tools.length, 1);
  update(mcp, connection.id, { enabled: false }); assert.deepEqual(unpack(await mcp.execute('search_tools', {}, direct)).tools, []);
});

test('team access and shared connector instructions require the current inventory proof', async t => {
  const mcp = service(t, { clientFactory: inert }), c = mcp.create({ name: 'CAS', transport: 'http', url: 'https://fixture.invalid/mcp' }).connection;
  assert.throws(() => mcp.update(c.id, { teamIds: [teamId] }), error => error.status === 409);
  const old = latest(mcp, c.id); update(mcp, c.id, { teamIds: [teamId], customInstructions: 'Reviewed instructions.' });
  assert.throws(() => mcp.update(c.id, { teamIds: [], expectedInventoryDigest: old.inventoryDigest }), error => error.status === 409);
  assert.throws(() => mcp.update(c.id, { customInstructions: 'Unreviewed overwrite' }), error => error.status === 409);
  assert.deepEqual(latest(mcp, c.id).teamIds, [teamId]);
  await mcp.check(c.id); assert.equal(latest(mcp, c.id).status, 'connected');
  update(mcp, c.id, { customInstructions: 'Updated public connector instructions.' });
  assert.equal(latest(mcp, c.id).status, 'connected', 'Editing instructions does not discard the current successful connectivity check.');
});

test('real SDK OAuth discovers audience, registers, uses state and S256 PKCE, then completes through the Mac callback', async t => {
  const fixture = await oauthFixture(t), dir = directory(t), mcp = service(t, { directory: dir });
  const c = mcp.create({ name: 'OAuth fixture', transport: 'http', url: fixture.url, authType: 'oauth', botIds: [botId] }).connection;
  const flow = await begin(mcp, fixture, c.id);
  assert.equal(flow.started.auth.status, 'waiting'); assert.equal(flow.authorization.searchParams.get('code_challenge_method'), 'S256'); assert.equal(flow.authorization.searchParams.get('resource'), fixture.url);
  assert.equal(flow.authorization.searchParams.get('state').length, 64);
  await assert.rejects(mcp.handle('POST', url(`/api/bots/connections/${c.id}/auth`), {}), error => error.status === 409);
  assert.equal(fixture.tokenRequests.length, 0);
  for (const bad of [flow.callback.replace(/state=[^&]+/, 'state=wrong'), `${flow.callback}&state=duplicate`, flow.callback.replace('127.0.0.1', 'localhost'), flow.callback.replace(/state=[^&]+/, `state=${'é'.repeat(64)}`)]) await assert.rejects(finish(mcp, c.id, bad), error => error.status === 400);
  assert.equal(fixture.tokenRequests.length, 0);
  const completed = await fetch(flow.callback); assert.equal(completed.status, 200); assert.match(await completed.text(), /Connected to Strata/);
  assert.equal(latest(mcp, c.id).auth.status, 'connected'); assert.equal(fixture.tokenRequests.length, 1);
  await assert.rejects(finish(mcp, c.id, flow.callback), error => error.status === 409);
  assert.equal(statSync(join(dir, 'bots-connector-auth.json')).mode & 0o777, 0o600);
  const publicData = JSON.stringify(mcp.list());
  for (const secret of ['PRIVATE_ACCESS_TOKEN_SENTINEL', 'PRIVATE_REFRESH_TOKEN_SENTINEL', fixture.tokenRequests[0].code_verifier, 'fixture-code']) assert.ok(!publicData.includes(secret));
  const checked = (await mcp.check(c.id)).connection; assert.equal(checked.tools.length, 1); assert.deepEqual(checked.enabledToolIds, []);
  update(mcp, c.id, { enabledToolIds: checked.tools.map(tool => tool.id) });
  const chat = context(mcp); const result = await mcp.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, chat); assert.equal(result.content[0].text, 'OAUTH_FIXTURE_OK');
  const frozen = JSON.stringify(chat.bot.extensionSnapshots); assert.ok(!frozen.includes('PRIVATE_')); assert.ok(!frozen.includes('code_verifier'));
  const restored = createBotMcp({ directory: dir }); assert.equal(restored.list().connections[0].auth.status, 'connected'); await restored.close();
});

test('real SDK refresh stays in the same account epoch and sends its refresh token only to the bound issuer', async t => {
  const fixture = await oauthFixture(t), mcp = service(t);
  const c = mcp.create({ name: 'Refresh', transport: 'http', url: fixture.url, authType: 'oauth', botIds: [botId] }).connection;
  const flow = await begin(mcp, fixture, c.id); await finish(mcp, c.id, flow.callback); const checked = (await mcp.check(c.id)).connection;
  update(mcp, c.id, { enabledToolIds: checked.tools.map(tool => tool.id) }); const chat = context(mcp), epoch = chat.bot.extensionSnapshots.mcp.assignments.connections[0].authRevision;
  fixture.rejectOld();
  await mcp.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, chat);
  assert.equal(fixture.tokenRequests.length, 2); assert.equal(fixture.tokenRequests[1].grant_type, 'refresh_token');
  assert.equal(mcp.snapshot(chat.bot).assignments.connections[0].authRevision, epoch);
  assert.ok(fixture.seen.filter(request => request.path.startsWith('/.well-known')).every(request => !request.authorization));
  assert.ok(fixture.seen.filter(request => request.path === '/token').every(request => !request.authorization));
});

test('OAuth sign out while awaiting approval revokes calls; a different sign-in cannot restore a frozen account grant', async t => {
  const fixture = await oauthFixture(t), mcp = service(t);
  const c = mcp.create({ name: 'Revoke', transport: 'http', url: fixture.url, authType: 'oauth', botIds: [botId] }).connection;
  let flow = await begin(mcp, fixture, c.id); await finish(mcp, c.id, flow.callback); const checked = (await mcp.check(c.id)).connection;
  update(mcp, c.id, { enabledToolIds: checked.tools.map(tool => tool.id) }); const chat = context(mcp);
  chat.requestPermission = async () => { mcp.handle('DELETE', url(`/api/bots/connections/${c.id}/auth`), {}); return true; };
  await assert.rejects(mcp.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, chat), /removed/); assert.equal(fixture.messages.includes('tools/call'), false);
  assert.equal(latest(mcp, c.id).auth.status, 'not_connected');
  flow = await begin(mcp, fixture, c.id); await finish(mcp, c.id, flow.callback);
  assert.deepEqual(unpack(await mcp.execute('search_tools', {}, chat)).tools, []);
  assert.equal(unpack(await mcp.execute('search_tools', {}, context(mcp))).tools.length, 1);
});

test('expired, declined and changed connector callbacks do not exchange codes or resurrect credentials', async t => {
  let now = Date.now(); const fixture = await oauthFixture(t), mcp = service(t, { authOptions: { now: () => now } });
  const c = mcp.create({ name: 'Expiry', transport: 'http', url: fixture.url, authType: 'oauth' }).connection;
  let flow = await begin(mcp, fixture, c.id); now += 11 * 60 * 1000; assert.equal(latest(mcp, c.id).auth.status, 'expired');
  await assert.rejects(finish(mcp, c.id, flow.callback), error => error.status === 409); assert.equal(fixture.tokenRequests.length, 0);
  flow = await begin(mcp, fixture, c.id); await assert.rejects(finish(mcp, c.id, flow.callback.replace('code=fixture-code', 'error=access_denied')), /not completed/); assert.equal(latest(mcp, c.id).auth.status, 'error');
  flow = await begin(mcp, fixture, c.id); mcp.update(c.id, { url: `${fixture.origin}/other-mcp` });
  await assert.rejects(finish(mcp, c.id, flow.callback), error => error.status === 409); assert.equal(fixture.tokenRequests.length, 0); assert.equal(latest(mcp, c.id).auth.status, 'not_connected');
});

test('SDK/provider failures are bounded and redact token endpoint errors and secrets', async t => {
  const fixture = await oauthFixture(t, { tokenError: true }), mcp = service(t);
  const c = mcp.create({ name: 'Errors', transport: 'http', url: fixture.url, authType: 'oauth' }).connection;
  const flow = await begin(mcp, fixture, c.id);
  await assert.rejects(finish(mcp, c.id, flow.callback), error => error.status === 503 && !error.message.includes('PRIVATE_TOKEN_ERROR_SENTINEL'));
  assert.equal(latest(mcp, c.id).auth.status, 'error'); assert.ok(!JSON.stringify(mcp.list()).includes('PRIVATE_TOKEN_ERROR_SENTINEL'));
  await assert.rejects(mcp.check(c.id), /Sign in/); assert.equal(fixture.messages.length, 0);
});

test('OAuth refuses missing audience metadata, issuer substitution and redirects before credentials leave the host', async t => {
  for (const behavior of [{ noResourceMetadata: true }, { resource: 'https://unrelated.invalid/mcp' }, { issuer: 'https://unrelated.invalid' }, { tokenEndpoint: 'http://unrelated.invalid/token' }]) {
    const fixture = await oauthFixture(t, behavior), mcp = service(t);
    const c = mcp.create({ name: 'Invalid metadata', transport: 'http', url: fixture.url, authType: 'oauth' }).connection;
    await assert.rejects(begin(mcp, fixture, c.id), /Could not start/); assert.equal(fixture.tokenRequests.length, 0); assert.equal(fixture.seen.filter(request => request.path === '/register').length, 0);
  }
  let requests = 0;
  await assert.rejects(botConnectorFetch('https://example.invalid/mcp', {}, { fetchImpl: async () => { requests++; return new Response(null, { status: 307, headers: { location: 'https://unrelated.invalid' } }); } }), /redirect/); assert.equal(requests, 1);
  await assert.rejects(botConnectorFetch('http://unrelated.invalid/token', {}, { fetchImpl: async () => { requests++; } }), /secure/); assert.equal(requests, 1);
});

test('real SDK protected-resource discovery uses the bounded injected transport and never follows a metadata redirect', async t => {
  const sink = await oauthFixture(t), fixture = await oauthFixture(t, { metadataRedirect: sink.url }), intercepted = [];
  const mcp = service(t, { authOptions: { fetchImpl: (target, init) => { intercepted.push({ url: String(target), redirect: init.redirect, signal: init.signal }); return fetch(target, init); } } });
  const c = mcp.create({ name: 'Metadata redirect', transport: 'http', url: fixture.url, authType: 'oauth' }).connection;
  await assert.rejects(begin(mcp, fixture, c.id), /Could not start/);
  assert.ok(intercepted.length > 0, 'The real SDK discovery must use the injected boundary, not global fetch.');
  assert.ok(intercepted.every(request => request.url.startsWith(fixture.origin) && request.redirect === 'error' && request.signal instanceof AbortSignal));
  assert.equal(sink.seen.length, 0); assert.equal(fixture.tokenRequests.length, 0);
});

test('bearer and explicit environment credentials are scrubbed from nested inventories, text, structured results and thrown SDK errors', async t => {
  for (const transport of ['http', 'stdio']) {
    const secret = transport === 'http' ? 'PRIVATE_BEARER_SENTINEL' : 'PRIVATE_ENV_SECRET_SENTINEL'; let fail = false, calledName;
    const mcp = service(t, { clientFactory: async () => ({
      listTools: async () => ({ tools: [{ name: `lookup_${secret}`, description: `Description ${secret}`, inputSchema: { type: 'object', properties: { token: { type: 'string', description: secret } } } }] }),
      callTool: async input => { calledName = input.name; if (fail) throw Object.assign(new Error(`SERVER_SECRET:${secret}`), { status: 503 }); return { content: [{ type: 'text', text: `Result ${secret}` }], structuredContent: { token: secret, nested: [secret, { [secret]: `Embedded ${secret}` }], valid: true, count: 2 }, isError: true }; }, close: async () => {},
    }) });
    const c = mcp.create({ name: 'Scrub', transport, ...(transport === 'http' ? { url: 'https://fixture.invalid/mcp', apiKey: secret } : { command: '/never-started-fixture', env: { CUSTOM_CREDENTIAL: secret } }), botIds: [botId] }).connection;
    const checked = (await mcp.check(c.id)).connection; assert.ok(!JSON.stringify(checked).includes(secret));
    assert.equal(checked.tools[0].name, 'lookup_[redacted]');
    update(mcp, c.id, { enabledToolIds: checked.tools.map(tool => tool.id) }); const chat = context(mcp);
    assert.ok(!JSON.stringify(chat.bot.extensionSnapshots).includes(secret));
    const found = unpack(await mcp.execute('search_tools', {}, chat)); assert.ok(!JSON.stringify(found).includes(secret));
    const result = await mcp.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, chat);
    assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(JSON.stringify(result).includes('[redacted]')); assert.equal(result.structuredContent.valid, true); assert.equal(result.structuredContent.count, 2); assert.ok(Array.isArray(result.structuredContent.nested)); assert.equal(result.isError, true);
    assert.equal(calledName, `lookup_${secret}`, 'The raw remote tool name remains private and must still be invoked correctly.');
    fail = true; await assert.rejects(mcp.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, chat), error => error.status === 503 && !error.message.includes(secret));
  }
});

test('real OAuth refresh redacts old and rotated access/refresh tokens from the same in-flight result', async t => {
  const fixture = await oauthFixture(t, { echoCredentials: true }), mcp = service(t);
  const c = mcp.create({ name: 'Refresh scrub', transport: 'http', url: fixture.url, authType: 'oauth', botIds: [botId] }).connection;
  const flow = await begin(mcp, fixture, c.id); await finish(mcp, c.id, flow.callback);
  const checked = (await mcp.check(c.id)).connection; assert.ok(!JSON.stringify(checked).includes('PRIVATE_')); update(mcp, c.id, { enabledToolIds: checked.tools.map(tool => tool.id) });
  const chat = context(mcp); fixture.rejectOld();
  const result = await mcp.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, chat);
  assert.equal(fixture.tokenRequests.length, 2); assert.ok(!JSON.stringify(result).includes('PRIVATE_')); assert.equal(result.structuredContent.count, 3); assert.equal(result.structuredContent.enabled, true); assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(mcp.list()).includes('PRIVATE_')); assert.ok(!JSON.stringify(mcp.snapshot(chat.bot)).includes('PRIVATE_'));
});

test('JSON text cannot escape redaction by serializing credentials with quotes, backslashes or line breaks', async t => {
  for (const secret of ['key"quote\\backslash', 'line\nsecret']) {
    const mcp = service(t, { clientFactory: async () => ({
      listTools: async () => ({ tools: [{ name: 'fixture_json', description: JSON.stringify({ token: secret }), inputSchema: { type: 'object' } }] }),
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ token: secret, nested: [{ token: secret }], count: 2 }) }], structuredContent: { token: secret }, isError: true }), close: async () => {},
    }) });
    const c = mcp.create({ name: 'Escaped environment', transport: 'stdio', command: '/not-launched', env: { CREDENTIAL: secret }, botIds: [botId] }).connection;
    const checked = (await mcp.check(c.id)).connection; assert.equal(JSON.parse(checked.tools[0].description).token, '[redacted]');
    update(mcp, c.id, { enabledToolIds: checked.tools.map(tool => tool.id) });
    const result = await mcp.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, context(mcp));
    const parsed = JSON.parse(result.content[0].text); assert.equal(parsed.token, '[redacted]'); assert.equal(parsed.nested[0].token, '[redacted]'); assert.equal(parsed.count, 2); assert.equal(result.structuredContent.token, '[redacted]');
  }
});

test('pre-upgrade frozen MCP inventories are scrubbed at discovery and approval without replacing their frozen authority', async t => {
  const secret = 'PRIVATE_LEGACY_BEARER_SENTINEL'; let invokedName, approvedName;
  const mcp = service(t, { clientFactory: async () => ({ listTools: async () => ({ tools: [{ name: `legacy_${secret}`, description: secret, inputSchema: { type: 'object', description: secret } }] }), callTool: async input => { invokedName = input.name; return { content: [] }; }, close: async () => {} }) });
  const c = mcp.create({ name: 'Legacy snapshot', transport: 'http', url: 'https://fixture.invalid/mcp', apiKey: secret, botIds: [botId] }).connection;
  const checked = (await mcp.check(c.id)).connection; update(mcp, c.id, { enabledToolIds: checked.tools.map(tool => tool.id) });
  const chat = context(mcp), frozen = chat.bot.extensionSnapshots.mcp.assignments.connections[0]; delete frozen.botGranted;
  frozen.tools[0] = { ...frozen.tools[0], name: `legacy_${secret}`, description: `Frozen original ${secret}`, inputSchema: { type: 'object', description: secret } };
  const discovered = unpack(await mcp.execute('search_tools', {}, chat)); assert.ok(!JSON.stringify(discovered).includes(secret)); assert.equal(discovered.tools[0].description, 'Frozen original [redacted]');
  chat.requestPermission = async request => { approvedName = request.name; return true; };
  await mcp.execute('call_tool', { toolId: checked.tools[0].id, arguments: {} }, chat);
  assert.ok(!approvedName.includes(secret)); assert.equal(invokedName, `legacy_${secret}`);
  assert.equal(frozen.tools[0].description, `Frozen original ${secret}`, 'The saved snapshot is not rewritten or broadened during projection.');
});

test('a late cancelled OAuth exchange cannot cancel a newer sign-in or restore its old credentials', async t => {
  let entered, release; const enteredToken = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; }); let tokenCount = 0;
  const fixture = await oauthFixture(t, { beforeToken: async () => { if (++tokenCount === 1) { entered(); await hold; } } }), mcp = service(t);
  const c = mcp.create({ name: 'Superseded sign-in', transport: 'http', url: fixture.url, authType: 'oauth' }).connection;
  const old = await begin(mcp, fixture, c.id), exchange = finish(mcp, c.id, old.callback); exchange.catch(() => {});
  await enteredToken;
  mcp.handle('DELETE', url(`/api/bots/connections/${c.id}/auth`), {});
  const fresh = await begin(mcp, fixture, c.id);
  release(); await assert.rejects(exchange, /sign-in failed/);
  assert.equal(latest(mcp, c.id).auth.status, 'waiting'); assert.equal(latest(mcp, c.id).auth.authorizationURL, fresh.started.auth.authorizationURL);
  await finish(mcp, c.id, fresh.callback); assert.equal(latest(mcp, c.id).auth.status, 'connected');
});

test('malformed and symlink OAuth stores are refused without overwriting retained files', t => {
  const dir = directory(t), sentinel = join(dir, 'sentinel'); writeFileSync(sentinel, 'untouched'); symlinkSync(sentinel, join(dir, 'bots-connector-auth.json'));
  assert.throws(() => createBotMcp({ directory: dir }), /regular file/); assert.equal(readFileSync(sentinel, 'utf8'), 'untouched');
  const bad = directory(t); writeFileSync(join(bad, 'bots-connector-auth.json'), '{"version":1,"accounts":[]}'); assert.throws(() => createBotMcp({ directory: bad }), /invalid/); assert.ok(existsSync(join(bad, 'bots-connector-auth.json')));
});
