/** Inert core projection fixture: no models, tools, accounts, owner files or API calls. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createTeamPlans} from '../server/bots-team-plans.mjs';
const teamId='team_00000000-0000-4000-8000-000000000001';
const memberIds=Array.from({length:22},(_,i)=>`bot_fixture_${i}`);
const team={id:teamId,revision:1,coordinatorId:memberIds[0],memberIds,enabled:true};
let saved,clock=1700000000000;
const store={read:()=>null,save:value=>{saved=structuredClone(value);},assertOwner(){},close(){}};
const controller=createTeamPlans({directory:'/unused-inert-fixture',store,teamFor:()=>team,prepare:()=>({authorities:Object.fromEntries(memberIds.map(id=>[id,'a'.repeat(64)])),resourceKeys:Object.fromEntries(memberIds.map(id=>[id,`local:/inert/${id}`]))}),ensure(){},dispatch:(_row,attempt)=>({chatId:`s_${attempt.id}`,jobId:`tj_${attempt.id}`}),stopRun(){},now:()=>clock++});
try{
 const plan=controller.create(teamId,{requestId:'inert-projection',goal:'Owner scope remains exact: '+ 'a'.repeat(15970)}).plan;
 controller.pump();const attempt=saved.plans[0].attempts[0];controller.beforeStart(plan.id,attempt.id,attempt.chatId);
 const tasks=Array.from({length:3},(_,i)=>({key:`review_${i}`,title:`Synthetic public projection ${i}`,instructions:String(i).repeat(1500),ownerId:memberIds[i+1],collaboratorIds:[],dependsOn:[],kind:'review',criteria:Array.from({length:i===0?16:1},()=>i===0?'\u0001'.repeat(1000):'Exact criterion preserved.')}));
 controller.submission('submit_team_plan',{summary:'Inert large public page; no execution/verification claim.',tasks,participation:memberIds.map(botId=>({botId,role:'Synthetic fixture role',reason:'\u0002'.repeat(1000)}))},{...controller.binding(plan.id,attempt.id),chatId:attempt.chatId,botId:attempt.botId,assertLive(){}});
 controller.finish(plan.id,attempt.id);
 const front=controller.detail(teamId,plan.id).plan,later=controller.detail(teamId,plan.id,{taskOffset:1}).plan;
 const source=fileURLToPath(new URL('../server/bots-team-plans.mjs',import.meta.url));
 const fixture={provenance:{source:'apps/host/server/bots-team-plans.mjs',sourceSHA256:createHash('sha256').update(readFileSync(source)).digest('hex'),generator:'apps/host/tests/generate-team-plan-preview-fixture.mjs',inert:true,description:'Real core public projections of the same saved checkpoint. A large leading task changes the per-page byte budget and legitimately shrinks overlapping instruction/participation previews.'},front,later};
 const directory=fileURLToPath(new URL('./fixtures/',import.meta.url));mkdirSync(directory,{recursive:true});const path=fileURLToPath(new URL('./fixtures/team-plan-preview-pages.json',import.meta.url));writeFileSync(path,JSON.stringify(fixture,null,2)+'\n');
 const overlap=front.tasks.find(task=>task.id===later.tasks[0].id);
 if(!overlap||overlap.instructions.length===later.tasks[0].instructions.length)throw Error('Fixture did not exercise different actual core excerpt lengths.');
 process.stdout.write(JSON.stringify({path,frontInstruction:overlap.instructions.length,laterInstruction:later.tasks[0].instructions.length,frontReason:front.participation[0].reason.length,laterReason:later.participation[0].reason.length,bytes:Buffer.byteLength(JSON.stringify(fixture)),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})+'\n');
}finally{controller.close();}
