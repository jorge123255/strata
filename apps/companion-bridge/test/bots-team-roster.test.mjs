import test from 'node:test';
import assert from 'node:assert/strict';
import { publicBotWorkspace } from '../bots-workspace.mjs';

const team = { id: 'team_fixture', name: 'Shared room', memberIds: ['bot_one', 'bot_two'], coordinatorId: 'bot_one', enabled: true, createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-21T01:00:00.000Z', limits: { maxParallel: 2, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 } };
const preview = { id: 'tm_public', sequence: 9, kind: 'report', author: { type: 'bot', botId: 'bot_two', name: 'Builder' }, content: 'The public result is ready.', createdAt: '2026-10-21T06:30:00.000Z' };
const project = value => publicBotWorkspace({ teams: [{ ...structuredClone(team), ...(value === undefined ? {} : { channelPreview: value }) }], runs: [], channelsSupported: true }, { kind: 'teams' });

test('paired roster preview preserves only public source caption, author and activity time', () => {
  const raw = structuredClone(preview); raw.credentials = 'PRIVATE_KEY'; raw.chatId = 'PRIVATE_CHAT'; raw.tools = [{ result: 'PRIVATE_TOOL_RESULT' }]; raw.author.avatarConfig = { privatePath: 'PRIVATE_ASSET' }; raw.author.checkpoint = 'PRIVATE_SESSION';
  const result = project(raw); assert.deepEqual(result.teams[0].channelPreview, preview); assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.equal(result.teams[0].createdAt, team.createdAt); assert.equal(result.teams[0].updatedAt, team.updatedAt); assert.equal(result.channelsSupported, true);
  assert.deepEqual(Object.keys(result.teams[0].channelPreview).sort(), ['author', 'content', 'createdAt', 'id', 'kind', 'sequence']);
  assert.deepEqual(Object.keys(result.teams[0].channelPreview.author).sort(), ['botId', 'name', 'type']);
});

test('Unicode preview bound counts code points and never forwards NUL or malformed scalar text', () => {
  const raw = { ...structuredClone(preview), content: '🧑'.repeat(280) };
  assert.equal(project(raw).teams[0].channelPreview.content, raw.content);
  for (const content of ['🧑'.repeat(281), 'a'.repeat(281), 'visible\0PRIVATE', 'lone\ud800', '\udc00']) assert.equal(project({ ...raw, content }).teams[0].channelPreview, undefined);
});

test('malformed optional preview is omitted without hiding the existing team or old-host roster', () => {
  for (const value of [null, 'PRIVATE_RAW', [], {}, { ...preview, id: '../private' }, { ...preview, sequence: 0 }, { ...preview, sequence: 1.5 }, { ...preview, sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...preview, kind: 'private_chat' }, { ...preview, author: null }, { ...preview, author: { type: 'bot', name: 'Missing identity' } }, { ...preview, author: { type: 'admin', name: 'PRIVATE' } }, { ...preview, author: { type: 'bot', botId: 'bot_two', name: '\ud800' } }, { ...preview, author: { type: 'user', name: 'Name\0PRIVATE' } }, { ...preview, createdAt: { secret: 'PRIVATE_DATE' } }, { ...preview, content: { secret: 'PRIVATE_BODY' } }]) {
    const result = project(value); assert.equal(result.teams.length, 1); assert.equal(result.teams[0].id, team.id); assert.equal(result.teams[0].channelPreview, undefined);
  }
  assert.equal(Object.hasOwn(project(undefined).teams[0], 'channelPreview'), false);
  const user = { ...structuredClone(preview), author: { type: 'user', name: 'You', botId: 'PRIVATE_FORGED_BOT' } };
  assert.deepEqual(project(user).teams[0].channelPreview.author, { type: 'user', name: 'You' });
});
