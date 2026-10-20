import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const { code } = await transform(await readFile(new URL('../src/lib/bots.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const bots = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('all five providers are independent from the model server registry', () => {
  assert.deepEqual(bots.BOT_PROVIDERS.map(provider => provider.id), ['claude', 'codex', 'grok', 'kimi', 'ollama']);
  const profile = bots.blankBot('/work/project');
  assert.equal(profile.policy, 'manual');
  assert.equal(profile.capabilities, 'both');
  assert.equal(profile.workspace, '/work/project');
  assert.deepEqual(profile.execution, { kind: 'local' });
  assert.equal(profile.providerSettings, undefined);
  assert.equal(profile.remoteModel, undefined);
});

test('bot history follows identity even when providers and computers overlap', () => {
  const sessions = [
    { id: 'regular', updatedAt: '2026-10-20', preferences: { remoteModel: { connectionId: 'maya', modelId: 'maya' } } },
    { id: 'old', updatedAt: '2026-10-18', preferences: { botId: 'bot-a' } },
    { id: 'other-bot', updatedAt: '2026-10-21', preferences: { botId: 'bot-b' } },
    { id: 'latest', updatedAt: '2026-10-20', preferences: { botId: 'bot-a' } },
  ];
  const before = structuredClone(sessions);
  assert.deepEqual(bots.botConversations(sessions, 'bot-a').map(session => session.id), ['latest', 'old']);
  assert.deepEqual(sessions, before);
});

test('profiles validate remote targets and provider addresses without requiring a fixed SSH username', () => {
  const draft = { ...bots.blankBot('/work/project'), name: 'Builder', execution: { kind: 'ssh', host: 'my-alias' } };
  assert.equal(bots.botDraftError(draft), null);
  assert.equal(bots.botComputerLabel(draft.execution), 'my-alias');
  assert.equal(bots.botComputerLabel({ kind: 'ssh', host: 'my-host', user: 'any-user', port: 2222 }), 'any-user@my-host:2222');
  assert.match(bots.botDraftError({ ...draft, execution: { kind: 'ssh' } }), /host or alias/);
  assert.match(bots.botDraftError({ ...draft, execution: { kind: 'ssh', host: 'my-alias', port: 0 } }), /1 to 65535/);
  assert.match(bots.botDraftError({ ...draft, execution: { kind: 'ssh', host: 'my-alias', port: 12.5 } }), /1 to 65535/);
  assert.match(bots.botDraftError({ ...draft, providerSettings: { baseURL: 'file:///tmp/model' } }), /HTTP or HTTPS/);
  assert.equal(bots.botDraftError({ ...draft, providerSettings: { baseURL: 'https://ollama.com/v1' } }), null);
});
