/** Disposable actual host/team/conversation integration. No provider CLI, owner API, SSH or device. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
const tick = () => new Promise(r => setImmediate(r));
async function until(fn, timeout=6000) { const at=Date.now(); while (!fn()) { if(Date.now()-at>timeout) throw new Error('Timed out'); await tick(); } }
function fixture(t, options={}) {
  const directory=mkdtempSync(join(tmpdir(),'strata-workflow-team-')), counter=join(directory,'counter.txt'); writeFileSync(counter,'0');
  let chats, state, f; const calls=[], frames=[], held=new Map(), cleanup=new Map();
  const runtime={ providers:async()=>[], close() {}, async run(input) {
    calls.push(input); const phase=/; role (planning|building|evaluating|repairing)\./.exec(input.message)?.[1];
    if (phase && options.authFailureOnce && !options.authFailed) { options.authFailed=true; throw new Error('configured model API returned HTTP 401 fixture failure'); }
    if (!phase) { if(options.privateWait) await new Promise(r=>input.signal.addEventListener('abort',r,{once:true})); return; }
    if(options.holdPhase===phase) { await new Promise(r=>{held.set(input.sessionId,r);input.signal.addEventListener('abort',r,{once:true});}); if(input.signal.aborted)return; }
    if(phase==='planning') { await input.executeTool('post_team_message',{message:'Public stage progress'},'progress'); await input.executeTool('submit_workflow_plan',{summary:'Scoped plan',items:['Inspect current workspace','Build and independently verify']},'plan'); }
    else if(['building','repairing'].includes(phase)) { await input.executeTool('write_file',{path:'counter.txt'},'write'); await input.executeTool('submit_workflow_build',{summary:'Implemented scoped change',evidence:[{kind:'file',label:'Counter',detail:'counter.txt'}]},'build'); }
    else { if(!options.noVerification) await input.executeTool('read_file',{path:'counter.txt'},'verify'); const wf=f.bots.team.workflows.list(f.team.id).workflows.find(w=>w.steps.some(s=>s.chatId===input.sessionId)); await input.executeTool('submit_workflow_review',{decision:'pass',summary:'Independently inspected actual output',checks:wf.criteria.map(c=>({criterionId:c.id,passed:true,detail:'Read actual disposable result'}))},'review'); }
    input.onFrame({type:'delta',text:'Private assistant output must not be copied to public workflow history.'}); input.onFrame({type:'done'});
  }};
  const tools={ definitions:()=>[{name:'read_file',description:'Read disposable counter',inputSchema:{type:'object'}},{name:'write_file',description:'Increment disposable counter',inputSchema:{type:'object'}}], execute:async({name})=>{if(name==='write_file')writeFileSync(counter,String(Number(readFileSync(counter,'utf8'))+1));return {content:[{type:'text',text:readFileSync(counter,'utf8')}],...(options.partialFailure&&name==='write_file'?{isError:true}:{})};}, async finish(chatId) { if(options.holdCleanup && !cleanup.has(chatId)) { const call=calls.find(c=>c.sessionId===chatId); if(call?.message.includes('role building.'))await new Promise(r=>cleanup.set(chatId,r)); } }};
  const bots=createBots({directory,runtime,tools,defaultWorkspace:()=>directory,conversations:()=>chats});
  chats=createConversations({directory,enabled:()=>bots.hasProfiles(),pending:id=>bots.pending(id),stop:id=>bots.stop(id),approve:v=>bots.approve(v),validateSelection:v=>bots.validateSelection(v),execute:v=>bots.run(v)});
  const create=(name,policy='bypass')=>bots.create({name,provider:'codex',workspace:directory,policy}).bot;
  const planner=create('Planner'),builder=create('Builder'),evaluator=create('Evaluator'),other=create('Independent'); const team=bots.team.create({name:'Disposable workflow',memberIds:[planner.id,builder.id,evaluator.id,other.id],coordinatorId:planner.id,enabled:true}).team;
  f={directory,counter,bots,chats,planner,builder,evaluator,other,team,calls,held,cleanup, create};
  f.start=(requestId='request1',roles={})=>bots.team.workflows.create(team.id,{requestId,goal:'Increment the scratch counter once and inspect it',plannerId:planner.id,builderId:builder.id,evaluatorId:evaluator.id,criteria:['Counter changed once'],...roles}).workflow;
  f.current=id=>bots.team.workflows.detail(team.id,id).workflow;
  f.selection=id=>({expectedRevision:f.current(id).revision,expectedProof:f.current(id).proof});
  t.after(async()=>{for(const r of [...held.values(),...cleanup.values()])r();await bots.close();chats.close();rmSync(directory,{recursive:true,force:true});});return f;
}
test('actual host workflow uses separate fresh stage chats, checkpoints real scratch effect once, and awaits owner',async t=>{
  const f=fixture(t), row=f.start(); await until(()=>f.current(row.id).phase==='awaiting_review'); const done=f.current(row.id); assert.equal(readFileSync(f.counter,'utf8'),'1'); assert.equal(f.calls.length,3);assert.equal(new Set(f.calls.map(c=>c.sessionId)).size,3);assert.deepEqual(done.steps.map(s=>s.botId),[f.planner.id,f.builder.id,f.evaluator.id]);assert.equal(f.bots.team.activeCount(),0);
  assert.equal(f.bots.team.channel(f.team.id).messages.some(m=>m.content.includes('Private assistant output')),false); assert.equal(f.bots.team.channel(f.team.id).messages.filter(m=>m.author.type==='user').length,1); assert.equal(f.bots.team.channel(f.team.id).messages.some(m=>m.content==='Public stage progress'),true);
  assert.equal(f.bots.team.workflows.review(f.team.id,row.id,{...f.selection(row.id),decision:'accept'}).workflow.phase,'completed');
});
test('actual evaluator cannot pass by copying a builder claim without its own supplied verification action',async t=>{
  const f=fixture(t,{noVerification:true}),row=f.start();await until(()=>f.current(row.id).phase==='blocked');assert.equal(f.current(row.id).checks.length,0);assert.equal(readFileSync(f.counter,'utf8'),'1');assert.equal(f.calls.length,3);
});
test('stage advancement waits for cleanup and parent run stays live between boundaries',async t=>{
  const f=fixture(t,{holdCleanup:true}),row=f.start();await until(()=>f.cleanup.size>0);assert.equal(f.current(row.id).phase,'building');assert.equal(f.calls.length,2);assert.equal(f.bots.team.activeCount(),1);for(const r of f.cleanup.values())r();await until(()=>f.current(row.id).phase==='awaiting_review');assert.equal(f.calls.length,3);
});
test('two workflows can share a future planner without reserving all members, and idle evaluator private chat works',async t=>{
  const f=fixture(t,{holdPhase:'building',privateWait:true}),one=f.start();await until(()=>f.calls.some(c=>c.message.includes('role building.')));// Use another existing member without editing the live team.
  const two=f.start('request2',{builderId:f.other.id});await until(()=>f.calls.filter(c=>c.message.includes('role building.')).length===2);assert.equal(f.bots.team.activeCount(),2);
  const privateChat=f.bots.createConversation(f.evaluator.id).conversation;f.chats.send(privateChat.id,'Private conversation with future evaluator');await until(()=>f.calls.some(c=>c.sessionId===privateChat.id));assert.equal(f.chats.detail(privateChat.id).conversation.active,true);await f.chats.stop(privateChat.id);
  await f.bots.team.workflows.stop(f.team.id,one.id,f.selection(one.id));await f.bots.team.workflows.stop(f.team.id,two.id,f.selection(two.id));assert.equal(f.current(one.id).phase,'stopped');assert.equal(f.current(two.id).phase,'stopped');
});
test('stopping one workflow fences stale provider callbacks but preserves unrelated bot conversation',async t=>{
  const f=fixture(t,{holdPhase:'building',privateWait:true}),row=f.start();await until(()=>f.calls.some(c=>c.message.includes('role building.')));const builderCall=f.calls.find(c=>c.message.includes('role building.'));const independent=f.bots.createConversation(f.other.id).conversation;f.chats.send(independent.id,'Independent work');await until(()=>f.calls.some(c=>c.sessionId===independent.id));
  await f.bots.team.workflows.stop(f.team.id,row.id,f.selection(row.id));assert.equal(f.current(row.id).phase,'stopped');assert.throws(()=>builderCall.executeTool('write_file',{path:'counter.txt'},'late'),/ended/);assert.equal(readFileSync(f.counter,'utf8'),'0');assert.equal(f.chats.detail(independent.id).conversation.active,true);await f.chats.stop(independent.id);
});
test('host create rejects Plan builder or evaluator while allowing a Plan planner',async t=>{
  const f=fixture(t);f.bots.update(f.builder.id,{policy:'plan'});assert.throws(()=>f.start(),/Work-capable/);assert.equal(existsSync(join(f.directory,'bot-workflows.json')),false);f.bots.update(f.builder.id,{policy:'bypass'});f.bots.update(f.planner.id,{policy:'plan'});const row=f.start();await until(()=>f.current(row.id).phase==='awaiting_review');
});

test('uncertain checkpoint storage revokes running tools while owner Stop still aborts the exact turn',async t=>{
  const f=fixture(t,{holdPhase:'planning'}),row=f.start();await until(()=>f.calls.length===1);const call=f.calls[0],path=join(f.directory,'bot-workflows.json'),foreign=join(f.directory,'foreign');writeFileSync(foreign,'preserve');unlinkSync(path);symlinkSync(foreign,path);
  await assert.rejects(call.executeTool('submit_workflow_plan',{summary:'Plan',items:['Scoped work']},'broken-checkpoint'),/unavailable/);
  await assert.rejects(Promise.resolve().then(()=>call.executeTool('write_file',{path:'counter.txt'},'after-failure')),/authority|ended|unavailable/);assert.equal(readFileSync(f.counter,'utf8'),'0');
  await assert.rejects(f.bots.team.workflows.stop(f.team.id,row.id,f.selection(row.id)),/stopped.*checkpoint|checkpoint.*confirmed/i);assert.equal(call.signal.aborted,true);assert.equal(f.chats.detail(call.sessionId).conversation.active,false);assert.equal(readFileSync(foreign,'utf8'),'preserve');assert.equal(f.calls.length,1);
});

test('a partially failed mutating tool blocks automatic next-stage execution until exact owner inspection',async t=>{
  const f=fixture(t,{partialFailure:true}),row=f.start();await until(()=>f.current(row.id).phase==='blocked');assert.equal(f.calls.length,2);assert.equal(readFileSync(f.counter,'utf8'),'1');assert.equal(f.current(row.id).canResume,false);
  const action=f.bots.harnessActions().actions.find(a=>a.state==='uncertain');assert.ok(action);const acknowledged=f.bots.reviewHarnessAction(action.id,{expectedRevision:action.revision,expectedProof:action.proof,decision:'acknowledge'});assert.equal(acknowledged.retried,false);assert.equal(f.current(row.id).canResume,true);
  f.bots.team.workflows.resume(f.team.id,row.id,{...f.selection(row.id),requestId:'owner-inspected',inspected:true});await until(()=>f.current(row.id).phase==='awaiting_review');assert.equal(readFileSync(f.counter,'utf8'),'1');assert.equal(f.calls.length,3);
});

test('actual local workflow routes preserve exact origin, body/query, role and stale-proof boundaries',async t=>{
 const f=fixture(t,{holdPhase:'planning'});let route;const server=http.createServer((req,res)=>route(req,res,new URL(req.url,`http://127.0.0.1:${server.address().port}`)));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const port=server.address().port,origin=`http://127.0.0.1:${port}`,base=`${origin}/api/bots/teams/${f.team.id}/workflows`;route=createBotRoutes({bots:f.bots,port});const body={requestId:'route-request',goal:'Bounded route fixture',plannerId:f.planner.id,builderId:f.builder.id,evaluatorId:f.evaluator.id,criteria:['Preserve scope']};const post=(url,input,requestOrigin=origin)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',Origin:requestOrigin},body:JSON.stringify(input)});
 assert.equal((await post(base,body,'https://untrusted.invalid')).status,403);assert.equal(f.calls.length,0);const created=await post(base,body);assert.equal(created.status,201);const row=(await created.json()).workflow;assert.equal((await post(base,body)).status,201);const listed=await fetch(base);assert.equal((await listed.json()).teamWorkflowsSupported,true);assert.equal((await fetch(base+'?settings=bad')).status,400);
 const bodyStatus=await new Promise(r=>{const request=http.request(base,{method:'GET',headers:{'content-length':'2'}},res=>{res.resume();res.on('end',()=>r(res.statusCode));});request.end('{}');});assert.equal(bodyStatus,400);const detail=await fetch(base+'/'+row.id);assert.equal(detail.status,200);assert.equal((await post(base+'/'+row.id+'/stop',{expectedRevision:1,expectedProof:'0'.repeat(64)})).status,409);await until(()=>f.calls.length===1);const selected=f.selection(row.id);assert.equal((await post(base+'/'+row.id+'/stop',selected)).status,200);assert.equal(f.current(row.id).phase,'stopped');assert.equal(f.bots.team.channel(f.team.id).messages.filter(m=>m.author.type==='user').length,1);
});

test('an explicit inspected continuation may make one new provider attempt without clearing old failure history',async t=>{
 const f=fixture(t,{authFailureOnce:true}),row=f.start();await until(()=>f.current(row.id).phase==='blocked');assert.equal(f.calls.length,1);const prior=JSON.parse(readFileSync(join(f.directory,'bot-teams.json'))).jobs.find(j=>j.retryRequiresOwner);assert.ok(prior);f.bots.team.workflows.resume(f.team.id,row.id,{...f.selection(row.id),requestId:'owner-fixed-signin',inspected:true});await until(()=>['awaiting_review','blocked'].includes(f.current(row.id).phase));assert.equal(f.current(row.id).phase,'awaiting_review');assert.equal(f.calls.length,4);assert.equal(readFileSync(f.counter,'utf8'),'1');const saved=JSON.parse(readFileSync(join(f.directory,'bot-teams.json'))).jobs.find(j=>j.id===prior.id);assert.equal(saved.retryRequiresOwner,true);assert.equal(saved.state,'error');
});
