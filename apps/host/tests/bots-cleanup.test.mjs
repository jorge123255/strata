/** Detached folder failure and close ownership; no provider, SSH or guest is started. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';

test('detached uncertain folder cleanup cannot skip browser/tool and runtime closures', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bot-close-'));
  const failure = Object.assign(Error('Fixture remote folder cleanup unconfirmed'), { code: 'ssh_cleanup_unconfirmed' });
  let chats, toolClosures = 0, runtimeClosures = 0, attempts = 0;
  const bots = createBots({ directory, defaultWorkspace: () => directory, conversations: () => chats,
    tools: { definitions: () => [], async finish() {}, async close() { toolClosures++; } },
    runtime: { providers: async () => [], async run(input) { await input.executeHostTool('host_read_file', { path: 'fixture.txt' }, 'folder_read'); }, async close() { runtimeClosures++; } },
    remoteSSH: { async hostFolder(_execution, input) {
      if (input.operation === 'validate') return { path: '/remote/synthetic-project', access: 'read', binding: { device: '1', inode: '2' }, remoteIdentity: 'a'.repeat(64) };
      attempts++; throw failure;
    } },
  });
  chats = createConversations({ directory, enabled: () => true, execute: input => bots.run(input), validateSelection: input => bots.validateSelection(input), stop: id => bots.stop(id) });
  t.after(async () => { await bots.close().catch(() => {}); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const bot = bots.create({ name: 'Fixture remote', provider: 'codex', computerMode: 'cua', workspace: '/workspace', policy: 'bypass', execution: { kind: 'ssh', host: 'fixture.invalid' } }).bot;
  await bots.setHostFolder(bot.id, { expectedUpdatedAt: bot.updatedAt, hostFolder: { path: '/remote/synthetic-project', access: 'read' } });
  const chat = bots.createConversation(bot.id).conversation; chats.send(chat.id, 'Synthetic bounded read');
  const deadline = Date.now() + 3000;
  while (chats.isRunning(chat.id)) { if (Date.now() > deadline) throw Error('Fixture turn did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(attempts, 1); assert.equal(bots.activeCount(), 0);
  await assert.rejects(bots.close(), { code: 'ssh_cleanup_unconfirmed' });
  assert.equal(toolClosures, 1); assert.equal(runtimeClosures, 1);
});
