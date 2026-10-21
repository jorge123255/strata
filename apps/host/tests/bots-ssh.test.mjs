import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRemoteBotSSH, botSSHArguments, normalizeBotSSH, botSSHTarget, botSSHBundle } from '../server/bots-ssh.mjs';
import { bootstrapSource, SSH_BOTS_COMMAND } from '../server/bots-ssh-bootstrap.mjs';
import { pythonBootstrap, BOT_NODE_ARCHIVES } from '../server/bots-ssh-python.mjs';
import { startWorker, computerOperation, activeRemoteRuns, acquireComputerLease } from '../server/bots-runtime/ssh-worker.mjs';
import { createBotRuntime } from '../server/bots-runtime/index.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'strata-bots-ssh-test-'));
test.after(async () => { await rm(scratch, { recursive: true, force: true }); });
const execution = { kind: 'ssh', host: 'fixture-alias', user: 'fixture' };
const bot = { id: 'bot_fixture', name: 'Remote fixture', provider: 'configured', model: 'fixture', capabilities: 'code', policy: 'manual', execution, workspace: join(scratch, 'remote-workspace') };
await mkdir(bot.workspace);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class Reader extends EventEmitter { close() { this.emit('close'); } }
const minimalWorker = `export async function probeWorker(){return {platform:process.platform,providers:[],activeRuns:0,detail:'Fixture helper'};}export async function startWorker(input,{reader,send}){send({type:'identity',value:'a'.repeat(64)});send({type:'cleanup',confirmed:true});send({type:'result',value:{text:'fixture',tokensIn:1,tokensOut:1}});reader.close();}export async function computerOperation(input,{reader,send}){send({type:'cleanup',confirmed:true});send({type:'result',value:{running:false,operation:input.operation}});reader.close();}`;
function fixtureBundle(worker = minimalWorker) {
  const assets = { 'server/bots-runtime/ssh-worker.mjs': Buffer.from(worker), 'package.json': Buffer.from(JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', private: true })), 'package-lock.json': Buffer.from(JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } })) };
  const files = Object.entries(assets).map(([name, value]) => [name, createHash('sha256').update(value).digest('hex')]);
  return { hash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files, dependencies: {}, assets: Object.fromEntries(Object.entries(assets).map(([name, value]) => [name, value.toString('base64')])) };
}

test('SSH settings preserve aliases and optional ports, reject shell injection and keep remote command fixed', () => {
  const args = botSSHArguments(execution);
  assert.equal(args.includes('-p'), false); assert.equal(args.includes('StrictHostKeyChecking=yes'), true); assert.equal(args.includes('ForwardAgent=no'), true); assert.equal(args.at(-1), SSH_BOTS_COMMAND);
  assert.equal(args.at(-2), 'fixture-alias'); assert.deepEqual(normalizeBotSSH({ ...execution, user: 'account$' }), { ...execution, user: 'account$' });
  assert.equal(botSSHArguments({ ...execution, port: 2222 }).includes('2222'), true);
  assert.notEqual(botSSHTarget(execution), botSSHTarget({ ...execution, user: 'different' }));
  for (const host of ['-oProxyCommand=oops', 'server;touch /tmp/oops', 'user@server', 'server\nother']) assert.throws(() => botSSHArguments({ ...execution, host }), /valid SSH/);
  assert.throws(() => botSSHArguments({ ...execution, user: 'root;id' }), /valid SSH/);
});
test('worker bundle pins SDK, browser library and all transitive lockfile bytes', async () => {
  const first = await botSSHBundle(), second = await botSSHBundle();
  assert.equal(first.hash, second.hash); assert.equal(first.dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.304');
  assert.ok(first.assets['package-lock.json']); assert.ok(first.assets['server/bots-runtime/devin.mjs']); assert.ok(first.assets['server/bots-tools.mjs']); assert.ok(first.assets['server/bots-models.mjs']); assert.ok(first.assets['server/bots-cua.mjs']); assert.ok(first.assets['server/bots-cua.py']);
  assert.ok(first.assets['server/bots-runtime/grok.mjs']);
  const lock = JSON.parse(Buffer.from(first.assets['package-lock.json'], 'base64')); assert.equal(lock.packages['node_modules/playwright-core'].version, '1.63.0');
  for (const [name, expected] of first.files) assert.equal(createHash('sha256').update(Buffer.from(first.assets[name], 'base64')).digest('hex'), expected);
});
test('complete SSH package imports its runtime with the same pinned Grok helper', async () => {
  const bundle = await botSSHBundle(), unpacked = join(scratch, 'complete-worker-bundle');
  for (const [name, encoded] of Object.entries(bundle.assets)) { const path = join(unpacked, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.from(encoded, 'base64')); }
  const source = await readFile(new URL('../server/bots-runtime/grok.mjs', import.meta.url));
  const copied = await readFile(join(unpacked, 'server/bots-runtime/grok.mjs'));
  assert.equal(copied.equals(source), true);
  const runtime = await import(pathToFileURL(join(unpacked, 'server/bots-runtime/index.mjs')).href);
  assert.equal(typeof runtime.createBotRuntime, 'function');
});
test('private Node pins match recorded desktop runtime and Python bootstrap compiles', async () => {
  assert.equal(BOT_NODE_ARCHIVES['linux-x64'], '6159227e0af7d7c3c6bb2fa900452b04a6cb8841a702a79acc613209d70b04d0');
  const source = pythonBootstrap(bootstrapSource), path = join(scratch, 'bootstrap.py'); await writeFile(path, source);
  const child = spawn('python3', ['-m', 'py_compile', path], { stdio: 'pipe' }); let err = ''; child.stderr.on('data', c => { err += c; });
  const code = await new Promise(resolve => child.on('close', resolve)); assert.equal(code, 0, err);
  assert.match(source, /https:\/\/nodejs\.org\/dist\/v/); assert.match(source, /sha\.hexdigest\(\)!=digest/); assert.match(source, /if node is None and request.get\('action'\)=='prepare'/);
});
test('read-only probe creates no helper; explicit private preparation verifies files and uses npm ci', async () => {
  const account = join(scratch, 'bootstrap-account'); await mkdir(account);
  const packageSet = fixtureBundle();
  const plans = [];
  const ssh = createRemoteBotSSH({ bundle: async () => packageSet, spawnProcess: (_command, args, options) => { plans.push(args); return spawn('python3', ['-c', pythonBootstrap(bootstrapSource)], { ...options, env: { ...process.env, HOME: account } }); }, managementTimeoutMs: 60_000, runTimeoutMs: 3000, cleanupTimeoutMs: 1000 });
  const before = await ssh.probe(execution); assert.equal(before.prepared, false); assert.equal(before.activeRuns, 0);
  await assert.rejects(access(join(account, '.local')), { code: 'ENOENT' }, 'probe must not create any Strata runtime, helper, catalog or cache');
  const prepared = await ssh.prepare(execution); assert.equal(prepared.prepared, true); assert.equal(prepared.activeRuns, 0);
  const folder = join(account, '.local/share/strata/bot-workers', packageSet.hash);
  assert.equal(await readFile(join(folder, 'server/bots-runtime/ssh-worker.mjs'), 'utf8'), minimalWorker);
  const checked = await ssh.probe(execution); assert.equal(checked.prepared, true); assert.equal(plans.every(p => p.at(-1) === SSH_BOTS_COMMAND), true);
  assert.equal((await ssh.run({ bot, sessionId: 's_bootstrap', message: 'fixture' })).text, 'fixture');
  assert.equal((await ssh.cua(execution, 'state', { bot })).operation, 'state');
  await ssh.close();
});

const protocolPath = join(scratch, 'ssh-fixture.mjs');
await writeFile(protocolPath, `
import readline from 'node:readline';import{writeFile}from'node:fs/promises';
const mode=process.argv[2];let input,stage='start';const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const end=value=>{out({type:'cleanup',confirmed:true});out({type:'result',value});setTimeout(()=>process.exit(0),5);};
readline.createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);if(m.type==='heartbeat')return;if(m.type==='cancel'){end({cancelled:true});return;}
 if(stage==='start'){input=m;stage='permission';if(JSON.stringify(m).includes('DO_NOT_TRANSFER_KEY'))process.exit(8);out({type:'identity',value:'a'.repeat(64)});if(mode==='disconnect'){out({type:'requestModel',id:'model_0',value:{messages:[],tools:[],system:'fixture'}});setTimeout(()=>process.exit(3),10);return;}out({type:'permission',id:'permission_0',value:{id:'tool_0',name:'write_file',args:{path:'marker.txt',content:'remote marker'},reason:'Allow fixture write'}});return;}
 if(m.type==='reply'&&m.id==='permission_0'){if(m.value!==true){end({text:'denied',tokensIn:1,tokensOut:1});return;}await writeFile(input.input.bot.workspace+'/transport-marker.txt','remote marker');stage='model';out({type:'requestModel',id:'model_0',value:{messages:[{role:'user',content:'fixture'}],tools:[],system:'fixture'}});return;}
 if(m.type==='reply'&&m.id==='model_0'){out({type:'checkpoint',value:{provider:input.input.bot.provider,workspace:input.input.bot.workspace,model:input.input.bot.model,nativeSessionId:'native_remote'}});out({type:'frame',value:{type:'reasoning',text:'Remote progress'}});out({type:'frame',value:{type:'delta',text:m.value.text}});end({text:m.value.text,tokensIn:4,tokensOut:2,checkpoint:{provider:input.input.bot.provider,workspace:input.input.bot.workspace,model:input.input.bot.model,nativeSessionId:'native_remote'}});}
});
`);
const fixtureSSH = (mode = 'success') => (_command, _args, options) => spawn(process.execPath, [protocolPath, mode], options);
test('remote run routes approval and configured inference RPC, never local tools or credentials', async () => {
  let localTools = 0, approvals = 0, modelCalls = 0, checkpoint; const frames = [];
  const ssh = createRemoteBotSSH({ bundle: async () => fixtureBundle(), spawnProcess: fixtureSSH(), leaseMs: 20, leaseCleanupGraceMs: 10 });
  const result = await ssh.run({ bot: { ...bot, providerSettings: { apiKey: 'DO_NOT_TRANSFER_KEY' } }, sessionId: 's_remote', message: 'fixture', executeTool: () => { localTools++; throw Error('must never run'); }, onFrame: f => frames.push(f), onCheckpoint: value => { checkpoint = value; }, requestPermission: async request => { approvals++; assert.match(request.reason, /fixture-alias/); return true; }, modelRequest: async (request, signal) => { modelCalls++; assert.equal(signal.aborted, false); assert.equal(request.system, 'fixture'); return { text: 'Remote answer' }; } });
  assert.equal(result.text, 'Remote answer'); assert.equal(localTools, 0); assert.equal(approvals, 1); assert.equal(modelCalls, 1);
  assert.equal(checkpoint.remoteTarget, botSSHTarget(execution)); assert.equal(checkpoint.remoteIdentity, 'a'.repeat(64)); assert.equal(checkpoint.remoteCheckpoint.nativeSessionId, 'native_remote');
  assert.equal(await readFile(join(bot.workspace, 'transport-marker.txt'), 'utf8'), 'remote marker'); assert.equal(frames.at(-1).type, 'done'); await ssh.close();
});
test('resume rejects a different SSH target before connecting', async () => {
  let spawns = 0; const ssh = createRemoteBotSSH({ spawnProcess() { spawns++; throw Error('must not connect'); } });
  await assert.rejects(ssh.run({ bot, checkpoint: { remoteTarget: 'wrong' } }), { code: 'ssh_session_target' }); assert.equal(spawns, 0); await ssh.close();
});
test('SSH preserves explicit terminal team answers, silence and legacy fallback after acknowledged cleanup', async () => {
  const program = `const readline=require('node:readline');const result=JSON.parse(process.argv[1]);readline.createInterface({input:process.stdin}).once('line',()=>{for(const value of [{type:'identity',value:'a'.repeat(64)},{type:'cleanup',confirmed:true},{type:'result',value:result}])process.stdout.write(JSON.stringify(value)+'\\n');setTimeout(()=>process.exit(0),5);});`;
  for (const publicReply of ['Remote final answer', '', undefined]) {
    const frames = [], value = { text: 'Progress plus full transcript', ...(publicReply === undefined ? {} : { publicReply }) };
    const ssh = createRemoteBotSSH({ bundle: async () => fixtureBundle(), spawnProcess: (_command, _args, options) => spawn(process.execPath, ['-e', program, JSON.stringify(value)], options) });
    try {
      const result = await ssh.run({ bot, sessionId: 's_public_final', message: 'fixture', onFrame: frame => frames.push(frame) });
      assert.equal(result.text, value.text);
      assert.equal(frames.at(-1).type, 'done');
      assert.equal(frames.at(-1).publicReply, publicReply);
      assert.equal(Object.hasOwn(frames.at(-1), 'publicReply'), publicReply !== undefined);
    } finally { await ssh.close(); }
  }
});
test('Stop waits for cleanup ACK and ignores late approval replies', async () => {
  const controller = new AbortController(); let approve, requestSignal;
  const ssh = createRemoteBotSSH({ bundle: async () => fixtureBundle(), spawnProcess: fixtureSSH(), cleanupTimeoutMs: 1000 });
  const running = ssh.run({ bot, sessionId: 's_stop', message: 'fixture', signal: controller.signal, requestPermission: (_request, signal) => { requestSignal = signal; controller.abort(); return new Promise(resolve => { approve = resolve; }); } });
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(requestSignal.aborted, true); approve(true); await ssh.close();
});
test('disconnect aborts model generation and reports unconfirmed cleanup without replay', async () => {
  let requestSignal, requests = 0; const frames = [];
  const ssh = createRemoteBotSSH({ bundle: async () => fixtureBundle(), spawnProcess: fixtureSSH('disconnect'), leaseMs: 20, leaseCleanupGraceMs: 10 });
  await assert.rejects(ssh.run({ bot, sessionId: 's_disconnect', message: 'fixture', onFrame: f => frames.push(f), modelRequest: (_request, signal) => { requests++; requestSignal = signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('stopped')), { once: true })); } }), { code: 'ssh_cleanup_unconfirmed' });
  assert.equal(requests, 1); assert.equal(requestSignal.aborted, true); assert.equal(frames.some(f => f.type === 'done'), false); await ssh.close();
});
test('runtime delegates SSH before local filesystem validation', async () => {
  let calls = 0, closed = 0; const runtime = createBotRuntime({ remoteSSH: { run: async input => { calls++; return input.bot.workspace; }, close: async () => { closed++; } } });
  const result = await runtime.run({ bot: { ...bot, workspace: '/remote/only/not/on/this/mac' } }); assert.equal(result, '/remote/only/not/on/this/mac'); assert.equal(calls, 1); await runtime.close(); assert.equal(closed, 1);
});
test('actual remote worker executes scoped tools in its workspace and records one shared ledger', async () => {
  const reader = new Reader(), sent = [], state = join(scratch, 'worker-state');
  const running = startWorker({ bot, sessionId: 's_worker', message: 'fixture' }, { reader, directory: state, leaseMs: 2000,
    send(message) { sent.push(message); if (message.type === 'permission') setTimeout(() => reader.emit('line', JSON.stringify({ type: 'reply', id: message.id, value: true })), 0); if (message.type === 'requestModel') setTimeout(() => reader.emit('line', JSON.stringify({ type: 'reply', id: message.id, value: { text: 'fixture inference', toolCalls: [] } })), 0); },
    runtimeFactory: () => ({ async run(input) { assert.equal(input.bot.execution.kind, 'local'); await input.executeTool('write_file', { path: 'worker-marker.txt', content: 'worker wrote remotely' }, 'tool_worker'); await input.modelRequest({ messages: [], tools: [], system: 'fixture' }); input.onFrame({ type: 'reasoning', text: 'Remote thought' }); await input.onCheckpoint({ nativeSessionId: 'native_worker' }); return { text: 'done', publicReply: 'Final team report', tokensIn: 1, tokensOut: 1 }; }, async close() {} }),
  });
  await running; assert.equal(await readFile(join(bot.workspace, 'worker-marker.txt'), 'utf8'), 'worker wrote remotely');
  assert.equal(sent.filter(m => m.type === 'frame' && m.value.type === 'agent-tool' && m.value.tool.state === 'done').length, 1);
  assert.equal(sent.find(m => m.type === 'result').value.publicReply, 'Final team report');
  assert.equal(sent.some(m => m.type === 'cleanup' && m.confirmed), true); assert.equal(await activeRemoteRuns(state), 0);
});
test('EOF revokes pending remote tool approval so late replies cannot write files', async () => {
  const reader = new Reader(), sent = [], state = join(scratch, 'eof-state'); let permission;
  const running = startWorker({ bot, sessionId: 's_eof', message: 'fixture' }, { reader, directory: state, leaseMs: 1000,
    send(message) { sent.push(message); if (message.type === 'permission') { permission = message; setTimeout(() => reader.close(), 0); } },
    runtimeFactory: () => ({ async run(input) { await input.executeTool('write_file', { path: 'must-not-exist.txt', content: 'late' }, 'late_tool'); return { text: 'unexpected' }; }, async close() {} }),
  });
  await running; reader.emit('line', JSON.stringify({ type: 'reply', id: permission.id, value: true })); await pause(10);
  await assert.rejects(access(join(bot.workspace, 'must-not-exist.txt')), { code: 'ENOENT' }); assert.equal(sent.some(m => m.type === 'cleanup' && m.confirmed), true);
});
test('heartbeat expiry stops the remote worker without a connected Mac', async () => {
  const reader = new Reader(), sent = [];
  await startWorker({ bot, sessionId: 's_lease', message: 'fixture' }, { reader, directory: join(scratch, 'lease-state'), leaseMs: 30, send: m => sent.push(m), runtimeFactory: () => ({ run: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('stopped'), { name: 'AbortError' })), { once: true })), async close() {} }) });
  assert.equal(sent.some(m => m.type === 'cleanup' && m.confirmed), true); assert.equal(sent.find(m => m.type === 'result').value.cancelled, true);
});
test('remote computer lease never removes a live owner and reclaims only a dead PID', async () => {
  const dir = join(scratch, 'computer-state'); const release = await acquireComputerLease(dir);
  await assert.rejects(acquireComputerLease(dir), /Another Bots worker/); await release();
  await writeFile(join(dir, 'leases/computer.lock'), JSON.stringify({ pid: 999999999, nonce: 'dead-fixture' }));
  const next = await acquireComputerLease(dir, { processExists: pid => pid === process.pid }); await next();
  await writeFile(join(dir, 'runs-fixture.json'), '{}'); assert.equal(await activeRemoteRuns(dir), 0);
});
test('active-run probe is read-only, reports live PID, ignores dead PID and preserves malformed records', async () => {
  const state = join(scratch, 'registry-state'), dir = join(state, 'runs'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'live.json'), JSON.stringify({ pid: process.pid, nonce: 'live' })); await writeFile(join(dir, 'dead.json'), JSON.stringify({ pid: 999999999, nonce: 'dead' }));
  assert.equal(await activeRemoteRuns(state), 1); assert.deepEqual((await readdir(dir)).sort(), ['dead.json', 'live.json']);
  await writeFile(join(dir, 'invalid.json'), 'broken'); assert.equal(await activeRemoteRuns(state), null); assert.equal(await readFile(join(dir, 'invalid.json'), 'utf8'), 'broken');
});
test('CUA native provider cwd is private while its logical workspace stays inside the sandbox', async () => {
  let cwd; const stateDir = join(scratch, 'cua-provider-state');
  const runtime = createBotRuntime({ stateDir, commands: { claude: '/fixture/claude' }, claudeSdk: { query({ options }) { cwd = options.cwd; return (async function* () { yield { type: 'system', session_id: 'native_cua' }; yield { type: 'assistant', message: { content: [{ type: 'text', text: 'fixture' }] } }; yield { type: 'result', subtype: 'success', usage: {} }; })(); } } });
  const logical = { ...bot, execution: { kind: 'local' }, provider: 'claude', model: '', computerMode: 'cua', workspace: '/workspace/only-inside-owned-space' };
  const result = await runtime.run({ bot: logical, message: 'fixture', sessionId: 's_cua', tools: [] });
  assert.equal(cwd, join(stateDir, 'cua-provider-workspaces', bot.id)); assert.equal(result.checkpoint.workspace, cwd); assert.equal(logical.workspace, '/workspace/only-inside-owned-space'); await runtime.close();
});
test('isolated computer state RPC never starts inference or the computer', async () => {
  const reader = new Reader(), sent = []; let starts = 0, states = 0;
  await computerOperation({ operation: 'state', bot: { ...bot, computerMode: 'cua' } }, { reader, directory: join(scratch, 'cua-state-op'), send: m => sent.push(m), cuaFactory: () => ({ async state({ bot: selected }) { states++; assert.equal(selected.execution.kind, 'local'); return { running: false, available: true }; }, async start() { starts++; }, async close() {} }) });
  assert.equal(states, 1); assert.equal(starts, 0); assert.equal(sent.some(m => m.type === 'cleanup' && m.confirmed), true); assert.equal(sent.find(m => m.type === 'result').value.running, false);
});
test('isolated computer manual control cannot steal an active bot space lease', async () => {
  const directory = join(scratch, 'cua-control-op'), release = await acquireComputerLease(directory, { key: `cua_${createHash('sha256').update(bot.id).digest('hex')}` }); let controls = 0; const sent = [], reader = new Reader();
  await computerOperation({ operation: 'control', bot: { ...bot, computerMode: 'cua' }, action: 'click', x: 10, y: 10 }, { reader, directory, send: m => sent.push(m), cuaFactory: () => ({ async control() { controls++; }, async close() {} }) });
  assert.equal(controls, 0); assert.match(sent.find(m => m.type === 'failure').message, /Another Bots worker/); await release();
});
test('guest cleanup uncertainty stays distinct from SSH cleanup and blocks only its CUA space until explicit stop', async () => {
  const directory = join(scratch, 'cua-uncertain-op'), selected = { ...bot, computerMode: 'cua' };
  const uncertain = Object.assign(Error('guest cleanup uncertain'), { cleanupUnconfirmed: true });
  let calls = 0;
  const operation = async (kind, factory) => { const sent = []; await computerOperation({ operation: kind, bot: selected, action: 'click', x: 1, y: 1 }, { reader: new Reader(), directory, send: m => sent.push(m), cuaFactory: () => factory }); return sent; };
  const failure = await operation('control', { async control() { throw uncertain; }, async close() { throw uncertain; } });
  assert.equal(failure.find(m => m.type === 'cleanup').confirmed, true); assert.equal(failure.find(m => m.type === 'cleanup').guestCleanupConfirmed, false);
  assert.equal(failure.find(m => m.type === 'failure').code, 'cua_cleanup_unconfirmed'); assert.equal(await activeRemoteRuns(directory), 0);
  const blocked = await operation('start', { async start() { calls++; }, async close() {} });
  assert.equal(calls, 0); assert.equal(blocked.find(m => m.type === 'failure').code, 'cua_cleanup_unconfirmed');
  const stopped = await operation('stop', { async stop() { return { running: false, stopped: true, cleanupConfirmed: true }; }, async close() {} });
  assert.equal(stopped.find(m => m.type === 'cleanup').confirmed, true);
  const restarted = await operation('start', { async start() { calls++; return { running: true }; }, async close() {} });
  assert.equal(calls, 1); assert.equal(restarted.find(m => m.type === 'result').value.running, true);
});
test('remote CUA bot runs acknowledge host cleanup but retain guest cleanup failure without done', async () => {
  const directory = join(scratch, 'cua-run-uncertain'), sent = [], uncertain = Object.assign(Error('guest still alive'), { cleanupUnconfirmed: true });
  await startWorker({ bot: { ...bot, computerMode: 'cua' }, sessionId: 's_cua_uncertain', message: 'fixture' }, {
    reader: new Reader(), directory, send: m => sent.push(m),
    cuaFactory: () => ({ definitions: () => [], async finish() { throw uncertain; }, async close() { throw uncertain; } }),
    runtimeFactory: () => ({ async run() { return { text: 'fixture' }; }, async close() {} }),
  });
  assert.equal(sent.find(m => m.type === 'cleanup').confirmed, true); assert.equal(sent.find(m => m.type === 'failure').code, 'cua_cleanup_unconfirmed');
  assert.equal(sent.some(m => m.type === 'result'), false); assert.equal(await activeRemoteRuns(directory), 0);
});
test('SSH client preserves acknowledged CUA uncertainty without broad transport failure or done', async () => {
  const path = join(scratch, 'cua-protocol-fixture.mjs'); await writeFile(path, `process.stdin.once('data',()=>{process.stdout.write(JSON.stringify({type:'cleanup',confirmed:true,guestCleanupConfirmed:false})+'\\n'+JSON.stringify({type:'failure',code:'cua_cleanup_unconfirmed',message:'Guest cleanup unknown'})+'\\n');process.stdin.destroy();});`);
  const frames = [], ssh = createRemoteBotSSH({ bundle: async () => fixtureBundle(), spawnProcess: (_command, _args, options) => spawn(process.execPath, [path], options) });
  await assert.rejects(ssh.run({ bot: { ...bot, computerMode: 'cua' }, sessionId: 's_cua_fail', message: 'fixture', onFrame: f => frames.push(f) }), error => error.code === 'cua_cleanup_unconfirmed' && error.cleanupUnconfirmed === true);
  assert.equal(frames.some(f => f.type === 'done'), false); await ssh.close();
});
test('remote worker retains per-chat policy: Bypass writes without a permission RPC while Ask denies and Plan excludes mutation', async () => {
  for (const provider of ['claude','codex','grok','kimi','ollama','devin','configured']) for (const policy of ['manual','plan','bypass']) {
    const reader = new Reader(), sent = [], marker = `policy-${provider}-${policy}.txt`;
    await startWorker({ bot: { ...bot, provider, policy }, sessionId: `s_policy_${provider}_${policy}`, message: 'fixture' }, {
      reader, directory: join(scratch, `policy-${provider}-${policy}`), leaseMs: 2000,
      send(message) { sent.push(message); if (message.type === 'permission') setTimeout(() => reader.emit('line', JSON.stringify({ type:'reply', id:message.id, value:false })),0); },
      runtimeFactory: () => ({ async run(input) {
        assert.equal(input.bot.policy, policy); assert.equal(input.bot.provider, provider);
        if (policy === 'plan') { assert.ok(!input.tools.some(tool=>tool.name==='write_file')); await assert.rejects(input.executeTool('write_file',{path:marker,content:'not allowed'},'policy_write'),/not enabled/); }
        else await input.executeTool('write_file',{path:marker,content:'bypass fixture'},'policy_write');
        return {text:'fixture'};
      },async close(){} }),
    });
    assert.equal(sent.filter(message=>message.type==='permission').length,policy==='manual'?1:0,`${provider} ${policy}`);
    if(policy==='bypass')assert.equal(await readFile(join(bot.workspace,marker),'utf8'),'bypass fixture');
    else await assert.rejects(access(join(bot.workspace,marker)),{code:'ENOENT'});
    assert.equal(sent.some(message=>message.type==='cleanup'&&message.confirmed),true);
  }
});
