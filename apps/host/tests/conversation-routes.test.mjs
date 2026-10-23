import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversations } from '../server/conversations.mjs';
import { createConversationRoutes } from '../server/conversation-routes.mjs';

test('shared conversations require the exact local desktop origin and expose bounded actions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-conversation-routes-'));
  const conversations = createConversations({ directory, execute: async ({ onFrame }) => onFrame({ type: 'delta', text: 'Shared reply' }) });
  let server;
  const route = createConversationRoutes({ conversations, port: () => server.address().port });
  server = http.createServer((req, res) => { res.setHeader('access-control-allow-origin', '*'); void route(req, res, new URL(req.url, 'http://localhost')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); conversations.close(); rmSync(directory, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const path = '/api/companion/conversations';
  const request = (suffix = '', method = 'GET', body, headers = {}) => fetch(root + path + suffix, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('', 'GET', undefined, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('', 'POST', {}, { origin: 'http://127.0.0.1:9999' })).status, 403);
  const rebound = await new Promise((resolve, reject) => { const req = http.request(root + path, { headers: { host: 'rebound.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(rebound, 403);
  const created = await request('', 'POST', {});
  assert.equal(created.status, 201); assert.equal(created.headers.get('access-control-allow-origin'), null);
  const { conversation } = await created.json();
  assert.equal((await request(`/${conversation.id}/messages`, 'POST', { message: 'Continue', mode: 'bypass', workspace: '/' })).status, 202);
  await new Promise(resolve => setImmediate(resolve));
  const detail = await (await request(`/${conversation.id}`)).json();
  assert.equal(detail.conversation.messages.at(-1).content, 'Shared reply');
  assert.equal(detail.conversation.preferences.mode, 'manual');
  assert.equal((await request(`/${conversation.id}/arbitrary-shell`, 'POST', {})).status, 404);
  assert.equal((await request(`/${conversation.id}/approval`, 'POST', { toolId: 'x', decision: 'always' })).status, 400);
  assert.equal((await request(`/${conversation.id}/messages/m_missing/choice`, 'GET')).status, 405);
  assert.equal((await request(`/${conversation.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/${conversation.id}`)).status, 404);
});

test('a paused one-to-one chat offers continue and that choice sends Continue', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-conversation-pause-'));
  const seen = [];
  const sentence = 'I finished the scan. The rest of this request is still left.';
  const conversations = createConversations({ directory, execute: async ({ message, onFrame }) => {
    seen.push(message);
    if (message === 'Continue') { onFrame({ type: 'delta', text: 'Resumed' }); return; }
    onFrame({ type: 'pause', recovery: { kind: 'paused', text: sentence, question: 'Keep going?', options: [{ id: 'continue', label: 'Keep going' }] }, text: sentence });
  } });
  let server;
  const route = createConversationRoutes({ conversations, port: () => server.address().port });
  server = http.createServer((req, res) => { void route(req, res, new URL(req.url, 'http://localhost')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); conversations.close(); rmSync(directory, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const request = (suffix = '', method = 'GET', body) => fetch(root + '/api/companion/conversations' + suffix, { method, headers: body ? { 'content-type': 'application/json' } : undefined, ...(body ? { body: JSON.stringify(body) } : {}) });
  const created = await (await request('', 'POST', {})).json();
  assert.equal((await request(`/${created.conversation.id}/messages`, 'POST', { message: 'Look at this' })).status, 202);
  const ready = async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const detail = await (await request(`/${created.conversation.id}`)).json();
      const reply = detail.conversation.messages.find(row => row.role === 'assistant' && row.recovery?.kind === 'paused');
      if (reply && !reply.streaming) return reply;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('The pause was not saved');
  };
  const reply = await ready();
  assert.equal(reply.recovery.kind, 'paused');
  assert.equal(reply.recovery.text, sentence);
  assert.equal(reply.recovery.question, 'Keep going?');
  assert.deepEqual(reply.recovery.options, [{ id: 'continue', label: 'Keep going' }]);
  assert.match(reply.content, /finished the scan/);
  assert.equal(/step limit|32-step/i.test(reply.content), false);
  const chosen = await request(`/${created.conversation.id}/messages/${reply.id}/choice`, 'POST', { choice: 'continue' });
  assert.equal(chosen.status, 200);
  const deadline = Date.now() + 2000;
  while (!seen.includes('Continue') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(seen, ['Look at this', 'Continue']);
  const after = await (await request(`/${created.conversation.id}`)).json();
  assert.equal(after.conversation.messages.find(row => row.id === reply.id).recovery.choice, 'continue');
  assert.equal(after.conversation.messages.at(-1).content, 'Resumed');
});
