import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, HostClient, publicConversation, publicTool } from '../bridge.mjs';

const card = {
  id: 'helper-session:call.1', name: 'mcp__browser__browser_navigate', state: 'proposed',
  verb: 'Opening a page in the browser', target: 'https://example.test/',
  preview: 'https://example.test/', effect: 'Open the page.', scope: 'connected',
  ask: { why: 'Open this page?', detail: 'https://example.test/', internal: 'ASK-SECRET' },
  args: { authorization: 'ARGS-SECRET' }, approvalToken: 'APPROVAL-SECRET',
};
const conversation = {
  id: 's_desktop-1', title: 'Continue the Mac task', active: true,
  updatedAt: '2026-10-19T21:00:00.000Z', workspace: '/Users/example/project',
  preferences: { mode: 'manual', remoteModel: { connectionId: 'INTERNAL-CONNECTION', modelId: 'internal/model' } },
  gatewayToken: 'GATEWAY-SECRET',
  messages: [
    { id: 'm_user', role: 'user', content: 'Open the page', at: '2026-10-19T21:00:00.000Z' },
    { id: 'm_assistant', role: 'assistant', content: 'I am opening the page.', model: 'Saved Mac model', streaming: true, tools: [card], raw: 'RAW-SECRET' },
  ],
};
const detail = () => ({ conversation: structuredClone(conversation), pending: [structuredClone(card)], apiKey: 'PROVIDER-SECRET' });

function request(bridge, path, { method = 'GET', token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    }, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: response.statusCode, text, json }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function fixture(t, responder = () => detail()) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-conversations-test-'));
  const calls = [];
  const host = { async json(path, options) {
    calls.push({ path, ...options });
    if (path === '/api/models') return { variants: [], loaded: null };
    if (path === '/api/native') return { instances: [], catalog: { families: [] } };
    if (path === '/api/model-providers') return { connections: [{ id: 'configured', name: 'Mac provider', apiKey: 'KEY-SECRET', models: [{ id: 'saved-model', name: 'Saved model' }] }] };
    return responder(path, options);
  } };
  const bridge = await createBridge({ directory, host, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  const { token, session } = bridge.authority.pair(bridge.authority.code, 'Conversation review iPhone');
  return { bridge, calls, token, session };
}

test('shared projections retain history, browser actions and helper IDs while omitting internal configuration', () => {
  const clean = publicConversation(conversation);
  assert.equal(clean.id, conversation.id); assert.equal(clean.mode, 'manual');
  assert.equal(clean.modelName, 'Saved Mac model'); assert.equal(clean.workspace, conversation.workspace);
  assert.equal(clean.messages[1].content, conversation.messages[1].content);
  assert.equal(clean.messages[1].tools[0].id, 'helper-session:call.1');
  assert.equal(clean.messages[1].tools[0].verb, card.verb);
  assert.deepEqual(clean.messages[1].tools[0].ask, { why: card.ask.why, detail: card.ask.detail });
  const encoded = JSON.stringify(clean);
  for (const secret of ['GATEWAY-SECRET', 'ARGS-SECRET', 'APPROVAL-SECRET', 'ASK-SECRET', 'RAW-SECRET', 'INTERNAL-CONNECTION', 'internal/model']) assert.ok(!encoded.includes(secret), secret);
  assert.equal(publicTool({ ...card, id: '../call' }), null);
  assert.equal(publicTool({ ...card, result: 'x'.repeat(40_000) }).result.length, 32_000);
  const summary = publicConversation(conversation, { summary: true });
  assert.equal(summary.preview, 'I am opening the page.'); assert.equal(summary.messages, undefined);
});

test('HostClient only admits exact shared-conversation methods and prevents desktop sync or URL forwarding', async () => {
  const calls = [];
  const host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { calls.push({ url, options }); return new Response('{}'); } });
  for (const [path, method] of [
    ['/api/companion/conversations', 'GET'], ['/api/companion/conversations', 'POST'],
    ['/api/companion/conversations/s_desktop-1', 'GET'],
    ...['messages', 'approval', 'stop'].map(action => [`/api/companion/conversations/s_desktop-1/${action}`, 'POST']),
  ]) await host.request(path, { method });
  assert.equal(calls.length, 6);
  for (const [path, method] of [
    ['/api/companion/conversations/sync', 'GET'], ['/api/companion/conversations/sync', 'POST'],
    ['/api/companion/conversations/s_desktop-1', 'DELETE'], ['/api/companion/conversations/s_desktop-1/messages', 'GET'],
    ['/api/companion/conversations/s_desktop-1/mode', 'POST'], ['/api/companion/conversations/s_desktop-1?path=/private', 'GET'],
    ['/api/companion/conversations/../settings', 'GET'], ['https://evil.test/api/companion/conversations', 'GET'],
  ]) await assert.rejects(host.request(path, { method }), { status: 403 });
  assert.equal(calls.length, 6, 'unsupported paths never reach fetch');
});

test('paired conversation routes inherit Mac configuration and forward only message, stop or exact approval', async t => {
  const { bridge, calls, token } = await fixture(t, path => path === '/api/companion/conversations'
    ? { conversations: [conversation], activeChatId: conversation.id } : detail());
  assert.equal((await request(bridge, '/v1/conversations')).status, 401);
  const listed = await request(bridge, '/v1/conversations', { token });
  assert.equal(listed.status, 200); assert.equal(listed.json.activeChatId, conversation.id);
  const loaded = await request(bridge, `/v1/conversations/${conversation.id}`, { token });
  assert.equal(loaded.status, 200); assert.equal(loaded.json.pending[0].id, card.id);
  const sent = await request(bridge, `/v1/conversations/${conversation.id}/messages`, { token, method: 'POST', body: { message: '  Continue on the Mac.  ' } });
  assert.equal(sent.status, 202); assert.deepEqual(calls.at(-1), { path: `/api/companion/conversations/${conversation.id}/messages`, method: 'POST', body: { message: 'Continue on the Mac.' } });
  const allowed = await request(bridge, `/v1/conversations/${conversation.id}/approval`, { token, method: 'POST', body: { toolId: card.id, decision: 'approve' } });
  assert.equal(allowed.status, 200); assert.deepEqual(calls.at(-1).body, { toolId: card.id, decision: 'approve' });
  assert.equal((await request(bridge, `/v1/conversations/${conversation.id}/stop`, { token, method: 'POST', body: {} })).status, 200);
  assert.deepEqual(calls.at(-1).body, {});
  for (const response of [listed, loaded, sent, allowed]) for (const secret of ['GATEWAY-SECRET', 'ARGS-SECRET', 'APPROVAL-SECRET', 'ASK-SECRET', 'RAW-SECRET', 'PROVIDER-SECRET']) assert.ok(!response.text.includes(secret), secret);
  const before = calls.length;
  for (const [path, body] of [
    [`${conversation.id}/messages`, { message: 'Continue', mode: 'bypass' }],
    [`${conversation.id}/messages`, { message: 'Continue', remoteModel: { connectionId: 'foreign', modelId: 'other' } }],
    [`${conversation.id}/messages`, { message: 'Continue', workspace: '/private' }],
    [`${conversation.id}/messages`, { message: 'Continue', agent: false }],
    [`${conversation.id}/approval`, { toolId: card.id, decision: 'always' }],
    [`${conversation.id}/approval`, { toolId: '../foreign', decision: 'approve' }],
    [`${conversation.id}/stop`, { sessionId: 'other' }],
    ['', { mode: 'bypass' }],
  ]) assert.equal((await request(bridge, `/v1/conversations${path ? `/${path}` : ''}`, { token, method: 'POST', body })).status, 400);
  for (const path of ['/v1/conversations/sync', '/v1/conversations/sync/messages', '/v1/conversations/s_desktop-1/mode', '/v1/conversations/s_desktop-1?url=https://evil.test']) assert.equal((await request(bridge, path, { token })).status, 404);
  assert.equal(calls.length, before, 'rejected overrides never reach Mac controls');
});

test('creating a shared chat sends only the paired device saved model choice', async t => {
  const { bridge, calls, token } = await fixture(t);
  const created = await request(bridge, '/v1/conversations', { token, method: 'POST', body: {} });
  assert.equal(created.status, 201);
  assert.deepEqual(calls.at(-1), { path: '/api/companion/conversations', method: 'POST', body: { remoteModel: { connectionId: 'configured', modelId: 'saved-model' } } });
  assert.ok(!created.text.includes('KEY-SECRET'));
});

test('revocation while reading shared history prevents the awaited private response from reaching the phone', async t => {
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  let resume; const blocked = new Promise(resolve => { resume = resolve; });
  const { bridge, token, session } = await fixture(t, async () => { entered(); await blocked; return detail(); });
  const pending = request(bridge, `/v1/conversations/${conversation.id}`, { token });
  await waiting; bridge.authority.revoke(session.id); resume();
  const response = await pending;
  assert.equal(response.status, 401); assert.ok(!response.text.includes(conversation.messages[0].content));
});

test('revocation while a new-chat body is arriving prevents a later Mac mutation', async t => {
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  let resume; const blocked = new Promise(resolve => { resume = resolve; });
  const { bridge, calls, token, session } = await fixture(t);
  const original = bridge.authority.sessions;
  const authority = bridge.authority;
  const oldAuthorize = authority.authorize.bind(authority);
  authority.authorize = header => { const result = oldAuthorize(header); if (result) entered(); return result; };
  // Send the JSON in two pieces so revocation occurs after initial authorization,
  // before the request body finishes and any model-dependent control is admitted.
  const response = new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path: '/v1/conversations', method: 'POST', agent: false, rejectUnauthorized: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', piece => { text += piece; }); res.on('end', () => resolve({ status: res.statusCode, text })); });
    req.on('error', reject); req.write('{');
    void blocked.then(() => req.end('}'));
  });
  await waiting; assert.equal(original.length, 1); authority.revoke(session.id); resume();
  const result = await response;
  assert.equal(result.status, 401);
  assert.ok(!calls.some(call => call.path === '/api/companion/conversations' && call.method === 'POST'));
});
