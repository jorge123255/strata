import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRemoteBotSSH } from '../server/bots-ssh.mjs';
import { startWorker } from '../server/bots-runtime/ssh-worker.mjs';

const directory = await mkdtemp(join(tmpdir(), 'strata-host-broker-'));
test.after(() => rm(directory, { recursive: true, force: true }));
const hostTools = [{ name: 'call_tool', description: 'Assigned host MCP tool', inputSchema: { type: 'object', properties: { toolId: { type: 'string' } } } }];
const bot = { id: 'bot_fixture', name: 'Fixture', provider: 'configured', model: 'fixture', workspace: directory, capabilities: 'code', policy: 'manual', execution: { kind: 'ssh', host: 'fixture.invalid', user: 'fixture' }, extensionSnapshots: { mcp: { privateText: 'PRIVATE_SNAPSHOT_MUST_STAY_ON_MAC' } }, providerSettings: { apiKey: 'PRIVATE_MODEL_KEY_MUST_STAY_ON_MAC' } };
const program = join(directory, 'transport.mjs');
await writeFile(program, `import readline from'node:readline';const mode=process.argv[2];let started=false;const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');const end=value=>{out({type:'cleanup',confirmed:true});out({type:'result',value});setTimeout(()=>process.exit(0),5)};readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='heartbeat')return;if(m.type==='cancel'){end({cancelled:true});return;}if(!started){started=true;if(JSON.stringify(m).includes('MUST_STAY_ON_MAC'))process.exit(11);if(m.input.hostTools?.[0]?.name!=='call_tool')process.exit(12);out({type:'requestHostTool',id:'host-request',value:{name:mode==='forbidden'?'run_command':'call_tool',args:{toolId:'opaque-id'},toolCallId:'stable-call'}});return;}if(m.type==='reply'&&m.id==='host-request')end({text:m.error||m.value.content[0].text,tokensIn:0,tokensOut:0});});`);
const bundle = async () => ({ hash: 'fixture', files: [], dependencies: {} });
function transport(mode) { return createRemoteBotSSH({ bundle, spawnProcess: (_command, _args, options) => spawn(process.execPath, [program, mode], options), cleanupTimeoutMs: 1000, leaseMs: 10, leaseCleanupGraceMs: 10 }); }

test('SSH host broker forwards only frozen tool descriptors, keeps private snapshots/keys on Mac and preserves call identity', async () => {
  const ssh = transport('allowed'); let calls = 0;
  const result = await ssh.run({ bot, hostTools, sessionId: 's_host', message: 'Fixture only', executeHostTool: async (name, args, id) => { calls++; assert.equal(name, 'call_tool'); assert.deepEqual(args, { toolId: 'opaque-id' }); assert.equal(id, 'stable-call'); return { content: [{ type: 'text', text: 'HOST_BROKER_OK' }] }; } });
  assert.equal(result.text, 'HOST_BROKER_OK'); assert.equal(calls, 1); await ssh.close();
});
test('SSH host broker rejects an unlisted host tool without calling the host executor', async () => {
  const ssh = transport('forbidden'); let calls = 0;
  const result = await ssh.run({ bot, hostTools, sessionId: 's_forbidden', message: 'Fixture only', executeHostTool: async () => { calls++; } });
  assert.equal(calls, 0); assert.match(result.text, /outside this turn/); await ssh.close();
});
test('SSH cancellation aborts ownership and ignores a late host tool response', async () => {
  const ssh = transport('allowed'), controller = new AbortController(); let release, called;
  const began = new Promise(resolve => { called = resolve; });
  const operation = ssh.run({ bot, hostTools, sessionId: 's_cancel', message: 'Fixture only', signal: controller.signal, executeHostTool: async () => { called(); return await new Promise(resolve => { release = resolve; }); } });
  await began; controller.abort(); await assert.rejects(operation, { name: 'AbortError' }); release({ content: [{ type: 'text', text: 'LATE_RESULT' }] }); await ssh.close();
});
class Reader extends EventEmitter { close() { this.emit('close'); } }
test('actual SSH worker combines execution tools with host descriptors and routes host execution back to Mac', async () => {
  const reader = new Reader(), sent = [], folder = join(directory, 'worker'); await mkdir(folder);
  let localCalls = 0, checked = false;
  await startWorker({ bot: { ...bot, extensionSnapshots: undefined, providerSettings: undefined }, sessionId: 's_worker', message: 'Fixture only', hostTools }, {
    reader, directory: folder, leaseMs: 1000,
    send(message) { sent.push(message); if (message.type === 'requestHostTool') setImmediate(() => reader.emit('line', JSON.stringify({ type: 'reply', id: message.id, value: { content: [{ type: 'text', text: 'HOST_RESULT' }] } }))); },
    toolFactory: () => ({ definitions: () => [{ name: 'read_file', description: 'Local file', inputSchema: { type: 'object' } }], execute: () => { localCalls++; }, finish: async () => {}, close: async () => {} }),
    runtimeFactory: () => ({ async run(input) { assert.deepEqual(input.tools.map(t => t.name), ['read_file', 'call_tool']); const result = await input.executeTool('call_tool', { toolId: 'opaque-id' }, 'worker-call'); assert.equal(result.content[0].text, 'HOST_RESULT'); checked = true; return { text: 'done' }; }, close: async () => {} }),
  });
  assert.equal(checked, true); assert.equal(localCalls, 0);
  const call = sent.find(m => m.type === 'requestHostTool'); assert.equal(call.value.toolCallId, 'worker-call');
  assert.equal(sent.some(m => m.type === 'cleanup' && m.confirmed), true);
});
