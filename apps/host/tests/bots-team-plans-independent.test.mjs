/** Non-author controller probes: inert memory storage and explicit dispatch records. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeamPlans} from '../server/bots-team-plans.mjs';
function fixture(){
 const members=['coordinator','builder','reviewer'],team={id:'team_fixture',revision:1,enabled:true,coordinatorId:members[0],memberIds:members},deliveries=[];let value;
 const store={read:()=>structuredClone(value),save:next=>{value=structuredClone(next);},assertOwner(){},close(){}};
 const plans=createTeamPlans({directory:'/inert',store,teamFor:()=>team,prepare:()=>({authorities:Object.fromEntries(members.map(id=>[id,'a'.repeat(64)])),resourceKeys:{coordinator:'local:/routing',builder:'local:/same',reviewer:'local:/review'}}),ensure(){},dispatch:(row,attempt)=>{const link={chatId:`chat_${deliveries.length}`,jobId:`job_${deliveries.length}`};deliveries.push({planId:row.id,attempt:structuredClone(attempt),...link});return link;},stopRun:async()=>{}});
 const current=id=>plans.detail(team.id,id).plan;
 const start=(id,kind)=>{plans.pump();const row=value.plans.find(row=>row.id===id),attempt=[...row.attempts].reverse().find(attempt=>attempt.kind===kind&&attempt.state==='pending');assert.ok(attempt);plans.beforeStart(id,attempt.id,attempt.chatId);return {attempt,binding:{...plans.binding(id,attempt.id),botId:attempt.botId,chatId:attempt.chatId,assertLive(){},hasVerificationEvidence:()=>true}};};
 const create=requestId=>plans.create(team.id,{requestId,goal:'Same requested bounded change'}).plan;
 const plan=id=>{const a=start(id,'planning');plans.submission('submit_team_plan',{summary:'Scoped work and independent review',participation:members.map(botId=>({botId,role:'Assigned',reason:'Concrete requested work'})),tasks:[{key:'work',title:'Work',instructions:'Do the requested work',ownerId:'builder',dependsOn:[],kind:'work',criteria:['Behavior implemented']},{key:'review',title:'Review',instructions:'Independently check current output',ownerId:'reviewer',dependsOn:['work'],kind:'review',criteria:['Actual behavior observed']}]},a.binding);plans.finish(id,a.attempt.id);};
 return {plans,current,create,plan,start,deliveries,team};
}
test('a useful working continuation yields a contested real workspace to an already waiting different plan',()=>{
 const f=fixture();try{const a=f.create('first'),b=f.create('second');f.plan(a.id);f.plan(b.id);const first=f.start(a.id,'task');f.plans.submission('checkpoint_team_plan_task',{outcome:'working',summary:'One useful chunk complete',progress:'Produced first concrete change',nextStep:'Inspect current state and do the next chunk'},first.binding);f.plans.finish(a.id,first.attempt.id);f.plans.pump();const tasks=f.deliveries.filter(row=>row.attempt.kind==='task');assert.equal(tasks.length,2);assert.equal(tasks[1].planId,b.id,'The earlier plan must not reacquire forever ahead of a waiting plan');}finally{f.plans.close();}
});
test('partial independent review cannot bypass exact criteria or role ownership even with a forged observation field',()=>{
 const f=fixture();try{const a=f.create('roles');f.plan(a.id);const work=f.start(a.id,'task');assert.throws(()=>f.plans.submission('checkpoint_team_plan_task',{outcome:'ready_for_review',summary:'Fake check',verificationObserved:true,evidence:[{kind:'note',label:'Claim',detail:'Claim only'}]},work.binding),/Unsupported/);assert.throws(()=>f.plans.submission('submit_team_plan_summary',{outcome:'ready_for_review',summary:'Skip actual review'},work.binding),/assigned plan role/);assert.equal(f.current(a.id).phase,'running');assert.equal(f.current(a.id).tasks[0].state,'running');}finally{f.plans.close();}
});
