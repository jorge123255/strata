/** Non-author adversarial checks: real manager and journal, no model/network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotActionJournal } from '../server/bots-action-journal.mjs';

async function manager(t, directory = mkdtempSync(join(tmpdir(), 'strata-post-review-'))) {
  let chats, start;
  const started = new Promise(resolve => { start = resolve; });
  const bots = createBots({ directory, conversations: () => chats, defaultWorkspace: () => directory,
    tools: { definitions: () => [], finish: async () => {}, execute: async () => assert.fail('No computer tool is assigned.') },
    runtime: { providers: async () => [], close() {}, async run(input) {
      start(input);
      await new Promise(resolve => { input.signal.addEventListener('abort', resolve, { once: true }); if (input.signal.aborted) resolve(); });
    } },
  });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), validateSelection: input => bots.validateSelection(input), execute: input => bots.run(input) });
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const members = ['Router', 'Peer'].map(name => bots.create({ name, provider: 'codex', workspace: directory, policy: 'bypass' }).bot);
  const team = bots.team.create({ name: 'Independent fixture', coordinatorId: members[0].id, memberIds: members.map(b => b.id), enabled: true }).team;
  bots.team.message(team.id, { requestId: 'human-fixture', message: 'Discuss this isolated fixture only.' });
  const input = await started;
  return { directory, bots, input, room: () => bots.team.channel(team.id).messages, actions: () => bots.harnessActions(input.sessionId).actions };
}

test('invitation validation and conflicting published identities never acquire a public-post no-effect exemption', async t => {
  const f = await manager(t), initial = f.room().length;
  await assert.rejects(f.input.executeTool('invite_teammates', { text: 'Invalid invitation, no recipient authority.' }, 'invalid-invite'));
  assert.equal(f.room().length, initial);
  assert.equal(f.actions().find(a => a.toolName === 'invite_teammates').state, 'uncertain');
  await f.input.executeTool('post_team_message', { message: 'One valid public statement.' }, 'fixed-identity');
  const before = readFileSync(join(f.directory, 'bot-team-channels.json'));
  await assert.rejects(f.input.executeTool('post_team_message', { message: 'Conflicting second statement.' }, 'fixed-identity'), /identity.*different action|different action.*identity/i);
  assert.deepEqual(readFileSync(join(f.directory, 'bot-team-channels.json')), before);
  assert.equal(f.room().filter(m => m.content === 'One valid public statement.').length, 1);
  assert.equal(f.room().some(m => m.content === 'Conflicting second statement.'), false);
  assert.equal(f.actions().find(a => a.toolName === 'post_team_message').state, 'succeeded');
});

test('existing uncertain malformed-post receipt remains byte-identical after loading and corrected future public speech', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-old-post-review-'));
  const journal = createBotActionJournal({ directory: join(directory, 'bots-action-journal') });
  await assert.rejects(journal.execute({ chatId: 's_prior', authority: 'a'.repeat(64), turnId: 'prior-turn', toolCallId: 'prior-post', name: 'post_team_message', args: { text: 'Previously rejected malformed public post.' } }, async () => { throw Object.assign(new Error('Choose supported public team message settings.'), { status: 400 }); }));
  const prior = journal.summary('s_prior').actions[0]; assert.equal(prior.state, 'uncertain');
  const files = [];
  function capture(path) { for (const item of readdirSync(path, { withFileTypes: true })) { const child = join(path, item.name); if (item.isDirectory()) capture(child); else files.push([child, readFileSync(child)]); } }
  capture(directory); assert.ok(files.length);
  const f = await manager(t, directory);
  const invalid = await f.input.executeTool('post_team_message', { text: 'New malformed post.' }, 'new-malformed');
  assert.equal(invalid.isError, true);
  await f.input.executeTool('post_team_message', { message: 'Valid new public statement, not a receipt acknowledgement.' }, 'new-valid');
  const retained = f.bots.harnessActions('s_prior').actions[0];
  assert.deepEqual(retained, prior);
  for (const [path, bytes] of files) assert.deepEqual(readFileSync(path), bytes, `Prior receipt bytes unchanged: ${path}`);
  assert.equal(f.bots.harnessActions('s_prior').counts.uncertain, 1);
  assert.equal(f.actions().find(a => a.state === 'error').toolName, 'post_team_message');
});
