import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBotActionJournal, botActionTurnIdentity } from '../server/bots-action-journal.mjs';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotTools } from '../server/bots-tools.mjs';
import { createBotCreatedTools } from '../server/bots-created-tools.mjs';
import { createCreatedCommandTools } from '../server/bots-runtime/created-tools.mjs';
import { BOT_TOOL_NO_EFFECT } from '../server/bots-runtime/tool-outcome.mjs';
import { startWorker } from '../server/bots-runtime/ssh-worker.mjs';
import { EventEmitter } from 'node:events';
import http from 'node:http';

const scope = (overrides = {}) => ({ chatId: 's_test', authority: 'a'.repeat(64), turnId: 'turn_1', toolCallId: 'native_call_1', name: 'run_command', args: { command: 'private command', token: 'SECRET_TOKEN' }, ...overrides });
function folder(t) { const directory = mkdtempSync(join(tmpdir(), 'strata-action-receipts-')); t.after(() => rmSync(directory, { force: true, recursive: true })); return directory; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('durable reservation precedes a real effect; duplicates share result without leaking contents', async t => {
  const root = folder(t), directory = join(root, 'receipts'), counter = join(root, 'counter');
  const journal = createBotActionJournal({ directory }); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const execute = async () => { const [name] = readdirSync(directory); const row = JSON.parse(readFileSync(join(directory, name))); assert.equal(row.state, 'pending'); writeFileSync(counter, String(Number(existsSync(counter) ? readFileSync(counter, 'utf8') : 0) + 1)); await gate; return { content: [{ type: 'text', text: 'PRIVATE_RESULT' }] }; };
  const first = journal.execute(scope(), execute), second = journal.execute(scope({ args: { token: 'SECRET_TOKEN', command: 'private command' } }), execute);
  assert.equal(first, second); assert.equal(readFileSync(counter, 'utf8'), '1'); release(); await first;
  assert.equal(journal.summary().counts.succeeded, 1); assert.equal(statSync(directory).mode & 0o777, 0o700);
  const file = join(directory, readdirSync(directory)[0]); assert.equal(statSync(file).mode & 0o777, 0o600);
  const stored = readFileSync(file, 'utf8') + JSON.stringify(journal.summary());
  for (const secret of ['SECRET_TOKEN', 'private command', 'PRIVATE_RESULT']) assert.equal(stored.includes(secret), false);
  const restored = createBotActionJournal({ directory }); const value = await restored.execute(scope(), () => assert.fail('No replay'));
  assert.equal(value.isError, true); assert.equal(readFileSync(counter, 'utf8'), '1');
});

test('same native identity rejects argument or exact-authority changes; other chats, turns and targets stay independent', async t => {
  const journal = createBotActionJournal({ directory: folder(t) }); let count = 0;
  await journal.execute(scope(), () => { count++; return {}; });
  await assert.rejects(journal.execute(scope({ args: { command: 'different' } }), () => count++), { code: 'harness_action_conflict' });
  await assert.rejects(journal.execute(scope({ authority: 'b'.repeat(64) }), () => count++), { code: 'harness_action_conflict' });
  await Promise.all([journal.execute(scope({ chatId: 's_other' }), () => count++), journal.execute(scope({ turnId: 'turn_2' }), () => count++), journal.execute(scope({ chatId: 's_other_target', authority: 'b'.repeat(64) }), () => count++)]);
  assert.equal(count, 4); assert.equal(journal.summary().counts.succeeded, 4);
});

test('actual process death before and after an effect becomes uncertain without startup rewriting files', async t => {
  const root = folder(t), source = new URL('../server/bots-action-journal.mjs', import.meta.url).href;
  for (const point of ['before', 'after']) {
    const directory = join(root, point), counter = join(root, `${point}-counter`);
    const script = `import {createBotActionJournal} from ${JSON.stringify(source)}; import {writeFileSync} from 'node:fs'; const j=createBotActionJournal({directory:${JSON.stringify(directory)}}); await j.execute(${JSON.stringify(scope())},()=>{ ${point === 'after' ? `writeFileSync(${JSON.stringify(counter)},'1');` : ''} process.exit(23); });`;
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', script]).status, 23);
    const filename = join(directory, readdirSync(directory)[0]), bytes = readFileSync(filename);
    const restored = createBotActionJournal({ directory }); const receipt = restored.summary().actions[0];
    assert.equal(receipt.state, 'uncertain'); assert.deepEqual(readFileSync(filename), bytes, 'Read-only startup projection preserves receipt bytes');
    const denied = await restored.execute(scope(), () => assert.fail('An uncertain mutation cannot replay'));
    assert.equal(denied.isError, true); assert.equal(existsSync(counter), point === 'after');
    await assert.rejects(restored.execute(scope({ toolCallId: 'replacement_native_id' }), () => assert.fail('New IDs cannot replay the same uncertain effect in the same turn')), { code: 'harness_action_uncertain' });
    await restored.execute(scope({ chatId: `s_unrelated_${point}` }), () => ({ content: [] }));
  }
});

test('Stop and thrown callbacks retain interrupted/uncertain receipts; acknowledgement never resumes or replays', async t => {
  const journal = createBotActionJournal({ directory: folder(t) });
  const pre = new AbortController(); pre.abort();
  await assert.rejects(journal.execute(scope({ signal: pre.signal }), () => assert.fail('No effect'))); assert.equal(journal.summary().actions.length, 0);
  await assert.rejects(journal.execute(scope(), () => { throw Error('PRIVATE_ERROR'); }));
  const receipt = journal.summary().actions[0]; assert.equal(receipt.state, 'uncertain');
  assert.throws(() => journal.review(receipt.id, { expectedRevision: receipt.revision + 1, expectedProof: receipt.proof, decision: 'acknowledge' }), /changed/);
  assert.throws(() => journal.review(receipt.id, { expectedRevision: receipt.revision, expectedProof: receipt.proof, decision: 'acknowledge', retry: true }), /exact/);
  const result = journal.review(receipt.id, { expectedRevision: receipt.revision, expectedProof: receipt.proof, decision: 'acknowledge' });
  assert.deepEqual([result.acknowledged, result.resumed, result.retried, result.action.state], [true, false, false, 'reviewed']);
  await journal.execute(scope(), () => assert.fail('Acknowledgement is not permission to execute'));
  const mid = new AbortController();
  await assert.rejects(journal.execute(scope({ toolCallId: 'stopped_call', signal: mid.signal, args: { command: 'another exact effect' } }), () => { mid.abort(); throw Error('Stop'); }));
  assert.equal(journal.summary().counts.interrupted, 1); assert.equal(JSON.stringify(journal.summary()).includes('PRIVATE_ERROR'), false);
});

test('settled retention is bounded; unresolved receipts survive any age and corruption affects only its exact action', async t => {
  const directory = folder(t), journal = createBotActionJournal({ directory, retention: 2 });
  await assert.rejects(journal.execute(scope({ toolCallId: 'unresolved' }), () => { throw Error('uncertain'); }));
  for (let index = 0; index < 8; index++) await journal.execute(scope({ toolCallId: `done_${index}`, args: { index } }), () => ({}));
  assert.equal(readdirSync(directory).length, 3); assert.equal(journal.summary().counts.uncertain, 1); assert.equal(journal.summary().counts.succeeded, 2);
  const uncertain = journal.summary().actions.find(row => row.state === 'uncertain'), path = join(directory, `${uncertain.id}.json`);
  writeFileSync(path, '{broken'); const bytes = readFileSync(path);
  const fresh = createBotActionJournal({ directory }); assert.equal(fresh.summary().available, false);
  await assert.rejects(fresh.execute(scope({ toolCallId: 'unresolved' }), () => assert.fail('No replay')));
  await fresh.execute(scope({ chatId: 's_independent', toolCallId: 'safe' }), () => ({}));
  assert.deepEqual(readFileSync(path), bytes);
  const absent = createBotActionJournal({ directory: join(directory, 'absent') }); assert.equal(absent.summary().available, true); assert.equal(existsSync(join(directory, 'absent')), false);
});

test('turn identities use persisted assistant boundaries and fall back to hashed history without storing prompts', () => {
  const before = { messages: [{ id: 'm_old', role: 'user', at: 1 }] }, live = id => ({ messages: [{ id, role: 'assistant', streaming: true }] });
  assert.equal(botActionTurnIdentity(before, 'Private prompt', live('m_a')), botActionTurnIdentity(before, 'Private prompt', live('m_a')));
  assert.notEqual(botActionTurnIdentity(before, 'Private prompt', live('m_a')), botActionTurnIdentity(before, 'Private prompt', live('m_b')));
  assert.notEqual(botActionTurnIdentity(before, 'Private prompt'), botActionTurnIdentity({ messages: [] }, 'Private prompt'));
});

function botsFixture(t, run, providedTools, extensions = {}) {
  const directory = folder(t); let chats;
  const tools = providedTools ?? createBotTools({ directory });
  const bots = createBots({ directory, ...extensions, defaultWorkspace: () => directory, conversations: () => chats, tools, runtime: { providers: async () => [], run, close() {} } });
  chats = createConversations({ directory, enabled: () => true, validateSelection: value => bots.validateSelection(value), execute: value => bots.run(value), pending: id => bots.pending(id), stop: id => bots.stop(id) });
  t.after(async () => { await bots.close(); chats.close(); });
  return { bots, chats, directory };
}

test('actual local command broker journals one side effect and applies the same ledger to host extensions', async t => {
  let duplicateChecked = false, hostEffects = 0;
  const f = botsFixture(t, async input => {
    const args = { command: 'printf x >> counter' };
    await Promise.all([input.executeTool('run_command', args, 'cmd_1'), input.executeTool('run_command', args, 'cmd_1')]);
    await assert.rejects(Promise.resolve().then(() => input.executeTool('run_command', { command: 'printf y >> counter' }, 'cmd_1')), /different action/);
    duplicateChecked = true;
    await Promise.all([input.executeHostTool('scratch_host', { message: 'Private team speech' }, 'host_1'), input.executeHostTool('scratch_host', { message: 'Private team speech' }, 'host_1')]);
  }, undefined, { skills: { tools: () => [{ name: 'scratch_host', inputSchema: { type: 'object' } }], snapshot: () => ({}), owns: name => name === 'scratch_host', execute: async () => { hostEffects++; return { content: [{ type: 'text', text: 'private host result' }] }; }, finish() {} } });
  const bot = f.bots.create({ name: 'Counter', provider: 'codex', policy: 'bypass', workspace: f.directory, capabilities: 'code' }).bot;
  const chat = f.bots.createConversation(bot.id).conversation; f.chats.send(chat.id, 'Run a scratch counter');
  for (let attempt = 0; attempt < 200 && !duplicateChecked; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  await tick();
  assert.equal(duplicateChecked, true); assert.equal(readFileSync(join(f.directory, 'counter'), 'utf8'), 'x');
  assert.equal(hostEffects, 1); assert.equal(f.bots.harnessActions(chat.id).counts.succeeded, 2);
  assert.equal(JSON.stringify(f.bots.harnessActions()).includes('printf'), false);
});

test('worker computer tools have their own durable receipts and never reuse a host tool executor', async t => {
  const directory = folder(t), input = { bot: { id: 'bot_remote', provider: 'codex', execution: { kind: 'ssh', host: 'fixture' }, workspace: directory, capabilities: 'code', policy: 'bypass' }, sessionId: 's_remote', message: 'Scratch', history: [], harnessActionScope: { turnId: 'c'.repeat(64), authority: 'd'.repeat(64) } };
  let effects = 0; const frames = [];
  const perform = async () => { const reader = new EventEmitter(); reader.close = () => reader.emit('close');
    await startWorker(input, { directory, reader, send: value => frames.push(value), toolFactory: () => ({ definitions: () => [{ name: 'scratch_effect', inputSchema: { type: 'object', properties: {} } }], async execute() { effects++; writeFileSync(join(directory, 'worker-counter'), String(effects)); return { content: [{ type: 'text', text: 'PRIVATE_REMOTE_RESULT' }] }; }, finish() {}, close() {} }), runtimeFactory: () => ({ async run(value) { await Promise.all([value.executeTool('scratch_effect', {}, 'native_remote'), value.executeTool('scratch_effect', {}, 'native_remote')]); return { text: 'Done' }; }, close() {} }) }); };
  await perform(); await perform(); assert.equal(effects, 1); assert.equal(readFileSync(join(directory, 'worker-counter'), 'utf8'), '1');
  const receipts = frames.filter(row => row.type === 'harness-action').map(row => row.value);
  assert.equal(receipts.some(row => row.state === 'pending'), true); assert.equal(receipts.some(row => row.state === 'succeeded'), true);
  assert.equal(JSON.stringify(receipts).includes('PRIVATE_REMOTE_RESULT'), false);
  const host = createBotActionJournal({ directory: join(directory, 'host-mirror') });
  for (const row of receipts) host.observeRemote(row, 's_remote');
  const remote = host.summary().actions[0]; assert.equal(remote.readOnly, true);
  assert.throws(() => host.review(remote.id, { expectedRevision: remote.revision, expectedProof: remote.proof, decision: 'acknowledge' }), /read-only/);
  assert.equal(frames.filter(row => row.type === 'cleanup').every(row => row.confirmed === true), true);
});

test('local receipt routes are read-only by default and acknowledgement is exact, local and non-executing', async t => {
  const f = botsFixture(t, async input => { await input.executeTool('scratch_failure', {}, 'failed').catch(() => {}); }, { definitions: () => [{ name: 'scratch_failure' }], execute: async () => { throw Error('private failure'); }, finish() {}, close() {} });
  const bot = f.bots.create({ name: 'Reviewer', provider: 'codex', workspace: f.directory }).bot, chat = f.bots.createConversation(bot.id).conversation;
  f.chats.send(chat.id, 'Create a fixture receipt'); await tick(); await tick();
  let route; const server = http.createServer((req, res) => route(req, res, new URL(req.url, `http://127.0.0.1:${server.address().port}`)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port; route = createBotRoutes({ bots: f.bots, port }); const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/api/bots/harness/actions`), payload = await response.json(); assert.equal(response.status, 200); assert.equal(payload.counts.uncertain, 1);
  assert.equal((await fetch(`${origin}/api/bots/harness/actions?chatId=${chat.id}`)).status, 405);
  const bodyStatus = await new Promise(resolve => { const req = http.request(`${origin}/api/bots/harness/actions`, { method: 'GET', headers: { 'content-length': '2' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.end('{}'); });
  assert.equal(bodyStatus, 400);
  const action = payload.actions[0], body = { expectedRevision: action.revision, expectedProof: action.proof, decision: 'acknowledge' };
  const reviewed = await fetch(`${origin}/api/bots/harness/actions/${action.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal(reviewed.status, 200); const result = await reviewed.json(); assert.deepEqual([result.acknowledged, result.resumed, result.retried], [true, false, false]);
  assert.equal((await fetch(`${origin}/api/bots/harness/actions/${action.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin }, body: JSON.stringify(body) })).status, 409);
});


test('concurrent independent processes cannot dispatch the same identity twice', async t => {
  const root = folder(t), directory = join(root, 'receipts'), counter = join(root, 'counter'), source = new URL('../server/bots-action-journal.mjs', import.meta.url).href;
  const script = `import {createBotActionJournal} from ${JSON.stringify(source)}; import {appendFileSync} from 'node:fs'; const j=createBotActionJournal({directory:${JSON.stringify(directory)}}); await j.execute(${JSON.stringify(scope())},async()=>{appendFileSync(${JSON.stringify(counter)},'x'); await new Promise(r=>setTimeout(r,50)); return {};}).catch(()=>{});`;
  const run = () => new Promise(resolve => { const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' }); child.once('close', resolve); });
  assert.deepEqual(await Promise.all([run(), run()]), [0, 0]);
  assert.equal(readFileSync(counter, 'utf8'), 'x'); assert.equal(createBotActionJournal({ directory }).summary().counts.succeeded, 1);
});

test('bounded summary always prioritizes older unresolved actions and remote uncertainty remains read-only', async t => {
  const directory = folder(t), journal = createBotActionJournal({ directory, retention: 1000, now: (() => { let value = 1; return () => value++; })() });
  await assert.rejects(journal.execute(scope({ toolCallId: 'old-uncertain' }), () => { throw Error('not persisted'); }));
  for (let index = 0; index < 205; index++) await journal.execute(scope({ toolCallId: `fresh-${index}`, args: { index } }), () => ({}));
  const payload = journal.summary(); assert.equal(payload.actions.length, 200); assert.equal(payload.hasMore, true); assert.equal(payload.actions[0].state, 'uncertain');
  assert.equal(payload.counts.succeeded, 205);
  const remote = createBotActionJournal({ directory: join(directory, 'remote'), origin: 'ssh-worker' });
  await assert.rejects(remote.execute(scope({ chatId: 's_remote', origin: 'ssh-worker' }), () => { throw Error('Remote private error'); }));
  journal.observeRemote(remote.summary('s_remote').actions[0], 's_remote');
  assert.equal(journal.summary('s_remote').actions[0].readOnly, true);
  assert.throws(() => journal.observeRemote(remote.summary('s_remote').actions[0], 's_wrong'), /invalid/);
});

test('remote worker rejects a reused identity across host RPC and computer tools before second dispatch', async t => {
  const directory = folder(t), reader = new EventEmitter(); reader.close = () => reader.emit('close');
  const sent = []; let computerEffects = 0, hostEffects = 0;
  await startWorker({ bot: { id: 'bot_crossplane', provider: 'codex', execution: { kind: 'ssh', host: 'fixture' }, workspace: directory, policy: 'bypass' }, sessionId: 's_crossplane', message: 'Fixture', hostTools: [{ name: 'scratch_host', inputSchema: { type: 'object', properties: {} } }] }, {
    directory, reader, send(value) { sent.push(value); if (value.type === 'requestHostTool') { hostEffects++; queueMicrotask(() => reader.emit('line', JSON.stringify({ type: 'reply', id: value.id, value: { content: [{ type: 'text', text: 'Host effect done' }] } }))); } },
    toolFactory: () => ({ definitions: () => [{ name: 'scratch_computer', inputSchema: { type: 'object', properties: {} } }], execute() { computerEffects++; return {}; }, finish() {}, close() {} }),
    runtimeFactory: () => ({ async run(input) { await input.executeTool('scratch_host', {}, 'one-native-call'); await assert.rejects(input.executeTool('scratch_computer', {}, 'one-native-call'), /different action/); return {}; }, close() {} }),
  });
  assert.equal(hostEffects, 1); assert.equal(computerEffects, 0); assert.equal(sent.filter(row => row.type === 'harness-action').length, 0, 'Host-owned RPC receipts are not duplicated in worker projections');
  assert.equal(sent.find(row => row.type === 'cleanup').confirmed, true);
});


test('uncertain same-turn mutations cannot escape with new IDs or acknowledgement, while reads and new owner turns remain independent', async t => {
  const journal = createBotActionJournal({ directory: folder(t) }); let effects = 0;
  await assert.rejects(journal.execute(scope(), () => { effects++; throw Error('After effect'); }), /Do not retry/);
  await assert.rejects(journal.execute(scope({ toolCallId: 'new_id' }), () => effects++), { code: 'harness_action_uncertain' });
  const receipt = journal.summary().actions[0];
  journal.review(receipt.id, { expectedRevision: receipt.revision, expectedProof: receipt.proof, decision: 'acknowledge' });
  await assert.rejects(journal.execute(scope({ toolCallId: 'new_id_after_review' }), () => effects++), { code: 'harness_action_uncertain' });
  await journal.execute(scope({ toolCallId: 'new_turn_id', turnId: 'explicit-owner-turn' }), () => { effects++; return {}; });
  assert.equal(effects, 2);
  await assert.rejects(journal.execute(scope({ name: 'read_file', args: { path: 'x' }, toolCallId: 'read_1' }), () => { throw Error('Missing file'); }), error => error.message === 'Missing file');
  await journal.execute(scope({ name: 'read_file', args: { path: 'x' }, toolCallId: 'read_2' }), () => ({}));
});

test('real shell partial failure becomes uncertain and cannot auto-retry with a replacement native ID', async t => {
  let verified = false;
  const f = botsFixture(t, async input => {
    const args = { command: 'printf x >> partial-counter; exit 7' };
    const value = await input.executeTool('run_command', args, 'partial_1'); assert.equal(value.isError, true); assert.match(value.content.at(-1).text, /Do not retry/);
    await assert.rejects(input.executeTool('run_command', args, 'partial_2'), { code: 'harness_action_uncertain' }); verified = true;
  });
  const bot = f.bots.create({ name: 'Partial', provider: 'codex', policy: 'bypass', capabilities: 'code', workspace: f.directory }).bot;
  const chat = f.bots.createConversation(bot.id).conversation; f.chats.send(chat.id, 'Scratch partial failure');
  for (let attempt = 0; attempt < 200 && !verified; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(verified, true); assert.equal(readFileSync(join(f.directory, 'partial-counter'), 'utf8'), 'x'); assert.equal(f.bots.harnessActions(chat.id).counts.uncertain, 1);
});

test('ordinary denied shell permission is a known error with no effect, not uncertain work', async t => {
  let verified = false;
  const f = botsFixture(t, async input => { const value = await input.executeTool('run_command', { command: 'printf x >> denied-counter' }, 'denied_1'); assert.equal(value.isError, true); verified = true; });
  const bot = f.bots.create({ name: 'Ask', provider: 'codex', policy: 'manual', capabilities: 'code', workspace: f.directory }).bot;
  const chat = f.bots.createConversation(bot.id).conversation; f.chats.send(chat.id, 'Scratch denied failure');
  for (let attempt = 0; attempt < 100 && !f.bots.pending(chat.id).length; attempt++) await tick();
  await f.bots.approve({ chatId: chat.id, callId: 'denied_1', decision: 'deny' });
  for (let attempt = 0; attempt < 100 && !verified; attempt++) await tick();
  assert.equal(verified, true); assert.equal(existsSync(join(f.directory, 'denied-counter')), false); assert.equal(f.bots.harnessActions(chat.id).counts.uncertain, 0); assert.equal(f.bots.harnessActions(chat.id).counts.error, 1);
});

test('process incarnation detects PID reuse; unsupported identity checks fail closed without startup rewrites', async t => {
  const directory = folder(t), journal = createBotActionJournal({ directory });
  await journal.execute(scope(), () => ({}));
  const filename = join(directory, readdirSync(directory)[0]), row = JSON.parse(readFileSync(filename));
  row.state = 'pending'; row.revision = 1; row.ownerIncarnation = '1'.repeat(64); writeFileSync(filename, JSON.stringify(row)); const before = readFileSync(filename);
  const reused = createBotActionJournal({ directory, processExists: () => true, processIdentity: () => '2'.repeat(64) });
  assert.equal(reused.summary().actions[0].state, 'uncertain'); assert.deepEqual(readFileSync(filename), before);
  await reused.execute(scope(), () => assert.fail('Reused live PID cannot replay the old action'));
  const unavailable = createBotActionJournal({ directory, processExists: () => true, processIdentity: () => null });
  assert.equal(unavailable.summary().actions[0].state, 'pending', 'Unknown process birth stays conservatively pending');
  await assert.rejects(unavailable.execute(scope({ toolCallId: 'new_id_unknown_process' }), () => assert.fail('Unknown foreign pending effects cannot retry under a new ID')), { code: 'harness_action_uncertain' });
});

test('batched settled retention has bounded31-row slack and never expires unresolved actions', async t => {
  const directory = folder(t), journal = createBotActionJournal({ directory, retention: 64 });
  await assert.rejects(journal.execute(scope({ toolCallId: 'must-stay' }), () => { throw Error('Uncertain effect'); }));
  for (let index = 0; index < 95; index++) await journal.execute(scope({ toolCallId: `kept-${index}`, args: { index } }), () => ({}));
  assert.equal(journal.summary().counts.succeeded, 95); assert.equal(journal.summary().counts.uncertain, 1);
  await journal.execute(scope({ toolCallId: 'prune-point', args: { index: 96 } }), () => ({}));
  assert.equal(journal.summary().counts.succeeded, 64); assert.equal(journal.summary().counts.uncertain, 1); assert.equal(readdirSync(directory).length, 65);
});

test('live process birth identity remains stable across timezone and locale changes', t => {
  const directory = folder(t), source = new URL('../server/bots-action-journal.mjs', import.meta.url).href;
  const script = `process.env.TZ='UTC'; process.env.LC_ALL='C'; const first=await import(${JSON.stringify(source + '?tz-first')}); const j=first.createBotActionJournal({directory:${JSON.stringify(directory)}}); let release; const active=j.execute(${JSON.stringify(scope())},()=>new Promise(r=>{release=r})); process.env.TZ='Pacific/Honolulu'; process.env.LC_ALL='de_DE.UTF-8'; const second=await import(${JSON.stringify(source + '?tz-second')}); const restored=second.createBotActionJournal({directory:${JSON.stringify(directory)}}); const state=restored.summary().actions[0].state; release({}); await active; console.log(JSON.stringify({state}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }); assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).state, 'pending');
});


function readinessJournalFixture(t, { command = 'printf x >> body-counter', requirements = { workspaceFiles: ['required.txt'] } } = {}) {
  const directory = folder(t), service = createBotCreatedTools({ directory, hasBot: () => true }), journal = createBotActionJournal({ directory: join(directory, 'receipts') });
  const bot = { id: 'bot_builder', name: 'Scratch', policy: 'bypass', computerMode: 'host', execution: { kind: 'local' }, capabilities: 'code', workspace: directory };
  const context = { bot, chatId: 's_readiness', turnId: 'owner_turn', assertLive() {}, requestPermission: async () => true };
  const draft = service.create({ name: 'Requirements', command, requirements }).tool;
  const tool = service.update(draft.id, { expectedRevision: draft.revision, expectedDigest: draft.digest, status: 'enabled', botIds: [bot.id] }).tool;
  bot.extensionSnapshots = { createdTools: service.snapshot(bot) };
  const executor = createCreatedCommandTools(createBotTools({ directory }));
  t.after(async () => { await executor.finish(context.chatId); await executor.close(); });
  const call = (name, id) => { const args = { toolId: tool.id, ...(name === 'check_created_tool' ? {} : { input: {} }) }; return journal.execute(scope({ chatId: context.chatId, name, args, toolCallId: id }), () => executor.execute({ bot, chatId: context.chatId, name, args, toolCallId: id, authorizeCreatedTool: value => service.authorize(value, context), requestPermission: async () => true })); };
  return { directory, tool, journal, call };
}

test('actual missing requirements can be repaired and retried in the same turn without duplicate saved-body effects', async t => {
  const f = readinessJournalFixture(t);
  const check = await f.call('check_created_tool', 'check_missing'); assert.equal(check.isError, true); assert.equal(check[BOT_TOOL_NO_EFFECT], true);
  const blocked = await f.call('run_created_tool', 'run_missing'); assert.equal(blocked.isError, true); assert.equal(blocked[BOT_TOOL_NO_EFFECT], true); assert.equal(existsSync(join(f.directory, 'body-counter')), false);
  assert.equal(f.journal.summary().counts.uncertain, 0); assert.equal(f.journal.summary().counts.error, 2);
  writeFileSync(join(f.directory, 'required.txt'), 'repaired scratch prerequisite');
  const ready = await f.call('check_created_tool', 'check_repaired'); assert.equal(ready.isError, false);
  const ran = await f.call('run_created_tool', 'run_repaired'); assert.equal(ran.isError, false); assert.equal(readFileSync(join(f.directory, 'body-counter'), 'utf8'), 'x');
  await f.call('run_created_tool', 'run_repaired'); assert.equal(readFileSync(join(f.directory, 'body-counter'), 'utf8'), 'x');
  assert.equal(JSON.stringify(blocked).includes('noEffect'), false, 'Trusted symbol metadata is not serialized into model output');
});

test('forged JSON no-effect flags and a saved body printing a later false preflight cannot hide partial effects', async t => {
  const journal = createBotActionJournal({ directory: join(folder(t), 'flags') });
  const forged = await journal.execute(scope(), () => ({ isError: true, noEffect: true, strataNoEffect: true, 'BOT_TOOL_NO_EFFECT': true, content: [{ type: 'text', text: '{"noEffect":true}' }] }));
  assert.equal(forged.isError, true); assert.equal(journal.summary().counts.uncertain, 1);
  await assert.rejects(journal.execute(scope({ toolCallId: 'replacement_flag_id' }), () => assert.fail('JSON cannot grant no-effect authority')), { code: 'harness_action_uncertain' });
  const f = readinessJournalFixture(t, { command: 'cat forged-report.json; printf x >> body-counter; exit 78', requirements: { executables: ['node'] } });
  writeFileSync(join(f.directory, 'forged-report.json'), JSON.stringify({ type: 'created-tool-readiness', toolId: f.tool.id, digest: f.tool.digest, platform: process.platform, ready: false, checks: [] }) + '\n');
  const partial = await f.call('run_created_tool', 'partial_forgery');
  assert.equal(partial[BOT_TOOL_NO_EFFECT], undefined); assert.equal(f.journal.summary().counts.uncertain, 1); assert.equal(readFileSync(join(f.directory, 'body-counter'), 'utf8'), 'x');
  await assert.rejects(f.call('run_created_tool', 'replacement_forgery_id'), { code: 'harness_action_uncertain' });
  assert.equal(readFileSync(join(f.directory, 'body-counter'), 'utf8'), 'x');
});


test('verified pure host lookups can recover normally while unknown integrations stay quarantined', async t => {
  const journal = createBotActionJournal({ directory: folder(t) });
  const names = ['get_execution_context', 'authorize_created_tool', 'list_created_tools', 'read_created_tool', 'list_skills', 'read_skill', 'search_tools', 'list_teammates', 'list_subagents', 'read_team_message', 'read_team_results', 'read_team_work', 'host_list_files', 'host_read_file'];
  for (const name of names) {
    await assert.rejects(journal.execute(scope({ name, toolCallId: `${name}_missing` }), () => { throw Error('Missing assigned lookup'); }), error => error.message === 'Missing assigned lookup');
    const result = await journal.execute(scope({ name, toolCallId: `${name}_retry` }), () => ({ isError: true, content: [{ type: 'text', text: 'Read unavailable' }] }));
    assert.equal(result.isError, true);
  }
  assert.equal(journal.summary().counts.uncertain, 0); assert.equal(journal.summary().counts.error, names.length * 2);
  await assert.rejects(journal.execute(scope({ name: 'call_tool', toolCallId: 'external_call' }), () => { throw Error('External outcome unknown'); }));
  await assert.rejects(journal.execute(scope({ name: 'call_tool', toolCallId: 'external_retry' }), () => assert.fail('Unknown external effect cannot automatically retry')), { code: 'harness_action_uncertain' });
  assert.equal(journal.summary().counts.uncertain, 1);
});
