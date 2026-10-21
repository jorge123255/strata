/** Pure public-briefing fixtures; no models, owner files, SSH or devices. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTeamBriefing, teamBriefingContext, TEAM_BRIEFING_LIMITS } from '../server/bots-team-instructions.mjs';

const ids = ['bot_coordinator', 'bot_builder', 'bot_reviewer'];
const empty = { instructions: '', members: [] };

test('missing briefings preserve empty behavior and replacement clears omitted content', () => {
  assert.deepEqual(normalizeTeamBriefing(undefined, ids), empty);
  assert.deepEqual(normalizeTeamBriefing({}, ids), empty);
  assert.deepEqual(normalizeTeamBriefing({ instructions: '  ' }, ids), empty);
  assert.deepEqual(normalizeTeamBriefing({ members: [{ botId: ids[0] }] }, ids), empty);
  assert.deepEqual(normalizeTeamBriefing({ members: [{ botId: ids[1], role: 'Builder' }] }, ids), { instructions: '', members: [{ botId: ids[1], role: 'Builder', instructions: '' }] });
  assert.equal(teamBriefingContext({ memberIds: ids }), '');
  assert.equal(teamBriefingContext({ memberIds: ids, briefing: empty }, ids[0]), '');
});

test('full replacement is deterministic, detached, trims text and omits empty member rows', () => {
  const supplied = { instructions: '  Work together.\r\nKeep reports concise.  ', members: [
    { botId: ids[2], role: '  Reviewer ', instructions: ' Check evidence.\r\nReport blockers. ' },
    { botId: ids[0], role: '\t ', instructions: '\n' },
    { botId: ids[1], role: 'Builder', instructions: '' },
  ] };
  const before = structuredClone(supplied), normalized = normalizeTeamBriefing(supplied, ids);
  assert.deepEqual(normalized, { instructions: 'Work together.\nKeep reports concise.', members: [
    { botId: ids[1], role: 'Builder', instructions: '' }, { botId: ids[2], role: 'Reviewer', instructions: 'Check evidence.\nReport blockers.' },
  ] });
  assert.deepEqual(supplied, before);
  assert.deepEqual(normalizeTeamBriefing({ ...supplied, members: [...supplied.members].reverse() }, [...ids].reverse()), normalized);
  normalized.members[0].role = 'Changed';
  assert.deepEqual(supplied, before);
});

test('only current member IDs and public briefing fields are accepted', () => {
  const rejected = [null, [], 'instructions', new Date(), { policy: 'bypass' }, { provider: 'devin' }, { execution: { kind: 'ssh' } }, { members: null }, { members: {} }, { members: [null] }, { members: [{ botId: 'bot_outside', role: 'Builder' }] }, { members: [{ botId: ids[1], role: 'Builder', policy: 'bypass' }] }, { members: [{ botId: ids[1] }, { botId: ids[1] }] }, { members: [{ botId: ids[1], instructions: 3 }] }, { instructions: true }];
  for (const input of rejected) assert.throws(() => normalizeTeamBriefing(input, ids), { status: 400 });
  for (const roster of [null, {}, [ids[0], ids[0]], [null], ['../private'], Array.from({ length: 13 }, (_, i) => `bot_${i}`)]) assert.throws(() => normalizeTeamBriefing(undefined, roster), { status: 400 });
  // Empty rows cannot smuggle nonexistent or repeated identities through omission.
  assert.throws(() => normalizeTeamBriefing({ members: [{ botId: 'bot_outside' }] }, ids), { status: 400 });
});

test('bounded UTF-16 text accepts exact limits and rejects oversized or control content', () => {
  assert.equal(normalizeTeamBriefing({ instructions: 'x'.repeat(8000) }, ids).instructions.length, 8000);
  assert.equal(normalizeTeamBriefing({ members: [{ botId: ids[0], role: 'r'.repeat(120), instructions: 'x'.repeat(4000) }] }, ids).members[0].instructions.length, 4000);
  assert.equal(normalizeTeamBriefing({ instructions: '😀'.repeat(4000) }, ids).instructions.length, 8000);
  for (const input of [{ instructions: 'x'.repeat(8001) }, { instructions: '😀'.repeat(4001) }, { members: [{ botId: ids[0], role: 'r'.repeat(121) }] }, { members: [{ botId: ids[0], instructions: 'x'.repeat(4001) }] }, { members: Array.from({ length: 13 }, () => ({ botId: ids[0] })) }]) assert.throws(() => normalizeTeamBriefing(input, ids), { status: 400 });
  for (const control of ['\0', '\u0001', '\b', '\u000b', '\u000c', '\u001b', '\u007f']) assert.throws(() => normalizeTeamBriefing({ instructions: `a${control}b` }, ids), { status: 400 });
  assert.equal(normalizeTeamBriefing({ instructions: '\tUse tabs\nand lines.\r\n' }, ids).instructions, 'Use tabs\nand lines.');
  const many = Array.from({ length: 6 }, (_, i) => `bot_${i}`);
  const members = many.map(botId => ({ botId, instructions: 'x'.repeat(4000) }));
  assert.equal(normalizeTeamBriefing({ members }, many).members.length, 6);
  assert.throws(() => normalizeTeamBriefing({ instructions: 'x', members }, many), { status: 400 });
  assert.equal(Object.isFrozen(TEAM_BRIEFING_LIMITS), true);
});

test('public context uses explicit IDs and roles without reading private bot data', () => {
  const team = { memberIds: ids, briefing: { instructions: 'Share progress.', members: [{ botId: ids[1], role: 'Evidence checker', instructions: 'Check claims before reporting.' }] }, privateInstructions: 'PRIVATE_TEAM_MARKER', profiles: [{ id: ids[1], name: 'Builder', instructions: 'PRIVATE_PROFILE_MARKER', providerSettings: { apiKey: 'PRIVATE_CREDENTIAL_MARKER' } }] };
  const context = teamBriefingContext(team, ids[1]);
  assert.match(context, /Share progress/);
  assert.match(context, /Evidence checker/);
  assert.match(context, /Check claims before reporting/);
  assert.match(context, /Your team member ID is "bot_builder"/);
  assert.match(context, /does not change models, computers, tools or approval policies/);
  assert.match(context, /do not infer responsibilities from names/);
  assert.equal(context.includes('PRIVATE_'), false);
  assert.equal(context.includes('Builder'), false);
  assert.throws(() => teamBriefingContext(team, 'bot_outside'), { status: 400 });
});

test('context is a frozen value per started turn; later turns see new public text', () => {
  const team = { memberIds: ids, briefing: { instructions: 'First instruction', members: [] } };
  const activeTurn = teamBriefingContext(team, ids[0]);
  team.briefing = normalizeTeamBriefing({ instructions: 'Updated next-turn instruction' }, ids);
  const nextTurn = teamBriefingContext(team, ids[0]);
  assert.match(activeTurn, /First instruction/);
  assert.equal(activeTurn.includes('Updated'), false);
  assert.match(nextTurn, /Updated next-turn instruction/);
  assert.equal(nextTurn.includes('First instruction'), false);
});
