/** Real host/team assembly and native adapters, with inert provider transports. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotRuntime } from '../server/bots-runtime/index.mjs';

async function until(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 10_000) throw new Error('Fixture team did not finish.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const codexFixture = `
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const thread='fixture_thread_'+process.pid,turn='fixture_turn_'+process.pid;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const ok=(id,result)=>send({id,result});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')ok(m.id,{});
 if(m.method==='config/read')ok(m.id,{config:{mcp_servers:{unrelated_private_connector:{}}}});
 if(m.method==='thread/start'||m.method==='thread/resume'){
  appendFileSync(process.argv[2],JSON.stringify({method:m.method,params:m.params})+'\\n');
  ok(m.id,{thread:{id:thread}});
 }
 if(m.method==='mcpServerStatus/list')ok(m.id,{data:[{name:'unrelated_private_connector',tools:{}}],nextCursor:null});
 if(m.method==='turn/start'){
  ok(m.id,{turn:{id:turn}});
  send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:thread,command:'MUST_NOT_EXECUTE'}});
 }
 if(m.id===900&&m.result){
  if(m.result.decision!=='decline')process.exit(21);
  send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Public fixture reply.'}}});
  send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
 }
});
`;

for (const provider of ['codex', 'claude']) test(`${provider} receives only the speaking bot's own saved identity in routing, conversations and bids`, async t => {
  const directory = await mkdtemp(join(tmpdir(), `strata-team-identity-${provider}-`));
  const script = join(directory, 'codex-fixture.mjs'), captureFile = join(directory, 'codex-capture.jsonl');
  await writeFile(script, codexFixture);
  const nativeCaptures = [], hostCaptures = [], markers = new Map();
  let sdkSessions = 0, chats, bots, computerDispatches = 0;
  const native = createBotRuntime({
    commands: { codex: '/fixture/codex', claude: '/fixture/claude' }, env: { PATH: '' }, runTimeoutMs: 5000,
    spawnProcess: (_command, _args, options) => spawn(process.execPath, [script, captureFile], options),
    claudeSdk: { query({ options }) {
      nativeCaptures.push(options);
      return (async function* () {
        assert.equal((await options.canUseTool('Bash', {}, {})).behavior, 'deny');
        yield { type: 'system', session_id: `fixture_claude_${++sdkSessions}` };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Public fixture reply.' }] } };
        yield { type: 'result', subtype: 'success', usage: {} };
      })();
    } },
  });
  const runtime = {
    providers: async () => [], close: () => native.close(),
    async run(input) {
      hostCaptures.push(input);
      const own = markers.get(input.bot.id);
      assert.ok(own && input.bot.instructions.includes(own));
      for (const [id, marker] of markers) if (id !== input.bot.id) assert.equal(input.bot.instructions.includes(marker), false);
      assert.equal(input.bot.teamConversationOnly, true);
      assert.equal(input.bot.instructions.includes('PRIVATE_WORK_MEMORY'), false);
      assert.equal(input.checkpoint, null);
      assert.equal(input.tools.some(tool => ['write_file', 'run_command', 'browser_open', 'computer_click', 'call_tool'].includes(tool.name)), false);
      assert.equal(await input.requestPermission({ id: 'forged-native', name: 'shell', args: {} }), false);
      await assert.rejects(async () => input.executeTool('write_file', { path: 'MUST_NOT_EXIST', content: 'denied' }, 'forbidden-file'), /cannot execute/);
      return native.run(input);
    },
  };
  bots = createBots({ directory, runtime, defaultWorkspace: () => directory, conversations: () => chats,
    tools: { definitions: () => [{ name: 'write_file', description: 'Unavailable in chat', inputSchema: { type: 'object' } }], execute: async () => { computerDispatches++; throw new Error('Computer dispatch must remain disabled.'); }, finish: async () => {} } });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: value => bots.validateSelection(value), execute: input => bots.run(input) });
  t.after(async () => { await bots.close(); chats.close(); await rm(directory, { recursive: true, force: true }); });
  const members = ['COORDINATOR', 'IMPLEMENTER', 'EVALUATOR'].map(role => {
    const marker = `PRIVATE_PROFILE_${role}`;
    const bot = bots.create({ name: role, provider, policy: 'manual', capabilities: 'both', workspace: directory, instructions: marker }).bot;
    markers.set(bot.id, marker); bots.work.update(bot.id, { memory: 'PRIVATE_WORK_MEMORY' }); return bot;
  });
  const team = bots.team.create({ name: 'Disposable identity team', memberIds: members.map(bot => bot.id), coordinatorId: members[0].id, enabled: true }).team;
  for (const [requestId, message, extra] of [['plain', 'Review the request', {}], ['greeting', 'Hi everyone', { everyone: true }], ['bid', 'Who wants this task?', {}]]) {
    const started = bots.team.message(team.id, { requestId, message, ...extra });
    await until(() => !['queued', 'running'].includes(bots.team.detail(team.id, started.run.id).run.state));
    const result = bots.team.detail(team.id, started.run.id);
    assert.equal(result.run.state, 'completed', JSON.stringify(result));
  }
  assert.deepEqual(new Set(hostCaptures.map(input => input.bot.teamContext.channelMode)), new Set(['routing', 'conversation', 'bid']));
  const persisted = JSON.parse(await readFile(join(directory, 'bots.json'), 'utf8'));
  assert.equal(persisted.checkpoints.length, 0, 'public-only native threads never become resumable private-provider checkpoints');
  const publicChannel = JSON.stringify(bots.team.channel(team.id));
  for (const marker of markers.values()) assert.equal(publicChannel.includes(marker), false, 'host never forwards profile instructions into public messages');
  assert.equal(computerDispatches, 0);
  const received = provider === 'codex' ? (await readFile(captureFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : nativeCaptures;
  assert.equal(received.length, hostCaptures.length);
  for (const row of received) {
    const text = provider === 'codex' ? row.params.developerInstructions : row.systemPrompt.append;
    assert.equal([...markers.values()].filter(marker => text.includes(marker)).length, 1);
    assert.match(text, /This turn has conversation tools only|This routing turn has no file/);
    if (provider === 'codex') {
      assert.equal(row.method, 'thread/start');
      assert.equal(row.params.sandbox, 'read-only'); assert.equal(row.params.approvalPolicy, 'never');
      assert.equal(row.params.config.features.shell_tool, false);
      assert.equal(row.params.config.mcp_servers.unrelated_private_connector.enabled, false);
      assert.equal(row.params.dynamicTools.some(tool => ['write_file', 'run_command', 'computer_click', 'call_tool'].includes(tool.name)), false);
    } else {
      assert.equal(row.resume, undefined); assert.deepEqual(row.tools, []); assert.deepEqual(row.settingSources, []);
      assert.deepEqual(row.allowedTools, []); assert.equal(row.permissionMode, 'default'); assert.equal(row.strictMcpConfig, true);
    }
  }
});
