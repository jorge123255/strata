/** Exercises the real SSH worker protocol locally with inert adapters; no SSH connection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { startWorker } from '../server/bots-runtime/ssh-worker.mjs';
import { createBotActionJournal } from '../server/bots-action-journal.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('only fresh worker action callbacks carry the exact execution scope proof; historical receipts never manufacture verification',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'strata-workflow-worker-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));writeFileSync(join(directory,'artifact'),'Actual scratch artifact');
 const input={bot:{id:'bot_fixture',provider:'codex',execution:{kind:'ssh',host:'fixture.invalid'},workspace:directory,capabilities:'code',policy:'bypass'},sessionId:'s_fixture',message:'Inspect scratch artifact',history:[],harnessActionScope:{turnId:'a'.repeat(64),authority:'b'.repeat(64)}};let effects=0;
 const perform=async()=>{const frames=[],reader=new EventEmitter();reader.close=()=>reader.emit('close');await startWorker(input,{directory,reader,send:v=>frames.push(v),toolFactory:()=>({definitions:()=>[{name:'read_file',inputSchema:{type:'object'}}],async execute(){effects++;return {content:[{type:'text',text:readFileSync(join(directory,'artifact'),'utf8')}]};},finish(){},close(){}}),runtimeFactory:()=>({async run(runtime){await runtime.executeTool('read_file',{path:'artifact'},'exact_native_id');return {text:'Inspected'};},close(){}})});return frames.filter(v=>v.type==='harness-action').map(v=>v.value);};
 const current=await perform(),proof=hash([input.sessionId,input.harnessActionScope.turnId,input.harnessActionScope.authority]);assert.ok(current.some(v=>v.state==='succeeded'&&v.executionScopeProof===proof));assert.equal(current.every(v=>v.executionScopeProof===proof),true);assert.equal(effects,1);
 const historic=await perform();assert.ok(historic.length);assert.equal(historic.every(v=>v.executionScopeProof===undefined),true);assert.equal(effects,1);
 const host=createBotActionJournal({directory:join(directory,'host-receipts')});for(const receipt of current)host.observeRemote(receipt,input.sessionId);assert.equal(JSON.stringify(host.summary()).includes('executionScopeProof'),false);assert.equal(readdirSync(join(directory,'action-receipts')).filter(n=>n.endsWith('.json')).some(n=>readFileSync(join(directory,'action-receipts',n),'utf8').includes('Actual scratch artifact')),false);
});
