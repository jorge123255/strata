/** Actual host-owned admission/tools over disposable files and inert providers,
 * command runners, browser and connector clients. No owner/model/network/device. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotTools } from '../server/bots-tools.mjs';
import { createBotMcp } from '../server/bots-mcp.mjs';
import { createBotTeams } from '../server/bots-team.mjs';
import { createTeamChannels } from '../server/bots-team-channel.mjs';

async function until(predicate) { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) throw Error('Disposable work-mode fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const say = (input, text) => input.onFrame({ type: 'delta', text });
const result = (summary = 'The bounded fixture check is reported.') => ({ summary, evidence: [{ kind: 'test', label: 'Disposable fixture', detail: 'Passed without owner resources.' }] });
function fixture(t, execute, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-team-work-mode-')), workspace = join(directory, 'project'); mkdirSync(workspace); writeFileSync(join(workspace, 'marker.txt'), 'disposable marker');
  let bots, chats; const seen = [], effects = [], commands = [], browserEvents = [], connectorCalls = [], guestCalls = [];
  const local = createBotTools({ directory, processRunner: async (command, args, settings) => { commands.push({ command, args, cwd: settings.cwd }); return { code: 0, stdout: 'inert command passed', stderr: '' }; },
    browserProbe: () => ({ found: true, path: '/fixture/browser' }), browserFactory: async () => { browserEvents.push('create'); let url = 'about:blank'; return { page: { goto: async value => { url = value; browserEvents.push('goto'); }, url: () => url, locator: () => ({ innerText: async () => 'Inert browser page' }), screenshot: async () => Buffer.from('fixture png') }, close: async () => browserEvents.push('close') }; } });
  const mcp = createBotMcp({ directory, hasBot: id => bots?.hasBot(id), hasTeam: id => bots?.hasTeam(id), teamAccess: (teamId, botId, runId) => bots?.teamConnectorAccess(teamId, botId, runId),
    clientFactory: async connection => ({ listTools: async () => ({ tools: [{ name: connection.name === 'Team connector' ? 'team_read' : 'PRIVATE_PEER_TOOL', inputSchema: { type: 'object' } }] }), callTool: async input => { connectorCalls.push({ connection: connection.id, ...input }); return { content: [{ type: 'text', text: 'Inert connector response' }] }; }, close: async () => {} }) });
  const tools = { definitions: bot => local.definitions(bot), execute: async input => { effects.push({ botId: input.bot.id, name: input.name, workspace: input.bot.workspace, computerMode: input.bot.computerMode }); if (input.bot.computerMode === 'cua') { guestCalls.push(input.name); return { content: [{ type: 'text', text: 'Inert guest tool' }] }; } return local.execute(input); }, finish: id => local.finish(id), close: () => local.close() };
  bots = createBots({ directory, mcp, defaultWorkspace: () => workspace, conversations: () => chats,
    runtime: { providers: async () => [{ id: 'codex', ready: true }], run: async input => { seen.push(input); await execute(input); input.onFrame({ type: 'done' }); }, close() {} }, tools,
    cuaTools: { state: async () => ({ available: true, cleanupConfirmed: true, frame: { width: 1, height: 1, mimeType: 'image/png', data: 'fixture' } }), stop: async () => ({ stopped: true, cleanupConfirmed: true }) }, ...options });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: selection => bots.validateSelection(selection), execute: input => bots.run(input) });
  const make = (name, patch = {}) => bots.create({ name, provider: 'codex', model: `fixture-${name}`, policy: 'bypass', capabilities: 'both', workspace, ...patch }).bot;
  const a = make('Coordinator'), b = make('Builder'), outsider = make('Outside');
  const team = bots.team.create({ name: 'Work mode team', memberIds: [a.id, b.id], coordinatorId: a.id, enabled: true, execution: { mode: 'shared', computerId: 'host:local', workspace } }).team;
  const send = (message, extra = {}, selected = team) => bots.team.message(selected.id, { message, requestId: `request_${randomUUID()}`, ...extra });
  const done = (run, selected = team) => until(() => !['queued', 'running'].includes(bots.team.detail(selected.id, run.id).run.state));
  const task = chatId => bots.team.activity().activity.find(row => row.chatId === chatId && row.work);
  t.after(async () => { await bots.close(); await mcp.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace, bots, chats, mcp, make, a, b, outsider, team, seen, effects, commands, browserEvents, connectorCalls, guestCalls, send, done, task,
    async connector(name, patch) { const c = mcp.create({ name, transport: 'http', url: 'https://fixture.invalid/mcp', ...patch }).connection; await mcp.check(c.id); const inventory = mcp.list().connections.find(row => row.id === c.id); const ids = inventory.tools.map(row => row.id); mcp.update(c.id, { enabledToolIds: ids, readOnlyToolIds: ids, expectedInventoryDigest: inventory.inventoryDigest }); return mcp.list().connections.find(row => row.id === c.id); } };
}

test('explicit Work coordinator really reads/writes, runs the inert command/browser, delegates and submits its final exact result', async t => {
  let f; f = fixture(t, async input => {
    if (input.message === 'Inspect this project with a helper') {
      assert.equal(input.bot.teamContext.channelMode, 'task'); assert.equal(input.bot.teamConversationOnly, undefined);
      assert.equal(input.bot.model, f.a.model); assert.equal(input.bot.workspace, f.workspace); assert.equal(input.bot.computerMode, 'host');
      for (const name of ['get_execution_context', 'read_file', 'write_file', 'run_command', 'browser_open', 'assign_team_task', 'submit_team_result']) assert.ok(input.tools.some(tool => tool.name === name), name);
      assert.match(input.bot.instructions, /also this team’s coordinator/); assert.match(input.bot.instructions, /Native provider shell, browser, MCP and subagent tools remain disabled/);
      assert.match(input.bot.instructions, /dirty\/conflicted checkout does not prove the entire computer is read-only/);
      assert.match(input.bot.instructions, /uniquely named clean task checkout inside the selected workspace/);
      const execution = JSON.parse((await input.executeTool('get_execution_context', {}, 'execution-context')).content[0].text);
      assert.equal(execution.workspace.selectedRoot, f.workspace);
      assert.equal(execution.savedPolicy, 'bypass');
      assert.equal(execution.operations.writeFile.assigned, true);
      await assert.rejects(input.executeTool('read_file', { path: join(f.directory, 'outside.txt') }, 'outside-read'), /outside.*workspace/);
      assert.match((await input.executeTool('read_file', { path: 'marker.txt' }, 'read')).content[0].text, /disposable marker/);
      await input.executeTool('write_file', { path: 'out.txt', content: 'written in the disposable selected folder' }, 'write');
      assert.match((await input.executeTool('run_command', { command: 'INERT_FIXTURE_COMMAND' }, 'command')).content[0].text, /inert command passed/);
      assert.match((await input.executeTool('browser_open', { url: 'https://fixture.invalid/read-only' }, 'browser')).content[0].text, /Inert browser page/);
      await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Check the just-written disposable output' }, 'helper'); say(input, 'The helper is checking the output.');
    } else if (input.bot.id === f.b.id) {
      assert.equal(input.bot.model, f.b.model); assert.equal(input.bot.workspace, f.workspace);
      assert.match((await input.executeTool('read_file', { path: 'out.txt' }, 'helper-read')).content[0].text, /disposable selected folder/);
      await input.executeTool('submit_team_result', result('The helper read the exact selected output.'), 'helper-result'); say(input, 'The selected output is readable.');
    } else if (input.message.startsWith('[Strata teammate result batch')) {
      await input.executeTool('read_team_results', {}, 'full-results'); await input.executeTool('submit_team_result', result('Final coordinator synthesis after the helper report.'), 'final-result'); say(input, 'Final public coordinator result.');
    } else if (input.message === 'Read current work') {
      const ledger = JSON.parse((await input.executeTool('read_team_work', {}, 'ledger')).content[0].text); f.ledger = ledger; say(input, 'Public work checked.');
    }
  });
  const profileBefore = readFileSync(join(f.directory, 'bots.json')); const started = f.send('Inspect this project with a helper', { workMode: 'work' }); await f.done(started.run);
  assert.equal(readFileSync(join(f.workspace, 'out.txt'), 'utf8'), 'written in the disposable selected folder'); assert.equal(f.commands.length, 1); assert.equal(f.commands[0].cwd, f.workspace); assert.deepEqual(f.browserEvents, ['create', 'goto']);
  const task = f.task(started.run.rootChatId); assert.equal(task.state, 'completed'); assert.equal(task.work.status, 'ready_for_review'); assert.equal(task.work.resultHistory.at(-1).summary, 'Final coordinator synthesis after the helper report.');
  const channel = f.bots.team.channel(f.team.id), request = channel.messages.find(row => row.author.type === 'user'); assert.equal(request.workMode, 'work');
  const inspect = f.send('Read current work'); await f.done(inspect.run); const root = f.ledger.tasks.find(row => row.id === task.id); assert.equal(root.assignmentMessageId, request.id);
  const finalReport = f.bots.team.channel(f.team.id).messages.find(row => row.id === root.reportMessageId); assert.equal(finalReport.content, 'Final public coordinator result.');
  const before = JSON.parse(profileBefore).bots, after = JSON.parse(readFileSync(join(f.directory, 'bots.json'))).bots; assert.deepEqual(after, before, 'execution never changes saved profiles/model connections');
});

test('Chat and absent intent keep plain greetings, thanks and addressed greetings conversation-only without guest tools', async t => {
  let f; f = fixture(t, async input => { assert.equal(input.bot.teamConversationOnly, true); assert.equal(input.tools.some(tool => ['read_file', 'write_file', 'run_command', 'browser_open', 'call_tool'].includes(tool.name)), false); assert.equal(await input.requestPermission({ id: 'native', name: 'native execution' }), false); say(input, 'Hello from the fixture.'); });
  f.bots.team.update(f.team.id, { execution: { mode: 'individual' } }); f.bots.update(f.a.id, { computerMode: 'cua', workspace: '/workspace' });
  f.bots.team.update(f.team.id, { execution: { mode: 'shared', computerId: `cua:${f.a.id}`, workspace: '/workspace' } });
  for (const message of ['hi', 'thanks', 'Hi Coordinator', 'are you there?', 'Hi everyone']) {
    const started = f.send(message, message === 'thanks' ? { workMode: 'chat' } : {}); await f.done(started.run);
    assert.equal(f.bots.team.activity().activity.some(row => row.runId === started.run.id && row.work), false);
  }
  assert.equal(f.effects.length, 0); assert.equal(f.guestCalls.length, 0);
  assert.equal(f.bots.team.channel(f.team.id).messages.some(row => Object.hasOwn(row, 'workMode')), false);
  const lease = await f.bots.computer.takeover(f.a.id, { owner: 'fixture' }); assert.equal(lease.control.owned, true);
  const chat = f.send('hello again'); await f.done(chat.run); assert.equal(f.seen.at(-1).bot.teamConversationOnly, true);
  f.bots.computer.release(f.a.id, { leaseToken: lease.leaseToken }, { owner: 'fixture' });
});

test('mode validation is strict and receipt identity cannot promote Chat to Work or erase Work intent', async t => {
  let f; f = fixture(t, async input => { if (input.bot.teamContext.channelMode === 'task') await input.executeTool('submit_team_result', result(), 'report'); say(input, 'Fixture reply'); });
  assert.equal(f.bots.team.list().teamCoordinatorWorkToolsSupported, true);
  const before = f.bots.team.channel(f.team.id), chats = JSON.parse(readFileSync(join(f.directory, 'bots.json'))).chatProfiles.length;
  for (const workMode of [null, true, false, 1, {}, [], 'task', 'WORK', '']) assert.throws(() => f.send('Invalid', { workMode }), { status: 400 });
  assert.deepEqual(f.bots.team.channel(f.team.id), before); assert.equal(JSON.parse(readFileSync(join(f.directory, 'bots.json'))).chatProfiles.length, chats);
  const chat = f.send('Same text', { requestId: 'same-chat' }); assert.equal(f.send('Same text', { requestId: 'same-chat', workMode: 'chat' }).run.id, chat.run.id); assert.throws(() => f.send('Same text', { requestId: 'same-chat', workMode: 'work' }), { status: 409 }); await f.done(chat.run);
  const work = f.send('Same text', { requestId: 'same-work', workMode: 'work' }); assert.equal(f.send('Same text', { requestId: 'same-work', workMode: 'work' }).run.id, work.run.id); assert.throws(() => f.send('Same text', { requestId: 'same-work' }), { status: 409 }); await f.done(work.run);
  const saved = JSON.parse(readFileSync(join(f.directory, 'bot-team-channels.json'))), receipt = saved.receipts.find(row => row.requestId === 'same-chat');
  assert.equal(receipt.digest, createHash('sha256').update(JSON.stringify(['Same text', null, null])).digest('hex'), 'default receipt digest remains byte-identical');
});

test('explicit Work preserves addressed owners and trailing scope after a busy room; volunteer bids still route first', async t => {
  let f; f = fixture(t, async input => {
    if (input.bot.id === f.b.id && input.message.startsWith('Hi, do this bounded')) {
      assert.equal(input.bot.teamContext.channelMode, 'task'); assert.equal(f.seen.filter(row => row.message.startsWith('Hi, do this bounded')).length, 1);
      assert.match(input.bot.instructions, /TRAILING_HUMAN_RELEASE_HOLD/); await input.executeTool('submit_team_result', result(), 'addressed-result'); say(input, 'Bounded task ready.');
    } else if (input.message === 'Who wants this task?') { assert.equal(input.bot.teamContext.channelMode, 'routing'); assert.equal(input.bot.teamConversationOnly, true); assert.equal(input.tools.some(tool => tool.name === 'run_command'), false); }
    else if (input.bot.teamContext.channelMode === 'bid') { assert.equal(input.bot.teamConversationOnly, true); assert.equal(input.tools.some(tool => tool.name === 'write_file'), false); say(input, 'An offer only; no work started.'); }
  });
  const text = `Hi, do this bounded check ${'scope '.repeat(210)}TRAILING_HUMAN_RELEASE_HOLD`;
  const started = f.send(text, { workMode: 'work', recipientIds: [f.b.id] }); await f.done(started.run);
  const rootInput = f.seen.find(row => row.sessionId === started.run.rootChatId); assert.equal(rootInput.bot.id, f.b.id); assert.match(rootInput.bot.instructions, /TRAILING_HUMAN_RELEASE_HOLD/);
  const bid = f.send('Who wants this task?', { workMode: 'work' }); await f.done(bid.run); assert.equal(f.bots.team.activity().activity.some(row => row.runId === bid.run.id && row.work), false); assert.equal(f.bots.team.channel(f.team.id).messages.find(row => row.runId === bid.run.id && row.author.type === 'user').workMode, 'work');
});

test('Plan keeps read-only tools and Manual/Bypass retain their actual permission gates for direct Work', async t => {
  for (const policy of ['plan', 'manual', 'bypass']) await t.test(policy, async sub => {
    let f; f = fixture(sub, async input => {
      assert.equal(input.bot.policy, policy); assert.match((await input.executeTool('read_file', { path: 'marker.txt' }, 'read')).content[0].text, /disposable marker/);
      if (policy === 'plan') { assert.equal(input.tools.some(tool => ['write_file', 'run_command', 'submit_team_result'].includes(tool.name)), false); await assert.rejects(input.executeTool('write_file', { path: 'denied.txt', content: 'no' }, 'no-write'), /not enabled/); }
      else { await input.executeTool('write_file', { path: 'allowed.txt', content: policy }, 'write'); await input.executeTool('run_command', { command: 'INERT_PERMISSION_CHECK' }, 'command'); await input.executeTool('submit_team_result', result(), 'submitted'); }
    });
    f.bots.update(f.a.id, { policy }); const started = f.send('Check permissions in the selected folder', { workMode: 'work' });
    if (policy === 'manual') { await until(() => f.bots.pending(started.run.rootChatId).length > 0); assert.equal(existsSync(join(f.workspace, 'allowed.txt')), false); await f.bots.approve({ chatId: started.run.rootChatId, callId: f.bots.pending(started.run.rootChatId)[0].callId, decision: 'approve' }); await until(() => f.bots.pending(started.run.rootChatId).length > 0); assert.equal(f.commands.length, 0); await f.bots.approve({ chatId: started.run.rootChatId, callId: f.bots.pending(started.run.rootChatId)[0].callId, decision: 'approve' }); }
    await f.done(started.run); assert.equal(f.bots.pending(started.run.rootChatId).length, 0); assert.equal(existsSync(join(f.workspace, 'allowed.txt')), policy !== 'plan'); assert.equal(f.commands.length, policy === 'plan' ? 0 : 1);
  });
});

test('Work connector tools require exact frozen team grants and never acquire a peer private connector', async t => {
  let f, ready, release; const entered = new Promise(resolve => ready = resolve), gate = new Promise(resolve => release = resolve);
  f = fixture(t, async input => {
    const found = JSON.parse((await input.executeTool('search_tools', { query: '' }, 'search')).content[0].text).tools; assert.deepEqual(found.map(row => row.name), ['team_read']);
    await assert.rejects(input.executeTool('call_tool', { toolId: f.privateTool, arguments: {} }, 'private-peer'), /not assigned|removed/);
    await input.executeTool('call_tool', { toolId: found[0].id, arguments: {} }, 'team-call'); ready(); await Promise.race([gate, new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))]);
    await assert.rejects(input.executeTool('call_tool', { toolId: found[0].id, arguments: {} }, 'revoked-team-call'), /not assigned|removed/); say(input, 'The revoked tool was not called.');
  });
  const shared = await f.connector('Team connector', { teamIds: [f.team.id] }), peer = await f.connector('Private peer connector', { botIds: [f.b.id] }); f.privateTool = peer.tools[0].id;
  const started = f.send('Use only the selected team connector', { workMode: 'work' }); await entered; assert.equal(f.connectorCalls.length, 1); assert.equal(f.connectorCalls[0].connection, shared.id);
  f.mcp.update(shared.id, { teamIds: [], expectedInventoryDigest: shared.inventoryDigest }); release(); await f.done(started.run); assert.equal(f.connectorCalls.length, 1); assert.equal(f.guestCalls.length, 0);
});

test('Stop revokes a Work root and pending Manual action before any effect or late tool call', async t => {
  let f, input; f = fixture(t, async value => { input = value; await value.executeTool('write_file', { path: 'never.txt', content: 'denied by Stop' }, 'held-write'); }); f.bots.update(f.a.id, { policy: 'manual' });
  const started = f.send('Prepare the bounded file change', { workMode: 'work' }); await until(() => f.bots.pending(started.run.rootChatId).length > 0);
  await f.bots.team.stop(f.team.id, started.run.id); assert.equal(existsSync(join(f.workspace, 'never.txt')), false); assert.equal(f.bots.pending(started.run.rootChatId).length, 0); assert.equal(f.task(started.run.rootChatId).work.status, 'interrupted');
  await assert.rejects(async () => input.executeTool('write_file', { path: 'late.txt', content: 'no' }, 'late'), /ended|stopped/); assert.equal(existsSync(join(f.workspace, 'late.txt')), false);
});

test('shared CUA Work roots serialize while Chat can greet; human takeover stops roots and never replays canceled work', async t => {
  let f, entered; const started = new Promise(resolve => entered = resolve); const workMessages = [];
  f = fixture(t, async input => {
    if (input.bot.teamConversationOnly) { assert.equal(input.tools.some(tool => tool.name === 'run_command'), false); say(input, 'Hello without a computer claim.'); return; }
    workMessages.push(input.message); assert.equal(input.bot.computerOwnerId, f.a.id); assert.equal(input.bot.workspace, '/workspace');
    if (input.message === 'first Work') { entered(); await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); }
    else { await input.executeTool('submit_team_result', result(), 'reported'); say(input, 'Explicit later Work completed.'); }
  });
  f.bots.team.update(f.team.id, { execution: { mode: 'individual' } }); f.bots.update(f.a.id, { computerMode: 'cua', workspace: '/workspace' });
  f.bots.team.update(f.team.id, { execution: { mode: 'shared', computerId: `cua:${f.a.id}`, workspace: '/workspace' } });
  const other = f.bots.team.create({ name: 'Other shared team', memberIds: [f.a.id, f.b.id], coordinatorId: f.b.id, enabled: true, execution: { mode: 'shared', computerId: `cua:${f.a.id}`, workspace: '/workspace' } }).team;
  const first = f.send('first Work', { workMode: 'work' }); await started; const second = f.send('second Work', { workMode: 'work' }, other);
  const chat = f.send('hi', { recipientIds: [f.b.id] }, other); await f.done(chat.run, other); assert.deepEqual(workMessages, ['first Work']); assert.equal(f.bots.team.detail(other.id, second.run.id).run.state, 'queued');
  const lease = await f.bots.computer.takeover(f.a.id, { owner: 'fixture-human' }); await f.done(first.run); await f.done(second.run, other); assert.equal(f.bots.team.detail(other.id, second.run.id).run.state, 'cancelled'); assert.deepEqual(workMessages, ['first Work']);
  const pending = f.send('explicit after lease', { workMode: 'work' }, other); await new Promise(resolve => setTimeout(resolve, 30)); assert.deepEqual(workMessages, ['first Work']);
  f.bots.computer.release(f.a.id, { leaseToken: lease.leaseToken }, { owner: 'fixture-human' }); f.bots.team.tick(); await f.done(pending.run, other); assert.deepEqual(workMessages, ['first Work', 'explicit after lease']); assert.equal(f.guestCalls.length, 0);
});

test('Work roots remain recoverable through their exact public human anchor and never replay the original prompt', async t => {
  let f; f = fixture(t, async input => {
    if (input.message === 'A bounded unfinished Work task') throw new Error('Inert initial failure');
    if (input.message.startsWith('[The owner explicitly chose')) { assert.match(input.message, /new conversation, not a replay/); assert.match(input.message, /First inspect the current files/); await input.executeTool('submit_team_result', result('Only the selected remainder is reported.'), 'continued-result'); }
    else if (input.message === 'Inspect public task identities') { f.ledger = JSON.parse((await input.executeTool('read_team_work', {}, 'public-ledger')).content[0].text); }
  });
  const initial = f.send('A bounded unfinished Work task', { workMode: 'work' }); await f.done(initial.run); const source = f.task(initial.run.rootChatId); assert.equal(source.work.status, 'blocked');
  const plan = f.bots.team.recoveryPlan(f.team.id, source.id).plan; assert.equal(plan.canResume, true); const selection = { planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: 'owner-selected-root-only' };
  const resumed = f.bots.team.resumeJob(f.team.id, source.id, selection); await f.done(resumed.run); assert.notEqual(resumed.activity.chatId, source.chatId); assert.equal(f.bots.team.resumeJob(f.team.id, source.id, selection).activity.id, resumed.activity.id);
  const inspect = f.send('Inspect public task identities'); await f.done(inspect.run); const original = f.ledger.tasks.find(row => row.id === source.id), continuation = f.ledger.tasks.find(row => row.id === resumed.activity.id); assert.equal(original.assignmentMessageId, continuation.assignmentMessageId); assert.equal(original.work.recoveryJobId, continuation.id); assert.equal(continuation.work.sourceJobId, original.id);
});

test('public Work identity rejects spoofed human intent/root job/run/chat/author, with journals retained read-only', async t => {
  let f; f = fixture(t, async input => { await input.executeTool('submit_team_result', result(), 'result'); }); const started = f.send('Published concrete Work', { workMode: 'work' }); await f.done(started.run);
  const sourceTask = f.task(started.run.rootChatId), originalTeams = JSON.parse(readFileSync(join(f.directory, 'bot-teams.json'))), originalChannels = JSON.parse(readFileSync(join(f.directory, 'bot-team-channels.json')));
  const cases = [
    ['valid', () => {}], ['missing Work marker', (_teams, channel) => delete channel.workMode], ['Chat marker', (_teams, channel) => channel.workMode = 'chat'], ['bot author', (_teams, channel) => channel.author = { type: 'bot', name: 'Coordinator', botId: f.a.id }],
    ['wrong root chat', (teams) => teams.runs.find(row => row.id === started.run.id).rootChatId = 's_other'], ['wrong root owner', teams => teams.runs.find(row => row.id === started.run.id).rootBotId = f.b.id], ['missing explicit host flag', teams => delete teams.jobs.find(row => row.id === sourceTask.id).explicitWork],
  ];
  for (const [name, edit] of cases) {
    const directory = join(f.directory, randomUUID()); mkdirSync(directory); const teams = structuredClone(originalTeams), channels = structuredClone(originalChannels), human = channels.channels.find(row => row.teamId === f.team.id).messages.find(row => row.runId === started.run.id && row.author.type === 'user'); edit(teams, human);
    writeFileSync(join(directory, 'bot-teams.json'), JSON.stringify(teams)); writeFileSync(join(directory, 'bot-team-channels.json'), JSON.stringify(channels));
    const service = createBotTeams({ directory, requireBot: id => ({ id, name: id, policy: 'bypass' }), createConversation: () => ({ conversation: { id: `s_${randomUUID()}` } }), conversations: () => ({ send() {}, detail: id => ({ conversation: { id } }) }), stopDirect: async () => {}, schedule: () => {} });
    const current = service.message(f.team.id, { message: 'Read existing public state', requestId: 'inspect' }).run; service.tick(); const rootChatId = service.detail(f.team.id, current.id).run.rootChatId; const ctx = { chatId: rootChatId, turnId: `turn_${randomUUID()}`, bot: { id: f.a.id, policy: 'bypass' }, assertLive() {} }; service.begin(ctx);
    const before = readFileSync(join(directory, 'bot-teams.json')), ledger = await service.execute('read_team_work', {}, ctx); assert.equal(ledger.tasks.some(row => row.id === sourceTask.id), name === 'valid', name); assert.deepEqual(readFileSync(join(directory, 'bot-teams.json')), before); await service.close();
  }
});

test('saved channel workMode is a strict additive enum and older Chat rows remain unchanged', t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-work-marker-')); t.after(() => rmSync(directory, { force: true, recursive: true }));
  const channels = createTeamChannels({ directory }); const old = channels.append('team_fixture', { author: { type: 'user', name: 'You' }, content: 'Old Chat' }); const work = channels.append('team_fixture', { author: { type: 'user', name: 'You' }, content: 'Explicit Work', workMode: 'work' }); assert.equal(Object.hasOwn(old, 'workMode'), false); assert.equal(work.workMode, 'work');
  assert.deepEqual(createTeamChannels({ directory }).snapshot('team_fixture').messages, [old, work]); const path = join(directory, 'bot-team-channels.json'), saved = JSON.parse(readFileSync(path)); saved.channels[0].messages[1].workMode = true; writeFileSync(path, JSON.stringify(saved)); const before = readFileSync(path); assert.throws(() => createTeamChannels({ directory }), { status: 503 }); assert.deepEqual(readFileSync(path), before);
});

test('a yielded Work root waits for its actual delegated task, then its final synthesis becomes ready for review', async t => {
  let f, entered, release; const held = new Promise(resolve => release = resolve), childStarted = new Promise(resolve => entered = resolve);
  f = fixture(t, async input => {
    if (input.message === 'Coordinate one real bounded helper') { await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Hold the disposable child check' }, 'owned-child'); say(input, 'The assigned helper is working.'); }
    else if (input.bot.id === f.b.id) { entered(); await Promise.race([held, new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))]); if (!input.signal.aborted) { await input.executeTool('submit_team_result', result(), 'child-result'); say(input, 'Child result.'); } }
    else if (input.message.startsWith('[Strata teammate result batch')) { await input.executeTool('submit_team_result', result('The coordinator inspected the completed helper result.'), 'root-final'); say(input, 'Final coordinator synthesis.'); }
  });
  const started = f.send('Coordinate one real bounded helper', { workMode: 'work' }); await childStarted; await until(() => f.task(started.run.rootChatId)?.state === 'completed');
  const before = readFileSync(join(f.directory, 'bot-teams.json')), waiting = f.task(started.run.rootChatId); assert.equal(waiting.work.status, 'working'); assert.match(waiting.work.summary, /Waiting for delegated work/); assert.equal(f.bots.team.recoveryPlan(f.team.id, waiting.id).plan.canResume, false);
  const saved = JSON.parse(before).jobs.find(row => row.id === waiting.id); assert.equal(saved.work.status, 'blocked'); assert.deepEqual(readFileSync(join(f.directory, 'bot-teams.json')), before, 'presentation does not rewrite the journal');
  release(); await f.done(started.run); assert.equal(f.task(started.run.rootChatId).work.status, 'ready_for_review'); assert.equal(f.task(started.run.rootChatId).work.resultHistory.at(-1).summary, 'The coordinator inspected the completed helper result.');
});

test('Stop does not strand a yielded coordinator Working or conceal a real provider/root blocker', async t => {
  let f, entered; const childStarted = new Promise(resolve => entered = resolve);
  f = fixture(t, async input => {
    if (input.message === 'Yield while the selected helper works') { await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Wait only in the inert fixture' }, 'child'); say(input, 'Waiting for the selected helper.'); }
    else if (input.bot.id === f.b.id) { entered(); await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); }
    else if (input.message === 'Report a real root blocker') { await input.executeTool('submit_team_result', { outcome: 'blocked', summary: 'An explicit fixture access blocker needs owner attention.' }, 'blocked'); say(input, 'A real blocker was reported.'); }
    else if (input.message === 'Report a blocked summary identical to the fallback') { await input.executeTool('assign_team_task', { botId: f.b.id, message: 'Wait only in the inert fixture' }, 'collision-child'); await input.executeTool('submit_team_result', { outcome: 'blocked', summary: 'This turn ended without a structured result. Review its conversation and inspect existing progress before continuing.' }, 'explicit-collision'); say(input, 'An explicit blocker was submitted.'); }
  });
  const started = f.send('Yield while the selected helper works', { workMode: 'work' }); await childStarted; await until(() => f.task(started.run.rootChatId)?.state === 'completed'); assert.equal(f.task(started.run.rootChatId).work.status, 'working');
  await f.bots.team.stop(f.team.id, started.run.id); assert.equal(f.task(started.run.rootChatId).work.status, 'interrupted'); assert.equal(f.bots.team.activity().activity.some(row => row.runId === started.run.id && row.work?.status === 'working'), false);
  const blocker = f.send('Report a real root blocker', { workMode: 'work' }); await f.done(blocker.run); const row = f.task(blocker.run.rootChatId); assert.equal(row.work.status, 'blocked'); assert.match(row.work.summary, /explicit fixture access blocker/);
  const collision = f.send('Report a blocked summary identical to the fallback', { workMode: 'work' }); await until(() => f.task(collision.run.rootChatId)?.state === 'completed'); const explicit = f.task(collision.run.rootChatId); assert.equal(explicit.work.status, 'blocked'); assert.equal(explicit.work.resultHistory.length, 1, 'an explicitly submitted blocker must not become a projected wait'); await f.bots.team.stop(f.team.id, collision.run.id); assert.equal(f.task(collision.run.rootChatId).work.status, 'blocked');
});
