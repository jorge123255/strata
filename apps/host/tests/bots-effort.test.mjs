import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createBotRuntime } from '../server/bots-runtime/index.mjs';
import { ownedGroupAliveFromPS, killOwned } from '../server/bots-runtime/process.mjs';

const root = await mkdtemp(join(tmpdir(), 'strata-effort-'));
test.after(() => rm(root, { recursive: true, force: true }));
const bot = (provider, extra = {}) => ({ id: 'bot_fixture', name: 'Fixture', provider, model: 'verified-model', effort: 'high', capabilities: 'code', policy: 'manual', workspace: root, execution: { kind: 'local' }, ...extra });

test('Codex effort catalog is discovered without a prompt and selected effort reaches exact turn/start', async () => {
  const program = join(root, 'codex.mjs'), log = join(root, 'codex.log');
  await writeFile(program, `import readline from 'node:readline';import{appendFileSync}from'node:fs';const send=o=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='model/list')send({id:m.id,result:{data:[{id:'verified-model',model:'verified-model',displayName:'Verified',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low'}],nextCursor:null}});if(m.method==='config/read')send({id:m.id,result:{config:{}}});if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'}}});if(m.method==='mcpServerStatus/list')send({id:m.id,result:{data:[],nextCursor:null}});if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});send({method:'item/agentMessage/delta',params:{threadId:'thread',itemId:'msg',delta:'Done'}});send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});}});`);
  const runtime = createBotRuntime({ stateDir: join(root, 'codex-state'), commands: { codex: '/fixture/codex' }, spawnProcess: (_command, _args, options) => spawn(process.execPath, [program], options) });
  const catalog = await runtime.models('codex'); assert.deepEqual(catalog.models[0].efforts, ['low', 'high']);
  assert.equal((await readFile(log, 'utf8')).includes('turn/start'), false);
  await runtime.run({ bot: bot('codex'), message: 'Fixture only', tools: [] });
  const messages = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.filter(row => row.method === 'turn/start').length, 1);
  assert.equal(messages.find(row => row.method === 'turn/start').params.effort, 'high');
  await assert.rejects(runtime.run({ bot: bot('codex', { effort: 'max' }), message: 'Must not prompt', tools: [] }), /could not be verified/);
  await runtime.close();
});

test('Claude metadata does not fabricate levels and supported SDK effort reaches the request', async () => {
  let received, prompts = 0, controls = 0;
  const sdk = { query({ prompt, options }) {
    if (typeof prompt !== 'string') { controls++; return { supportedModels: async () => [{ value: 'sonnet', resolvedModel: 'verified-model', displayName: 'Verified Claude', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }, { value: 'legacy', displayName: 'Legacy', supportsEffort: false }], close() {} }; }
    prompts++; received = options;
    return (async function* () { yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }; yield { type: 'result', subtype: 'success', usage: {} }; })();
  } };
  const runtime = createBotRuntime({ stateDir: join(root, 'claude-state'), commands: { claude: '/fixture/claude' }, claudeSdk: sdk });
  const catalog = await runtime.models('claude'); assert.equal(prompts, 0); assert.equal(controls, 1); assert.deepEqual(catalog.models[1].efforts, []);
  await runtime.run({ bot: bot('claude'), message: 'Fixture only', tools: [] }); assert.equal(received.effort, 'high');
  await assert.rejects(runtime.run({ bot: bot('claude', { model: 'legacy', effort: 'high' }), message: 'Must not prompt', tools: [] }), /could not be verified/);
  assert.equal(prompts, 1); await runtime.close();
});

test('ACP applies only advertised effort and requires exact readback before any prompt', async () => {
  const program = join(root, 'acp.mjs'), log = join(root, 'acp.log');
  await writeFile(program, `import readline from'node:readline';import{appendFileSync}from'node:fs';const wrong=process.argv[2]==='wrong';const send=o=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');if(m.method==='initialize')send({id:m.id,result:{agentCapabilities:{}}});if(m.method==='session/new')send({id:m.id,result:{sessionId:'acp',configOptions:[{id:'thinking',category:'thought_level',currentValue:'low',options:[{value:'low',name:'Low'},{value:'high',name:'High'}]}]}});if(m.method==='session/set_config_option')send({id:m.id,result:{configOptions:[{id:'thinking',currentValue:wrong?'low':m.params.value}]}});if(m.method==='session/prompt')send({id:m.id,result:{stopReason:'end_turn'}});});`);
  for (const provider of ['grok', 'kimi']) {
    const runtime = createBotRuntime({ stateDir: join(root, provider), commands: { [provider]: `/fixture/${provider}` }, spawnProcess: (_command, _args, options) => spawn(process.execPath, [program], options) });
    await runtime.run({ bot: bot(provider), message: 'Fixture only', tools: [] }); await runtime.close();
  }
  const before = (await readFile(log, 'utf8')).split('\n').filter(row => row.includes('session/prompt')).length;
  const wrong = createBotRuntime({ stateDir: join(root, 'wrong'), commands: { kimi: '/fixture/kimi' }, spawnProcess: (_command, _args, options) => spawn(process.execPath, [program, 'wrong'], options) });
  await assert.rejects(wrong.run({ bot: bot('kimi'), message: 'Must not prompt', tools: [] }), /did not confirm/); await wrong.close();
  const after = (await readFile(log, 'utf8')).split('\n').filter(row => row.includes('session/prompt')).length;
  assert.equal(after, before);
});

test('unknown configured and Ollama effort stay default and reject unsupported overrides before inference', async () => {
  let prompts = 0;
  const runtime = createBotRuntime({ fetch: () => { prompts++; throw new Error('Must not request'); }, modelRequest: () => { prompts++; throw new Error('Must not request'); } });
  for (const provider of ['grok', 'kimi', 'ollama', 'configured']) assert.deepEqual((await runtime.models(provider)).models, []);
  for (const provider of ['ollama', 'configured']) await assert.rejects(runtime.run({ bot: bot(provider), message: 'No prompt', tools: [] }), /could not be verified/);
  assert.equal(prompts, 0); await runtime.close();
});

test('Darwin process ownership distinguishes live descendants from zombies and fails closed on malformed ps', async () => {
  assert.equal(ownedGroupAliveFromPS('  55 Z\n  77 S+\n', 55), false);
  assert.equal(ownedGroupAliveFromPS('  55 Z\n  55 S\n  77 S+\n', 55), true);
  assert.equal(ownedGroupAliveFromPS('  55 Z\n  77 S+\n', 99), false);
  for (const output of ['', 'garbage', '55 S\ntruncated row']) assert.throws(() => ownedGroupAliveFromPS(output, 55), /could not be verified/);
  await assert.rejects(killOwned({ pid: 999999999 }, { platform: 'darwin', processTable: async () => 'malformed' }), /could not be verified/);
});
