import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotMcp } from '../server/bots-mcp.mjs';

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('The disposable team run did not settle.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('real team grants apply only during the bound team run, including saved task continuations', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-connectors-'));
  let bots, chats;
  const observed = [];
  const mcp = createBotMcp({
    directory,
    hasBot: id => bots?.hasBot(id) === true,
    hasTeam: id => bots?.hasTeam(id) === true,
    teamAccess: (teamId, botId, runId) => bots?.teamConnectorAccess(teamId, botId, runId) === true,
    clientFactory: async () => ({
      listTools: async () => ({ tools: [{ name: 'read_fixture', description: 'Read the inert fixture.', inputSchema: { type: 'object' } }] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'Inert fixture result' }] }),
      close: async () => {},
    }),
  });
  bots = createBots({
    directory, mcp, defaultWorkspace: () => directory, conversations: () => chats,
    runtime: {
      providers: async () => [{ id: 'codex', available: true }], close() {},
      async run(input) {
        const found = await input.executeTool('search_tools', { query: '' }, `search-${observed.length}`);
        observed.push({ message: input.message, tools: JSON.parse(found.content[0].text).tools });
        input.onFrame({ type: 'delta', text: 'Fixture finished.' });
        input.onFrame({ type: 'done' });
      },
    },
    tools: { definitions: () => [], finish() {}, close() {} },
  });
  chats = createConversations({ directory, enabled: () => true, validateSelection: selection => bots.validateSelection(selection), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), execute: input => bots.run(input) });
  t.after(async () => { await bots.close(); await mcp.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = name => bots.create({ name, provider: 'codex', policy: 'bypass', workspace: directory }).bot;
  const owner = create('Coordinator'), builder = create('Builder'), outsider = create('Outside bot');
  const team = bots.team.create({ name: 'Connected team', memberIds: [owner.id, builder.id], coordinatorId: owner.id, enabled: true }).team;
  const other = bots.team.create({ name: 'Other team', memberIds: [owner.id, outsider.id], coordinatorId: owner.id, enabled: true }).team;
  const created = mcp.create({ name: 'Team service', transport: 'http', url: 'https://fixture.invalid/mcp', teamIds: [team.id] }).connection;
  await mcp.check(created.id);
  const inventory = mcp.list().connections[0];
  mcp.update(created.id, { enabledToolIds: inventory.tools.map(tool => tool.id), expectedInventoryDigest: inventory.inventoryDigest });

  const privateChat = bots.createConversation(owner.id).conversation;
  chats.send(privateChat.id, 'Private fixture');
  await until(() => !chats.detail(privateChat.id).conversation.active);
  assert.equal(observed.at(-1).tools.length, 0, 'team membership alone grants no private-chat access');

  const started = bots.team.start(team.id, { message: 'Use the connected team fixture' }).run;
  assert.equal(bots.teamConnectorAccess(team.id, owner.id, started.id), true);
  assert.equal(bots.teamConnectorAccess(other.id, owner.id, started.id), false);
  assert.equal(bots.teamConnectorAccess(team.id, outsider.id, started.id), false);
  await until(() => bots.team.detail(team.id, started.id).run.state === 'completed');
  assert.equal(observed.at(-1).tools[0]?.name, 'read_fixture');
  assert.equal(bots.teamConnectorAccess(team.id, owner.id, started.id), false);

  chats.send(started.rootChatId, 'Continue the saved fixture after its team run finished');
  await until(() => !chats.detail(started.rootChatId).conversation.active);
  assert.equal(observed.at(-1).tools.length, 0, 'frozen team assignments are revoked when their run finishes');

  const foreign = bots.team.start(other.id, { message: 'Use the unrelated team fixture' }).run;
  await until(() => bots.team.detail(other.id, foreign.id).run.state === 'completed');
  assert.equal(observed.at(-1).tools.length, 0, 'a shared member does not bridge connector access across teams');
});
