import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBots} from '../server/bots.mjs';
import {createConversations} from '../server/conversations.mjs';
async function until(check){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture did not settle');}
test('real bot ownership stores results and continues only one explicitly recovered task in a fresh chat',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'strata-reviewed-task-'));let bots,chats;const prompts=[];
 t.after(async()=>{await bots?.close();chats?.close();rmSync(directory,{recursive:true,force:true});});
 const runtime={providers:async()=>[],close(){},async run(c){prompts.push({chatId:c.sessionId,message:c.message,checkpoint:c.checkpoint});await c.executeTool('submit_team_result',{summary:'Fixture report',evidence:[{kind:'note',label:'Fixture result',detail:'Only inert fixture work happened.'}]},'fixture_result');c.onFrame({type:'delta',text:'Fixture report ready for review.'});c.onFrame({type:'done'});}};
 bots=createBots({directory,defaultWorkspace:()=>directory,conversations:()=>chats,runtime,tools:{definitions:()=>[],execute(){assert.fail('No real tools');},finish(){},close(){}}});
 chats=createConversations({directory,enabled:()=>true,validateSelection:v=>bots.validateSelection(v),execute:v=>bots.run(v),pending:id=>bots.pending(id),stop:id=>bots.stop(id),approve:v=>bots.approve(v)});
 const one=bots.create({name:'Worker',provider:'codex',model:'fixture',policy:'bypass',workspace:directory}).bot,two=bots.create({name:'Helper',provider:'codex',model:'fixture',policy:'bypass',workspace:directory}).bot;
 const team=bots.team.create({name:'Fixture team',memberIds:[one.id,two.id],coordinatorId:one.id,enabled:true}).team;
 const first=bots.team.start(team.id,{message:'Prepare the fixture; keep all release holds.',requestId:'fixture_start'});
 await until(()=>!['queued','running'].includes(bots.team.detail(team.id,first.run.id).run.state));
 let row=bots.team.activity().activity.find(v=>v.work);assert.ok(row,'Execution root has a distinct discoverable task');assert.equal(row.work.status,'ready_for_review');
 bots.team.reviewJob(team.id,row.id,{expectedRevision:row.work.revision,decision:'reject',note:'Check the remaining fixture detail.'});
 const plan=bots.team.recoveryPlan(team.id,row.id).plan;assert.equal(plan.canResume,true,plan.blockedReason);assert.equal(prompts.length,1,'Preview starts no model');
 const body={planId:plan.id,expectedRevision:plan.expectedRevision,idempotencyKey:'fixture_recovery'};
 const recovered=bots.team.resumeJob(team.id,row.id,body);assert.notEqual(recovered.activity.chatId,row.chatId);
 assert.equal(bots.team.resumeJob(team.id,row.id,body).activity.id,recovered.activity.id);
 await until(()=>!['queued','running'].includes(bots.team.detail(team.id,recovered.run.id).run.state));
 assert.equal(prompts.length,2);assert.equal(prompts[1].checkpoint,null);assert.notEqual(prompts[1].message,prompts[0].message);assert.match(prompts[1].message,/keep all release holds/);assert.match(prompts[1].message,/inspect|Inspect/);
 row=bots.team.activity().activity.find(v=>v.id===recovered.activity.id);assert.equal(row.work.status,'ready_for_review');
 const accepted=bots.team.reviewJob(team.id,row.id,{expectedRevision:row.work.revision,decision:'accept'});assert.equal(accepted.activity.work.status,'verified');assert.equal(bots.team.recoveryPlan(team.id,row.id).plan.canResume,false);assert.equal(prompts.length,2);
});
