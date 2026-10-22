import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamPlans } from '../../host/server/bots-team-plans.mjs';
import { teamPlanRoute, teamPlanRequest, publicTeamPlan, publicTeamPlanResponse } from '../bots-team-plans.mjs';
import { botWorkspaceRequest, publicBotWorkspace, handleBotWorkspace } from '../bots-workspace.mjs';

const teamId='team_01234567-0123-4123-8123-0123456789ab';
function fixture(){
  let saved;const deliveries=[];const team={id:teamId,revision:1,enabled:true,coordinatorId:'bot_coordinator',memberIds:['bot_coordinator','bot_builder','bot_reviewer']};
  const c=createTeamPlans({directory:'/unused',teamFor:()=>team,store:{read:()=>saved,save:value=>{saved=structuredClone(value);},assertOwner(){},close(){}},prepare:()=>({authorities:Object.fromEntries(team.memberIds.map(id=>[id,'a'.repeat(64)])),resourceKeys:Object.fromEntries(team.memberIds.map(id=>[id,`local:/fixture/${id}`]))}),ensure(){},dispatch:(row,attempt)=>{const d={...attempt,chatId:`s_fixture_${deliveries.length}`,jobId:`tj_fixture_${deliveries.length}`};deliveries.push(d);return d;},stopRun:async()=>{}});
  const p=c.create(teamId,{requestId:'fixture',goal:'Make the bounded change; no release or production actions.'}).plan;
  return {c,p,team,deliveries,saved:()=>saved};
}
function populated(){
  const f=fixture();f.c.pump();const a=f.deliveries[0];f.c.beforeStart(f.p.id,a.id,a.chatId);
  f.c.submission('submit_team_plan',{summary:'One builder and an independent reviewer.',participation:f.team.memberIds.map(botId=>({botId,role:botId,reason:'Concrete role for this requested task.'})),tasks:[{key:'build',title:'Build the bounded change',instructions:'Preserve all owner holds.',kind:'work',ownerId:'bot_builder',dependsOn:[],criteria:['The bounded change is implemented.']},{key:'review',title:'Independent review',instructions:'Inspect the actual implementation and checks.',kind:'review',ownerId:'bot_reviewer',dependsOn:['build'],criteria:['The requested behavior passes an independent check.']}]},{...f.c.binding(f.p.id,a.id),chatId:a.chatId,botId:a.botId,assertLive(){}});
  f.c.finish(f.p.id,a.id,{});return {...f,p:f.c.detail(teamId,f.p.id).plan};
}
test('paired projection consumes real controller rows and strips private execution/receipt fields',()=>{
  const f=populated(),safe=publicTeamPlan({...f.p,authorities:{secret:'never'},resourceKeys:{private:'never'},token:'never'},teamId);
  assert.equal(safe.tasks.length,2);assert.equal(safe.counts.pending,2);assert.equal(safe.goal,f.p.goal);assert.equal('authorities'in safe,false);assert.equal(JSON.stringify(safe).includes('never'),false);
  assert.deepEqual(publicBotWorkspace({plan:f.p},{kind:'teamPlan',teamId,planId:f.p.id}),{plan:safe});
  const list=publicTeamPlanResponse(f.c.list(teamId),{kind:'teamPlan',teamId});assert.equal(list.plans[0].id,f.p.id);assert.equal(list.hasMore,false);
});
test('plan reads and proof actions have narrow methods, pages and request bodies',()=>{
  const f=fixture(),base=`/api/bots/teams/${teamId}/plans`;
  assert.equal(botWorkspaceRequest(`${base}/${f.p.id}?taskOffset=64`,'GET').taskOffset,64);
  assert.equal(botWorkspaceRequest(`${base}?beforePlanId=${f.p.id}`,'GET').beforePlanId,f.p.id);
  for(const path of [`${base}?x=1`,`${base}/${f.p.id}?taskOffset=-1`,`${base}/${f.p.id}?taskOffset=1&taskOffset=2`,`${base}/${f.p.id}/stop?x=1`])assert.throws(()=>teamPlanRoute(path));
  assert.throws(()=>teamPlanRequest(teamPlanRoute(base),'POST',{}));
  const stop=teamPlanRoute(`${base}/${f.p.id}/stop`),selection={expectedRevision:f.p.revision,expectedProof:f.p.proof};
  assert.equal(teamPlanRequest(stop,'POST',selection).kind,'teamPlan');
  for(const body of [{...selection,force:true},{...selection,expectedProof:'bad'}])assert.throws(()=>teamPlanRequest(stop,'POST',body));
  const resume=teamPlanRoute(`${base}/${f.p.id}/resume`);assert.throws(()=>teamPlanRequest(resume,'POST',{...selection,requestId:'r'}));
  assert.equal(teamPlanRequest(resume,'POST',{...selection,requestId:'r',inspected:true,note:'n'.repeat(4000)}).action,'resume');
});
test('a foreign owner, invented count, missing page or unsupported completed review is rejected',()=>{
  const f=populated();const mutate=fn=>{const p=structuredClone(f.p);fn(p);assert.throws(()=>publicTeamPlan(p,teamId),{status:502});};
  mutate(p=>p.tasks[0].ownerId='foreign');mutate(p=>p.counts.pending++);mutate(p=>p.tasks[0].criteria=[]);mutate(p=>{p.totalTasks++;p.counts.pending++;p.tasksTruncated=true;p.nextTaskOffset=null;});
  mutate(p=>{p.tasks[1].state='ready_for_review';p.counts.pending--;p.counts.ready_for_review++;});
  mutate(p=>p.teamId='team_foreign');mutate(p=>p.proof='bad');
});
test('durable intake is explicit Work only, with capability preserved and no promotion of Chat',()=>{
  const path=`/api/bots/teams/${teamId}/messages`;
  for(const body of [{message:'a',requestId:'a',durablePlan:true},{message:'a',requestId:'a',workMode:'chat',durablePlan:true},{message:'a',requestId:'a',workMode:'work',durablePlan:false}])assert.throws(()=>botWorkspaceRequest(path,'POST',body,400));
  assert.equal(botWorkspaceRequest(path,'POST',{message:'a',requestId:'a',workMode:'work',durablePlan:true},400).kind,'channelMessage');
  assert.equal(publicBotWorkspace({teams:[],runs:[],teamWorkPlansSupported:true},{kind:'teams'}).teamWorkPlansSupported,true);
});
test('paired Stop checks current proof once and revocation prevents the write',async()=>{
  for(const revoked of [false,true]){
    const f=fixture(),calls=[],body={expectedRevision:f.p.revision,expectedProof:f.p.proof};let checks=0,result;
    const host={json:async(path,options)=>{calls.push([path,options]);if(path==='/api/bots/teams')return{teamWorkPlansSupported:true,teams:[f.team]};if(path.endsWith('/stop'))return f.c.stop(teamId,f.p.id,body);return f.c.detail(teamId,f.p.id);}};
    const run=()=>handleBotWorkspace({path:`/v1/bots/teams/${teamId}/plans/${f.p.id}/stop`,method:'POST',req:{headers:{}},res:{},session:{id:'fixture-device'},host,readBody:async()=>body,sendJSON:(_,status,value)=>{result=value;},requireCurrentSession(){if(revoked&&++checks>=3)throw Error('revoked');}});
    if(revoked){await assert.rejects(run,/revoked/);assert.equal(calls.some(([,options])=>options?.method==='POST'),false);}
    else{await run();assert.equal(result.plan.phase,'stopped');assert.equal(calls.filter(([,options])=>options?.method==='POST').length,1);}
  }
});
