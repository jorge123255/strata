/** Non-author regression: owned scratch processes only, never a real SSH or owner host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {createBotTools,runBotProcess} from '../server/bots-tools.mjs';
import {createBotActionJournal} from '../server/bots-action-journal.mjs';
import {startWorker} from '../server/bots-runtime/ssh-worker.mjs';
function fixture(t,options={}){
 const directory=mkdtempSync(join(tmpdir(),'strata-outcome-review-')),receiptDirectory=join(directory,'receipts'),bot={id:'bot_fixture',execution:{kind:'local'},workspace:directory,policy:'bypass',capabilities:'code',computerMode:'host'};
 const tools=createBotTools({directory,...options}),journal=createBotActionJournal({directory:receiptDirectory});
 const scope=(args,extra={})=>({chatId:'s_fixture',authority:'a'.repeat(64),turnId:'owner-turn',toolCallId:'call-one',name:'run_command',args,...extra});
 const execute=(args,extra={})=>journal.execute(scope(args,extra),()=>tools.execute({bot,chatId:'s_fixture',name:'run_command',args,signal:extra.signal,requestPermission:async()=>true}));
 t.after(async()=>{await tools.close();rmSync(directory,{recursive:true,force:true});});return {directory,receiptDirectory,bot,tools,journal,scope,execute};
}
test('real nonzero command retains its effect as error; reload refuses exact replay and does not rewrite old receipt',async t=>{
 const f=fixture(t),args={command:'printf x >> counter; exit 9'},result=await f.execute(args);assert.equal(result.isError,true);assert.match(result.content.at(-1).text,/may have changed/);assert.equal(readFileSync(join(f.directory,'counter'),'utf8'),'x');assert.equal(f.journal.summary().counts.error,1);assert.equal(f.journal.summary().counts.uncertain,0);
 const receipt=f.journal.summary().actions[0],path=join(f.receiptDirectory,receipt.id+'.json'),bytes=readFileSync(path);assert.equal(bytes.includes(Buffer.from('printf')),false);assert.equal(bytes.includes(Buffer.from('counter')),false);
 const reloaded=createBotActionJournal({directory:f.receiptDirectory});let dispatched=0;const replay=await reloaded.execute(f.scope(args),()=>{dispatched++;return {};});assert.match(replay.content[0].text,/not executed again/);assert.equal(dispatched,0);assert.deepEqual(readFileSync(path),bytes);assert.equal(readFileSync(join(f.directory,'counter'),'utf8'),'x');
 await assert.rejects(reloaded.execute(f.scope({command:'different'}),()=>{dispatched++;return {};}),/different action/);assert.equal(dispatched,0);
 // A genuinely new command may inspect/repair after the failure; the prior
 // exact receipt remains unchanged and never becomes a success/rollback.
 await f.execute({command:'test "$(cat counter)" = x; printf repaired > repaired'},{toolCallId:'new-command'});assert.equal(readFileSync(join(f.directory,'repaired'),'utf8'),'repaired');assert.deepEqual(readFileSync(path),bytes);
});
test('plain adapter exit JSON and invented flags cannot certify completion or bypass earlier uncertainty',async t=>{
 const f=fixture(t,{processRunner:async()=>({code:7,stdout:'adapter text',stderr:'',completed:true,processExited:true,exitObserved:true})});await f.execute({command:'fixture untrusted adapter'});assert.equal(f.journal.summary().counts.uncertain,1);
 const prior=f.journal.summary().actions[0],bytes=readFileSync(join(f.receiptDirectory,prior.id+'.json'));let dispatch=0;
 await assert.rejects(f.journal.execute(f.scope({command:'fixture untrusted adapter'},{toolCallId:'fresh-id'}),()=>{dispatch++;return {isError:true,completedProcessError:true,exitCode:7,content:[]};}),/uncertain receipt/);assert.equal(dispatch,0);assert.deepEqual(readFileSync(join(f.receiptDirectory,prior.id+'.json')),bytes);
 const reloaded=createBotActionJournal({directory:f.receiptDirectory});await assert.rejects(reloaded.execute(f.scope({command:'fixture untrusted adapter'},{toolCallId:'post-restart-id'}),()=>{dispatch++;return {};}),/uncertain receipt/);assert.equal(dispatch,0);assert.deepEqual(readFileSync(join(f.receiptDirectory,prior.id+'.json')),bytes);
 const value={isError:true,completedProcessError:{exitCode:7},processExitObserved:7,content:[{type:'text',text:'Exit 7'}]};Object.defineProperty(value,Symbol.for('Strata broker observed a completed command error; effects may exist'),{value:{exitCode:7}});
 await f.journal.execute(f.scope({command:'different unknown command'},{toolCallId:'json-forgery'}),()=>value);assert.equal(f.journal.summary().counts.uncertain,2);
});
test('owned timeout and owner abort remain uncertain/interrupted after a real partial effect',async t=>{
 for(const kind of ['timeout','abort']){
  const f=fixture(t,{processRunner:(command,args,options)=>runBotProcess(command,args,{...options,timeout:kind==='timeout'?80:5000})}),controller=new AbortController();
  const work=f.execute({command:'printf x >> interrupted; sleep 5'},{signal:controller.signal});let timer;if(kind==='abort')timer=setTimeout(()=>controller.abort(),80);
  await assert.rejects(work,/time limit|stopped/);clearTimeout(timer);assert.equal(readFileSync(join(f.directory,'interrupted'),'utf8'),'x');const row=f.journal.summary().actions[0];assert.equal(row.state,kind==='abort'?'interrupted':'uncertain');assert.equal(f.journal.summary().counts.error,0);let dispatched=0;await assert.rejects(f.journal.execute(f.scope({command:'printf x >> interrupted; sleep 5'},{toolCallId:'another-id'}),()=>{dispatched++;return {};}),/uncertain receipt/);assert.equal(dispatched,0);
 }
});
test('a surviving background group is never branded a completed command error',async t=>{
 const f=fixture(t);let pid;
 try{
  const result=await f.execute({command:'sleep 20 >/dev/null 2>&1 & echo $! > owned-background-pid; printf x >> counter; exit 5'});pid=Number(readFileSync(join(f.directory,'owned-background-pid'),'utf8').trim());assert.ok(Number.isSafeInteger(pid)&&pid>1);assert.equal(result.isError,true);assert.match(result.content.at(-1).text,/may have changed the outside world/);assert.equal(f.journal.summary().counts.uncertain,1);assert.equal(f.journal.summary().counts.error,0);
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{}}
});
test('worker classifies its owned process before JSON and host mirrors that exact non-success without replay',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'strata-worker-outcome-review-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const sent=[],results=[];
 const input={bot:{id:'bot_worker',provider:'codex',execution:{kind:'ssh',host:'inert-fixture'},workspace:directory,policy:'bypass',capabilities:'code'},sessionId:'s_worker',message:'Exact disposable worker turn',hostTools:[]};
 const run=async()=>{const reader=new EventEmitter();reader.close=()=>reader.emit('close');await startWorker(input,{directory,reader,send:value=>{sent.push(value);if(value.type==='permission')queueMicrotask(()=>reader.emit('line',JSON.stringify({type:'reply',id:value.id,value:true})));},toolFactory:options=>createBotTools({...options,browserProbe:()=>({found:false})}),runtimeFactory:()=>({async run({executeTool}){const result=await executeTool('run_command',{command:'printf x >> worker-counter; exit 6'},'native-command');results.push(result);return {};},close(){}})});};
 await run();assert.equal(readFileSync(join(directory,'worker-counter'),'utf8'),'x');assert.equal(results[0].isError,true);assert.match(results[0].content.at(-1).text,/completed with an error/);const observed=sent.filter(value=>value.type==='harness-action').map(value=>value.value);assert.equal(observed.at(-1).state,'error');assert.equal(JSON.stringify(observed).includes('printf'),false);assert.equal(sent.find(value=>value.type==='cleanup').confirmed,true);
 const mirror=createBotActionJournal({directory:join(directory,'host-mirror')});for(const row of observed)mirror.observeRemote(row,input.sessionId);const summary=mirror.summary();assert.equal(summary.counts.error,1);assert.equal(summary.actions[0].readOnly,true);mirror.markRemoteUncertain(input.sessionId);assert.equal(mirror.summary().counts.error,1);
 await run();assert.equal(readFileSync(join(directory,'worker-counter'),'utf8'),'x');assert.match(results[1].content[0].text,/not executed again/);
});
