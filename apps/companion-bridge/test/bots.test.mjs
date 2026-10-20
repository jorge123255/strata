import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, HostClient, publicBots, publicConversation } from '../bridge.mjs';

const catalog = {
  bots: [{ id: 'bot_coder', name: 'Coder', provider: 'codex', model: 'default', capabilities: 'both', policy: 'manual',
    execution: { kind: 'ssh', host: 'SSH-SECRET', user: 'SSH-USER', identity: 'KEY-PATH' }, instructions: 'PRIVATE-INSTRUCTIONS',
    providerSettings: { apiKey: 'PROVIDER-SECRET', baseURL: 'PRIVATE-ENDPOINT' }, conversations: ['s_bot', '../invalid'] }],
  providers: [{ id: 'codex', name: 'Codex', available: true, detail: 'Ready on Mac', models: ['default'], token: 'TOKEN-SECRET' }],
  computers: [{ id: 'local', name: 'Your Mac', kind: 'local', available: true, detail: 'Ready', privateKey: 'PRIVATE-KEY' }],
};
const detail = {
  conversation: { id: 's_bot', title: 'Coder conversation', preferences: { botId: 'bot_coder', mode: 'manual', providerSettings: 'SECRET' },
    active: false, messages: [{ id: 'assistant', role: 'assistant', content: 'Earlier result', reasoning: 'Checked the files' }] }, pending: [],
};

function request(bridge, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function fixture(t, responder) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bots-test-'));
  const calls = [];
  const bridge = await createBridge({ directory, host: { async json(path, options) {
    calls.push({ path, ...options });
    return responder ? responder(path, options) : path === '/api/bots' ? structuredClone(catalog) : structuredClone(detail);
  } }, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, calls, ...bridge.authority.pair(bridge.authority.code, 'Bots fixture iPhone') };
}

test('bot catalog is a public projection with no provider credentials or SSH connection settings', () => {
  const clean = publicBots(catalog), encoded = JSON.stringify(clean);
  assert.deepEqual(clean.bots[0].execution, { kind: 'ssh' });
  assert.deepEqual(clean.bots[0].conversations, ['s_bot']);
  assert.equal(clean.bots[0].policy, 'manual'); assert.equal(clean.providers[0].available, true);
  for (const secret of ['SSH-SECRET', 'SSH-USER', 'KEY-PATH', 'PRIVATE-INSTRUCTIONS', 'PROVIDER-SECRET', 'PRIVATE-ENDPOINT', 'TOKEN-SECRET', 'PRIVATE-KEY']) assert.ok(!encoded.includes(secret), secret);
  assert.equal(publicConversation(detail.conversation).botId, 'bot_coder');
  assert.equal(publicConversation(detail.conversation, { summary: true }).botId, 'bot_coder');
  assert.equal(publicConversation({ ...detail.conversation, preferences: {} }).botId, undefined);
  assert.throws(() => publicBots({ bots: [] }), { status: 502 });
});

test('host permits only public bot listing and empty saved-bot conversation creation', async () => {
  const calls = [];
  const host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { calls.push({ url, ...options }); return new Response('{}'); } });
  await host.request('/api/bots');
  await host.request('/api/bots/bot_coder/conversations', { method: 'POST', body: {} });
  for (const [path, method, body] of [
    ['/api/bots', 'POST', {}], ['/api/bots/bot_coder', 'GET'], ['/api/bots/bot_coder', 'DELETE'],
    ['/api/bots/providers', 'PUT', { apiKey: 'secret' }], ['/api/bots/bot_coder/conversations', 'GET'],
    ['/api/bots/bot_coder/conversations', 'POST', { policy: 'bypass' }],
    ['/api/bots?apiKey=true', 'GET'], ['/api/bots/../settings/conversations', 'POST', {}],
  ]) await assert.rejects(host.request(path, { method, body }), { status: 403 });
  assert.equal(calls.length, 2);
  assert.throws(() => new HostClient({ upstream: 'https://remote.test:443' }));
});

test('paired bot routes list without launching and create only a shared empty conversation', async t => {
  const { bridge, token, calls } = await fixture(t);
  assert.equal((await request(bridge, '/v1/bots')).status, 401);
  const listed = await request(bridge, '/v1/bots', { token });
  assert.equal(listed.status, 200); assert.equal(listed.json.bots[0].name, 'Coder');
  assert.deepEqual(calls, [{ path: '/api/bots' }], 'listing must not create a conversation or start a turn');
  const created = await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body: {} });
  assert.equal(created.status, 201); assert.equal(created.json.conversation.botId, 'bot_coder');
  assert.equal(created.json.conversation.messages[0].reasoning, 'Checked the files');
  assert.deepEqual(calls.at(-1), { path: '/api/bots/bot_coder/conversations', method: 'POST', body: {} });
  const count = calls.length;
  for (const body of [{ provider: 'kimi' }, { message: 'Run this' }, { execution: {} }, { policy: 'bypass' }, { apiKey: 'secret' }]) {
    assert.equal((await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body })).status, 400);
  }
  for (const path of ['/v1/bots/bot_coder', '/v1/bots/providers', '/v1/bots?include=credentials']) assert.equal((await request(bridge, path, { token })).status, 404);
  assert.equal(calls.length, count);
});

test('removed pairing cannot receive an in-flight bot catalog', async t => {
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { resume = resolve; });
  const { bridge, token, session } = await fixture(t, async () => { entered(); await blocked; return catalog; });
  const pending = request(bridge, '/v1/bots', { token });
  await waiting; bridge.authority.revoke(session.id); resume();
  const result = await pending;
  assert.equal(result.status, 401); assert.ok(!result.text.includes('Coder'));
});

test('old hosts explain unsupported bots and provider failures do not export raw diagnostic secrets', async t => {
  const { bridge, token } = await fixture(t, path => {
    throw Object.assign(new Error('INTERNAL-SECRET'), { status: path === '/api/bots' ? 404 : 409 });
  });
  const listed = await request(bridge, '/v1/bots', { token });
  assert.equal(listed.status, 200); assert.deepEqual(listed.json.bots, []); assert.match(listed.json.reason, /Update Strata/);
  const created = await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body: {} });
  assert.equal(created.status, 409); assert.ok(!created.text.includes('INTERNAL-SECRET'));
});

test('revocation while bot creation body arrives prevents any later host mutation', async t => {
  const { bridge, token, session, calls } = await fixture(t);
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const authorize = bridge.authority.authorize.bind(bridge.authority);
  bridge.authority.authorize = header => { const result = authorize(header); if (result) entered(); return result; };
  let finishBody;
  const pending = new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path: '/v1/bots/bot_coder/conversations', method: 'POST', agent: false, rejectUnauthorized: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text })); });
    req.on('error', reject); req.write('{'); finishBody = () => req.end('}');
  });
  await waiting; bridge.authority.revoke(session.id); finishBody();
  assert.equal((await pending).status, 401);
  assert.equal(calls.length, 0, 'revoked devices cannot create a bot conversation after the body finishes');
});
