import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const { code } = await transform(await readFile(new URL('../src/lib/bots.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { botConversations, botPersonalConversations, botRosterPreview } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('personal chat selection ignores newer team routers, workers and legacy child markers without removing history', () => {
  const chat = (id, day, preferences) => ({ id, updatedAt: `2026-10-${day}T12:00:00Z`, title: id, preferences, messages: [] });
  const sessions = [
    chat('personal-old', '01', { botId: 'ava' }),
    chat('team-root', '20', { botId: 'ava', teamId: 'crew' }),
    chat('legacy-run', '23', { botId: 'ava', teamRunId: 'run' }),
    chat('personal-latest', '15', { botId: 'ava' }),
    chat('legacy-child', '25', { botId: 'ava', parentChatId: 'root' }),
    chat('another-bot', '27', { botId: 'iris' }),
    chat('ordinary-model', '28', {}),
  ];
  const before = structuredClone(sessions);
  assert.deepEqual(botPersonalConversations(sessions, 'ava').map(row => row.id), ['personal-latest', 'personal-old']);
  assert.deepEqual(botConversations(sessions, 'ava').map(row => row.id), ['legacy-child', 'legacy-run', 'team-root', 'personal-latest', 'personal-old']);
  assert.equal(botRosterPreview('ava', sessions).text, 'personal-latest');
  assert.deepEqual(sessions, before, 'Selection never edits or removes shared history.');
});

test('team-only bot has no personal chat or misleading personal preview', () => {
  const sessions = [{ id: 'worker', title: 'Private routing prompt', updatedAt: '2026-10-21', preferences: { botId: 'ava', parentChatId: 'legacy-root' }, messages: [] }];
  assert.deepEqual(botPersonalConversations(sessions, 'ava'), []);
  assert.equal(botRosterPreview('ava', sessions), undefined);
  assert.equal(botConversations(sessions, 'ava').length, 1);
});
