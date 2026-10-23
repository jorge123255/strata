/** Removed teammates, the 12-member cap, bot deletion, and team deletion. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBotTeams } from '../server/bots-team.mjs';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const live = new Set(['queued', 'running', 'stopping', 'cleanup_pending']);
const removedMessage = 'This bot profile was removed. Its conversations are still in your history.';

function teamFile(directory) {
  return JSON.parse(readFileSync(join(directory, 'bot-teams.json'), 'utf8'));
}
function openTeams(directory, ids, removed = new Set()) {
  const bots = new Map(ids.map(id => [id, { id, name: id, paused: false, policy: 'bypass' }]));
  const requireBot = id => {
    if (removed.has(id) || !bots.has(id)) throw Object.assign(new Error(removedMessage), { status: 404 });
    return bots.get(id);
  };
  const teams = createBotTeams({
    directory, requireBot,
    conversations: () => ({ send() {}, stop: async () => {}, detail: () => ({ conversation: { id: 's', messages: [] } }) }),
    createConversation: () => ({ conversation: { id: `s_${randomUUID()}` } }),
    stopDirect: async () => {},
  });
  return { teams, bots, removed };
}
function host(directory, run = async ({ onFrame }) => { onFrame({ type: 'done', publicReply: 'done' }); }) {
  let chats;
  const bots = createBots({
    directory,
    runtime: { providers: async () => [], run, close() {} },
    tools: { definitions: () => [], finish: async () => {}, close() {} },
    defaultWorkspace: () => directory,
    conversations: () => chats,
  });
  chats = createConversations({
    directory, enabled: () => bots.hasProfiles(), pending: id => bots.pending(id), stop: id => bots.stop(id),
    approve: input => bots.approve(input), validateSelection: selection => bots.validateSelection(selection), execute: input => bots.run(input),
  });
  const create = name => bots.create({ name, provider: 'codex', workspace: directory, policy: 'bypass' }).bot;
  return { bots, chats, create };
}
async function settle(bots, teamId, runId) {
  if (live.has(bots.team.detail(teamId, runId).run.state)) await bots.team.stop(teamId, runId);
  const started = Date.now();
  while (live.has(bots.team.detail(teamId, runId).run.state)) {
    if (Date.now() - started > 4000) throw new Error('Team run stayed active');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function loadDraft() {
  const { code } = await transform(await readFile(new URL('../src/lib/bots.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
async function loadClient() {
  const result = await build({
    stdin: { contents: `export { deleteBotTeam } from ${JSON.stringify(new URL('../src/lib/client.ts', import.meta.url).pathname)};`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node',
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

test('saving a team drops members whose profiles are gone and still requires a newly added bot to exist', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-drop-'));
  const ids = ['bot_a', 'bot_b', 'bot_c'];
  const opened = openTeams(directory, ids);
  t.after(async () => { await opened.teams.close(); rmSync(directory, { recursive: true, force: true }); });
  const briefing = { instructions: 'Ship it', members: [{ botId: 'bot_a', role: 'Lead', instructions: 'Coordinate' }, { botId: 'bot_b', role: 'Build', instructions: 'Implement' }] };
  const team = opened.teams.create({ name: 'Crew', memberIds: ids, coordinatorId: 'bot_a', enabled: true, talkativeness: { bot_a: 90, bot_b: 10 }, selectorBotId: 'bot_a', briefing }).team;
  opened.removed.add('bot_a');
  const saved = opened.teams.update(team.id, { expectedRevision: team.revision, name: 'Crew saved', memberIds: ids, coordinatorId: 'bot_a', selectorBotId: 'bot_a', talkativeness: { bot_a: 90, bot_b: 10 } }).team;
  assert.deepEqual(saved.memberIds, ['bot_b', 'bot_c']);
  assert.equal(saved.coordinatorId, 'bot_b');
  assert.equal(saved.selectorBotId, undefined);
  assert.deepEqual(saved.talkativeness, { bot_b: 10 });
  assert.deepEqual(saved.briefing.members.map(row => row.botId), ['bot_b']);
  assert.equal(saved.name, 'Crew saved');
  const renamed = opened.teams.update(saved.id, { name: 'Name only' }).team;
  assert.equal(renamed.name, 'Name only');
  assert.deepEqual(renamed.memberIds, ['bot_b', 'bot_c']);
  assert.throws(() => opened.teams.update(renamed.id, { memberIds: ['bot_b', 'bot_c', 'bot_missing'], coordinatorId: 'bot_b' }), error => error.status === 404 && error.message === removedMessage);
  assert.deepEqual(opened.teams.list().teams[0].memberIds, ['bot_b', 'bot_c']);
  assert.throws(() => opened.teams.update(renamed.id, { memberIds: ['bot_b', 'bot_c'], coordinatorId: 'bot_missing' }), /coordinator/);
  await opened.teams.close();
  const restored = openTeams(directory, ids, opened.removed);
  t.after(() => restored.teams.close());
  assert.deepEqual(restored.teams.list().teams[0].memberIds, ['bot_b', 'bot_c']);
  assert.equal(restored.teams.list().teams[0].coordinatorId, 'bot_b');
});

test('an over-cap team can keep or shrink its roster, and can add only when the result is 12 or fewer', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-cap-'));
  const ids = Array.from({ length: 14 }, (_, index) => `bot_${index}`);
  const opened = openTeams(directory, [...ids, 'bot_extra']);
  t.after(async () => { await opened.teams.close(); rmSync(directory, { recursive: true, force: true }); });
  const created = opened.teams.create({ name: 'Large', memberIds: ids.slice(0, 2), coordinatorId: ids[0], enabled: false }).team;
  assert.throws(() => opened.teams.create({ name: 'Too many', memberIds: ids.slice(0, 13), coordinatorId: ids[0] }), /2 to 12/);
  await opened.teams.close();
  const saved = teamFile(directory);
  saved.teams[0].memberIds = ids;
  saved.teams[0].coordinatorId = ids[0];
  writeFileSync(join(directory, 'bot-teams.json'), JSON.stringify(saved));
  const reopened = openTeams(directory, [...ids, 'bot_extra']);
  t.after(() => reopened.teams.close());
  const kept = reopened.teams.update(created.id, { name: 'Kept' }).team;
  assert.equal(kept.name, 'Kept');
  assert.deepEqual(kept.memberIds, ids);
  assert.throws(() => reopened.teams.update(created.id, { memberIds: [...ids, 'bot_extra'], coordinatorId: ids[0] }), /12 or fewer/);
  assert.throws(() => reopened.teams.update(created.id, { memberIds: [...ids.slice(0, 13), 'bot_extra'], coordinatorId: ids[0] }), /12 or fewer/);
  assert.deepEqual(reopened.teams.list().teams[0].memberIds, ids);
  const stillOver = reopened.teams.update(created.id, { memberIds: ids.slice(0, 13), coordinatorId: ids[0] }).team;
  assert.deepEqual(stillOver.memberIds, ids.slice(0, 13));
  const addedAtCap = reopened.teams.update(created.id, { memberIds: [...ids.slice(0, 11), 'bot_extra'], coordinatorId: ids[0] }).team;
  assert.equal(addedAtCap.memberIds.length, 12);
  assert.equal(addedAtCap.memberIds.at(-1), 'bot_extra');
  assert.throws(() => reopened.teams.update(created.id, { memberIds: [...addedAtCap.memberIds, ids[12]], coordinatorId: ids[0] }), /2 to 12/);
});

test('deleting a bot removes it from every team roster, coordinator, talkativeness and selector', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-forget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const active = host(directory);
  t.after(async () => { await active.bots.close(); active.chats.close(); });
  const ada = active.create('Ada'), bea = active.create('Bea'), cam = active.create('Cam'), dee = active.create('Dee');
  const crew = active.bots.team.create({ name: 'Crew', memberIds: [ada.id, bea.id, cam.id], coordinatorId: ada.id, enabled: true, talkativeness: { [ada.id]: 80, [bea.id]: 15 }, selectorBotId: ada.id, briefing: { instructions: 'Build', members: [{ botId: ada.id, role: 'Lead', instructions: 'Steer' }, { botId: bea.id, role: 'Build', instructions: 'Code' }] } }).team;
  const side = active.bots.team.create({ name: 'Side', memberIds: [bea.id, ada.id, dee.id], coordinatorId: bea.id, enabled: true, selectorBotId: dee.id, talkativeness: { [ada.id]: 70, [dee.id]: 5 } }).team;
  const pair = active.bots.team.create({ name: 'Pair', memberIds: [ada.id, cam.id], coordinatorId: ada.id, enabled: true }).team;
  const untouched = active.bots.team.create({ name: 'Untouched', memberIds: [bea.id, dee.id], coordinatorId: dee.id, enabled: true }).team;
  const pairNote = active.bots.team.message(pair.id, { message: 'Pair note', requestId: 'pair-note' });
  await settle(active.bots, pair.id, pairNote.run.id);
  active.bots.markTeamRead(pair.id, {});
  const otherNote = active.bots.team.message(untouched.id, { message: 'Stay', requestId: 'stay-note' });
  await settle(active.bots, untouched.id, otherNote.run.id);
  active.bots.markTeamRead(untouched.id, {});
  assert.equal(active.bots.remove(ada.id).deleted, ada.id);
  const teams = Object.fromEntries(active.bots.team.list().teams.map(team => [team.name, team]));
  assert.equal(teams.Pair, undefined);
  assert.deepEqual(teams.Crew.memberIds, [bea.id, cam.id]);
  assert.equal(teams.Crew.coordinatorId, bea.id);
  assert.equal(teams.Crew.selectorBotId, undefined);
  assert.deepEqual(teams.Crew.talkativeness, { [bea.id]: 15 });
  assert.deepEqual(teams.Crew.briefing.members.map(row => row.botId), [bea.id]);
  assert.deepEqual(teams.Side.memberIds, [bea.id, dee.id]);
  assert.equal(teams.Side.coordinatorId, bea.id);
  assert.equal(teams.Side.selectorBotId, dee.id);
  assert.deepEqual(teams.Side.talkativeness, { [dee.id]: 5 });
  assert.deepEqual(teams.Untouched.memberIds, [bea.id, dee.id]);
  const channels = JSON.parse(readFileSync(join(directory, 'bot-team-channels.json'), 'utf8'));
  assert.equal(channels.channels.some(row => row.teamId === pair.id), false);
  assert.equal(channels.receipts.some(row => row.teamId === pair.id), false);
  assert.equal(channels.channels.some(row => row.teamId === untouched.id && row.messages.some(message => message.content === 'Stay')), true);
  const reads = JSON.parse(readFileSync(join(directory, 'bot-reads.json'), 'utf8'));
  assert.equal(Object.hasOwn(reads.teams, pair.id), false);
  assert.equal(typeof reads.teams[untouched.id], 'number');
  assert.equal(active.bots.summary().rooms.some(room => room.id === pair.id), false);
  assert.equal(active.bots.summary().rooms.some(room => room.id === untouched.id), true);
  await active.bots.close();
  active.chats.close();
  const restored = host(directory);
  t.after(async () => { await restored.bots.close(); restored.chats.close(); });
  const again = Object.fromEntries(restored.bots.team.list().teams.map(team => [team.name, team]));
  assert.equal(again.Pair, undefined);
  assert.deepEqual(again.Crew.memberIds, [bea.id, cam.id]);
  assert.equal(again.Crew.coordinatorId, bea.id);
  assert.equal(again.Side.coordinatorId, bea.id);
});

test('DELETE /api/bots/teams/:id removes the team, its channel and its room read', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-delete-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let releaseHold = () => {}, holdRun = false;
  const held = new Promise(resolve => { releaseHold = resolve; });
  const active = host(directory, async ({ onFrame }) => { if (holdRun) await held; onFrame({ type: 'done', publicReply: 'done' }); });
  t.after(async () => { await active.bots.close(); active.chats.close(); });
  const ada = active.create('Ada'), bea = active.create('Bea'), cam = active.create('Cam');
  const gone = active.bots.team.create({ name: 'Gone', memberIds: [ada.id, bea.id], coordinatorId: ada.id, enabled: true }).team;
  const kept = active.bots.team.create({ name: 'Kept', memberIds: [bea.id, cam.id], coordinatorId: cam.id, enabled: true }).team;
  const goneNote = active.bots.team.message(gone.id, { message: 'Delete me', requestId: 'delete-me' });
  await settle(active.bots, gone.id, goneNote.run.id);
  active.bots.markTeamRead(gone.id, {});
  const keptNote = active.bots.team.message(kept.id, { message: 'Keep me', requestId: 'keep-me' });
  await settle(active.bots, kept.id, keptNote.run.id);
  active.bots.markTeamRead(kept.id, {});
  const server = http.createServer((req, res) => { routes(req, res, new URL(req.url, `http://127.0.0.1:${server.address().port}`)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const routes = createBotRoutes({ bots: active.bots, port });
  const headers = { Origin: origin };
  holdRun = true;
  const busy = active.bots.team.start(gone.id, { message: 'Hold', requestId: 'hold' });
  const denied = await fetch(`${origin}/api/bots/teams/${gone.id}`, { method: 'DELETE', headers });
  assert.equal(denied.status, 409);
  assert.match((await denied.json()).error, /Stop this team/);
  releaseHold();
  await settle(active.bots, gone.id, busy.run.id);
  const bodied = await fetch(`${origin}/api/bots/teams/${gone.id}`, { method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bodied.status, 400);
  const queried = await fetch(`${origin}/api/bots/teams/${gone.id}?force=1`, { method: 'DELETE', headers });
  assert.equal(queried.status, 400);
  const missing = await fetch(`${origin}/api/bots/teams/team_${randomUUID()}`, { method: 'DELETE', headers });
  assert.equal(missing.status, 404);
  const { deleteBotTeam } = await loadClient();
  const previous = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => previous(new URL(url, origin), { ...options, headers: { ...headers, ...options.headers } });
  t.after(() => { globalThis.fetch = previous; });
  assert.deepEqual(await deleteBotTeam(gone.id), { deleted: gone.id });
  assert.equal(active.bots.team.list().teams.some(team => team.id === gone.id), false);
  assert.equal(active.bots.team.list().teams.some(team => team.id === kept.id), true);
  assert.throws(() => active.bots.team.channel(gone.id), error => error.status === 404);
  const channels = JSON.parse(readFileSync(join(directory, 'bot-team-channels.json'), 'utf8'));
  assert.equal(channels.channels.some(row => row.teamId === gone.id), false);
  assert.equal(channels.receipts.some(row => row.teamId === gone.id), false);
  assert.equal(channels.channels.some(row => row.teamId === kept.id && row.messages.some(message => message.content === 'Keep me')), true);
  const reads = JSON.parse(readFileSync(join(directory, 'bot-reads.json'), 'utf8'));
  assert.equal(Object.hasOwn(reads.teams, gone.id), false);
  assert.equal(typeof reads.teams[kept.id], 'number');
  assert.equal(active.bots.summary().rooms.map(room => room.id).includes(gone.id), false);
  const again = await fetch(`${origin}/api/bots/teams/${gone.id}`, { method: 'DELETE', headers });
  assert.equal(again.status, 404);
});

test('the team editor accepts a saved missing member and an over-cap roster that does not grow', async () => {
  const { botTeamDraftError, DEFAULT_BOT_TEAM_LIMITS } = await loadDraft();
  const roster = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const draft = { name: 'Crew', memberIds: ['a', 'b', 'gone'], coordinatorId: 'a', limits: DEFAULT_BOT_TEAM_LIMITS };
  assert.equal(botTeamDraftError(draft, roster, undefined, false, false, ['a', 'b', 'gone']), null);
  assert.match(botTeamDraftError({ ...draft, memberIds: ['a', 'b', 'gone', 'missing'] }, roster, undefined, false, false, ['a', 'b', 'gone']), /available bots/);
  assert.match(botTeamDraftError({ ...draft, memberIds: ['a', 'missing'] }, roster), /available bots/);
  const big = Array.from({ length: 14 }, (_, index) => `m${index}`);
  const bigRoster = big.map(id => ({ id }));
  const bigDraft = { name: 'Big', memberIds: big, coordinatorId: big[0], limits: DEFAULT_BOT_TEAM_LIMITS };
  assert.equal(botTeamDraftError(bigDraft, bigRoster, undefined, false, false, big), null);
  assert.equal(botTeamDraftError({ ...bigDraft, memberIds: big.slice(0, 13) }, bigRoster, undefined, false, false, big), null);
  assert.match(botTeamDraftError({ ...bigDraft, memberIds: [...big, 'extra'] }, [...bigRoster, { id: 'extra' }], undefined, false, false, big), /12 or fewer/);
  assert.equal(botTeamDraftError({ ...bigDraft, memberIds: [...big.slice(0, 11), 'extra'] }, [...bigRoster, { id: 'extra' }], undefined, false, false, big), null);
  assert.match(botTeamDraftError(bigDraft, bigRoster), /2 to 12/);
});
