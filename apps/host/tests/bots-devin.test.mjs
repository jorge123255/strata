/** Disposable stdio protocol fixtures: no account, network, model, SSH, browser or VM is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createBotRuntime } from '../server/bots-runtime/index.mjs';
import { prepareDevin, devinConfig, devinArguments, devinAuthState, devinCatalog, DEVIN_DISABLED_TOOLS } from '../server/bots-runtime/devin.mjs';

const root = await mkdtemp(join(tmpdir(), 'strata-devin-test-'));
test.after(() => rm(root, { recursive: true, force: true }));
const program = join(root, 'devin-fixture.mjs');
await writeFile(program, `
import readline from 'node:readline';import{readFileSync,appendFileSync}from'node:fs';import{join}from'node:path';import{connect}from'node:net';
const args=JSON.parse(process.env.FIXTURE_ARGS),mode=process.env.FIXTURE_MODE,log=process.env.FIXTURE_LOG;
const configPath=args[args.indexOf('--config')+1],config=JSON.parse(readFileSync(configPath,'utf8'));
const record=o=>appendFileSync(log,JSON.stringify(o)+'\\n');
const mcpFile=JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME,'devin/mcp_config.json'),'utf8'));
record({mcpFile,args,env:{HOME:process.env.HOME,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,XDG_DATA_HOME:process.env.XDG_DATA_HOME,DEVIN_SESSIONS_DIR:process.env.DEVIN_SESSIONS_DIR,DEVIN_PLUGIN_DISCOVERY:process.env.DEVIN_PLUGIN_DISCOVERY},config});
if(args.includes('auth')){console.log(mode==='signedout'?'Not logged in.':'Logged in (via Devin).');process.exit(0);}
if(args.includes('models')){if(args.slice(-4).join(' ')!=='models list --format json')process.exit(8);console.log(JSON.stringify({families:[{family_label:'Verified family',variants:[{model_uid:'fixture-model',label:'Verified Medium'},{model_uid:'fixture-high',label:'Verified High'},{model_uid:'fusion-hidden',label:'Fusion'}]}]}));process.exit(0);}
const send=o=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n'),ok=(id,result)=>send({id,result});
let options=[{id:'mode',category:'mode',currentValue:'accept-edits',options:[{value:'accept-edits'},{value:'ask'},{value:'bypass'}]},{id:'model',category:'model',currentValue:mode==='model-fallback'?'fixture-fallback':args.includes('--model')?args.at(-1):'fixture-model',options:[{value:'fixture-model'}]},{id:'thought_level',category:'thought_level',currentValue:'medium',options:[{value:'medium'},{value:'high'}]}],promptId,bridge=null;
const update=(type,text,sessionId='devin-fixture')=>send({method:'session/update',params:{sessionId,update:{sessionUpdate:type,content:{type:'text',text}}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);record(m);
 if(!m.method){if(m.id===100){if(m.result?.outcome?.optionId!=='deny')process.exit(10);const notification={method:'session/update',params:{sessionId:mode==='identity-session'?'other':'devin-fixture',update:{sessionUpdate:'tool_call',toolCallId:'known-call',title:'Calling inspect from strata',kind:'edit',_meta:{'cognition.ai/toolName':'mcp__strata__inspect'}}}};if(mode!=='identity-missing')send(notification);if(mode==='identity-reused')send(notification);if(mode==='identity-mutated')send({method:'session/update',params:{sessionId:'devin-fixture',update:{sessionUpdate:'tool_call_update',toolCallId:'known-call',_meta:{'cognition.ai/toolName':'exec'}}}});send({id:101,method:'session/request_permission',params:{sessionId:'devin-fixture',toolCall:{toolCallId:'known-call',title:'mcp__strata__inspect'},options:[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}]}});}
 else if(m.id===101){if(mode.startsWith('identity-')){if(m.result?.outcome?.optionId!=='deny')process.exit(11);ok(promptId,{stopReason:'end_turn'});return;}if(m.result?.outcome?.optionId!=='allow')process.exit(11);send({id:102,method:'fs/write_text_file',params:{path:'/must-not-write',content:'unsafe'}});}
 else if(m.id===102){if(!m.error)process.exit(12);const socket=connect(process.env.STRATA_BOT_SOCKET);socket.setEncoding('utf8');socket.on('connect',()=>socket.write(JSON.stringify({id:'fixture-tool',name:'inspect',args:{marker:'inert'}})+'\\n'));socket.once('data',chunk=>{const response=JSON.parse(chunk);record({toolResult:response});socket.end();ok(promptId,{stopReason:'end_turn',usage:{inputTokens:7,outputTokens:3}});});}
 return;}
 if(m.method==='initialize')ok(m.id,{protocolVersion:1,agentCapabilities:{loadSession:mode!=='no-load'},_meta:{mcpConfigPath:mode==='mcp-escape'?'/owner/mcp_config.json':join(process.env.XDG_CONFIG_HOME,'devin/mcp_config.json')}});
 if(m.method==='session/new'){bridge=m.params.mcpServers?.[0]??null;if(bridge&&JSON.stringify(mcpFile.mcpServers?.strata)!==JSON.stringify({command:bridge.command,args:bridge.args,env:Object.fromEntries(bridge.env.map(e=>[e.name,e.value]))}))process.exit(18);if(mode==='missing-id')ok(m.id,{configOptions:options});else ok(m.id,{sessionId:'devin-fixture',configOptions:options});}
 if(m.method==='session/load'){bridge=m.params.mcpServers?.[0]??null;if(bridge&&JSON.stringify(mcpFile.mcpServers?.strata)!==JSON.stringify({command:bridge.command,args:bridge.args,env:Object.fromEntries(bridge.env.map(e=>[e.name,e.value]))}))process.exit(18);update('agent_message_chunk','OLD REPLAY');update('agent_thought_chunk','OLD THOUGHT');ok(m.id,{configOptions:options});}
 if(m.method==='_cognition.ai/config/read'){if(mode==='native-enabled')config.disabled_tools=config.disabled_tools.filter(n=>n!=='exec');if(mode==='inherited-config')config.read_config_from.claude=true;if(mode==='subagents')config.subagents_enabled=true;if(mode==='allow-native')config.permissions.allow=['exec'];ok(m.id,{configPath,config});}
 if(m.method==='_cognition.ai/rules/list')ok(m.id,{rules:mode==='inherited-rules'?[{text:'injected'}]:[]});
 if(m.method==='_cognition.ai/hooks/list')ok(m.id,{hooks:mode==='inherited-hooks'?[{command:'unsafe'}]:[]});
 if(m.method==='_cognition.ai/mcp/listServers'){const servers=bridge?[{serverId:'strata',disabled:false,disabledTools:[],connectionStatus:'connected',sourcePath:join(process.env.XDG_CONFIG_HOME,'devin/mcp_config.json'),transport:'stdio',command:bridge.command,args:bridge.args,env:Object.fromEntries(bridge.env.map(e=>[e.name,e.value]))}]:[];if(mode==='extra-mcp')servers.push({serverId:'owner-private'});if(mode==='old-socket'&&servers[0])servers[0].env.STRATA_BOT_SOCKET='/stale/socket';ok(m.id,{servers});}
 if(m.method==='_cognition.ai/mcp/listTools'){const tools=JSON.parse(readFileSync(process.env.STRATA_BOT_TOOLS,'utf8'));if(mode==='extra-tool')tools.push({name:'unassigned',description:'unsafe',inputSchema:{type:'object'}});ok(m.id,{serverId:'strata',tools,resources:mode==='resource'?[{uri:'owner:private'}]:[]});}
 if(m.method==='_cognition.ai/plugins/list')ok(m.id,{plugins:mode==='plugin'?[{name:'unsafe'}]:[],availability:{complete:mode!=='pending-plugin',originsPending:mode==='pending-plugin'?1:0,originsFailed:0}});
 if(m.method==='_cognition.ai/skills/list')ok(m.id,{skills:mode==='owner-skill'?[{isBuiltin:false,provider:'global',path:'/owner/.agents/skills/secret'}]:[]});
 if(m.method==='session/set_config_option'){options=options.map(o=>o.id===m.params.configId?{...o,currentValue:mode==='wrong-readback'?'bypass':m.params.value}:o);ok(m.id,{configOptions:options});}
 if(m.method==='session/prompt'){promptId=m.id;if(mode==='hang')return;if(mode==='provider-error'){send({id:m.id,error:{code:-32000,message:'fixture provider failed Bearer fixture-secret'}});return;}
 update('agent_message_chunk','OTHER SESSION','unrelated');update('agent_thought_chunk','Thinking');update('agent_message_chunk','Devin answer');
 if(mode==='tools'||mode.startsWith('identity-'))send({id:100,method:'session/request_permission',params:{sessionId:'devin-fixture',toolCall:{title:'exec',kind:'execute',rawInput:{command:'unsafe'}},options:[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}]}});
 else ok(m.id,mode==='incomplete'?{}:{stopReason:mode==='stopped'?'max_tokens':'end_turn',usage:{inputTokens:7,outputTokens:3}});
 }
});
`);
const makeBot = (extra = {}) => ({ id: 'bot_fixture', name: 'Fixture', provider: 'devin', model: 'fixture-model', effort: '', policy: 'manual', capabilities: 'both', execution: { kind: 'local' }, workspace: root, ...extra });
let next = 0;
function fixture(mode = 'ok') {
  const log = join(root, `protocol-${++next}.jsonl`), plans = [], outgoing = [];
  let enteredPrompt; const promptEntered = new Promise(resolve => { enteredPrompt = resolve; });
  const runtime = createBotRuntime({ stateDir: join(root, `state-${next}`), env: { ...process.env, HOME: join(root, 'native-account'), XDG_DATA_HOME: join(root, 'native-account-data') }, commands: { claude: '/not-installed', codex: '/not-installed', grok: '/not-installed', kimi: '/not-installed', ollama: '/not-installed', devin: '/fixture/devin' }, runTimeoutMs: 5000,
    spawnProcess(command, args, options) {
      if (command !== '/fixture/devin') return spawn(command, args, options);
      plans.push({ command, args, options });
      const child = spawn(process.execPath, [program], { ...options, env: { ...options.env, FIXTURE_ARGS: JSON.stringify(args), FIXTURE_MODE: mode, FIXTURE_LOG: log } });
      const write = child.stdin?.write.bind(child.stdin);
      if (write) child.stdin.write = (chunk, ...more) => { try { const message = JSON.parse(String(chunk)); outgoing.push(message); if (message.method === 'session/prompt') enteredPrompt(); } catch {} return write(chunk, ...more); };
      return child;
    } });
  const frames = [], input = { bot: makeBot(), sessionId: `s_fixture_${next}`, message: 'Fixture only', tools: [], onFrame: frame => frames.push(frame) };
  return { runtime, input, plans, outgoing, frames, log, promptEntered, messages: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

test('Devin public auth parser does not equate exit zero with signed in or expose credentials', () => {
  assert.equal(devinAuthState('Not logged in.\n'), 'signed_out');
  assert.equal(devinAuthState('Logged in (via Devin).\n'), 'signed_in');
  for (const value of [null, '', 'Unexpected output', '{"token":"private"}', 'prefix Logged in']) assert.equal(devinAuthState(value), 'unverified');
});
test('private Devin configuration retains native auth location and isolates homes, sessions, MCP and default tools', async () => {
  const s = await prepareDevin({ stateDir: join(root, 'settings'), key: 'same-chat', env: { HOME: '/native-account', PATH: '/fixture', XDG_DATA_HOME: '/native-data' } });
  try {
    assert.equal(s.env.XDG_DATA_HOME, '/native-data'); assert.notEqual(s.env.HOME, '/native-account');
    assert.equal(s.env.DEVIN_PLUGIN_DISCOVERY, 'off'); assert.equal(s.cwd.startsWith(join(root, 'settings')), true);
    assert.deepEqual(JSON.parse(await readFile(s.mcpConfigPath, 'utf8')), { mcpServers: {} });
    assert.equal((await stat(s.configPath)).mode & 0o777, 0o600);
    const config = JSON.parse(await readFile(s.configPath, 'utf8'));
    for (const name of ['exec', 'web_search', 'run_subagent', 'discover_skills', 'apply_patch', 'restricted_exec']) assert.ok(config.disabled_tools.includes(name));
    assert.deepEqual(config.permissions.allow, []); assert.equal(config.subagents_enabled, false); assert.equal(config.auto_update, false);
    assert.equal(Object.values(config.read_config_from).every(v => v === false), true);
    assert.deepEqual(devinArguments(s.configPath, 'model'), ['--config', s.configPath, '--permission-mode', 'auto', 'acp', '--model', 'model']);
  } finally { await s.close(); }
  await assert.rejects(readFile(s.configPath), { code: 'ENOENT' });
});
test('the observed Devin native tool registry is disabled and denied while MCP transport remains available', () => {
  const config = devinConfig();
  const native = ['exec', 'read', 'edit', 'grep', 'glob', 'exit_plan_mode', 'get_output', 'kill_shell', 'write_to_process', 'write', 'notebook_read', 'notebook_edit', 'todo_write', 'webfetch', 'web_search', 'ask_user_question', 'run_subagent', 'read_subagent', 'request_scope', 'code_search', 'browser_preview', 'close_browser_preview', 'extend_context', 'sidekick', 'skill'];
  assert.equal(native.length, 25);
  for (const name of native) { assert.equal(config.disabled_tools.includes(name), true, name); assert.equal(config.permissions.deny.includes(name), true, name); }
  for (const name of ['mcp_call_tool', 'mcp_list_servers', 'mcp_list_tools', 'mcp_read_resource']) assert.equal(config.disabled_tools.includes(name), false, name);
});
test('model catalog uses exact verified variant IDs, invents no effort levels, and excludes Fusion brains', () => {
  const models = devinCatalog({ families: [{ family_label: 'Family', variants: [{ model_uid: 'fixture-medium', label: 'Medium' }, { model_uid: 'fixture-high', label: 'High' }, { model_uid: 'fixture-high', label: 'Duplicate' }, { model_uid: 'fusion-hidden', label: 'Fusion' }] }] });
  assert.deepEqual(models, [{ id: 'fixture-medium', name: 'Medium', efforts: [] }, { id: 'fixture-high', name: 'High', efforts: [] }]);
  assert.throws(() => devinCatalog({ models: [] }), /unrecognized/);
});
test('provider discovery exposes actual signed-out state without reading a credentials file', async () => {
  const f = fixture('signedout');
  try { const row = (await f.runtime.providers()).find(p => p.id === 'devin'); assert.equal(row.installed, true); assert.equal(row.ready, false); assert.equal(row.auth.state, 'signed_out'); }
  finally { await f.runtime.close(); }
  assert.equal(f.plans.length, 1); assert.deepEqual(f.plans[0].args.slice(-2), ['auth', 'status']);
});
test('Devin catalog discovery runs only the public catalog command and never opens a session or sends a prompt', async () => {
  const f = fixture();
  try { assert.deepEqual((await f.runtime.models('devin')).models.map(m => m.id), ['fixture-model', 'fixture-high']); }
  finally { await f.runtime.close(); }
  const messages = await f.messages(); assert.equal(messages.some(m => m.method), false); assert.deepEqual(f.plans[0].args.slice(-4), ['models', 'list', '--format', 'json']);
});
test('Devin real stdio framing preserves thinking, exact native checkpoint and logical workspace, while excluding replay or other sessions', async () => {
  const f = fixture();
  try {
    const result = await f.runtime.run({ ...f.input, history: [{ role: 'user', content: 'Earlier user message' }, { role: 'assistant', content: 'Earlier answer', tools: [{ name: 'inspect', state: 'done', result: 'Already completed' }] }] });
    assert.equal(result.text, 'Devin answer'); assert.equal(result.checkpoint.provider, 'devin'); assert.equal(result.checkpoint.nativeSessionId, 'devin-fixture'); assert.equal(result.checkpoint.workspace, root);
    assert.equal(result.tokensIn, 7); assert.equal(result.tokensOut, 3); assert.equal(f.frames.filter(f => f.type === 'reasoning').length, 1);
    assert.equal((await f.messages()).find(m => m.method === 'session/set_config_option' && m.params.configId === 'mode').params.value, 'accept-edits', 'Devin Code mode permits MCP mutations; Strata owns the selected policy.');
    const prompt = (await f.messages()).find(m => m.method === 'session/prompt').params.prompt[0].text;
    assert.match(prompt, /Earlier user message/); assert.match(prompt, /Already completed/); assert.match(prompt, /do not replay/);
    assert.notEqual(f.plans[0].options.cwd, root); assert.equal(f.plans[0].args.includes('--model'), true); assert.equal(f.plans[0].args.includes('-m'), false);
  } finally { await f.runtime.close(); }
  const resumed = fixture();
  try { const result = await resumed.runtime.run({ ...resumed.input, checkpoint: { provider: 'devin', nativeSessionId: 'devin-fixture', model: 'fixture-model', workspace: root } }); assert.equal(result.text, 'Devin answer'); assert.equal(resumed.frames.some(f => f.text?.includes('OLD')), false); }
  finally { await resumed.runtime.close(); }
});
test('Devin lists pass_team_turn once and the prompt names the prefixed call', async () => {
  const pass = { name: 'pass_team_turn', description: 'Decline this team message. This uses your one reply and publishes nothing.', inputSchema: { type: 'object', properties: {} } };
  const f = fixture();
  try {
    await f.runtime.run({ ...f.input, tools: [pass] });
    const rows = await f.messages();
    const mode = rows.findIndex(row => row.method === 'session/set_config_option' && row.params.configId === 'mode');
    const listed = rows.findIndex(row => row.method === '_cognition.ai/mcp/listTools');
    assert.ok(mode >= 0 && listed > mode, 'Code mode is set before the tool inventory');
    const prompt = rows.find(row => row.method === 'session/prompt').params.prompt[0].text;
    assert.match(prompt, /pass_team_turn/);
    assert.match(prompt, /mcp__strata__pass_team_turn/);
  } finally { await f.runtime.close(); }
});
test('continuous Devin prompt survives 31 virtual minutes and Stop still waits for owned CLI cleanup', { timeout: 10000 }, async t => {
  const f = fixture('hang'), controller = new AbortController();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const observed = f.runtime.run({ ...f.input, bot: { ...f.input.bot, continuousTeam: true }, signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([f.promptEntered, observed.then(() => { throw new Error('The fixture ended before its prompt.'); })]);
    t.mock.timers.tick(31 * 60_000);
    let settled = false; observed.then(() => { settled = true; }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(f.frames.some(frame => frame.type === 'error' || frame.type === 'done'), false);
    // Real process cleanup retains its own bounded verification timers.
    t.mock.timers.reset(); controller.abort(); assert.equal((await observed).error.name, 'AbortError');
    assert.equal(f.frames.some(frame => frame.type === 'done'), false);
  } finally { t.mock.timers.reset(); controller.abort(); await observed; await f.runtime.close(); }
});
test('Devin model fallback fails before prompting with actionable guidance and does not change the requested model', async () => {
  const f = fixture('model-fallback');
  try {
    await assert.rejects(f.runtime.run({ ...f.input, bot: { ...f.input.bot, continuousTeam: true } }), /Devin selected a different model\. Refresh the native model catalog/);
    const messages = await f.messages(); assert.equal(messages.some(message => message.method === 'session/prompt'), false);
    assert.equal(messages.some(message => message.method === 'session/set_config_option' && message.params.configId === 'model'), false);
    assert.equal(f.plans[0].args.at(-1), 'fixture-model'); assert.equal(f.input.bot.model, 'fixture-model');
  } finally { await f.runtime.close(); }
});
for (const [mode, label] of [
  ['mcp-escape', 'private MCP configuration path'], ['native-enabled', 'native tool disable list'],
  ['inherited-rules', 'inherited rules empty'], ['inherited-hooks', 'inherited hooks empty'],
  ['old-socket', 'fresh MCP bridge environment'], ['extra-tool', 'assigned MCP tool count'],
  ['resource', 'MCP resources empty'], ['plugin', 'plugins empty'],
  ['pending-plugin', 'plugin discovery complete'], ['owner-skill', 'built-in skills only'],
]) test(`Devin closed isolation diagnostic is visible before any prompt or action: ${mode}`, async () => {
  const f = fixture(mode); let actions = 0;
  try {
    await assert.rejects(f.runtime.run({ ...f.input, tools: [{ name: 'inspect', description: 'Inert fixture', inputSchema: { type: 'object' } }], executeTool: async () => { actions++; } }), error => {
      assert.ok(error.message.includes(`(${label})`)); assert.match(error.message, /No model prompt was sent/); assert.equal(error.message.includes('/stale/socket'), false); assert.equal(error.message.includes('/owner/'), false); return true;
    });
    assert.equal(actions, 0); assert.equal((await f.messages()).some(message => message.method === 'session/prompt'), false);
    assert.equal(f.frames.some(frame => frame.type === 'done'), false);
  } finally { await f.runtime.close(); }
});
test('continuing the same Strata conversation reuses its private Devin state while replacing the previous MCP socket', async () => {
  const f = fixture();
  const tools = [{ name: 'inspect', description: 'Inert fixture', inputSchema: { type: 'object' } }];
  try {
    const first = await f.runtime.run({ ...f.input, tools });
    await f.runtime.run({ ...f.input, tools, checkpoint: first.checkpoint });
    assert.equal(f.plans.length, 2);
    assert.equal(f.plans[0].options.cwd, f.plans[1].options.cwd);
    assert.equal(f.plans[0].options.env.HOME, f.plans[1].options.env.HOME);
    assert.equal(f.plans[0].options.env.DEVIN_SESSIONS_DIR, f.plans[1].options.env.DEVIN_SESSIONS_DIR);
    assert.notEqual(f.plans[0].options.env.STRATA_BOT_SOCKET, f.plans[1].options.env.STRATA_BOT_SOCKET);
    const snapshots = (await f.messages()).filter(row => row.mcpFile);
    assert.equal(snapshots.length, 2); for (let i = 0; i < 2; i++) assert.equal(snapshots[i].mcpFile.mcpServers.strata.env.STRATA_BOT_SOCKET, f.plans[i].options.env.STRATA_BOT_SOCKET);
    const rows = await f.messages(), load = rows.find(m => m.method === 'session/load');
    assert.equal(load.params.mcpServers[0].env.find(e => e.name === 'STRATA_BOT_SOCKET').value, f.plans[1].options.env.STRATA_BOT_SOCKET);
    assert.equal(f.frames.some(frame => frame.text?.includes('OLD')), false);
  } finally { await f.runtime.close(); }
});
test('parallel Devin chats have different private config, homes and native session stores', async () => {
  const f = fixture();
  try { await Promise.all([f.runtime.run({ ...f.input, sessionId: 's_parallel_a' }), f.runtime.run({ ...f.input, sessionId: 's_parallel_b' })]);
    assert.equal(f.plans.length, 2); for (const key of ['HOME', 'XDG_CONFIG_HOME', 'DEVIN_SESSIONS_DIR']) assert.notEqual(f.plans[0].options.env[key], f.plans[1].options.env[key]);
  } finally { await f.runtime.close(); }
});
test('Devin native tools and direct ACP mutations are denied even with Bypass; injected MCP executes only through Strata once', async () => {
  const f = fixture('tools'); let actions = 0, approvals = 0;
  try {
    const result = await f.runtime.run({ ...f.input, bot: makeBot({ policy: 'bypass' }), tools: [{ name: 'inspect', description: 'Inert fixture', inputSchema: { type: 'object' } }], requestPermission: async () => { approvals++; return true; }, executeTool: async (name, args) => { assert.equal(name, 'inspect'); assert.deepEqual(args, { marker: 'inert' }); actions++; return { content: [{ type: 'text', text: 'fixture result' }, { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }] }; } });
    assert.equal(result.text, 'Devin answer'); assert.equal(actions, 1); assert.equal(approvals, 0, 'Only the host tool ledger may own the policy.');
    assert.equal(f.frames.some(f => f.type === 'agent-tool'), false, 'MCP transport must not duplicate the host tool ledger.');
    assert.equal((await f.messages()).find(m => m.toolResult).toolResult.result.content[1].type, 'image');
  } finally { await f.runtime.close(); }
});
test('Devin transport identity rejects missing, reused, mutated and other-session tool metadata despite a spoofed display title', async () => {
  for (const mode of ['identity-missing', 'identity-reused', 'identity-mutated', 'identity-session']) {
    const f = fixture(mode); let actions = 0;
    try { await f.runtime.run({ ...f.input, bot: makeBot({ policy: 'bypass' }), tools: [{ name: 'inspect', description: 'Inert fixture', inputSchema: { type: 'object' } }], executeTool: async () => { actions++; return 'must not run'; } }); assert.equal(actions, 0, mode); }
    finally { await f.runtime.close(); }
  }
});
test('Devin pre-prompt inventory rejects inherited MCPs, changed sockets, unassigned tools and resources', async () => {
  for (const mode of ['extra-mcp', 'old-socket', 'extra-tool', 'resource']) {
    const f = fixture(mode); let actions = 0;
    try { await assert.rejects(f.runtime.run({ ...f.input, tools: [{ name: 'inspect', description: 'Inert fixture', inputSchema: { type: 'object' } }], executeTool: async () => { actions++; } }), /isolated tool configuration/); assert.equal(actions, 0); assert.equal((await f.messages()).some(m => m.method === 'session/prompt'), false); }
    finally { await f.runtime.close(); }
  }
});
test('Devin effort is accepted only from the native session and exact readback before the prompt', async () => {
  const good = fixture();
  try { await good.runtime.run({ ...good.input, bot: makeBot({ effort: 'high' }) }); const rows = await good.messages(); assert.equal(rows.find(m => m.method === 'session/set_config_option' && m.params.configId === 'thought_level').params.value, 'high'); }
  finally { await good.runtime.close(); }
  const bad = fixture();
  try { await assert.rejects(bad.runtime.run({ ...bad.input, bot: makeBot({ effort: 'invented' }) }), /did not advertise/); assert.equal((await bad.messages()).some(m => m.method === 'session/prompt'), false); }
  finally { await bad.runtime.close(); }
});
test('Devin configuration, inherited hooks/rules and session-setting failures stop before any model prompt', async () => {
  for (const mode of ['mcp-escape', 'native-enabled', 'inherited-config', 'subagents', 'allow-native', 'inherited-rules', 'inherited-hooks', 'wrong-readback', 'missing-id', 'extra-mcp', 'plugin', 'pending-plugin', 'owner-skill']) {
    const f = fixture(mode);
    try { await assert.rejects(f.runtime.run(f.input), /isolated tool configuration|did not confirm|native session id/); assert.equal((await f.messages()).some(m => m.method === 'session/prompt'), false, mode); assert.equal(f.frames.some(f => f.type === 'done'), false); }
    finally { await f.runtime.close(); }
  }
});
test('Devin Fusion selection and unsupported native restore fail without sending or replaying a prompt', async () => {
  const f = fixture();
  try { await assert.rejects(f.runtime.run({ ...f.input, bot: makeBot({ model: 'fusion-unsafe' }) }), /single Devin model/); assert.equal(f.plans.length, 0); }
  finally { await f.runtime.close(); }
  const noLoad = fixture('no-load');
  try { await assert.rejects(noLoad.runtime.run({ ...noLoad.input, checkpoint: { provider: 'devin', nativeSessionId: 'existing', model: 'fixture-model', workspace: root } }), /Strata history is preserved/); assert.equal((await noLoad.messages()).some(m => m.method === 'session/prompt'), false); }
  finally { await noLoad.runtime.close(); }
});
test('Devin provider errors and missing or unsuccessful completion markers never report done or replay a turn', async () => {
  for (const mode of ['provider-error', 'incomplete', 'stopped']) {
    const f = fixture(mode);
    try { await assert.rejects(f.runtime.run(f.input)); assert.equal(f.frames.some(f => f.type === 'done'), false); assert.equal(f.frames.some(f => f.message?.includes('fixture-secret')), false); assert.equal((await f.messages()).filter(m => m.method === 'session/prompt').length, 1); }
    finally { await f.runtime.close(); }
  }
});
test('Stop sends native cancel, revokes its process group, and never emits a successful completion', { timeout: 10000 }, async () => {
  const f = fixture('hang'), controller = new AbortController();
  const observed = f.runtime.run({ ...f.input, signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([f.promptEntered, observed.then(() => { throw new Error('The fixture ended before its prompt.'); })]);
    controller.abort(); assert.equal((await observed).error.name, 'AbortError');
    assert.equal(f.outgoing.some(m => m.method === 'session/cancel' && m.params.sessionId === 'devin-fixture'), true); assert.equal(f.frames.some(f => f.type === 'done'), false);
  } finally { controller.abort(); await observed; await f.runtime.close(); }
});
