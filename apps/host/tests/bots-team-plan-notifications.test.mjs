/** Actual durable controller/channel/notification paths with inert providers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createBotTools } from '../server/bots-tools.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotNotifications } from '../server/bot-notifications.mjs';

const fakeNative = () => ({ status: async () => ({ available: false, authorization: 'unavailable' }), deliver: async () => assert.fail('No actual OS notification is permitted.'), permission: async () => assert.fail('No permission grant is permitted.'), setBridge() {} });
const fakeApns = () => ({ status: () => ({ configured: false }) });
async function until(check) { const until = Date.now() + 6000; while (!check()) { if (Date.now() > until) throw Error('Disposable plan did not advance.'); await new Promise(resolve => setImmediate(resolve)); } }

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-plan-alert-')), calls = [], releases = new Map(); let chats;
  const bots = createBots({ directory, defaultWorkspace: () => directory, conversations: () => chats, tools: createBotTools({ directory }), runtime: { providers: async () => [], close() {}, async run(input) { calls.push(input); await new Promise(resolve => { releases.set(input.sessionId, resolve); input.signal.addEventListener('abort', resolve, { once: true }); }); if (!input.signal.aborted) input.onFrame({ type: 'done' }); } } });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), validateSelection: input => bots.validateSelection(input), execute: input => bots.run(input) });
  const services = [], open = () => { const service = createBotNotifications({ directory, native: fakeNative(), apns: fakeApns(), start: false, sources: heads => ({ conversations: [], teams: bots.team.notificationSources(heads), approvals: [] }) }); services.push(service); return service; };
  const notifications = open();
  t.after(async () => { for (const service of services) service.close(); await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const baseline = await notifications.settings('desktop', { enabled: true });
  const members = ['Coordinator', 'Builder', 'Reviewer'].map(name => bots.create({ name, provider: 'codex', workspace: directory, policy: 'bypass' }).bot);
  const team = bots.team.create({ name: 'Disposable lifecycle', coordinatorId: members[0].id, memberIds: members.map(m => m.id), enabled: true }).team;
  const intake = bots.team.message(team.id, { message: 'Work only on this isolated fixture.', requestId: 'fixture-work', workMode: 'work', durablePlan: true });
  await until(() => calls.length === 1);
  const base = { instructions: 'Use only the fixture file.', criteria: ['Observe the fixture artifact.'], dependsOn: [] };
  await calls[0].executeTool('submit_team_plan', { summary: 'Build then independent review.', participation: members.map(m => ({ botId: m.id, role: 'Concrete fixture role', reason: 'Useful work or review.' })), tasks: [
    { ...base, key: 'build', title: 'Build', ownerId: members[1].id, kind: 'work' }, { ...base, key: 'review', title: 'Review', ownerId: members[2].id, kind: 'review', dependsOn: ['build'] },
  ] }, 'plan');
  releases.get(calls[0].sessionId)(); await until(() => calls.length === 2);
  return { directory, bots, notifications, open, calls, releases, team, baseline, plan: () => bots.team.plans.detail(team.id, intake.planId).plan, events: async () => (await notifications.feed('desktop', { after: baseline.nextCursor, journalId: baseline.journalId })).events };
}

test('actual blocked plan emits one generic team attention event, with no provider/private text or OS grant', async t => {
  const f = await fixture(t), build = f.calls[1];
  await build.executeTool('checkpoint_team_plan_task', { outcome: 'blocked', summary: 'PRIVATE fixture blocker with /private/path and provider detail.' }, 'blocked');
  f.releases.get(build.sessionId)(); await until(() => f.plan().phase === 'blocked');
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'failed'); assert.deepEqual(events[0].destination, { type: 'team', id: f.team.id });
  assert.equal(events[0].title, 'Work needs attention'); assert.doesNotMatch(JSON.stringify(events), /PRIVATE|private\/path|provider detail/);
  assert.deepEqual(await f.events(), events, 'Repeated reconciliation cannot duplicate the event.');
  f.notifications.close(); const reopened = f.open();
  assert.deepEqual((await reopened.feed('desktop', { after: f.baseline.nextCursor, journalId: f.baseline.journalId })).events, events, 'Restart keeps the same event identity, with no duplicate or replay.');
});

test('actual independent review and synthesis emit a team update without implying owner acceptance', async t => {
  const f = await fixture(t); writeFileSync(join(f.directory, 'artifact.txt'), 'Actual scratch artifact.');
  await f.calls[1].executeTool('checkpoint_team_plan_task', { outcome: 'ready_for_review', summary: 'Fixture output ready.', evidence: [{ kind: 'file', label: 'Artifact', detail: 'artifact.txt' }] }, 'build-ready');
  f.releases.get(f.calls[1].sessionId)(); await until(() => f.calls.length === 3);
  await f.calls[2].executeTool('read_file', { path: 'artifact.txt' }, 'verify');
  const row = f.plan().tasks.find(t => t.key === 'review');
  await f.calls[2].executeTool('checkpoint_team_plan_task', { outcome: 'ready_for_review', summary: 'Independently read the artifact.', evidence: [{ kind: 'file', label: 'Observed artifact', detail: 'artifact.txt' }], checks: row.criteria.map(c => ({ criterionId: c.id, passed: true, detail: 'Read the real scratch file.' })) }, 'review-ready');
  f.releases.get(f.calls[2].sessionId)(); await until(() => f.calls.length === 4);
  await f.calls[3].executeTool('submit_team_plan_summary', { outcome: 'ready_for_review', summary: 'Ready for the owner, not accepted.' }, 'summary');
  f.releases.get(f.calls[3].sessionId)(); await until(() => f.plan().phase === 'awaiting_review');
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].kind, 'team_message');
  assert.equal(events[0].title, 'Team update'); assert.doesNotMatch(JSON.stringify(events), /Work completed|Accepted/);
  assert.equal(f.plan().phase, 'awaiting_review');
});

test('marked lifecycle notifications retain startup, mute and existing opt-in fences; plain bot prose is not lifecycle metadata', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-plan-alert-policy-')), planId = 'tp_01234567-0123-4123-8123-0123456789ab', messages = [];
  let sequence = 0;
  const source = () => ({ conversations: [], approvals: [], teams: [{ id: 'team_fixture', latestSequence: sequence, messages }] });
  const add = (planEvent, extra = {}) => { sequence++; messages.push({ id: `tm_${sequence}`, sequence, kind: 'status', author: { type: 'system' }, planId, planEvent, state: planEvent === 'blocked' ? 'interrupted' : 'done', ...extra }); };
  add('blocked');
  const service = createBotNotifications({ directory, native: fakeNative(), apns: fakeApns(), start: false, sources: source });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  const disabled = await service.feed(); add('awaiting_review');
  assert.equal((await service.feed('desktop', { after: disabled.nextCursor, journalId: disabled.journalId })).events.length, 0);
  const enabled = await service.settings('desktop', { enabled: true, muted: ['team:team_fixture'] }); add('blocked');
  assert.equal((await service.feed('desktop', { after: enabled.nextCursor, journalId: enabled.journalId })).events.length, 0);
  const baseline = await service.settings('desktop', { muted: [], work: false, teams: false }); add('blocked'); add('awaiting_review');
  assert.equal((await service.feed('desktop', { after: baseline.nextCursor, journalId: baseline.journalId })).events.length, 0);
  const workOnly = await service.settings('desktop', { work: true, teams: false }); add('blocked'); add('awaiting_review');
  assert.deepEqual((await service.feed('desktop', { after: workOnly.nextCursor, journalId: workOnly.journalId })).events.map(e => e.kind), ['failed']);
  const teamOnly = await service.settings('desktop', { work: false, teams: true }); add('blocked'); add('awaiting_review');
  assert.deepEqual((await service.feed('desktop', { after: teamOnly.nextCursor, journalId: teamOnly.journalId })).events.map(e => e.kind), ['team_message']);
  const opted = await service.settings('desktop', { work: true, teams: true });
  add('blocked', { planId: 'malformed' }); add('blocked', { state: 'done' }); add('awaiting_review', { author: { type: 'user' } }); add(undefined, { author: { type: 'bot' }, content: 'Team plan blocked' });
  add('blocked'); add('awaiting_review');
  const events = (await service.feed('desktop', { after: opted.nextCursor, journalId: opted.journalId })).events;
  assert.deepEqual(events.map(e => e.kind), ['failed', 'team_message']);
});
