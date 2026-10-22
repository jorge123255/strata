/** Real pinned-TLS bridge -> HostClient -> HTTP routes -> durable team service.
 * Only the models and execution tools are inert; no installed host is contacted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBridge, HostClient } from '../../companion-bridge/bridge.mjs';

async function until(check) { const start = Date.now(); while (!check()) { if (Date.now() - start > 8000) throw Error('Fixture team did not settle'); await new Promise(r => setTimeout(r, 10)); } }

test('paired team room shares real attributed history, semantic invitations, bids/reports and Stop with the Mac', { timeout: 30_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-paired-')), owner = join(directory, 'owner'), pairing = join(directory, 'pairing');
  let bots, chats, bridge, server, port, coordinator, builder, reviewer;
  t.after(async () => { await bridge?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } await bots?.close(); chats?.close(); rmSync(directory, { recursive: true, force: true }); });
  mkdirSync(owner, { recursive: true });
  const calls = [], counters = { localTools: 0, remote: 0 };
  const runtime = { providers: async () => [{ id: 'codex', name: 'Fixture Codex', available: true }], async close() {}, async run(input) {
    const mode = input.bot.teamContext?.channelMode;
    calls.push({ mode, botId: input.bot.id, model: input.bot.model, policy: input.bot.policy, chatId: input.sessionId });
    if (mode !== 'task') {
      assert.equal(input.bot.teamConversationOnly, true);
      assert.ok(!input.bot.instructions.includes('PRIVATE_PROFILE_MARKER'));
      assert.ok(input.tools.every(tool => ['post_team_message', 'read_team_message', 'read_team_results', 'read_team_work', 'invite_teammates', 'assign_team_task', 'update_team_instructions', 'send_to_teammate', 'spawn_subagent', 'list_teammates', 'list_subagents', 'stop_subagent'].includes(tool.name)));
      await assert.rejects(async () => input.executeTool('write_file', {}, 'forbidden'), /conversation|not assigned|unavailable/i);
    }
    if (mode === 'routing' && input.message.startsWith('[The public conversation invitations')) {
      // Greetings need no redundant coordinator acknowledgement.
    } else if (mode === 'routing' && input.message === 'Hi everyone') {
      await input.executeTool('invite_teammates', { botIds: [builder.id, reviewer.id], message: 'Greet the team once as yourself.', purpose: 'conversation' }, 'greeting');
      input.onFrame({ type: 'delta', text: 'Hello from Coordinator' });
    } else if (mode === 'conversation') input.onFrame({ type: 'delta', text: `Hello from ${input.bot.name}` });
    else if (mode === 'routing' && input.message === 'Who wants this draft task?') {
      await input.executeTool('invite_teammates', { botIds: [builder.id, reviewer.id], message: 'Offer which part of this draft you can own.', purpose: 'bid' }, 'bid');
      input.onFrame({ type: 'delta', text: 'Who can own the draft?' });
    } else if (mode === 'bid') input.onFrame({ type: 'delta', text: `${input.bot.name} volunteers to help.` });
    else if (mode === 'routing' && input.message.includes('invited teammates have finished')) {
      await input.executeTool('post_team_message', { message: 'Builder owns the draft; Reviewer is available to help.' }, 'decision');
      await input.executeTool('assign_team_task', { botId: builder.id, message: 'Prepare the bounded fixture draft.' }, 'assign');
      input.onFrame({ type: 'delta', text: 'Builder has the assignment.' });
    } else if (mode === 'task') {
      assert.equal(input.bot.id, builder.id); assert.equal(input.bot.model, 'fixture-builder-model'); assert.equal(input.bot.policy, 'bypass');
      input.onFrame({ type: 'reasoning', text: 'Fixture drafting progress.' }); input.onFrame({ type: 'delta', text: 'The fixture draft is complete.' });
    } else if (mode === 'routing' && input.message === 'Wait for Stop') {
      await new Promise(resolve => { input.signal.addEventListener('abort', resolve, { once: true }); if (input.signal.aborted) resolve(); });
    } else if (mode === 'routing') input.onFrame({ type: 'delta', text: 'The team finished the draft together.' });
    else assert.fail(`Unexpected fixture mode ${mode}`);
    input.onFrame({ type: 'done' });
  } };
  bots = createBots({ directory: owner, defaultWorkspace: () => owner, conversations: () => chats, runtime,
    remoteSSH: { async probe() { counters.remote++; assert.fail('No SSH'); }, async prepare() { counters.remote++; assert.fail('No SSH'); }, async cua() { counters.remote++; assert.fail('No CUA'); } },
    tools: { definitions: () => [], execute: async () => { counters.localTools++; assert.fail('No external tools'); }, finish() {}, close() {} },
  });
  chats = createConversations({ directory: owner, enabled: () => true, validateSelection: v => bots.validateSelection(v), execute: v => bots.run(v), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: v => bots.approve(v) });
  coordinator = bots.create({ name: 'Coordinator', provider: 'codex', model: 'fixture-coordinator-model', workspace: owner, policy: 'bypass', instructions: 'PRIVATE_PROFILE_MARKER' }).bot;
  builder = bots.create({ name: 'Builder', provider: 'codex', model: 'fixture-builder-model', workspace: owner, policy: 'bypass', avatarConfig: { color: 'sky', eyes: 'round', ears: 'small', shape: 'orb' } }).bot;
  reviewer = bots.create({ name: 'Reviewer', provider: 'codex', model: 'fixture-reviewer-model', workspace: owner, policy: 'bypass' }).bot;
  const team = bots.team.create({ name: 'Shared room', memberIds: [coordinator.id, builder.id, reviewer.id], coordinatorId: coordinator.id, enabled: true }).team;
  const routes = createBotRoutes({ bots, port: () => port });
  server = http.createServer(async (req, res) => { try { await routes(req, res, new URL(req.url, `http://${req.headers.host}`)); } catch { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"Fixture host failure"}'); } else res.destroy(); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); port = server.address().port;
  bridge = await createBridge({ directory: pairing, host: new HostClient({ upstream: `http://127.0.0.1:${port}` }), listen: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, adminPort: 0, qr: false });
  const ca = readFileSync(join(pairing, 'server-cert.pem'));
  const request = (path, { method = 'GET', body, token } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, ca, agent: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(text), text }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(payload);
  });
  const paired = await request('/v1/pair', { method: 'POST', body: { code: bridge.authority.code, deviceName: 'Inert fixture phone' } }); assert.equal(paired.status, 200); const token = paired.json.token;
  const path = `/v1/bots/teams/${team.id}`, hostPath = `http://127.0.0.1:${port}/api/bots/teams/${team.id}/channel`;
  assert.equal((await request(path + '/channel', { token })).json.messages.length, 0); assert.equal(calls.length, 0);
  const greet = await request(path + '/messages', { token, method: 'POST', body: { message: 'Hi everyone', requestId: 'greeting_request' } }); assert.equal(greet.status, 200);
  await until(() => !bots.team.detail(team.id, greet.json.run.id).run.state.match(/queued|running/));
  assert.equal(bots.team.detail(team.id, greet.json.run.id).run.state, 'completed', JSON.stringify(bots.team.activity().activity)); assert.equal(calls.length, 4);
  const phone = await request(path + '/channel', { token }), mac = await (await fetch(hostPath)).json();
  assert.deepEqual(phone.json.messages.map(v => v.id), mac.messages.map(v => v.id));
  assert.deepEqual(phone.json.messages.filter(v => v.content.startsWith('Hello from')).map(v => v.author.name).sort(), ['Builder', 'Coordinator', 'Reviewer']);
  assert.equal(phone.json.messages.find(v => v.author.botId === builder.id).author.avatarConfig.shape, 'orb');
  const retry = await request(path + '/messages', { token, method: 'POST', body: { message: 'Hi everyone', requestId: 'greeting_request' } }); assert.equal(retry.json.run.id, greet.json.run.id); assert.equal(calls.length, 4);
  assert.equal((await request(path + '/messages', { token, method: 'POST', body: { message: 'Different', requestId: 'greeting_request' } })).status, 409);
  const bid = await request(path + '/messages', { token, method: 'POST', body: { message: 'Who wants this draft task?', requestId: 'bid_request', recipientIds: [builder.id, reviewer.id], replyToId: phone.json.messages[0].id } }); assert.equal(bid.status, 200);
  await until(() => !bots.team.detail(team.id, bid.json.run.id).run.state.match(/queued|running/));
  assert.equal(bots.team.detail(team.id, bid.json.run.id).run.state, 'completed');
  const result = await request(path + '/channel', { token });
  assert.equal(result.json.messages.filter(v => v.kind === 'assignment').length, 1); assert.ok(result.json.messages.some(v => v.kind === 'report' && v.content.includes('draft is complete')));
  assert.equal(calls.filter(v => v.mode === 'task').length, 1); assert.ok(!result.text.includes('PRIVATE_PROFILE_MARKER'));
  const wait = await request(path + '/messages', { token, method: 'POST', body: { message: 'Wait for Stop', requestId: 'stop_request' } }); assert.equal(wait.status, 200);
  await until(() => bots.team.detail(team.id, wait.json.run.id).run.state === 'running');
  const stopped = await request(path + `/runs/${wait.json.run.id}/stop`, { token, method: 'POST', body: {} }); assert.equal(stopped.status, 200); assert.equal(stopped.json.run.state, 'cancelled');
  const afterStop = await request(path + '/channel?after=0', { token }); assert.equal(afterStop.status, 200); assert.equal(afterStop.json.activeRuns.length, 0);
  assert.deepEqual(counters, { localTools: 0, remote: 0 });
  for (const call of calls) assert.equal(call.model, `fixture-${call.botId === coordinator.id ? 'coordinator' : call.botId === builder.id ? 'builder' : 'reviewer'}-model`);
});
