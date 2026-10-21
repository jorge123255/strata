import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const { code } = await transform(await readFile(new URL('../src/lib/bots.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { botTeamDraftError, botTeamWorkplace, DEFAULT_BOT_TEAM_LIMITS } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const bots = [{ id: 'ava', name: 'Ava' }, { id: 'bolt', name: 'Bolt' }, { id: 'iris', name: 'Iris' }];
const computers = [{ id: 'host:local', name: 'This Mac', label: 'Direct access to this Mac', computerMode: 'host', workspace: '/project', available: true }, { id: 'host:workshop', name: 'Workshop server', label: 'Saved SSH computer', computerMode: 'host', workspace: '', available: true }, { id: 'cua:ava', memberId: 'ava', name: 'Ava’s computer', label: 'This Mac · Isolated CUA desktop', computerMode: 'cua', workspace: '/workspace', available: true }];
const draft = { name: 'Studio', memberIds: ['ava', 'bolt'], coordinatorId: 'ava', limits: DEFAULT_BOT_TEAM_LIMITS };
test('legacy per-bot teams retain independent saved computers and folders', () => {
  assert.equal(botTeamDraftError(draft, bots), null);
  assert.equal(botTeamDraftError({ ...draft, execution: { mode: 'individual' } }, bots, computers), null);
  assert.deepEqual(botTeamWorkplace(draft), { shared: false, name: 'Each bot’s computer', label: 'Each teammate uses its saved computer.', workspace: 'Each bot’s saved working folder' });
});
test('direct configured Mac and SSH targets do not require an anchor member', () => {
  for (const computerId of ['host:local', 'host:workshop']) assert.equal(botTeamDraftError({ ...draft, memberIds: ['bolt', 'iris'], coordinatorId: 'bolt', execution: { mode: 'shared', computerId, workspace: '/project' } }, bots, computers), null);
  assert.equal(botTeamWorkplace({ execution: { mode: 'shared', computerId: 'host:local', workspace: '/chosen/project' } }, computers, bots).name, 'This Mac');
});
test('shared CUA keeps the owning teammate and only accepts workspace-contained folders', () => {
  for (const workspace of ['/workspace', '/workspace/team/project']) assert.equal(botTeamDraftError({ ...draft, execution: { mode: 'shared', computerId: 'cua:ava', workspace } }, bots, computers), null);
  assert.match(botTeamDraftError({ ...draft, memberIds: ['bolt', 'iris'], coordinatorId: 'bolt', execution: { mode: 'shared', computerId: 'cua:ava', workspace: '/workspace' } }, bots, computers), /Keep the teammate/);
  for (const workspace of ['/tmp/project', '/workspace-other', '/workspace/../private', 'C:\\project']) assert.match(botTeamDraftError({ ...draft, execution: { mode: 'shared', computerId: 'cua:ava', workspace } }, bots, computers), /inside \/workspace/);
});
test('shared execution needs an explicit computer and bounded full working-folder path', () => {
  assert.match(botTeamDraftError({ ...draft, execution: { mode: 'shared', computerId: '', workspace: '/project' } }, bots, computers), /Choose a shared/);
  for (const workspace of ['', 'relative/project', '/bad\0folder', '/' + 'x'.repeat(4096)]) assert.match(botTeamDraftError({ ...draft, execution: { mode: 'shared', computerId: 'host:local', workspace } }, bots, computers), /full working folder/);
  assert.match(botTeamDraftError({ ...draft, coordinatorId: 'iris' }, bots, computers), /coordinator from this team/);
});
test('public team briefings validate exact selected members and UTF-16 per-field and aggregate bounds', () => {
  const good = { instructions: 'Ship and review together.', members: [{ botId: 'bolt', role: 'Reviewer', instructions: 'Review Ava’s changes.' }] };
  assert.equal(botTeamDraftError({ ...draft, briefing: good }, bots), null);
  const error = briefing => botTeamDraftError({ ...draft, briefing }, bots);
  assert.match(error({ ...good, members: [{ ...good.members[0], botId: 'iris' }] }), /selected teammates/);
  assert.match(error({ ...good, members: [good.members[0], good.members[0]] }), /selected teammates/);
  assert.match(error({ ...good, instructions: '😀'.repeat(4001) }), /8,000/);
  assert.match(error({ ...good, members: [{ ...good.members[0], role: '😀'.repeat(61) }] }), /120/);
  assert.match(error({ ...good, members: [{ ...good.members[0], instructions: 'x'.repeat(4001) }] }), /4,000/);
  for (const instructions of ['bad\0text', '\ud800']) assert.ok(error({ ...good, instructions }));
  const roster = Array.from({ length: 5 }, (_, i) => ({ id: `bot${i}` }));
  const large = { ...draft, memberIds: roster.map(bot => bot.id), coordinatorId: 'bot0', briefing: { instructions: '界'.repeat(8000), members: roster.slice(0,4).map(bot => ({ botId: bot.id, role: '', instructions: '界'.repeat(4000) })) } };
  assert.equal(botTeamDraftError(large, roster), null);
  assert.match(botTeamDraftError({ ...large, briefing: { ...large.briefing, members: [...large.briefing.members, { botId: 'bot4', role: 'R', instructions: '' }] } }, roster), /24,000/);
});
