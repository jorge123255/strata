import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('../src/screens/botTeamPlanState.ts',import.meta.url),'utf8');
const {teamPlanCheckpointMatches:matches,validTeamPlan}=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const fixture=JSON.parse(readFileSync(new URL('./fixtures/team-plan-preview-pages.json',import.meta.url),'utf8'));
const copy=v=>structuredClone(v);
test('actual core same-checkpoint escape-heavy pages accept only compatible public previews',()=>{
 assert.equal(fixture.provenance.sourceSHA256,createHash('sha256').update(readFileSync(new URL('../server/bots-team-plans.mjs',import.meta.url))).digest('hex'));
 const {front,later}=fixture;assert.equal(front.proof,later.proof);assert.equal(front.revision,later.revision);assert.equal(validTeamPlan(front,front.teamId),true);assert.equal(validTeamPlan(later,later.teamId),true);
 const overlap=front.tasks.find(t=>t.id===later.tasks[0].id);assert.equal(overlap.instructions.length,500);assert.equal(later.tasks[0].instructions.length,1000);assert.equal(front.participation[0].reason.length,500);assert.equal(later.participation[0].reason.length,1000);
 assert.equal(matches(front,later),true);assert.equal(matches(later,front),true);
});
test('higher-revision instruction clipping retains exact task identity, goal, owners and criteria',()=>{
 const prior=copy(fixture.later),next=copy(fixture.front);next.revision++;next.proof='b'.repeat(64);assert.equal(matches(next,prior),true);
 for(const mutate of [v=>{v.goal+=' changed';},v=>{v.tasks[1].ownerId=v.coordinatorId;},v=>{v.tasks[1].criteria[0].text+=' changed';},v=>{v.tasks[1].id='tpt_00000000-0000-4000-8000-000000000099';},v=>{v.totalTasks--;}]){const changed=copy(next);mutate(changed);assert.equal(matches(changed,prior),false);}
 const arbitrary=copy(next);arbitrary.tasks[1].instructions=prior.tasks[0].instructions.slice(0,77);assert.equal(matches(arbitrary,prior),false);
 const falseFull=copy(next);falseFull.tasks[1].instructionsTruncated=false;assert.equal(matches(falseFull,prior),false);
});
test('same checkpoint still rejects changed state/counts, short summaries and protected bindings',()=>{
 const prior=copy(fixture.later);
 for(const mutate of [v=>{v.counts.pending--;v.counts.running++;},v=>{v.tasks[0].state='running';},v=>{v.tasks[0].summary='Different short report';},v=>{v.tasks[0].chatId='s_foreign';},v=>{v.participation[0].role+=' changed';},v=>{v.attempts[0].state='blocked';},v=>{v.summary+=' changed';}]){const next=copy(prior);mutate(next);assert.equal(matches(next,prior),false);}
});
test('known clipped report previews match but links, criterion identity and pass flags remain exact',()=>{
 const prior=copy(fixture.later),task=prior.tasks[0];task.summary='s'.repeat(1000);task.nextStep='n'.repeat(1000);task.checks=[{criterionId:task.criteria[0].id,passed:true,detail:'c'.repeat(2000)}];task.evidence=[{kind:'file',label:'Exact file',detail:'d'.repeat(1000)},{kind:'link',label:'Exact URL',detail:'https://example.invalid/exact-target'}];prior.attempts[0].summary='a'.repeat(1000);
 const next=copy(prior);next.tasks[0].summary='s'.repeat(500);next.tasks[0].nextStep='n'.repeat(200);next.tasks[0].checks[0].detail='c'.repeat(80);next.tasks[0].evidence[0].detail='d'.repeat(500);next.attempts[0].summary='a'.repeat(200);
 assert.equal(matches(next,prior),true);assert.equal(matches(prior,next),true);
 for(const mutate of [v=>{v.tasks[0].evidence[1].detail='https://example.invalid/exact';},v=>{v.tasks[0].evidence[0].label='Changed file';},v=>{v.tasks[0].checks[0].passed=false;},v=>{v.tasks[0].checks[0].criterionId='tpc_00000000-0000-4000-8000-000000000099';},v=>{v.tasks[0].checks[0].detail='c'.repeat(1000);},v=>{v.tasks[0].summary='s'.repeat(79);}]){const changed=copy(next);mutate(changed);assert.equal(matches(changed,prior),false);}
});
test('minus-one clip boundary is accepted only for an actual split UTF-16 surrogate pair',()=>{
 const prior=copy(fixture.later),next=copy(prior);prior.tasks[0].instructions='x'.repeat(79)+'😀'+'tail';next.tasks[0].instructions='x'.repeat(79);prior.tasks[0].instructionsTruncated=true;next.tasks[0].instructionsTruncated=true;assert.equal(matches(next,prior),true);
 prior.tasks[0].instructions='x'.repeat(79)+'ordinary';assert.equal(matches(next,prior),false);
 prior.tasks[0].instructions='x'.repeat(80)+'tail';next.tasks[0].instructions='x'.repeat(80);next.tasks[0].instructionsTruncated=false;assert.equal(matches(next,prior),false);
});
