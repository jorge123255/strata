/** Actual host/team/conversation lifecycle with disposable tools; no provider or owner data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createBots} from '../server/bots.mjs';
import {createConversations} from '../server/conversations.mjs';
const taskKey=call=>/; role task\./.test(call.message)?JSON.parse(call.message.slice(call.message.lastIndexOf('\n')+1)).task?.key:undefined;
const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){const start=Date.now();while(!fn()){if(Date.now()-start>6500)throw Error('Timed out waiting for fixture state');await pause();}}
function fixture(t,options={}){
 const directory=mkdtempSync(join(tmpdir(),'strata-team-plan-')),calls=[],held=new Map(),cleanup=new Map();let chats,f;
 const runtime={providers:async()=>[],close(){},async run(input){calls.push(input);const match=/; role (planning|task|synthesis)\./.exec(input.message);if(!match){if(options.privateWait)await new Promise(r=>input.signal.addEventListener('abort',r,{once:true}));return;}
  const role=match[1],data=JSON.parse(input.message.slice(input.message.lastIndexOf('\n')+1));
  if(options.authFailureOnce&&!options.authFailed){options.authFailed=true;throw Error('configured model API returned HTTP 401 fixture');}
  if(options.holdRole===role||options.holdKey&&options.holdKey===data.task?.key){await new Promise(r=>{held.set(input.sessionId,r);input.signal.addEventListener('abort',r,{once:true});});if(input.signal.aborted)return;}
  if(role==='planning'){
   assert.equal(input.tools.some(tool=>tool.name==='write_file'),false);
   await input.executeTool('post_team_message',{message:'Planning exact requested scratch work'},'progress');
   if(options.fillRoom)for(let i=0;i<105;i++)await input.executeTool('post_team_message',{message:`Public progress ${i}`},`room-${i}`);
   if(options.invalidPlanFirst){const rejected=await input.executeTool('submit_team_plan',{summary:'Invalid self review',participation:[],tasks:[]},'invalid-plan');assert.equal(rejected.isError,true);}
   await input.executeTool('submit_team_plan',{summary:'Split actual scratch work and independent review',participation:f.members.map(bot=>({botId:bot.id,role:bot.id===f.coordinator.id?'Coordinator':bot.id===f.reviewer.id?'Independent review':'Implementation',reason:'Distinct authorized contribution'})),tasks:f.tasks()},'plan');
  }else if(role==='task'){
   const task=data.task;
   if(task.kind==='work'){
    await input.executeTool('write_file',{path:task.key+'.txt',content:task.key},'effect');
    const working=options.workingOnce&&!options.worked&&task.key==='left';if(working)options.worked=true;
    await input.executeTool('checkpoint_team_plan_task',{outcome:working?'working':'ready_for_review',summary:'Actual scratch output '+task.key,evidence:[{kind:'file',label:'Scratch output',detail:task.key+'.txt'}],...(working?{progress:'Created first scratch output',nextStep:'Inspect current output then finish'}:{})},'checkpoint');
   }else{
    await input.executeTool('read_file',{path:'verify'},'verify');
    await input.executeTool('checkpoint_team_plan_task',{outcome:'ready_for_review',summary:'Independently read actual outputs',evidence:[{kind:'test',label:'Scratch read',detail:'Read actual fixture files'}],checks:task.criteria.map(c=>({criterionId:c.id,passed:true,detail:'Observed actual supplied read'}))},'checkpoint');
   }
  }else{
   assert.equal(input.tools.some(tool=>tool.name==='write_file'),false);
   await input.executeTool('submit_team_plan_summary',{summary:'Scratch changes and independent verification are ready for owner inspection',outcome:'ready_for_review'},'synthesis');
  }
  input.onFrame({type:'delta',text:'PRIVATE transcript should never be automatically public.'});input.onFrame({type:'done'});
 }};
 const tools={definitions:()=>[{name:'read_file',description:'Read scratch outputs',inputSchema:{type:'object'}},{name:'write_file',description:'Write scratch output',inputSchema:{type:'object'}}],async execute({name,args,bot}){if(name==='write_file'){const path=join(bot.workspace,args.path),old=existsSync(path)?Number(readFileSync(path,'utf8')):0;writeFileSync(path,String(old+1));return {content:[{type:'text',text:'Wrote scratch output'}]};}return {content:[{type:'text',text:f.builders.map(bot=>existsSync(join(bot.workspace,'left.txt'))||existsSync(join(bot.workspace,'right.txt'))).join(',')}]};},async finish(chatId){const call=calls.find(c=>c.sessionId===chatId);if(options.holdCleanup&&!options.cleanupHeld&&call&&taskKey(call)==='left'){options.cleanupHeld=true;await new Promise(r=>cleanup.set(chatId,r));}}};
 const bots=createBots({directory,runtime,tools,defaultWorkspace:()=>directory,conversations:()=>chats});
 chats=createConversations({directory,enabled:()=>bots.hasProfiles(),pending:id=>bots.pending(id),stop:id=>bots.stop(id),approve:value=>bots.approve(value),validateSelection:value=>bots.validateSelection(value),execute:value=>bots.run(value)});
 const create=name=>{const workspace=options.sameWorkspace?directory:join(directory,name);mkdirSync(workspace,{recursive:true});return bots.create({name,provider:'codex',workspace,policy:name==='Coordinator'?options.coordinatorPolicy??'bypass':'bypass'}).bot;};
 const coordinator=create('Coordinator'),left=create('Left'),right=create('Right'),reviewer=create('Reviewer'),other=create('Other'),members=[coordinator,left,right,reviewer];
 const team=bots.team.create({name:'Disposable DAG team',memberIds:members.map(bot=>bot.id),coordinatorId:coordinator.id,enabled:true}).team;
 f={directory,bots,chats,calls,held,cleanup,coordinator,reviewer,members,builders:[left,right],other,team};
 f.tasks=()=>[{key:'left',title:'Left change',instructions:'Write the requested left scratch output only',ownerId:left.id,dependsOn:[],kind:'work',criteria:['Left output exists'],workspaceKey:'left-hint'},{key:'right',title:'Right change',instructions:'Write the requested right scratch output only',ownerId:right.id,dependsOn:[],kind:'work',criteria:['Right output exists'],workspaceKey:'right-hint'},{key:'review-left',title:'Review left',instructions:'Read and verify actual left output',ownerId:reviewer.id,dependsOn:['left'],kind:'review',criteria:['Left output independently observed']},{key:'review-right',title:'Review right',instructions:'Read and verify actual right output',ownerId:reviewer.id,dependsOn:['right'],kind:'review',criteria:['Right output independently observed']}];
 f.start=(requestId='scratch-request')=>bots.team.message(team.id,{requestId,message:'Implement the two scratch changes, independently review, and preserve all release holds.',workMode:'work',durablePlan:true});
 f.current=id=>bots.team.plans.detail(team.id,id).plan;
 f.selection=id=>{const row=f.current(id);return {expectedRevision:row.revision,expectedProof:row.proof};};
 t.after(async()=>{for(const resolve of [...held.values(),...cleanup.values()])resolve();await bots.close();chats.close();rmSync(directory,{recursive:true,force:true});});return f;
}
test('actual durable intake preserves public human scope, distinct role tools and owner acceptance',async t=>{
 const f=fixture(t),ack=f.start();assert.match(ack.planId,/^tp_/);assert.equal(ack.run.planId,ack.planId);assert.equal(ack.sourceMessage.planId,ack.planId);assert.equal(ack.sourceMessage.workMode,'work');assert.equal(f.start().planId,ack.planId);
 await until(()=>f.current(ack.planId).phase==='awaiting_review');const row=f.current(ack.planId);assert.equal(row.totalTasks,4);assert.equal(row.tasks.every(task=>task.state==='ready_for_review'),true);assert.equal(f.calls.length,6);assert.equal(f.bots.team.activeCount(),0);assert.equal(f.bots.team.activity().activity.filter(item=>item.work).length,0);
 assert.equal(f.bots.team.channel(f.team.id).messages.filter(message=>message.author.type==='user').length,1);assert.equal(f.bots.team.channel(f.team.id).messages.some(message=>message.content.includes('PRIVATE transcript')),false);assert.equal(f.bots.team.channel(f.team.id).messages.some(message=>message.content==='Planning exact requested scratch work'),true);
 const accepted=f.bots.team.plans.review(f.team.id,row.id,{...f.selection(row.id),decision:'accept'}).plan;assert.equal(accepted.phase,'completed');assert.equal(f.calls.length,6);
});
test('dependency completion wakes its ready review before an unrelated held sibling finishes',async t=>{
 const f=fixture(t,{holdKey:'right'}),ack=f.start();await until(()=>f.calls.some(call=>taskKey(call)==='review-left'));assert.equal(f.current(ack.planId).tasks.find(task=>task.key==='right').state,'running');assert.equal(f.current(ack.planId).tasks.find(task=>task.key==='left').state,'ready_for_review');assert.equal(f.bots.team.activeCount(),1);for(const resolve of f.held.values())resolve();await until(()=>f.current(ack.planId).phase==='awaiting_review');
});
test('same actual workspace serializes despite distinct untrusted model workspace hints',async t=>{
 const f=fixture(t,{sameWorkspace:true,holdKey:'left'}),ack=f.start();await until(()=>f.held.size===1);assert.equal(f.calls.filter(call=>call.message.includes('; role task.')).length,1);assert.equal(f.current(ack.planId).tasks.find(task=>task.key==='right').state,'pending');for(const resolve of f.held.values())resolve();await until(()=>f.current(ack.planId).phase==='awaiting_review');
});
test('structured working checkpoint waits for actual cleanup before fresh attempt, never legacy result continuation',async t=>{
 const f=fixture(t,{workingOnce:true,holdCleanup:true}),ack=f.start();await until(()=>f.cleanup.size===1);assert.equal(f.calls.filter(call=>taskKey(call)==='left').length,1);assert.equal(f.current(ack.planId).tasks.find(task=>task.key==='left').state,'running');assert.equal(f.bots.team.activeCount(),1);for(const resolve of f.cleanup.values())resolve();await until(()=>f.calls.filter(call=>taskKey(call)==='left').length===2);for(const resolve of f.cleanup.values())resolve();await until(()=>f.current(ack.planId).phase==='awaiting_review');assert.equal(new Set(f.calls.map(call=>call.sessionId)).size,f.calls.length);assert.equal(readFileSync(join(f.builders[0].workspace,'left.txt'),'utf8'),'2');
});
test('Stop from one running task fences entire plan while unrelated private chat remains usable',async t=>{
 const f=fixture(t,{holdKey:'left',privateWait:true}),ack=f.start();await until(()=>f.held.size===1);const call=f.calls.find(call=>taskKey(call)==='left'),privateChat=f.bots.createConversation(f.other.id).conversation;f.chats.send(privateChat.id,'Independent private chat');await until(()=>f.calls.some(item=>item.sessionId===privateChat.id));await f.bots.team.stopForChat(call.sessionId);assert.equal(f.current(ack.planId).phase,'stopped');assert.throws(()=>call.executeTool('write_file',{path:'late.txt'},'late'),/ended/);assert.equal(f.chats.detail(privateChat.id).conversation.active,true);await f.chats.stop(privateChat.id);
});
test('checkpoint write failure revokes tools and still permits explicit cleanup Stop',async t=>{
 const f=fixture(t,{holdRole:'planning'}),ack=f.start();await until(()=>f.held.size===1);const call=f.calls[0],path=join(f.directory,'bot-team-plans.json'),foreign=join(f.directory,'preserve');writeFileSync(foreign,'retain exact bytes');unlinkSync(path);symlinkSync(foreign,path);
 await assert.rejects(call.executeTool('submit_team_plan',{summary:'Plan',participation:f.members.map(bot=>({botId:bot.id,role:'Member',reason:'Scoped work'})),tasks:f.tasks()},'broken-store'),/unavailable/);await assert.rejects(Promise.resolve().then(()=>call.executeTool('post_team_message',{message:'Must not publish'},'stale')),/authority|ended|unavailable/);await assert.rejects(f.bots.team.plans.stop(f.team.id,ack.planId,f.selection(ack.planId)),/stopped.*checkpoint|checkpoint.*confirmed/i);assert.equal(call.signal.aborted,true);assert.equal(readFileSync(foreign,'utf8'),'retain exact bytes');
});
test('old Chat/Work receipt cannot gain durable execution on retry',async t=>{
 const f=fixture(t,{holdRole:'planning'});const old=f.bots.team.message(f.team.id,{requestId:'old-chat',message:'Hello team'});assert.equal(Object.hasOwn(old,'planId'),false);assert.throws(()=>f.bots.team.message(f.team.id,{requestId:'old-chat',message:'Hello team',workMode:'work',durablePlan:true}),/request ID/);assert.equal(existsSync(join(f.directory,'bot-team-plans.json')),false);
});
test('a durable retry returns exact original source beyond the bounded room without redispatching',async t=>{
 const f=fixture(t,{fillRoom:true}),ack=f.start();await until(()=>f.current(ack.planId).phase==='awaiting_review');const callCount=f.calls.length,retry=f.start();assert.equal(retry.channel.messages.some(message=>message.id===ack.sourceMessageId),false);assert.deepEqual(retry.sourceMessage,ack.sourceMessage);assert.equal(retry.planId,ack.planId);assert.equal(f.calls.length,callCount);
});
test('invalid plan is a no-effect validation failure and a corrected checkpoint can proceed without uncertainty',async t=>{
 const f=fixture(t,{invalidPlanFirst:true}),ack=f.start();await until(()=>f.current(ack.planId).phase==='awaiting_review');const receipts=f.bots.harnessActions();assert.equal(receipts.actions.some(action=>['uncertain','interrupted'].includes(action.state)),false);assert.equal(f.current(ack.planId).tasks.length,4);
});
test('manual plan assignment requires actual consent and Stop clears pending approval without execution',async t=>{
 const f=fixture(t,{coordinatorPolicy:'manual'}),ack=f.start();await until(()=>f.bots.pending(ack.run.rootChatId??f.calls[0]?.sessionId).length>0);const call=f.calls[0];assert.equal(f.bots.pending(call.sessionId)[0].tool,'submit_team_plan');assert.equal(f.current(ack.planId).tasks.length,0);await f.bots.team.stop(f.team.id,ack.run.id);assert.equal(f.current(ack.planId).phase,'stopped');assert.equal(f.bots.pending(call.sessionId).length,0);assert.equal(f.calls.length,1);assert.equal(f.builders.some(bot=>existsSync(join(bot.workspace,'left.txt'))),false);
});
test('Plan policy does not acquire task delegation through durable planning controls',async t=>{
 const f=fixture(t,{coordinatorPolicy:'plan'}),ack=f.start();await until(()=>f.current(ack.planId).phase==='blocked');assert.equal(f.current(ack.planId).tasks.length,0);assert.equal(f.calls.length,1);assert.equal(f.bots.pending(f.calls[0].sessionId).length,0);assert.equal(f.bots.harnessActions().actions.some(action=>['uncertain','interrupted'].includes(action.state)),false);
});
test('an idle future role remains available for an unrelated private conversation',async t=>{
 const f=fixture(t,{holdKey:'left',privateWait:true}),ack=f.start();await until(()=>f.held.size===1);const privateChat=f.bots.createConversation(f.coordinator.id).conversation;f.chats.send(privateChat.id,'Private conversation while builders work');await until(()=>f.calls.some(call=>call.sessionId===privateChat.id));assert.equal(f.chats.detail(privateChat.id).conversation.active,true);await f.chats.stop(privateChat.id);await f.bots.team.plans.stop(f.team.id,ack.planId,f.selection(ack.planId));
});
test('explicit inspected provider recovery starts one fresh attempt without clearing prior failure',async t=>{
 const f=fixture(t,{authFailureOnce:true}),ack=f.start();await until(()=>f.current(ack.planId).phase==='blocked');assert.equal(f.calls.length,1);const prior=JSON.parse(readFileSync(join(f.directory,'bot-teams.json'))).jobs.find(job=>job.retryRequiresOwner);assert.ok(prior);f.bots.team.plans.resume(f.team.id,ack.planId,{...f.selection(ack.planId),requestId:'signin-fixed',inspected:true});await until(()=>f.current(ack.planId).phase==='awaiting_review');assert.equal(f.calls.length,7);const retained=JSON.parse(readFileSync(join(f.directory,'bot-teams.json'))).jobs.find(job=>job.id===prior.id);assert.equal(retained.retryRequiresOwner,true);assert.equal(retained.state,'error');
});
test('a real process crash retains completed nodes and uncertain effects; explicit recovery inspects without command replay',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'strata-team-plan-crash-')),marker=join(directory,'ready.json'),script=join(directory,'child.mjs');
 const botsModule=new URL('../server/bots.mjs',import.meta.url).href,chatsModule=new URL('../server/conversations.mjs',import.meta.url).href;
 writeFileSync(script,`import {createBots} from ${JSON.stringify(botsModule)};import {createConversations} from ${JSON.stringify(chatsModule)};import {writeFileSync,readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
 const directory=process.argv[2];let chats,bots,ids,planId,teamId;
 const tools={definitions:()=>[{name:'write_file',inputSchema:{type:'object'}},{name:'read_file',inputSchema:{type:'object'}}],async execute({name,args}){const path=join(directory,args.path);if(name==='write_file')writeFileSync(path,String((existsSync(path)?Number(readFileSync(path,'utf8')):0)+1));return {content:[{type:'text',text:'Actual scratch result'}]};}};
 const runtime={providers:async()=>[],close(){},async run(input){const data=JSON.parse(input.message.slice(input.message.lastIndexOf('\\n')+1));if(input.message.includes('; role planning.')){await input.executeTool('submit_team_plan',{summary:'Two serial changes and independent review',participation:ids.map(botId=>({botId,role:'Assigned',reason:'Concrete scratch scope'})),tasks:[{key:'left',title:'Left',instructions:'One left effect',ownerId:ids[1],dependsOn:[],kind:'work',criteria:['Left exists']},{key:'right',title:'Right',instructions:'One right effect',ownerId:ids[1],dependsOn:['left'],kind:'work',criteria:['Right exists']},{key:'review',title:'Review',instructions:'Inspect both effects',ownerId:ids[2],dependsOn:['right'],kind:'review',criteria:['Actual effects inspected']}]},'plan');}else if(data.task){await input.executeTool('write_file',{path:data.task.key+'.txt'},'write');if(data.task.key==='right'){writeFileSync(join(directory,'ready.json'),JSON.stringify({planId,teamId,chatId:input.sessionId}));await new Promise(()=>{});}await input.executeTool('checkpoint_team_plan_task',{outcome:'ready_for_review',summary:'Actual left output',evidence:[{kind:'file',label:'Left',detail:'left.txt'}]},'checkpoint');}input.onFrame({type:'done'});}};
 bots=createBots({directory,runtime,tools,defaultWorkspace:()=>directory,conversations:()=>chats});chats=createConversations({directory,enabled:()=>true,pending:id=>bots.pending(id),stop:id=>bots.stop(id),approve:v=>bots.approve(v),validateSelection:v=>bots.validateSelection(v),execute:v=>bots.run(v)});ids=['Coordinator','Builder','Reviewer'].map(name=>bots.create({name,provider:'codex',workspace:directory,policy:'bypass'}).bot.id);teamId=bots.team.create({name:'Crash fixture',coordinatorId:ids[0],memberIds:ids,enabled:true}).team.id;planId=bots.team.message(teamId,{requestId:'crash-intake',message:'Two isolated scratch effects and independent review',workMode:'work',durablePlan:true}).planId;setInterval(()=>{},1000);
 `);
 const child=spawn(process.execPath,[script,directory],{stdio:['ignore','ignore','pipe']});let childError='';child.stderr.on('data',data=>{childError+=String(data).slice(0,2000);});t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');rmSync(directory,{recursive:true,force:true});});
 await until(()=>existsSync(marker)||child.exitCode!==null);assert.equal(existsSync(marker),true,childError);const pin=JSON.parse(readFileSync(marker));const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 const calls=[];let chats,bots;const tools={definitions:()=>[{name:'read_file',inputSchema:{type:'object'}},{name:'write_file',inputSchema:{type:'object'}}],async execute({name,args}){assert.equal(name,'read_file','Recovery must inspect current state, never replay writes');return {content:[{type:'text',text:readFileSync(join(directory,args.path),'utf8')}]};}};
 const runtime={providers:async()=>[],close(){},async run(input){calls.push(input);const data=JSON.parse(input.message.slice(input.message.lastIndexOf('\n')+1));assert.equal(input.message.includes('; role planning.'),false);if(data.task){await input.executeTool('read_file',{path:'right.txt'},'inspect');await input.executeTool('checkpoint_team_plan_task',{outcome:'ready_for_review',summary:'Inspected retained effects without replay',evidence:[{kind:'test',label:'Existing effects',detail:'Observed one left and one right effect'}],...(data.task.kind==='review'?{checks:data.task.criteria.map(c=>({criterionId:c.id,passed:true,detail:'Read actual retained output'}))}:{})},'checkpoint');}else await input.executeTool('submit_team_plan_summary',{outcome:'ready_for_review',summary:'Inspected recovered task and independent verification'},'summary');input.onFrame({type:'done'});}};
 bots=createBots({directory,runtime,tools,defaultWorkspace:()=>directory,conversations:()=>chats});chats=createConversations({directory,enabled:()=>true,pending:id=>bots.pending(id),stop:id=>bots.stop(id),approve:v=>bots.approve(v),validateSelection:v=>bots.validateSelection(v),execute:v=>bots.run(v)});t.after(async()=>{await bots.close();chats.close();});
 const current=()=>bots.team.plans.detail(pin.teamId,pin.planId).plan;await pause();assert.equal(current().phase,'interrupted');assert.equal(calls.length,0);assert.equal(readFileSync(join(directory,'left.txt'),'utf8'),'1');assert.equal(readFileSync(join(directory,'right.txt'),'utf8'),'1');const left=current().tasks.find(task=>task.key==='left'),right=current().tasks.find(task=>task.key==='right');assert.equal(left.state,'ready_for_review');assert.equal(right.state,'interrupted');
 // This is an explicit owner inspection receipt in a disposable fixture. It
 // acknowledges metadata only; it never executes or clears the old action.
 for(const action of bots.harnessActions().actions.filter(action=>['uncertain','interrupted'].includes(action.state)))bots.reviewHarnessAction(action.id,{expectedRevision:action.revision,expectedProof:action.proof,decision:'acknowledge'});
 let row=current();bots.team.plans.resume(pin.teamId,pin.planId,{expectedRevision:row.revision,expectedProof:row.proof,requestId:'inspect-right',inspected:true,taskId:right.id});await until(()=>current().tasks.find(task=>task.key==='right').state==='ready_for_review');
 // Restart interrupted the not-yet-dispatched review too. Resume its selected
 // node explicitly after inspecting the recovered result; left stays retained.
 row=current();const review=row.tasks.find(task=>task.key==='review');bots.team.plans.resume(pin.teamId,pin.planId,{expectedRevision:row.revision,expectedProof:row.proof,requestId:'inspect-review',inspected:true,taskId:review.id});await until(()=>current().phase==='awaiting_review');assert.equal(calls.length,3);assert.equal(current().tasks.find(task=>task.key==='left').attemptId,left.attemptId);assert.equal(readFileSync(join(directory,'left.txt'),'utf8'),'1');assert.equal(readFileSync(join(directory,'right.txt'),'utf8'),'1');
});
