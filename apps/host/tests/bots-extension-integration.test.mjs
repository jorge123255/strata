import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotSkills } from '../server/bots-skills.mjs';
import { createBotMcp } from '../server/bots-mcp.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function reviewAndEnable(service, id) { const skill = service.list().skills.find(s => s.id === id); return service.update(id, { status: 'enabled', expectedRevision: skill.revision, expectedDigest: skill.digest }); }
function updateAccess(service, id, input) { const connection = service.list().connections.find(c => c.id === id); return service.update(id, { ...input, expectedInventoryDigest: connection.inventoryDigest }); }
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Fixture condition did not become true.'); }
function fixture(t, run, clientFactory) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-extension-integration-')); let bots, chats;
  const skills = createBotSkills({ directory, hasBot: id => bots?.hasBot(id) === true });
  const mcp = createBotMcp({ directory, hasBot: id => bots?.hasBot(id) === true, ...(clientFactory ? { clientFactory } : {}) });
  bots = createBots({ directory, skills, mcp, runtime: { run, models: async () => ({ models: [] }), providers: async () => [{ id: 'codex', available: true }], close() {} }, tools: { definitions: () => [], execute: () => { throw new Error('No computer tools in this fixture.'); }, finish() {}, close() {} }, defaultWorkspace: () => directory, conversations: () => chats });
  chats = createConversations({ directory, enabled: () => true, validateSelection: selection => bots.validateSelection(selection), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: options => bots.approve(options), execute: args => bots.run(args) });
  const bot = bots.create({ name: 'Fixture bot', provider: 'codex', policy: 'manual', workspace: directory }).bot;
  t.after(async () => { await bots.close(); await mcp.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, bot, bots, chats, skills, mcp };
}
test('actual bot conversations freeze assigned skills and share one completed tool card and thinking stream', async t => {
  const f = fixture(t, async input => {
    assert.match(input.bot.instructions, /Original reviewed instructions/);
    const skill = await input.executeTool('read_skill', { id: f.skillId }, 'read-owned-skill');
    assert.equal(JSON.parse(skill.content[0].text).body, 'Original reviewed instructions');
    input.onFrame({ type: 'reasoning', text: 'Checking assigned instructions.' }); input.onFrame({ type: 'delta', text: 'Shared result.' });
  });
  const { skill } = f.skills.create({ name: 'Procedure', body: 'Original reviewed instructions' }); f.skillId = skill.id;
  reviewAndEnable(f.skills, skill.id); f.skills.assign({ botId: f.bot.id, skillIds: [skill.id] });
  const chat = f.bots.createConversation(f.bot.id).conversation;
  f.skills.update(skill.id, { body: 'New unreviewed instructions' }); f.chats.send(chat.id, 'Use the assigned skill');
  await until(() => !f.chats.detail(chat.id).conversation.active); const saved = f.chats.detail(chat.id).conversation;
  assert.equal(saved.messages.at(-1).content, 'Shared result.'); assert.equal(saved.messages.at(-1).reasoning, 'Checking assigned instructions.');
  assert.equal(saved.messages.at(-1).tools.length, 1); assert.equal(saved.messages.at(-1).tools[0].state, 'done');
  const publicCatalog = JSON.stringify(await f.bots.list()); assert.ok(!publicCatalog.includes('extensionSnapshots')); assert.ok(!publicCatalog.includes('Original reviewed instructions'));
});
test('bot-authored drafts use the real shared approval identity and remain disabled until owner review', async t => {
  const f = fixture(t, async input => { await input.executeTool('draft_skill', { name: 'Learned procedure', body: 'Review this first.' }, 'draft-call-1'); input.onFrame({ type: 'delta', text: 'Draft saved for review.' }); });
  const chat = f.bots.createConversation(f.bot.id).conversation; f.chats.send(chat.id, 'Draft a procedure'); await until(() => f.bots.pending(chat.id).length > 0);
  assert.equal(f.bots.pending(chat.id)[0].callId, 'draft-call-1'); assert.equal(f.skills.list().skills.length, 0);
  await f.chats.approval(chat.id, 'draft-call-1', 'approve'); await until(() => !f.chats.detail(chat.id).conversation.active);
  const draft = f.skills.list().skills[0]; assert.equal(draft.status, 'draft'); assert.equal(draft.provenance.botId, f.bot.id); assert.equal(draft.provenance.chatId, chat.id);
  const cards = f.chats.detail(chat.id).conversation.messages.at(-1).tools; assert.equal(cards.length, 1); assert.equal(cards[0].id, 'draft-call-1'); assert.equal(cards[0].state, 'done');
});
test('shared Stop waits for an owned MCP connection to close before acknowledging cleanup', async t => {
  let called, closing, release;
  const callBegan = new Promise(resolve => { called = resolve; }), closeBegan = new Promise(resolve => { closing = resolve; }), closeGate = new Promise(resolve => { release = resolve; });
  let inCall = false;
  const f = fixture(t, async input => { await input.executeTool('call_tool', { toolId: f.toolId, arguments: {} }, 'mcp-stop-call'); }, async () => ({ listTools: async () => ({ tools: [{ name: 'waiting_fixture', inputSchema: { type: 'object' } }] }), callTool: async (_, { signal }) => { inCall = true; called(); return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }); }, close: async () => { if (inCall) { closing(); await closeGate; } } }));
  f.bots.update(f.bot.id, { policy: 'bypass' }); const c = f.mcp.create({ name: 'Owned fixture', transport: 'http', url: 'https://fixture.invalid/mcp', botIds: [f.bot.id] }).connection; await f.mcp.check(c.id);
  f.toolId = f.mcp.list().connections[0].tools[0].id; updateAccess(f.mcp, c.id, { enabledToolIds: [f.toolId] });
  const chat = f.bots.createConversation(f.bot.id).conversation; f.chats.send(chat.id, 'Wait for Stop'); await callBegan;
  let finished = false; const stopped = f.chats.stop(chat.id).then(value => { finished = true; return value; }); await closeBegan; await tick(); assert.equal(finished, false);
  release(); await stopped; assert.equal(finished, true); assert.equal(f.chats.detail(chat.id).conversation.active, false);
});
