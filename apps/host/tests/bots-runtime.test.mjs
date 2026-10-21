import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createBotRuntime, acpArguments, acpProfile, normalizeTools, readSse } from '../server/bots-runtime/index.mjs';
import { redact, jsonRpcProcess, killOwned } from '../server/bots-runtime/process.mjs';
import { startToolBridge } from '../server/bots-runtime/tool-bridge.mjs';

const root = await mkdtemp(join(tmpdir(), 'strata-runtime-test-'));
test.after(async () => { await rm(root, { recursive: true, force: true }); });
const bot = (provider, more = {}) => ({ id: 'b_test', name: 'Test', provider, model: '', capabilities: 'both', policy: 'manual', workspace: root, execution: { kind: 'local' }, ...more });
const tools = [{ name: 'inspect', description: 'Fixture tool', inputSchema: { type: 'object', properties: {} } }];
const baseInput = provider => ({ bot: bot(provider), sessionId: 's_test', message: 'Fixture only', history: [], tools, executeTool: async () => 'fixture result', requestPermission: async () => false });
const framesFor = () => { const frames = []; return { frames, onFrame: f => frames.push(f) }; };
const sse = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

test('provider list exposes all six without credentials or login claims', async () => {
  const runtime = createBotRuntime({ stateDir: join(root, 'provider-list'), env: { PATH: '', OLLAMA_API_KEY: 'private-fixture-key' }, commands: { claude: '/not-installed', codex: '/not-installed', grok: '/not-installed', kimi: '/not-installed', ollama: '/not-installed', devin: '/not-installed' } });
  const providers = await runtime.providers();
  assert.deepEqual(providers.map(p => p.id), ['claude', 'codex', 'grok', 'kimi', 'ollama', 'devin']);
  assert.equal(JSON.stringify(providers).includes('private-fixture-key'), false);
  assert.equal(providers[0].auth.state, 'unverified'); assert.equal(providers[4].auth.state, 'configured'); runtime.close();
});
test('rejects unsupported targets and invalid workspaces before inference', async () => {
  const runtime = createBotRuntime({ fetch: () => { throw new Error('must not request'); } });
  await assert.rejects(runtime.run({ ...baseInput('ollama'), bot: bot('ollama', { execution: { kind: 'ssh', host: 'example' } }) }), /SSH Bots transport is not configured/);
  await assert.rejects(runtime.run({ ...baseInput('ollama'), bot: bot('ollama', { workspace: 'relative' }) }), /absolute workspace/);
  runtime.close();
});
test('rejects native resume when provider/model/workspace ownership changes', async () => {
  const runtime = createBotRuntime();
  await assert.rejects(runtime.run({ ...baseInput('codex'), checkpoint: { provider: 'codex', workspace: '/wrong', model: '', nativeSessionId: 'owned' } }), /Start a new bot chat/);
  runtime.close();
});
test('ACP arguments and profiles exclude automatic approval and native tools', () => {
  for (const provider of ['grok', 'kimi']) {
    const args = acpArguments(provider, bot(provider), '/profile.md');
    assert.equal(args.includes('--always-approve') || args.includes('-y') || args.includes('--auto') || args.includes('bypassPermissions'), false);
    assert.equal(args.includes('/profile.md'), true); assert.match(acpProfile(bot(provider)), /tools:\n  - mcp__strata__\*/);
    assert.match(acpProfile(bot(provider)), /subagents: \[\]/);
  }
});
test('normalizes JSON schema tools and rejects duplicate or invalid names', () => {
  assert.deepEqual(normalizeTools([{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }])[0].inputSchema, { type: 'object' });
  assert.throws(() => normalizeTools([...tools, ...tools]), /unique/); assert.throws(() => normalizeTools([{ name: 'not valid' }]), /simple/);
});
test('SSE parser handles split UTF-8 and CRLF frames', async () => {
  const bytes = new TextEncoder().encode('data: {"text":"Hi 🌎"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const chunks = (async function* () { for (let i = 0; i < bytes.length; i += 3) yield bytes.slice(i, i + 3); })();
  const parsed = []; for await (const event of readSse(chunks)) parsed.push(event);
  assert.deepEqual(parsed, [{ text: 'Hi 🌎' }]);
});
test('Ollama streams thinking, executes root tools once, preserves image tool content and history', async () => {
  const requests = []; let executions = 0; const events = framesFor();
  const runtime = createBotRuntime({ env: { OLLAMA_API_KEY: 'fixture-api-secret' }, fetch: async (url, options) => {
    requests.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    return requests.length === 1 ? sse([
      { choices: [{ delta: { reasoning: 'Inspecting now' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'inspect', arguments: '{' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]) : sse([{ choices: [{ delta: { content: 'Finished' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }]);
  } });
  const result = await runtime.run({ ...baseInput('ollama'), bot: bot('ollama', { model: 'fixture:cloud' }), ...events, history: [{ role: 'user', content: 'Previous' }, { role: 'assistant', content: 'Acknowledged' }], executeTool: async () => { executions++; return { content: [{ type: 'text', text: 'Screenshot' }, { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }] }; } });
  assert.equal(result.text, 'Finished'); assert.equal(executions, 1);
  assert.equal(requests[0].headers.Authorization, 'Bearer fixture-api-secret'); assert.equal(requests[0].body.model, 'fixture');
  assert.equal(requests[0].body.messages.filter(m => m.content === 'Previous').length, 1);
  assert.equal(requests[0].body.messages.at(-1).content, 'Fixture only');
  assert.equal(requests[1].body.messages.at(-1).content[1].image_url.url, 'data:image/png;base64,ZmFrZQ==');
  assert.equal(events.frames.some(f => f.type === 'reasoning' && f.text === 'Inspecting now'), true);
  assert.equal(events.frames.some(f => f.type === 'agent-tool'), false, 'the host owns injected-tool cards');
  assert.equal(result.tokensOut, 5); runtime.close();
});
test('Ollama never sends cloud key to a local daemon and rejects insecure remote URL', async () => {
  let headers; const runtime = createBotRuntime({ env: { OLLAMA_API_KEY: 'private-key' }, fetch: async (_url, options) => { headers = options.headers; return sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]); } });
  await runtime.run({ ...baseInput('ollama'), bot: bot('ollama', { model: 'fixture:cloud', providerSettings: { baseURL: 'http://127.0.0.1:11434/v1' } }) });
  assert.equal(headers.Authorization, undefined);
  await assert.rejects(runtime.run({ ...baseInput('ollama'), bot: bot('ollama', { model: 'fixture', providerSettings: { baseURL: 'http://remote.invalid/v1' } }) }), /HTTPS/); runtime.close();
});
test('Ollama does not retry provider failure or execute malformed/unknown tools', async () => {
  let requests = 0, executions = 0; const runtime = createBotRuntime({ env: { OLLAMA_API_KEY: 'fixture' }, fetch: async () => { requests++; return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'unlisted', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }]); } });
  await assert.rejects(runtime.run({ ...baseInput('ollama'), bot: bot('ollama', { model: 'fixture' }), executeTool: async () => executions++ }), /unavailable Strata tool/);
  assert.equal(requests, 1); assert.equal(executions, 0); runtime.close();
});
test('Ollama incomplete stream is a failure, not a successful answer', async () => {
  const runtime = createBotRuntime({ env: { OLLAMA_API_KEY: 'fixture' }, fetch: async () => sse([{ choices: [{ delta: { content: 'partial' } }] }]) });
  const events = framesFor(); await assert.rejects(runtime.run({ ...baseInput('ollama'), bot: bot('ollama', { model: 'fixture' }), ...events }), /completion marker/);
  assert.equal(events.frames.some(f => f.type === 'done'), false); runtime.close();
});
test('Claude SDK uses the installed CLI, only injected tools, native resume and real streamed events', async () => {
  let sdkOptions, checkpoint; const events = framesFor();
  const runtime = createBotRuntime({ commands: { claude: '/fixture/claude' }, claudeSdk: { query({ options }) { sdkOptions = options; return (async function* () {
    yield { type: 'system', session_id: 'claude_native' };
    yield { type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: 'Checking' } } };
    yield { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Answer' } } };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Answer' }, { type: 'thinking', thinking: 'Checking' }] } };
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 5, output_tokens: 3 } };
  })(); } } });
  const result = await runtime.run({ ...baseInput('claude'), ...events, checkpoint: { provider: 'claude', workspace: root, model: '', nativeSessionId: 'existing' }, onCheckpoint: cp => { checkpoint = cp; } });
  assert.equal(result.text, 'Answer'); assert.equal(sdkOptions.resume, 'existing'); assert.equal(sdkOptions.pathToClaudeCodeExecutable, '/fixture/claude');
  assert.deepEqual(sdkOptions.tools, []); assert.deepEqual(sdkOptions.settingSources, []); assert.equal(sdkOptions.strictMcpConfig, true);
  assert.deepEqual(sdkOptions.allowedTools, [], 'MCP allow rules must not shadow the permission callback');
  assert.equal((await sdkOptions.canUseTool('Bash', { command: 'unsafe' }, {})).behavior, 'deny');
  assert.equal(checkpoint.nativeSessionId, 'claude_native'); assert.equal(events.frames.filter(f => f.type === 'reasoning').length, 1); runtime.close();
});

const fixturePath = join(root, 'protocol-fixture.mjs');
await writeFile(fixturePath, `
import readline from 'node:readline';
const mode = process.argv[2]; let next = 100, stage = null;
const send = o => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n');
const ok = (id,result) => send({id,result});
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id>=100&&!m.method){
  if(stage==='approval'){if(m.result.decision!=='decline')process.exit(10);stage='tool';send({id:101,method:'item/tool/call',params:{threadId:'thread_fixture',turnId:'turn_1',callId:'call_1',tool:'inspect',arguments:{}}});}
  else if(stage==='tool'){if(m.result.contentItems?.[0]?.text!=='fixture result')process.exit(11);send({method:'turn/completed',params:{threadId:'thread_fixture',turn:{id:'turn_1',status:'completed'}}});}
  else if(stage==='acp_permission'){if(m.result.outcome?.optionId!==(mode==='known_mcp'?'allow':'reject'))process.exit(12);ok(3,{stopReason:'end_turn',usage:{inputTokens:4,outputTokens:2}});}
  return;
 }
 if(m.method==='initialize')ok(m.id,mode==='codex'?{}:{protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(m.method==='config/read')ok(m.id,{config:{mcp_servers:{fixture_external:{url:'https://fixture.invalid',bearer_token:'PRIVATE'}}}});
 if(m.method==='mcpServerStatus/list')ok(m.id,{data:[{name:'fixture_external',tools:{}}],nextCursor:null});
 if(m.method==='thread/start'||m.method==='thread/resume'){if(m.params.sandbox!=='read-only'||m.params.approvalPolicy!=='never'||m.params.config?.mcp_servers?.fixture_external?.enabled!==false||m.params.config?.features?.shell_tool!==false)process.exit(13);ok(m.id,{thread:{id:'thread_fixture'}});}
 if(m.method==='turn/start'){ok(m.id,{turn:{id:'turn_1'}});send({method:'item/reasoning/summaryTextDelta',params:{threadId:'thread_fixture',delta:'Plan'}});send({method:'item/agentMessage/delta',params:{threadId:'thread_fixture',itemId:'msg',delta:'Native answer'}});stage='approval';send({id:100,method:'item/commandExecution/requestApproval',params:{threadId:'thread_fixture',command:'fixture'}});}
 if(m.method==='session/new')ok(m.id,{sessionId:'acp_fixture'});
 if(m.method==='session/load'){send({method:'session/update',params:{sessionId:'acp_fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD REPLAY ANSWER'}}}});send({method:'session/update',params:{sessionId:'acp_fixture',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'OLD REPLAY THOUGHT'}}}});ok(m.id,{});}
 if(m.method==='session/prompt'){send({method:'session/update',params:{sessionId:'acp_fixture',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Thought'}}}});send({method:'session/update',params:{sessionId:'acp_fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP answer'}}}});stage='acp_permission';send({id:100,method:'session/request_permission',params:{toolCall:{title:mode==='known_mcp'?'strata__inspect':'Fixture native tool',kind:mode==='known_mcp'?'edit':'execute',rawInput:{}},options:[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'reject'}]}});}
});
`);
function fixtureSpawner(mode, plans) { return (command, args, options) => { plans?.push({ command, args, options }); return spawn(process.execPath, [fixturePath, mode], options); }; }
test('Codex actual stdio protocol brokers native denial and returns dynamic tool result with shared thinking', async () => {
  let approvals = 0; const events = framesFor(), plans = [];
  const runtime = createBotRuntime({ commands: { codex: '/fixture/codex' }, spawnProcess: fixtureSpawner('codex', plans), runTimeoutMs: 4000 });
  const result = await runtime.run({ ...baseInput('codex'), ...events, requestPermission: async () => { approvals++; return false; } });
  assert.equal(result.text, 'Native answer'); assert.equal(approvals, 0, 'native tools cannot bypass the root ledger'); assert.equal(result.checkpoint.nativeSessionId, 'thread_fixture');
  assert.equal(events.frames.some(f => f.type === 'reasoning' && f.text === 'Plan'), true); assert.equal(plans[0].options.cwd, root); runtime.close();
});
test('Grok and Kimi actual stdio protocols use native session load and decline permissions', async () => {
  for (const provider of ['grok', 'kimi']) {
    const events = framesFor(), plans = []; const runtime = createBotRuntime({ commands: { [provider]: `/fixture/${provider}` }, spawnProcess: fixtureSpawner(provider, plans), stateDir: join(root, provider), runTimeoutMs: 4000 });
    const result = await runtime.run({ ...baseInput(provider), ...events, checkpoint: { provider, workspace: root, model: '', nativeSessionId: 'acp_fixture' } });
    assert.equal(result.text, 'ACP answer'); assert.equal(result.checkpoint.nativeSessionId, 'acp_fixture');
    assert.equal(events.frames.some(f => f.type === 'reasoning' && f.text === 'Thought'), true);
    const profileIndex = plans[0].args.indexOf(provider === 'kimi' ? '--agent-file' : '--agent-profile'); assert.ok(profileIndex >= 0);
    assert.equal((await stat(plans[0].args[profileIndex + 1])).mode & 0o777, 0o600); runtime.close();
  }
});
test('MCP tool bridge transports image results and rejects unlisted tools', async () => {
  const bridge = await startToolBridge({ tools, executeTool: async () => ({ content: [{ type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }] }) });
  const rpc = jsonRpcProcess({ command: bridge.command, args: bridge.args, env: { ...process.env, ...bridge.env }, cwd: root });
  try {
    await rpc.request('initialize', {}); const listed = await rpc.request('tools/list', {}); assert.equal(listed.tools[0].name, 'inspect');
    const result = await rpc.request('tools/call', { name: 'inspect', arguments: {} }); assert.equal(result.content[0].type, 'image');
    const rejected = await rpc.request('tools/call', { name: 'missing', arguments: {} }); assert.equal(rejected.isError, true);
  } finally { await rpc.close(); await bridge.close(); }
});
test('ACP acknowledges known MCP tools classified as edits without duplicating root approval or cards', async () => {
  let approvals = 0; const events = framesFor();
  const runtime = createBotRuntime({ commands: { grok: '/fixture/grok' }, spawnProcess: fixtureSpawner('known_mcp'), stateDir: join(root, 'known_mcp'), runTimeoutMs: 4000 });
  await runtime.run({ ...baseInput('grok'), ...events, requestPermission: async () => { approvals++; return false; } });
  assert.equal(approvals, 0); assert.equal(events.frames.some(f => f.type === 'agent-tool'), false); runtime.close();
});
test('MCP stdio replies preserve JSON-RPC request id zero', async () => {
  const bridge = await startToolBridge({ tools, executeTool: async () => 'zero result' });
  const child = spawn(bridge.command, bridge.args, { cwd: root, env: { ...process.env, ...bridge.env }, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const reply = new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error('id zero was dropped')), 1500); child.stdout.on('data', chunk => { output += chunk; const end = output.indexOf('\n'); if (end >= 0) { clearTimeout(timer); resolve(JSON.parse(output.slice(0, end))); } }); child.once('error', reject); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'inspect', arguments: {} } })}\n`);
    const result = await reply; assert.equal(result.id, 0); assert.equal(result.result.content[0].text, 'zero result');
  } finally { await killOwned(child); await bridge.close(); }
});
test('redaction removes bearer and configured secrets', () => {
  const output = redact('failure Bearer abc.def_secret custom-private-key sk-abcdefghijklmnop', ['custom-private-key']);
  assert.equal(output.includes('custom-private-key'), false); assert.equal(output.includes('abc.def_secret'), false); assert.equal(output.includes('sk-abcdefghijklmnop'), false);
});
test('Stop aborts only owned protocol process and never reports done', async () => {
  const controller = new AbortController(), events = framesFor();
  const runtime = createBotRuntime({ commands: { codex: '/fixture/codex' }, spawnProcess: (_command, _args, options) => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options), runTimeoutMs: 4000 });
  const running = runtime.run({ ...baseInput('codex'), ...events, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(events.frames.some(f => f.type === 'done'), false); runtime.close();
});
test('Stop escalates the owned group when its leader exits before a TERM-resistant descendant', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>console.log(c.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const descendant = await new Promise((resolve, reject) => { child.stdout.once('data', data => resolve(Number(String(data).trim()))); child.once('error', reject); });
  try { const start = Date.now(); await killOwned(child); assert.ok(Date.now() - start >= 900, 'must wait for escalation'); assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' }); }
  finally { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
});
test('bridge refuses an already stopped run without creating a live socket', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(startToolBridge({ tools, executeTool: async () => '', signal: controller.signal }), { name: 'AbortError' });
});
