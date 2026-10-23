/** Inert inference/stdio fixtures only. No provider, account, SSH, VM or owner data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runConfiguredBot, createBotModelClient } from '../server/bots-models.mjs';
import { createBotRuntime } from '../server/bots-runtime/index.mjs';
import { jsonRpcProcess } from '../server/bots-runtime/process.mjs';
import { createRemoteBotSSH } from '../server/bots-ssh.mjs';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';

const directory = await mkdtemp(join(tmpdir(), 'strata-continuous-runtime-'));
test.after(() => rm(directory, { recursive: true, force: true }));
const immediate = () => new Promise(resolve => setImmediate(resolve));
const tool = { name: 'inspect', description: 'Inert fixture', inputSchema: { type: 'object', properties: {} } };
const bot = (provider, continuousTeam) => ({ id: 'bot_fixture', name: 'Fixture', provider, model: 'fixture:cloud', workspace: directory, execution: { kind: 'local' }, continuousTeam });
const answer = (round, terminal = 40) => round <= terminal ? { text: `Progress ${round}`, toolCalls: [{ id: `call_${round}`, name: 'inspect', args: {} }] } : { text: 'Final report', toolCalls: [] };
const sse = event => new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);

for (const continuousTeam of [false, true]) test(`configured model ${continuousTeam ? 'continues beyond 32 steps' : 'keeps the standalone 32-step behavior'}`, async () => {
  let requests = 0, executions = 0, saved = 0;
  const context = { bot: bot('configured', continuousTeam), history: [], message: 'Fixture', tools: [tool], signal: new AbortController().signal, frame() {}, save() { saved++; },
    modelRequest: async () => answer(++requests), execute: async () => { executions++; return { content: [{ type: 'text', text: 'Inert result' }] }; } };
  if (continuousTeam) { await runConfiguredBot(context); assert.equal(requests, 41); assert.equal(executions, 40); assert.equal(saved, 1); assert.equal(context.publicReply, 'Final report'); }
  else { await assert.rejects(runConfiguredBot(context), /32-step/); assert.equal(requests, 32); assert.equal(executions, 32); assert.equal(saved, 0); }
});

for (const continuousTeam of [false, true]) test(`Ollama ${continuousTeam ? 'continues beyond 32 steps' : 'keeps the standalone 32-step behavior'}`, async () => {
  let requests = 0, executions = 0;
  const runtime = createBotRuntime({ env: { OLLAMA_API_KEY: 'inert-fixture-key' }, fetch: async () => {
    const result = answer(++requests);
    return sse({ choices: [{ delta: result.toolCalls.length ? { content: result.text, tool_calls: [{ index: 0, id: result.toolCalls[0].id, function: { name: 'inspect', arguments: '{}' } }] } : { content: result.text }, finish_reason: result.toolCalls.length ? 'tool_calls' : 'stop' }] });
  } });
  try {
    const pending = runtime.run({ bot: bot('ollama', continuousTeam), history: [], message: 'Fixture', tools: [tool], executeTool: async () => { executions++; return 'Inert result'; } });
    if (continuousTeam) { const result = await pending; assert.equal(requests, 41); assert.equal(executions, 40); assert.equal(result.publicReply, 'Final report'); assert.match(result.text, /Progress 1/); }
    else { await assert.rejects(pending, /32-step/); assert.equal(requests, 32); assert.equal(executions, 32); }
  } finally { await runtime.close(); }
});

test('continuous configured API accepts more than 500 protocol messages but retains the byte bound', async () => {
  let requests = 0;
  const client = createBotModelClient({ providers: { resolve: () => ({ connection: { id: 'fixture', baseUrl: 'https://fixture.invalid/v1', protocol: 'openai-chat' }, model: { id: 'fixture' } }) }, fetchImpl: async () => { requests++; return sse({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }); } });
  const profile = { ...bot('configured', true), modelSource: { connectionId: 'fixture', model: 'fixture' } };
  const payload = { messages: Array.from({ length: 601 }, () => ({ role: 'user', content: 'Inert context' })), tools: [], system: 'Fixture' };
  assert.equal((await client(payload, profile, new AbortController().signal)).text, 'Done');
  await assert.rejects(client(payload, { ...profile, continuousTeam: false }, new AbortController().signal), /model request is invalid/);
  await assert.rejects(client({ ...payload, messages: [{ role: 'user', content: 'x'.repeat(16 * 1024 * 1024) }] }, profile, new AbortController().signal), /context exceeded the size limit/);
  assert.equal(requests, 1, 'oversized and ordinary requests fail before transport');
});

for (const continuousTeam of [false, true]) test(`${continuousTeam ? 'continuous team' : 'standalone'} provider deadline after 31 virtual minutes; Stop still owns cancellation`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), frames = []; let started, providerSignal;
  const entered = new Promise(resolve => { started = resolve; });
  const runtime = createBotRuntime();
  const pending = runtime.run({ bot: bot('configured', continuousTeam), history: [], message: 'Fixture', signal: controller.signal, onFrame: frame => frames.push(frame), modelRequest: (_payload, _bot, signal) => {
    providerSignal = signal; started(); return new Promise((_resolve, reject) => { const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  } });
  // Attach rejection before advancing the timer, keeping the fixture itself handled.
  const observed = pending.then(value => ({ value }), error => ({ error }));
  await entered; t.mock.timers.tick(31 * 60_000); await immediate();
  assert.equal(providerSignal.aborted, !continuousTeam);
  if (continuousTeam) { assert.equal(frames.some(frame => frame.type === 'done' || frame.type === 'error'), false); controller.abort(); }
  assert.equal((await observed).error.name, 'AbortError');
  assert.equal(frames.some(frame => frame.type === 'done'), false);
  await runtime.close();
});

test('continuous runtime propagates quota failure once without retries or success', async () => {
  let requests = 0; const frames = [];
  const runtime = createBotRuntime({ env: { OLLAMA_API_KEY: 'inert-fixture-key' }, fetch: async () => { requests++; return new Response('', { status: 402 }); } });
  try { await assert.rejects(runtime.run({ bot: bot('ollama', true), message: 'Fixture', onFrame: frame => frames.push(frame) }), /402/); assert.equal(requests, 1); assert.equal(frames.some(frame => frame.type === 'done'), false); }
  finally { await runtime.close(); }
});

test('Claude public team reply uses the successful terminal result while shared history retains progress', async () => {
  const runtime = createBotRuntime({ commands: { claude: '/inert' }, claudeSdk: { query() { return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Progress commentary.' }] } };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Final report.' }] } };
    yield { type: 'result', subtype: 'success', result: 'Final report.', usage: {} };
  })(); } } });
  try {
    const result = await runtime.run({ bot: bot('claude', true), message: 'Inert', tools: [] });
    assert.equal(result.text, 'Progress commentary.Final report.'); assert.equal(result.publicReply, 'Final report.');
  } finally { await runtime.close(); }
});

test('continuous configured loop stops beyond 32 tools without replaying another model request', async () => {
  const controller = new AbortController(); let requests = 0, executions = 0;
  await assert.rejects(runConfiguredBot({ bot: bot('configured', true), history: [], message: 'Fixture', tools: [tool], signal: controller.signal, frame() {}, save() {},
    modelRequest: async () => answer(++requests, 100), execute: async () => { if (++executions === 40) controller.abort(); return { content: [{ type: 'text', text: 'Inert result' }] }; },
  }), { name: 'AbortError' });
  assert.equal(requests, 40); assert.equal(executions, 40);
});

function rpcFixture(signal) {
  const child = new EventEmitter(), messages = [];
  Object.assign(child, { exitCode: 0, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(chunk, _encoding, done) { messages.push(JSON.parse(String(chunk))); done(); } }) });
  const rpc = jsonRpcProcess({ command: 'inert', args: [], signal, spawnProcess: () => child });
  return { child, messages, rpc };
}
test('only explicit null RPC prompts omit a deadline; setup requests remain bounded and Abort rejects pending prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const controller = new AbortController(); const f = rpcFixture(controller.signal);
  const prompt = f.rpc.request('session/prompt', {}, null).catch(error => error), setup = f.rpc.request('initialize', {}, null).catch(error => error);
  t.mock.timers.tick(31 * 60_000); await immediate();
  assert.match((await setup).message, /initialize timed out/);
  let settled = false; prompt.then(() => { settled = true; }); await immediate(); assert.equal(settled, false);
  controller.abort(); assert.equal((await prompt).name, 'AbortError'); await f.rpc.close();
});

for (const provider of ['grok', 'kimi']) test(`${provider} continuous ACP prompt survives 31 virtual minutes, then Stop cleans up`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const controller = new AbortController(); let entered, child;
  const promptEntered = new Promise(resolve => { entered = resolve; });
  const runtime = createBotRuntime({ stateDir: join(directory, provider), commands: { [provider]: '/inert' }, spawnProcess() {
    child = new EventEmitter(); const emit = message => queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`));
    Object.assign(child, { exitCode: 0, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(String(chunk));
      if (message.method === 'session/prompt') entered();
      else if (message.id !== undefined) emit({ id: message.id, result: message.method === 'session/new' ? { sessionId: 'inert' } : {} });
      done();
    } }) }); return child;
  } });
  const observed = runtime.run({ bot: bot(provider, true), sessionId: 's_fixture', message: 'Inert', signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  await promptEntered; t.mock.timers.tick(31 * 60_000); await immediate();
  assert.equal(controller.signal.aborted, false);
  let settled = false; observed.then(() => { settled = true; }); await immediate(); assert.equal(settled, false);
  controller.abort(); assert.equal((await observed).error.name, 'AbortError'); await runtime.close();
});

for (const continuousTeam of [false, true]) test(`SSH ${continuousTeam ? 'continuous' : 'standalone'} run deadline and acknowledged Stop preserve the trusted worker flag`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const controller = new AbortController(); let entered, request, cancels = 0;
  const requestEntered = new Promise(resolve => { entered = resolve; });
  const ssh = createRemoteBotSSH({ bundle: async () => ({ hash: 'inert', files: [], dependencies: {} }), spawnProcess() {
    const child = new EventEmitter(); const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
    Object.assign(child, { exitCode: 0, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(String(chunk));
      if (message.action === 'run') { request = message; queueMicrotask(entered); }
      if (message.type === 'cancel') { cancels++; queueMicrotask(() => { emit({ type: 'cleanup', confirmed: true }); emit({ type: 'result', value: { cancelled: true } }); child.emit('close', 0); }); }
      done();
    } }) }); return child;
  } });
  const observed = ssh.run({ bot: { ...bot('configured', continuousTeam), execution: { kind: 'ssh', host: 'fixture.invalid' } }, sessionId: 's_inert', message: 'Inert', signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  await requestEntered; assert.equal(request.input.bot.continuousTeam, continuousTeam);
  t.mock.timers.tick(31 * 60_000); await immediate(); assert.equal(cancels, continuousTeam ? 0 : 1);
  if (continuousTeam) controller.abort();
  const outcome = await observed; assert.equal(continuousTeam ? outcome.error.name : outcome.error.code, continuousTeam ? 'AbortError' : 'ssh_timeout');
  assert.equal(cancels, 1); await ssh.close();
});

test('only a current bound team job grants continuous runtime and model inference; profiles and standalone chats cannot forge it', async t => {
  const path = await mkdtemp(join(directory, 'authority-')); let chats; const seen = [], modelFlags = [];
  const connection = { id: 'inert', name: 'Inert', baseUrl: 'https://fixture.invalid/v1', protocol: 'openai-chat', models: [{ id: 'inert' }] };
  const bots = createBots({ directory: path, defaultWorkspace: () => path, conversations: () => chats, tools: { definitions: () => [], finish() {} }, modelProviders: { resolve: () => ({ connection, model: connection.models[0] }), list: () => ({ connections: [connection] }) },
    modelRequest: async (_payload, profile) => { modelFlags.push(profile.continuousTeam); return { text: 'Inert answer', toolCalls: [] }; },
    runtime: { providers: async () => [], async run(input) { seen.push(input.bot.continuousTeam); await input.modelRequest({ messages: [], tools: [] }); input.onFrame({ type: 'done' }); }, async close() {} },
  });
  chats = createConversations({ directory: path, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), execute: input => bots.run(input), validateSelection: selection => bots.validateSelection(selection) });
  t.after(async () => { await bots.close(); chats.close(); });
  const profile = { name: 'Inert', provider: 'configured', workspace: path, policy: 'bypass', modelSource: { connectionId: 'inert', model: 'inert' } };
  const member = bots.create({ ...profile, continuousTeam: true }).bot;
  assert.equal(Object.hasOwn(member, 'continuousTeam'), false, 'native profile creation cannot persist the internal flag');
  await assert.rejects(bots.saveProfile({ name: 'Inert', provider: 'codex', computerId: 'local', continuousTeam: true }), { status: 400 });
  const other = bots.create({ ...profile, name: 'Other inert member' }).bot;
  // A bound job is continuous only when every limit is 0. New teams use finite
  // defaults, so this job opts into unlimited limits explicitly.
  bots.team.create({ name: 'Inert team', memberIds: [member.id, other.id], coordinatorId: member.id, enabled: true, limits: { maxParallel: 0, maxDepth: 0, maxHops: 0, maxTurns: 0, maxDurationMs: 0 } });
  const team = bots.team.list().teams[0];
  const standalone = bots.createConversation(member.id).conversation.id;
  chats.send(standalone, 'Inert standalone');
  for (let i = 0; i < 1000 && !seen.length; i++) await immediate();
  assert.equal(seen[0], false);
  bots.team.start(team.id, { message: 'Inert team' });
  for (let i = 0; i < 1000 && seen.length < 2; i++) await immediate();
  assert.equal(seen[1], true);
  assert.deepEqual(modelFlags, [false, true], 'configured inference independently receives host-bound authority');
});
