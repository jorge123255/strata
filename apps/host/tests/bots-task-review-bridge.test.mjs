import test from 'node:test';
import assert from 'node:assert/strict';
import {botWorkspaceRequest,publicBotWorkspace} from '../../companion-bridge/bots-workspace.mjs';
import {botWorkAuthorityFingerprint as hash} from '../server/bots-work-authority.mjs';
const teamId='team_abcdef',jobId='tj_abcdef',path=`/api/bots/teams/${teamId}/jobs/${jobId}`;
const at='2026-10-21T00:00:00Z';
const evidence=[{kind:'test',label:'Fixture checks',detail:'3 passed; no live provider contacted.'}];
const work={status:'ready_for_review',revision:2,summary:'Fixture complete',evidence,resultHistory:[{id:'result_one',summary:'Fixture complete',evidence,submittedAt:at,botId:'bot_abcdef'}],reviewHistory:[]};
const row={id:jobId,teamId,runId:'tr_abcdef',type:'delivery',title:'Fixture',state:'completed',createdAt:at,updatedAt:at,work};
test('paired task reads and review/resume writes accept only their exact methods and revisioned fields',()=>{
 assert.equal(botWorkspaceRequest(path+'/recovery','GET').action,'recovery');
 assert.equal(botWorkspaceRequest(path+'/review','POST',{expectedRevision:2,decision:'accept'}).jobId,jobId);
 assert.equal(botWorkspaceRequest(path+'/resume','POST',{planId:'trecovery_one',expectedRevision:2,idempotencyKey:'request_one'}).action,'resume');
 for(const [suffix,method,body] of [['recovery','POST',{}],['review','GET'],['resume','GET'],['review','POST',{expectedRevision:2,decision:'accept',actor:'bot'}],['review','POST',{decision:'accept'}],['resume','POST',{planId:'one',expectedRevision:2,idempotencyKey:'one',model:'other'}]]) assert.throws(()=>botWorkspaceRequest(path+'/'+suffix,method,body));
 assert.throws(()=>botWorkspaceRequest(path+'/recovery?start=true','GET'));
});
test('paired result projection retains exact evidence and strips unknown private fields',()=>{
 const got=publicBotWorkspace({teamWorkReviewSupported:true,activity:[{...row,privateKey:'PRIVATE',work:{...work,privateNativeSession:'PRIVATE'}}]},{kind:'activity'});
 assert.deepEqual(got.activity[0].work,work);assert.equal(got.teamWorkReviewSupported,true);assert.ok(!JSON.stringify(got).includes('PRIVATE'));
 assert.equal(publicBotWorkspace({teamWorkReviewSupported:'true',activity:[]},{kind:'activity'}).teamWorkReviewSupported,undefined);
 assert.throws(()=>publicBotWorkspace({activity:[{...row,work:{...work,status:'verified'}}]},{kind:'activity'}),/unverified/);
 assert.throws(()=>publicBotWorkspace({activity:[{...row,work:{...work,evidence:[{...evidence[0],detail:'x'.repeat(4001)}]}}]},{kind:'activity'}),/unreadable/);
});
test('history provenance is explicit, literal and cannot conceal submitted evidence or verification',()=>{
 const historical={status:'blocked',revision:1,summary:'Earlier untracked task',legacy:true,evidence:[],resultHistory:[],reviewHistory:[]};
 const project=value=>publicBotWorkspace({activity:[{...row,work:value}]},{kind:'activity'}).activity[0].work;
 assert.deepEqual(project(historical),historical);
 assert.equal(project({...historical,legacy:false}).legacy,false);
 const {legacy,...unknown}=historical;assert.equal(project(unknown).legacy,undefined);
 for(const value of ['true',1,null,{}]) assert.throws(()=>project({...historical,legacy:value}),/inconsistent/);
 assert.throws(()=>project({...work,legacy:true}),/inconsistent/);
 for(const patch of [{sourceJobId:'tj_source'},{recoveryJobId:'tj_next'},{evidence}]) assert.throws(()=>project({...historical,...patch}),/inconsistent/);
});
test('public legacy markers are derived without rewriting stored tasks or inventing recovery authority',async()=>{
 const {initialWork,publicWork}=await import('../server/bots-team-work.mjs');
 const old={state:'completed'};assert.equal(publicWork(old).legacy,true);assert.deepEqual(old,{state:'completed'});
 const modern={state:'completed',work:{...initialWork(),status:'blocked',legacy:true}};
 const before=structuredClone(modern);assert.equal(publicWork(modern).legacy,undefined);assert.deepEqual(modern,before);
 assert.equal(publicWork({state:'running'}).status,'working');
 assert.equal(publicWork({state:'interrupted'}).status,'interrupted');
});
test('paired owner actions cannot return a different source task or resume an unrelated continuation',()=>{
 const route={kind:'task',action:'review',teamId,jobId};
 assert.equal(publicBotWorkspace({activity:row},route).activity.id,jobId);
 assert.throws(()=>publicBotWorkspace({activity:{...row,id:'tj_other'}},route),/unrelated/);
 assert.throws(()=>publicBotWorkspace({activity:{...row,teamId:'team_other'}},route),/unrelated/);
 const resume={...route,action:'resume'},run={id:'tr_new',teamId,state:'queued',limits:{maxParallel:0,maxDepth:0,maxHops:0,maxTurns:0,maxDurationMs:0},createdAt:at,updatedAt:at};
 const next={...row,id:'tj_new',runId:run.id,work:{...work,sourceJobId:jobId}};
 assert.equal(publicBotWorkspace({activity:next,run},resume).activity.work.sourceJobId,jobId);
 assert.throws(()=>publicBotWorkspace({activity:row,run},resume),/unrelated/);
});
test('recovery fingerprint permits new run identity only while binding original model, folder and tool authority',()=>{
 const original={id:'bot_one',provider:'configured',model:'model_one',workspace:'/fixture',policy:'manual',extensionSnapshots:{mcp:{revision:'old_run_digest',assignments:{connections:[{id:'mcp_one',revision:'fixed',authRevision:'auth_one',teamId:'team_one',teamRunId:'tr_old',toolIds:['read'],readOnlyToolIds:['read']}]}}}};
 const next=structuredClone(original);next.extensionSnapshots.mcp.revision='new_run_digest';next.extensionSnapshots.mcp.assignments.connections[0].teamRunId='tr_new';assert.equal(hash(original),hash(next));
 for(const patch of [{model:'other'},{workspace:'/different'},{policy:'bypass'}])assert.notEqual(hash(original),hash({...next,...patch}));
 next.extensionSnapshots.mcp.assignments.connections[0].toolIds.push('write');assert.notEqual(hash(original),hash(next));
 assert.ok(!hash(original).includes('/fixture'));
});
