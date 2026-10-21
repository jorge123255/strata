/** Disposable host turn fixtures; no native provider, SSH, device or owner chat. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';

async function fixture(t, execute) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-public-reply-'));
  let chats;
  const outcomes = [];
  const bots = createBots({ directory, defaultWorkspace: () => directory, conversations: () => chats,
    runtime: { providers: async () => [], run: execute, close() {} },
    tools: { definitions: () => [], execute: async () => assert.fail('No execution tool expected'), finish: async () => {}, close: async () => {} },
  });
  const originalEnd = bots.team.end;
  bots.team.end = (context, outcome) => { outcomes.push(outcome); return originalEnd(context, outcome); };
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: input => bots.validateSelection(input), execute: input => bots.run(input) });
  const bot = bots.create({ name: 'Fixture bot', provider: 'codex', workspace: directory }).bot;
  const chat = bots.createConversation(bot.id).conversation;
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  chats.send(chat.id, 'Disposable fixture');
  const started = Date.now();
  while (chats.detail(chat.id).conversation.active) {
    if (Date.now() - started > 4000) assert.fail('Fixture turn did not settle');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(outcomes.length, 1);
  return outcomes[0];
}

test('host forwards an explicit terminal public reply without combining preliminary speech', async t => {
  const outcome = await fixture(t, async input => {
    input.onFrame({ type: 'delta', text: 'Preliminary progress.\n' });
    input.onFrame({ type: 'delta', text: 'Final public result.' });
    input.onFrame({ type: 'done', publicReply: 'Final public result.' });
  });
  assert.deepEqual(outcome, { cancelled: false, error: undefined, publicReply: 'Final public result.' });
});

test('an explicit empty public reply is retained instead of falling back to progress text', async t => {
  const outcome = await fixture(t, async input => {
    input.onFrame({ type: 'delta', text: 'Progress only.' });
    input.onFrame({ type: 'done', publicReply: '' });
  });
  assert.equal(Object.hasOwn(outcome, 'publicReply'), true);
  assert.equal(outcome.publicReply, '');
  assert.equal(outcome.cancelled, false);
});

test('unknown or missing final phase retains the existing team transcript fallback', async t => {
  for (const terminal of [{ type: 'done' }, { type: 'done', publicReply: { text: 'Untrusted shape' } }]) {
    await t.test(JSON.stringify(terminal), async child => {
      const outcome = await fixture(child, async input => { input.onFrame({ type: 'delta', text: 'Ordinary result.' }); input.onFrame(terminal); });
      assert.deepEqual(outcome, { cancelled: false, error: undefined });
    });
  }
});

test('provider failure preserves the existing error outcome alongside any terminal text', async t => {
  const outcome = await fixture(t, async input => {
    input.onFrame({ type: 'done', publicReply: 'Partial public result.' });
    throw new Error('Disposable provider failure');
  });
  assert.deepEqual(outcome, { cancelled: false, error: 'Disposable provider failure', publicReply: 'Partial public result.' });
});
