/** Actual paired TLS bridge -> loopback HTTP routes -> saved bot store.
 * Providers, models and computers are disposable fixtures; no work is started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBridge, HostClient } from '../../companion-bridge/bridge.mjs';

test('paired phone drafts round-trip configured identities, edits and frozen approval choices through the actual host', { timeout: 30_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-paired-profile-'));
  const owner = join(directory, 'owner'), pairing = join(directory, 'pairing');
  const connections = [
    { id: 'maya', name: 'Maya separate', baseUrl: 'https://maya.invalid/v1', apiKey: 'FIXTURE_MAYA_SECRET', models: [{ id: 'same', name: 'Maya model' }] },
    { id: 'strata', name: 'Strata server', baseUrl: 'https://strata.invalid/v1', apiKey: 'FIXTURE_STRATA_SECRET', models: [{ id: 'same', name: 'Strata model' }], modelManagement: { transport: 'ssh', host: 'FIXTURE_SSH_ALIAS', user: 'FIXTURE_SSH_USER', port: 2222 } },
  ];
  const originalConnections = structuredClone(connections);
  const counts = { run: 0, probe: 0, prepare: 0, cua: 0, execute: 0 };
  const providers = ['claude', 'codex', 'grok', 'kimi', 'ollama'].map(id => ({ id, name: id, available: id === 'codex' }));
  const modelProviders = {
    list: () => ({ connections: structuredClone(connections) }),
    resolve({ connectionId, modelId }) {
      const connection = connections.find(row => row.id === connectionId);
      const model = connection?.models.find(row => row.id === modelId);
      if (!model) throw Error('Fixture model removed');
      return { connection, model };
    },
  };
  let chats, bridge, server;
  const bots = createBots({
    directory: owner, defaultWorkspace: () => owner, modelProviders, conversations: () => chats,
    runtime: { providers: async () => structuredClone(providers), run: async () => { counts.run++; assert.fail('Saving or creating a chat must not run a provider'); }, close() {} },
    remoteSSH: { probe: async () => { counts.probe++; assert.fail('A profile draft must not probe SSH'); }, prepare: async () => { counts.prepare++; assert.fail('A profile draft must not install a worker'); }, cua: async () => { counts.cua++; assert.fail('A profile draft must not start a computer'); } },
    tools: { definitions: () => [], execute: async () => { counts.execute++; assert.fail('A profile draft must not execute tools'); }, finish() {}, close() {} },
  });
  chats = createConversations({ directory: owner, enabled: () => bots.hasProfiles(), defaultWorkspace: () => owner,
    validateSelection: value => bots.validateSelection(value), execute: value => bots.run(value), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: value => bots.approve(value) });
  t.after(async () => {
    await bridge?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true });
  });
  let port;
  const routes = createBotRoutes({ bots, port: () => port });
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      await routes(req, res, url);
      if (res.headersSent) return;
      res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Unexpected fixture route' }));
    } catch {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Fixture host failed' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  bridge = await createBridge({ directory: pairing, host: new HostClient({ upstream: `http://127.0.0.1:${port}` }),
    listen: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, adminPort: 0, qr: false });
  const ca = readFileSync(join(pairing, 'server-cert.pem'));
  const request = (path, { method = 'GET', body, token } = {}) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, ca, agent: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await request('/v1/bots', { method: 'POST', body: {} })).status, 401);
  const paired = await request('/v1/pair', { method: 'POST', body: { code: bridge.authority.code, deviceName: 'Synthetic fixture phone' } });
  assert.equal(paired.status, 200);
  const token = paired.json.token;
  const catalog = await request('/v1/bots', { token });
  assert.equal(catalog.status, 200); assert.equal(catalog.json.lifecycleSupported, true);
  const shapes = ['orb', 'pebble', 'tile', 'diamond', 'spark', 'hexagon'];
  assert.deepEqual(catalog.json.avatarShapes, shapes);
  const target = catalog.json.computers.find(row => row.kind === 'ssh');
  const selected = catalog.json.models.find(row => row.connectionName === 'Strata server');
  const other = catalog.json.models.find(row => row.connectionName === 'Maya separate');
  assert.ok(target && selected && other); assert.notEqual(selected.id, other.id); assert.equal(selected.model, other.model);
  const draft = { name: 'Phone-created partner', provider: 'configured', modelId: selected.id, model: selected.model,
    computerId: target.id, workspace: '/srv/project', capabilities: 'both', computerMode: 'host', policy: 'manual',
    instructions: 'Fixture instructions', avatarConfig: { kind: 'fox', color: 'sky', eyes: 'happy', ears: 'small' } };
  const created = await request('/v1/bots', { method: 'POST', token, body: draft });
  assert.equal(created.status, 201); assert.equal(created.json.bot.modelId, selected.id);
  assert.equal(created.json.bot.policy, 'manual'); assert.equal(created.json.bot.computerId, target.id);
  assert.deepEqual(created.json.bot.execution, { kind: 'ssh' });
  assert.equal(chats.list().conversations.length, 0);
  for (const secret of ['FIXTURE_MAYA_SECRET', 'FIXTURE_STRATA_SECRET', 'FIXTURE_SSH_ALIAS', 'FIXTURE_SSH_USER']) assert.ok(!JSON.stringify(created.json).includes(secret));
  const id = created.json.bot.id;
  const oldChat = await request(`/v1/bots/${id}/conversations`, { method: 'POST', token, body: { policy: 'manual' } });
  assert.equal(oldChat.status, 201); assert.equal(oldChat.json.conversation.mode, 'manual');
  const updated = await request(`/v1/bots/${id}`, { method: 'PATCH', token, body: { ...draft, name: 'Edited on phone', policy: 'bypass', expectedUpdatedAt: created.json.bot.updatedAt } });
  assert.equal(updated.status, 200); assert.equal(updated.json.bot.policy, 'bypass');
  assert.equal(chats.detail(oldChat.json.conversation.id).conversation.preferences.mode, 'manual');
  const stale = await request(`/v1/bots/${id}`, { method: 'PATCH', token, body: { name: 'Stale overwrite', expectedUpdatedAt: created.json.bot.updatedAt } });
  assert.equal(stale.status, 409);
  for (const policy of ['bypass', 'plan', 'manual']) {
    const result = await request(`/v1/bots/${id}/conversations`, { method: 'POST', token, body: { policy } });
    assert.equal(result.status, 201); assert.equal(result.json.conversation.mode, policy);
    assert.equal(result.json.conversation.messages.length, 0);
  }
  assert.equal((await request('/v1/bots', { method: 'POST', token, body: { ...draft, model: '' } })).status, 400, 'Configured model payload must agree with its saved identity');
  assert.equal((await request('/v1/bots', { method: 'POST', token, body: { ...draft, execution: { kind: 'ssh', host: 'foreign' } } })).status, 400);
  assert.equal((await request('/v1/bots', { method: 'POST', token, body: { ...draft, modelId: 'removed' } })).status, 409);
  const geometric = { color: 'sky', eyes: 'round', ears: 'small' };
  for (const shape of shapes) {
    assert.equal((await request(`/v1/bots/${id}/avatar`, { method: 'POST', token, body: { avatarConfig: { ...geometric, shape } } })).status, 200);
    const saved = (await request('/v1/bots', { token })).json.bots[0];
    assert.deepEqual(saved.avatarConfig, { ...geometric, shape });
  }
  const beforeOldEdit = (await request('/v1/bots', { token })).json.bots[0];
  const oldClientEdit = await request(`/v1/bots/${id}`, { method: 'PATCH', token, body: { avatarConfig: { ...geometric, color: 'orange' }, expectedUpdatedAt: beforeOldEdit.updatedAt } });
  assert.equal(oldClientEdit.status, 200); assert.equal(oldClientEdit.json.bot.avatarConfig.shape, 'hexagon');
  const geometricChat = await request(`/v1/bots/${id}/conversations`, { method: 'POST', token, body: {} });
  assert.equal(geometricChat.status, 201); assert.equal(geometricChat.json.conversation.botAvatarConfig.shape, 'hexagon');
  assert.deepEqual(chats.detail(oldChat.json.conversation.id).conversation.preferences.botAvatarConfig, draft.avatarConfig);
  assert.equal((await request(`/v1/bots/${id}/avatar`, { method: 'POST', token, body: { avatarConfig: { ...geometric, shape: 'classic' } } })).status, 200);
  assert.equal(Object.hasOwn((await request('/v1/bots', { token })).json.bots[0].avatarConfig, 'shape'), false);
  for (const invalid of [{ ...geometric, shape: null }, { ...geometric, shape: 'external' }, { ...geometric, kind: 'fox', shape: 'orb' }]) {
    assert.equal((await request(`/v1/bots/${id}/avatar`, { method: 'POST', token, body: { avatarConfig: invalid } })).status, 400);
  }
  const final = await request('/v1/bots', { token });
  assert.equal(final.json.bots.length, 1); assert.equal(final.json.bots[0].name, 'Edited on phone');
  assert.equal(final.json.bots[0].modelId, selected.id);
  assert.deepEqual(connections, originalConnections);
  assert.deepEqual(counts, { run: 0, probe: 0, prepare: 0, cua: 0, execute: 0 });
  const folderPath = join(realpathSync(directory), 'shared project'); mkdirSync(folderPath);
  const isolated = await request('/v1/bots', { method: 'POST', token, body: { ...draft, provider: 'codex', modelId: undefined, model: '', computerId: 'local', computerMode: 'cua', workspace: '/workspace' } });
  assert.equal(isolated.status, 201); const isolatedId = isolated.json.bot.id;
  const folderRoute = `/v1/bots/${isolatedId}/host-folder`;
  const grant = { expectedUpdatedAt: isolated.json.bot.updatedAt, hostFolder: { path: folderPath, access: 'read' } };
  assert.equal((await request(folderRoute, { method: 'PUT', body: grant })).status, 401);
  assert.equal((await request(folderRoute, { method: 'PUT', token, body: { ...grant, hostFolderBinding: {} } })).status, 400);
  const granted = await request(folderRoute, { method: 'PUT', token, body: grant });
  assert.equal(granted.status, 200, JSON.stringify(granted.json)); assert.equal(granted.json.hostFolderSupported, true);
  assert.deepEqual(granted.json.bot.hostFolder, grant.hostFolder);
  for (const key of ['hostFolderBinding', 'hostFolderRevision', 'hostFolderOwnerId', 'hostFolderRemoteIdentity']) assert.equal(JSON.stringify(granted.json).includes(key), false);
  assert.equal((await request(folderRoute, { method: 'PUT', token, body: grant })).status, 409);
  const revoked = await request(folderRoute, { method: 'PUT', token, body: { expectedUpdatedAt: granted.json.bot.updatedAt, hostFolder: null } });
  assert.equal(revoked.status, 200); assert.equal(revoked.json.bot.hostFolder, undefined);
  assert.deepEqual(connections, originalConnections);
  assert.deepEqual(counts, { run: 0, probe: 0, prepare: 0, cua: 0, execute: 0 });
});
