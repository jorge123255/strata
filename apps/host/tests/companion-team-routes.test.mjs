/** Companion team routes: inert providers, temporary files and a loopback server only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotTools } from '../server/bots-tools.mjs';
import { createCompanionTeamRoutes } from '../server/companion-team-routes.mjs';

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const held = signal => new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve(); });

async function fixture(t, run = async () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-companion-team-'));
  let chats, server;
  const page = { goto: async () => {}, url: () => 'https://example.test', screenshot: async () => Buffer.from('fixture'), locator: () => ({ innerText: async () => 'Fixture browser' }) };
  const tools = createBotTools({ directory, browserProbe: () => ({ found: true }), browserFactory: async () => ({ page, close: async () => {} }) });
  const bots = createBots({ directory, defaultWorkspace: () => directory, conversations: () => chats, tools,
    runtime: { providers: async () => [], run, close() {} }, remoteSSH: { run: () => assert.fail('No SSH'), cua: () => assert.fail('No CUA') } });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: input => bots.validateSelection(input), execute: input => bots.run(input) });
  const route = createCompanionTeamRoutes({ bots, port: () => server.address().port });
  server = http.createServer((req, res) => { res.setHeader('access-control-allow-origin', '*'); void route(req, res, new URL(req.url, 'http://localhost')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const make = name => bots.create({ name, provider: 'codex', workspace: directory, computerMode: 'host', capabilities: 'both', policy: 'bypass' }).bot;
  const patch = (teamId, body, headers = {}) => fetch(`${base}/api/companion/teams/${teamId}/members`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { bots, chats, base, make, patch };
}

test('companion team routes reject a non-local origin and keep wildcard CORS off', async t => {
  const f = await fixture(t);
  const a = f.make('QA-TEST-Origin A'), b = f.make('QA-TEST-Origin B');
  const team = f.bots.team.create({ name: 'QA-TEST-Origin', memberIds: [a.id, b.id], coordinatorId: a.id }).team;
  const path = `/api/companion/teams/${team.id}/members`;
  const denied = await fetch(f.base + path, { headers: { origin: 'http://evil.invalid' } });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /Open Strata on this Mac/);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const deniedPatch = await f.patch(team.id, { coordinatorId: b.id }, { origin: 'http://127.0.0.1:9999' });
  assert.equal(deniedPatch.status, 403);
  assert.equal(f.bots.team.list().teams.find(row => row.id === team.id).coordinatorId, a.id);
  const allowed = await fetch(f.base + path);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
});

test('GET members returns the team, per-member roles and a bounded roster', async t => {
  const f = await fixture(t);
  const lead = f.make('QA-TEST-Lead'), builder = f.make('QA-TEST-Builder'), spare = f.make('QA-TEST-Spare');
  const team = f.bots.team.create({ name: 'QA-TEST-Get', memberIds: [lead.id, builder.id], coordinatorId: lead.id,
    briefing: { instructions: 'QA-TEST brief', members: [{ botId: lead.id, role: 'Lead' }, { botId: builder.id, role: 'Build' }] } }).team;
  const response = await fetch(`${f.base}/api/companion/teams/${team.id}/members`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.team, { id: team.id, name: 'QA-TEST-Get', memberIds: [lead.id, builder.id], coordinatorId: lead.id, revision: 1 });
  assert.deepEqual(body.members, [
    { id: lead.id, name: 'QA-TEST-Lead', role: 'Lead', paused: false, available: true },
    { id: builder.id, name: 'QA-TEST-Builder', role: 'Build', paused: false, available: true },
  ]);
  assert.deepEqual(body.roster.map(row => row.id).sort(), [lead.id, builder.id, spare.id].sort());
  assert.ok(body.roster.every(row => Object.keys(row).sort().join(',') === 'id,name,paused'));
});

test('PATCH adds a member, removes a member and changes the coordinator with revision bumps', async t => {
  const f = await fixture(t);
  const a = f.make('QA-TEST-Edit A'), b = f.make('QA-TEST-Edit B'), c = f.make('QA-TEST-Edit C');
  const team = f.bots.team.create({ name: 'QA-TEST-Edit', memberIds: [a.id, b.id], coordinatorId: a.id }).team;
  const added = await (await f.patch(team.id, { memberIds: [a.id, b.id, c.id], expectedRevision: 1 })).json();
  assert.deepEqual(added.team.memberIds, [a.id, b.id, c.id]);
  assert.equal(added.team.revision, 2);
  const removed = await (await f.patch(team.id, { memberIds: [a.id, c.id] })).json();
  assert.deepEqual(removed.team.memberIds, [a.id, c.id]);
  assert.equal(removed.team.revision, 3);
  const changed = await (await f.patch(team.id, { coordinatorId: c.id, expectedRevision: 3 })).json();
  assert.equal(changed.team.coordinatorId, c.id);
  assert.equal(changed.team.revision, 4);
  assert.deepEqual(f.bots.team.list().teams.find(row => row.id === team.id).memberIds, [a.id, c.id]);
});

test('PATCH passes the shared member validation through unchanged', async t => {
  const f = await fixture(t);
  const a = f.make('QA-TEST-Valid A'), b = f.make('QA-TEST-Valid B'), c = f.make('QA-TEST-Valid C');
  const team = f.bots.team.create({ name: 'QA-TEST-Valid', memberIds: [a.id, b.id], coordinatorId: a.id }).team;
  const coordinatorOutside = await f.patch(team.id, { coordinatorId: c.id });
  assert.equal(coordinatorOutside.status, 400);
  assert.match((await coordinatorOutside.json()).error, /coordinator/);
  const tooFew = await f.patch(team.id, { memberIds: [a.id] });
  assert.equal(tooFew.status, 400);
  assert.match((await tooFew.json()).error, /at least two/);
  const unknown = await f.patch(team.id, { memberIds: [a.id, b.id, `bot_${randomUUID()}`] });
  assert.equal(unknown.status, 404);
  const extras = Array.from({ length: 11 }, (_, index) => f.make(`QA-TEST-Valid Extra ${index}`));
  const tooMany = await f.patch(team.id, { memberIds: [a.id, b.id, ...extras.map(bot => bot.id)] });
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /2 to 12/);
  const unexpected = await f.patch(team.id, { memberIds: [a.id, b.id], enabled: false });
  assert.equal(unexpected.status, 400);
  assert.match((await unexpected.json()).error, /supported member settings/);
  const empty = await f.patch(team.id, { expectedRevision: 1 });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /members or a coordinator/);
  const stale = await f.patch(team.id, { coordinatorId: b.id, expectedRevision: 99 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'team_changed');
  assert.deepEqual(f.bots.team.list().teams.find(row => row.id === team.id).memberIds, [a.id, b.id]);
});

test('PATCH during live team work returns 409 team_busy', async t => {
  const running = new Set();
  const f = await fixture(t, async input => { running.add(input.sessionId); await held(input.signal); });
  const a = f.make('QA-TEST-Busy A'), b = f.make('QA-TEST-Busy B');
  const team = f.bots.team.create({ name: 'QA-TEST-Busy', memberIds: [a.id, b.id], coordinatorId: a.id, enabled: true }).team;
  f.bots.team.start(team.id, { message: 'QA-TEST hold', requestId: 'qa-test-hold' });
  await until(() => running.size === 1);
  const busy = await f.patch(team.id, { coordinatorId: b.id });
  assert.equal(busy.status, 409);
  const body = await busy.json();
  assert.equal(body.code, 'team_busy');
  assert.match(body.error, /Stop this team/);
  assert.equal(f.bots.team.list().teams.find(row => row.id === team.id).coordinatorId, a.id);
});

test('unknown teams, traversal and other paths are rejected', async t => {
  const f = await fixture(t);
  const a = f.make('QA-TEST-Path A'), b = f.make('QA-TEST-Path B');
  const team = f.bots.team.create({ name: 'QA-TEST-Path', memberIds: [a.id, b.id], coordinatorId: a.id }).team;
  assert.equal((await fetch(`${f.base}/api/companion/teams/team_${randomUUID()}/members`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/companion/teams/../../secret/members`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/companion/teams/${team.id}`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/companion/teams/${team.id}/members/extra`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/companion/teams/${team.id}/members?force=1`)).status, 400);
  assert.equal((await fetch(`${f.base}/api/companion/teams/${team.id}/members`, { method: 'DELETE' })).status, 405);
  const bodied = await new Promise((resolve, reject) => {
    const raw = http.request(`${f.base}/api/companion/teams/${team.id}/members`, { method: 'GET', headers: { 'content-type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
    raw.on('error', reject); raw.end('{}');
  });
  assert.equal(bodied, 400);
});
