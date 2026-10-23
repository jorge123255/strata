/** TLS bridges, fake upstreams and temporary pairing state only; no real phone or owner services. */
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, HostClient } from '../bridge.mjs';
import { EventHub } from '../../host/server/util.mjs';
import { addConversationEvents } from '../../host/server/conversation-routes.mjs';

const temporary = () => mkdtempSync(join(tmpdir(), 'strata-companion-events-'));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function mockStreamHost() {
  const streams = [];
  return {
    streams,
    async json() { throw new Error('Unexpected QA-TEST json call'); },
    async stream(path, { signal } = {}) {
      assert.equal(path, '/api/events');
      const entry = { cancelled: false, controller: null };
      const body = new ReadableStream({
        start(controller) { entry.controller = controller; },
        cancel() { entry.cancelled = true; },
      });
      entry.push = text => { if (!entry.cancelled) entry.controller.enqueue(new TextEncoder().encode(text)); };
      signal.addEventListener('abort', () => { entry.cancelled = true; try { entry.controller.error(new DOMException('Aborted', 'AbortError')); } catch {} }, { once: true });
      streams.push(entry);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  };
}
async function fixture(t, host = mockStreamHost()) {
  const directory = temporary();
  const bridge = await createBridge({ directory, host, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, discoverEndpoints: async () => [] });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, host };
}
function openEvents(bridge, token, headers = {}) {
  const state = { text: '', status: null, ended: false };
  const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path: '/v1/events', method: 'GET', rejectUnauthorized: false, agent: false,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, response => {
    state.status = response.statusCode;
    response.setEncoding('utf8');
    response.on('data', chunk => { state.text += chunk; });
    response.on('end', () => { state.ended = true; });
  });
  req.on('error', () => { state.ended = true; });
  req.end();
  return { req, state };
}
const progressFrame = state => {
  const frame = state.text.split('\n\n').map(part => part.trim()).find(part => part.startsWith('event: task.progress'));
  return frame ? JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)) : null;
};

test('GET /v1/events requires a paired session and rejects browser origins', async t => {
  const { bridge, host } = await fixture(t);
  const anonymous = openEvents(bridge);
  await until(() => anonymous.state.status !== null);
  assert.equal(anonymous.state.status, 401);
  const { token } = bridge.authority.pair(bridge.authority.code, 'QA-TEST-phone');
  const browser = openEvents(bridge, token, { origin: 'https://qa-test.invalid' });
  await until(() => browser.state.status !== null);
  assert.equal(browser.state.status, 403);
  assert.equal(host.streams.length, 0);
});

test('task.progress crosses the bridge projected; other hub events and extra fields do not', async t => {
  const { bridge, host } = await fixture(t);
  const { token } = bridge.authority.pair(bridge.authority.code, 'QA-TEST-phone');
  const { state } = openEvents(bridge, token);
  await until(() => host.streams.length === 1);
  const upstream = host.streams[0];
  upstream.push(': connected\n\n');
  upstream.push('event: conversation\ndata: {"conversation":{"messages":[{"content":"QA-TEST-SECRET"}]}}\n\n');
  upstream.push('event: task.progress\ndata: {"teamId":"team_ab12","runId":"tr_ab12","jobId":"tj_ab12","botId":"bot_ab12","conversationId":"s_ab12","step":2,"toolName":"write_file","args":{"path":"/QA-TEST-secret"},"text":"QA-TEST-SECRET","extra":"drop"}\n\n');
  await until(() => state.text.includes('event: task.progress'));
  assert.deepEqual(progressFrame(state), { teamId: 'team_ab12', runId: 'tr_ab12', jobId: 'tj_ab12', botId: 'bot_ab12', conversationId: 's_ab12', step: 2, toolName: 'write_file' });
  assert.ok(!state.text.includes('QA-TEST-SECRET'));
  assert.ok(!state.text.includes('event: conversation'));
});

test('revoking the device ends the phone stream and aborts the upstream', async t => {
  const { bridge, host } = await fixture(t);
  const { token, session } = bridge.authority.pair(bridge.authority.code, 'QA-TEST-phone');
  const { state } = openEvents(bridge, token);
  await until(() => host.streams.length === 1);
  host.streams[0].push('event: task.progress\ndata: {"conversationId":"s_ab12","step":1,"toolName":"read_file"}\n\n');
  await until(() => state.text.includes('event: task.progress'));
  bridge.revokeSession(session.id);
  await until(() => host.streams[0].cancelled);
  await until(() => state.ended);
  const received = state.text;
  host.streams[0].push('event: task.progress\ndata: {"conversationId":"s_ab12","step":2,"toolName":"write_file"}\n\n');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(state.text, received);
  const denied = openEvents(bridge, token);
  await until(() => denied.state.status !== null);
  assert.equal(denied.state.status, 401);
});

test('a phone disconnect aborts the upstream stream', async t => {
  const { bridge, host } = await fixture(t);
  const { token } = bridge.authority.pair(bridge.authority.code, 'QA-TEST-phone');
  const { req } = openEvents(bridge, token);
  await until(() => host.streams.length === 1);
  req.destroy();
  await until(() => host.streams[0].cancelled);
});

test('HostClient.stream allows only the hub events path with a caller signal', async () => {
  const calls = [];
  const host = new HostClient({ upstream: 'http://127.0.0.1:9', fetcher: async (url, options) => { calls.push({ url, options }); return new Response('ok'); } });
  const signal = new AbortController().signal;
  await host.stream('/api/events', { signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:9/api/events');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.signal, signal);
  for (const bad of ['/api/chat/stream', '/api/bots/teams/team_ab12/channel/stream', '/api/events?token=1', 'https://qa-test.invalid/api/events']) await assert.rejects(host.stream(bad, { signal }), { status: 403 });
  await assert.rejects(host.stream('/api/events'), { status: 403 });
  assert.equal(calls.length, 1);
  await assert.rejects(host.request('/api/events'), { status: 403 });
  await assert.rejects(host.request('/api/bots/teams/team_ab12/channel/stream'), { status: 403 });
});

async function realHostHub(t, conversations) {
  const hub = new EventHub();
  const hostServer = http.createServer((req, res) => {
    if (req.url === '/api/events') return addConversationEvents({ req, res, hub, conversations, port: hostServer.address().port });
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => hostServer.listen(0, '127.0.0.1', resolve));
  t.after(() => { hostServer.closeAllConnections(); hostServer.close(); });
  return { hub, origin: `http://127.0.0.1:${hostServer.address().port}` };
}

test('the phone stream passes the real host loopback guard and relays hub progress', async t => {
  const { hub, origin } = await realHostHub(t, { list: () => ({ conversations: [] }) });
  const { bridge } = await fixture(t, new HostClient({ upstream: origin }));
  const { token } = bridge.authority.pair(bridge.authority.code, 'QA-TEST-real-phone');
  const { state } = openEvents(bridge, token);
  await until(() => state.status === 200);
  hub.send('task.progress', { conversationId: 's_real1', step: 4, toolName: 'qa_test_real_tool', secret: 'QA-TEST-DROP' });
  await until(() => state.text.includes('event: task.progress'));
  assert.deepEqual(progressFrame(state), { conversationId: 's_real1', step: 4, toolName: 'qa_test_real_tool' });
});

const bigTranscript = () => `QA-TEST-BIG-${'x'.repeat(1_100_000)}`;
const bigConversation = content => ({ id: 's_big', title: 'QA-TEST-big', updatedAt: '2026-10-23T00:00:00Z', revision: 1, active: false, status: null, messages: [{ id: 'm_big', role: 'user', content }] });

test('an over-1MB initial conversation snapshot never crosses and never ends the stream', async t => {
  const content = bigTranscript();
  const { hub, origin } = await realHostHub(t, { list: () => ({ conversations: [bigConversation(content)] }) });
  const { bridge } = await fixture(t, new HostClient({ upstream: origin }));
  const { token } = bridge.authority.pair(bridge.authority.code, 'QA-TEST-big-phone');
  const { state } = openEvents(bridge, token);
  await until(() => state.status === 200);
  hub.send('task.progress', { conversationId: 's_big', step: 1, toolName: 'qa_test_after_big' });
  await until(() => state.text.includes('event: task.progress'));
  assert.deepEqual(progressFrame(state), { conversationId: 's_big', step: 1, toolName: 'qa_test_after_big' });
  assert.ok(!state.text.includes('QA-TEST-BIG'));
  assert.equal(state.ended, false);
});

test('an over-1MB mid-stream conversation update is skipped and later progress still arrives', async t => {
  const { hub, origin } = await realHostHub(t, { list: () => ({ conversations: [] }) });
  const { bridge } = await fixture(t, new HostClient({ upstream: origin }));
  const { token } = bridge.authority.pair(bridge.authority.code, 'QA-TEST-big-phone');
  const { state } = openEvents(bridge, token);
  await until(() => state.status === 200);
  hub.send('task.progress', { conversationId: 's_live', step: 1, toolName: 'qa_test_before_big' });
  await until(() => state.text.includes('qa_test_before_big'));
  hub.send('conversation', { conversation: bigConversation(bigTranscript()) });
  hub.send('task.progress', { conversationId: 's_live', step: 2, toolName: 'qa_test_after_big' });
  await until(() => state.text.includes('qa_test_after_big'));
  assert.ok(!state.text.includes('QA-TEST-BIG'));
  assert.equal(state.ended, false);
  const frames = state.text.split('\n\n').filter(part => part.trim().startsWith('event: task.progress'));
  assert.equal(frames.length, 2);
});

test('frames split across arbitrary chunk boundaries still parse, including skipped giants', async t => {
  const { bridge, host } = await fixture(t);
  const { token } = bridge.authority.pair(bridge.authority.code, 'QA-TEST-phone');
  const { state } = openEvents(bridge, token);
  await until(() => host.streams.length === 1);
  const upstream = host.streams[0];
  const giant = `event: conversation\ndata: {"content":"QA-TEST-CHUNK-${'y'.repeat(300_000)}"}\n\n`;
  for (let i = 0; i < giant.length; i += 4096) upstream.push(giant.slice(i, i + 4096));
  const frame = 'event: task.progress\ndata: {"conversationId":"s_chunk","step":3,"toolName":"qa_test_chunked"}\n\n';
  for (let i = 0; i < frame.length; i += 7) upstream.push(frame.slice(i, i + 7));
  await until(() => state.text.includes('event: task.progress'));
  assert.deepEqual(progressFrame(state), { conversationId: 's_chunk', step: 3, toolName: 'qa_test_chunked' });
  assert.ok(!state.text.includes('QA-TEST-CHUNK'));
  assert.equal(state.ended, false);
});

test('an over-limit task.progress frame is dropped and the stream keeps forwarding', async t => {
  const { bridge, host } = await fixture(t);
  const { token } = bridge.authority.pair(bridge.authority.code, 'QA-TEST-phone');
  const { state } = openEvents(bridge, token);
  await until(() => host.streams.length === 1);
  const upstream = host.streams[0];
  upstream.push(`event: task.progress\ndata: {"conversationId":"s_fat","step":1,"toolName":"qa_test_${'z'.repeat(70_000)}"}\n\n`);
  upstream.push('event: task.progress\ndata: {"conversationId":"s_fat","step":2,"toolName":"qa_test_slim"}\n\n');
  await until(() => state.text.includes('event: task.progress'));
  assert.deepEqual(progressFrame(state), { conversationId: 's_fat', step: 2, toolName: 'qa_test_slim' });
  assert.equal(state.text.split('event: task.progress').length - 1, 1);
  assert.ok(!state.text.includes('zzzz'));
  assert.equal(state.ended, false);
});
