/** Additive unified-roster captions use public team history only. No provider is run. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createTeamChannels } from '../server/bots-team-channel.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBridge, HostClient } from '../../companion-bridge/bridge.mjs';

const files = directory => readdirSync(directory).flatMap(name => { const path = join(directory, name); return statSync(path).isDirectory() ? files(path) : [path]; });
const hashes = directory => Object.fromEntries(files(directory).map(path => [path.slice(directory.length + 1), createHash('sha256').update(readFileSync(path)).digest('hex')]));

test('empty and populated public journal previews are read-only, scalar-safe and allowlisted', t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-roster-caption-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-21T06:00:00.000Z'); const journal = createTeamChannels({ directory, now: () => clock });
  assert.equal(journal.preview('team_empty'), undefined); assert.equal(existsSync(join(directory, 'bot-team-channels.json')), false);
  const content = '😀'.repeat(279) + '🌟' + 'DO_NOT_INCLUDE_THIS_SUFFIX';
  const row = journal.append('team_public', { kind: 'report', author: { type: 'bot', botId: 'bot_public', name: 'Builder', credentials: 'PRIVATE_AUTHOR_KEY', avatarConfig: { private: 'PRIVATE_ARTWORK' } }, content, chatId: 's_private_link', runId: 'tr_private_link', state: 'done' });
  const before = hashes(directory), preview = journal.preview('team_public');
  assert.deepEqual(preview, { id: row.id, sequence: 1, kind: 'report', author: { type: 'bot', botId: 'bot_public', name: 'Builder' }, content: '😀'.repeat(279) + '🌟', createdAt: '2026-10-21T06:00:00.000Z' });
  assert.equal(Array.from(preview.content).length, 280); assert.equal(preview.content.isWellFormed(), true); assert.ok(!JSON.stringify(preview).includes('PRIVATE_')); assert.ok(!JSON.stringify(preview).includes('private_link'));
  preview.author.name = 'Client mutation'; assert.equal(journal.preview('team_public').author.name, 'Builder'); assert.deepEqual(hashes(directory), before);
  clock += 1000; const last = journal.append('team_public', { kind: 'status', author: { type: 'system', name: 'Strata' }, content: 'Visible\0status\ud800' });
  assert.equal(journal.preview('team_public').id, last.id); assert.equal(journal.preview('team_public').content, 'Visiblestatus�');
  const reopened = createTeamChannels({ directory }); assert.deepEqual(reopened.preview('team_public'), journal.preview('team_public'));
});

test('actual team GET and authenticated pinned bridge retain public caption/time without reading private bot chats or starting work', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-roster-wire-')), owner = join(directory, 'owner'), pairing = join(directory, 'pairing');
  mkdirSync(owner);
  let bots, chats, bridge, server, port; const counters = { providerDiscovery: 0, modelTurns: 0, executionTools: 0, httpReads: 0 };
  t.after(async () => { await bridge?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await bots?.close(); chats?.close(); rmSync(directory, { recursive: true, force: true }); });
  function open() {
    bots = createBots({ directory: owner, conversations: () => chats, defaultWorkspace: () => owner, runtime: { providers: async () => { counters.providerDiscovery++; return []; }, run: async () => { counters.modelTurns++; assert.fail('Roster reads cannot run models'); }, close() {} }, tools: { definitions: () => [], execute: async () => { counters.executionTools++; assert.fail('No execution'); }, finish() {}, close() {} } });
    chats = createConversations({ directory: owner, enabled: () => true });
  }
  open(); const a = bots.create({ name: 'Coordinator', provider: 'codex', workspace: owner, policy: 'manual', instructions: 'PRIVATE_PROFILE_MARKER' }).bot;
  const b = bots.create({ name: 'Builder', provider: 'codex', workspace: owner, policy: 'manual' }).bot;
  const room = bots.team.create({ name: 'Shared work', memberIds: [a.id, b.id], coordinatorId: a.id, enabled: true }).team;
  const empty = bots.team.create({ name: 'No messages', memberIds: [a.id, b.id], coordinatorId: a.id }).team;
  const privateChat = bots.createConversation(a.id).conversation;
  chats.sync([{ session: { ...privateChat, messages: [{ id: 'm_private', role: 'assistant', content: 'PRIVATE_CHAT_MARKER' }] }, baseRevision: privateChat.revision }]);
  bots.work.update(a.id, { memory: 'PRIVATE_MEMORY_MARKER' }); await bots.close(); chats.close();
  const journal = createTeamChannels({ directory: owner, now: () => Date.parse('2026-10-21T08:30:00.000Z') });
  const publicRow = journal.append(room.id, { kind: 'message', author: { type: 'bot', botId: b.id, name: b.name }, content: 'Coordinator, the public review is ready.', chatId: privateChat.id });
  open(); const before = hashes(owner), local = bots.team.list(), preview = local.teams.find(team => team.id === room.id).channelPreview;
  assert.equal(preview.id, publicRow.id); assert.equal(preview.author.name, b.name); assert.equal(preview.createdAt, publicRow.createdAt); assert.ok(!JSON.stringify(preview).includes('PRIVATE_'));
  assert.equal(local.teams.find(team => team.id === empty.id).channelPreview, undefined); assert.equal(local.teams.find(team => team.id === empty.id).createdAt, empty.createdAt);
  bots.team.list(); assert.deepEqual(hashes(owner), before);
  bots.team.update(room.id, { name: 'Renamed work' });
  assert.deepEqual(bots.team.list().teams.find(team => team.id === room.id).channelPreview, preview);
  assert.equal(bots.team.list().teams.find(team => team.id === empty.id).createdAt, empty.createdAt);
  const routes = createBotRoutes({ bots, port: () => port });
  server = http.createServer((req, res) => { counters.httpReads++; void routes(req, res, new URL(req.url, `http://${req.headers.host}`)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  bridge = await createBridge({ directory: pairing, host: new HostClient({ upstream: `http://127.0.0.1:${port}` }), listen: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, adminPort: 0, qr: false });
  const ca = readFileSync(join(pairing, 'server-cert.pem'));
  const request = token => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path: '/v1/bots/teams', method: 'GET', ca, agent: false, headers: token ? { authorization: `Bearer ${token}` } : {} }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text), text })); }); req.on('error', reject); req.end();
  });
  assert.equal((await request()).status, 401); assert.equal(counters.httpReads, 0);
  const { token } = bridge.authority.pair(bridge.authority.code, 'Roster fixture phone'), immutable = hashes(owner);
  const phone = await request(token); assert.equal(phone.status, 200); assert.deepEqual(phone.body.teams.find(team => team.id === room.id).channelPreview, preview);
  assert.equal(phone.body.teams.find(team => team.id === empty.id).channelPreview, undefined); assert.equal(phone.body.teams.find(team => team.id === empty.id).createdAt, empty.createdAt);
  assert.ok(!phone.text.includes('PRIVATE_')); assert.deepEqual(hashes(owner), immutable);
  assert.deepEqual(counters, { providerDiscovery: 0, modelTurns: 0, executionTools: 0, httpReads: 1 });
});
