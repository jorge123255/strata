/** Compact polling projections never replace or expose durable full history. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversations } from '../server/conversations.mjs';
import { createConversationRoutes } from '../server/conversation-routes.mjs';
import { createBots } from '../server/bots.mjs';
import { publicConversation } from '../../companion-bridge/bridge.mjs';

const at = '2026-10-21T00:00:00.000Z';
const history = (id, botId = 'bot_fixture', updatedAt = at) => ({ id, title: 'Existing shared history', createdAt: at, updatedAt, workspace: '/fixture/project',
  preferences: { mode: 'manual', botId, botName: 'Builder', botAvatar: '🤖', botAvatarConfig: { color: 'sky', eyes: 'round', ears: 'round' }, botComputer: 'Selected computer', botModel: 'Saved model', botEffort: 'high', botComputerMode: 'cua', teamId: 'team_fixture', teamRunId: 'run_fixture', parentChatId: 'parent_fixture', remoteModel: { apiKey: 'PRIVATE_API_KEY' }, instructions: 'PRIVATE_INSTRUCTIONS' },
  messages: [{ id: id + '_user', role: 'user', content: 'Earlier question', at }, { id: id + '_answer', role: 'assistant', content: '  A useful 🐨 preview. '.repeat(35), model: 'Earlier exact model', reasoning: 'PRIVATE_THINKING', tools: [{ id: 'tool_fixture', state: 'done', result: 'PRIVATE_TOOL_RESULT' }], at }, { id: id + '_blank', role: 'assistant', content: ' \n\t', at }] });
function fixture(t, sessions = []) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-summary-'));
  const file = join(directory, 'conversations.json');
  writeFileSync(file, JSON.stringify({ version: 1, deleted: [], conversations: sessions.map(session => ({ session, revision: 7 })) }));
  const service = createConversations({ directory });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, service };
}

test('compact summaries preserve paired display and full default history without reading transcript payloads', t => {
  const original = history('chat_fixture'), legacy = { ...history('chat_legacy'), preferences: {}, botName: 'Legacy name', mode: 'plan', computerMode: 'host', botEffort: 'low', modelName: 'Legacy selected model', botAvatarConfig: { color: 'orange', eyes: 'happy', ears: 'small' } };
  const invalid = history('chat_invalid'); invalid.preferences.botAvatarConfig = { color: 'sky', eyes: 'round', ears: 'round', apiKey: 'PRIVATE_AVATAR_FIELD' };
  const { service, file } = fixture(t, [original, legacy, invalid]);
  const disk = readFileSync(file), full = service.list();
  assert.deepEqual(full, { available: true, conversations: [original, legacy, invalid].map(session => ({ ...structuredClone(session), revision: 7, active: false, status: null })), activeChatId: null }, 'The default list still returns every original message, tool, Thinking and saved preference.');
  let fullCopies = 0; const clone = globalThis.structuredClone;
  globalThis.structuredClone = value => { if (Array.isArray(value?.messages)) fullCopies++; return clone(value); };
  let compact;
  try { compact = service.list({ summary: true }); } finally { globalThis.structuredClone = clone; }
  assert.equal(fullCopies, 0, 'A compact poll never deep-copies a conversation transcript.');
  assert.deepEqual(compact.conversations.map(row => publicConversation(row, { summary: true })), full.conversations.map(row => publicConversation(row, { summary: true })));
  assert.deepEqual(service.list(), full, 'The legacy/default history contract is unchanged.');
  assert.deepEqual(readFileSync(file), disk, 'Read-only projection does not rewrite the journal.');
  for (const row of compact.conversations) {
    for (const key of ['messages', 'preferences', 'tokensIn', 'tokensOut', 'reasoning', 'tools', 'blocks']) assert.equal(Object.hasOwn(row, key), false, key);
    assert.ok(row.preview.length <= 300);
  }
  for (const secret of ['PRIVATE_API_KEY', 'PRIVATE_INSTRUCTIONS', 'PRIVATE_THINKING', 'PRIVATE_TOOL_RESULT', 'PRIVATE_AVATAR_FIELD']) assert.equal(JSON.stringify(compact).includes(secret), false, secret);
  compact.conversations[0].title = 'Changed metadata'; compact.conversations[0].botAvatarConfig.color = 'orange';
  assert.deepEqual(service.list(), full, 'Returned display objects cannot alter saved history or avatars.');
});

test('compact lists retain current active identity and exact updatedAt ordering; bot IDs include team chats', t => {
  const first = history('first'), newer = history('newer', 'bot_fixture', '2026-10-22T00:00:00.000Z'), other = history('other', 'bot_other');
  const { service } = fixture(t, [first, newer, other]);
  service.begin('first', 'Only the disposable fixture is active');
  const full = service.list(), compact = service.list({ summary: true });
  assert.equal(compact.activeChatId, full.activeChatId); assert.equal(compact.activeChatId, 'first');
  assert.deepEqual(compact.conversations.map(row => [row.id, row.active, row.revision, row.status]), full.conversations.map(row => [row.id, row.active, row.revision, row.status]));
  assert.deepEqual(service.identitiesForBot('bot_fixture'), full.conversations.filter(row => row.preferences.botId === 'bot_fixture').map(row => row.id));
  assert.deepEqual(service.identitiesForBot('missing_bot'), []);
  service.finish('first'); assert.equal(service.list({ summary: true }).activeChatId, null);
});

test('compact polling cannot enable an unavailable history catalog or create a journal', t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-summary-disabled-'));
  const service = createConversations({ directory, enabled: () => false });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  const unavailable = { available: false, conversations: [], activeChatId: null };
  assert.deepEqual(service.list({ summary: true }), unavailable); assert.deepEqual(service.list(), unavailable);
  assert.deepEqual(service.identitiesForBot('bot_fixture'), []); assert.equal(existsSync(join(directory, 'conversations.json')), false);
});

test('bot catalog uses lightweight identities rather than cloning all transcript histories once per bot', async t => {
  const { service, directory } = fixture(t, [history('first'), history('second', 'bot_other')]);
  let fullLists = 0, identityCalls = 0;
  const catalog = { identitiesForBot(id) { identityCalls++; return service.identitiesForBot(id); }, list() { fullLists++; throw Error('Full transcripts must not be fetched for a roster.'); } };
  const bots = createBots({ directory, defaultWorkspace: () => directory, conversations: () => catalog,
    runtime: { providers: async () => [{ id: 'codex', ready: true }], close() {} }, tools: { definitions: () => [], close() {} } });
  t.after(() => bots.close());
  const created = Array.from({ length: 18 }, (_, index) => bots.create({ name: 'Bot ' + index, provider: 'codex', workspace: directory }).bot);
  identityCalls = 0;
  const result = await bots.list();
  assert.equal(result.bots.length, 18); assert.equal(identityCalls, 18); assert.equal(fullLists, 0);
  for (const bot of created) assert.deepEqual(result.bots.find(row => row.id === bot.id).conversations, []);
});

test('summary=1 is additive and keeps the same exact local-origin access boundary', async t => {
  const { service } = fixture(t, [history('fixture')]); let server;
  const route = createConversationRoutes({ conversations: service, port: () => server.address().port });
  server = http.createServer((req, res) => void route(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`, path = '/api/companion/conversations';
  const full = await (await fetch(origin + path)).json();
  const compact = await (await fetch(origin + path + '?summary=1')).json();
  assert.ok(full.conversations[0].messages.length > 0); assert.equal(Object.hasOwn(compact.conversations[0], 'messages'), false);
  for (const value of ['true', '0', 'full']) assert.deepEqual(await (await fetch(origin + path + '?summary=' + value)).json(), full);
  const forbidden = await fetch(origin + path + '?summary=1', { headers: { origin: 'https://untrusted.example' } }); assert.equal(forbidden.status, 403);
  assert.deepEqual(service.list(), full, 'Reading either mode cannot change history.');
});
