import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../bridge.mjs';
import { botWorkspaceRequest, publicBotWorkspace } from '../bots-workspace.mjs';
const action = {id:'ba_'+'a'.repeat(64),chatId:'s_fixture',toolName:'run_command',state:'uncertain',revision:2,proof:'b'.repeat(64),origin:'local',readOnly:false,startedAt:'2026-10-22T00:00:00Z',updatedAt:'2026-10-22T00:01:00Z'};
const snapshot = {available:true,actions:[{...action,args:'PRIVATE',result:'PRIVATE',apiKey:'PRIVATE'}],counts:{uncertain:1},hasMore:false};
const proof = {expectedRevision:action.revision,expectedProof:action.proof,decision:'acknowledge'};
function request(bridge,path,{token,method='GET',body}={}) {
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:'127.0.0.1',port:bridge.port,path,method,agent:false,rejectUnauthorized:false,headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(body===undefined?{}:{'content-type':'application/json'})}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(text),text}));
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
test('action routes accept only exact receipt review; no execution or recovery mutation surface',()=>{
  assert.equal(botWorkspaceRequest('/api/bots/harness/actions','GET').kind,'harnessActions');
  assert.equal(botWorkspaceRequest(`/api/bots/harness/actions/${action.id}/review`,'POST',proof).actionId,action.id);
  for(const method of ['POST','PATCH','DELETE']) assert.throws(()=>botWorkspaceRequest('/api/bots/harness/actions',method,{}));
  for(const path of ['/api/bots/harness/actions?chatId=s_fixture',`/api/bots/harness/actions/${action.id}/review?x=1`]) assert.throws(()=>botWorkspaceRequest(path,'GET'));
  for(const body of [{...proof,retry:true},{...proof,decision:'retry'},{...proof,expectedRevision:0},{...proof,expectedProof:'bad'}]) assert.throws(()=>botWorkspaceRequest(`/api/bots/harness/actions/${action.id}/review`,'POST',body));
  assert.throws(()=>botWorkspaceRequest('/api/bots/harness/actions','GET',{}));
});
test('receipt and timing projections strip private data and reject deceptive acknowledgements',()=>{
  const projected=publicBotWorkspace(snapshot,{kind:'harnessActions'});
  assert.equal(JSON.stringify(projected).includes('PRIVATE'),false);assert.equal(projected.actions[0].readOnly,false);
  assert.equal(publicBotWorkspace({...snapshot,actions:[{...action,origin:'ssh-worker',readOnly:false}]},{kind:'harnessActions'}).actions[0].readOnly,true);
  const ack={acknowledged:true,action:{...action,state:'reviewed',revision:action.revision+1,proof:'c'.repeat(64)},resumed:false,retried:false};
  assert.equal(publicBotWorkspace(ack,{kind:'harnessReview',actionId:action.id}).acknowledged,true);
  for(const patch of [{resumed:true},{retried:true},{action:{...ack.action,id:'ba_'+'c'.repeat(64)}},{action:{...ack.action,origin:'ssh-worker'}}]) assert.throws(()=>publicBotWorkspace({...ack,...patch},{kind:'harnessReview',actionId:action.id}));
  const harness={phase:'model',elapsedMs:2000,firstOutputMs:1000,timings:{startingMs:100,modelMs:1900,approvalMs:0,toolMs:0,cleanupMs:0,private:'PRIVATE'},toolCalls:2,toolErrors:0,contextCompactions:1,secret:'PRIVATE'};
  const source={supported:true,sessions:[{id:'s_fixture',botId:'bot_fixture',name:'Bot',title:'Work',state:'thinking',approvalCount:0,harness}],counts:{},hasMore:false};
  const result=publicBotWorkspace(source,{kind:'supervision'}); assert.equal(result.sessions[0].harness.elapsedMs,2000);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  source.sessions[0].harness.phase='future';assert.equal(publicBotWorkspace(source,{kind:'supervision'}).sessions[0].harness,undefined);
});
test('paired TLS receipts require current pairing, stale proofs cannot write, ack cannot execute or resume',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'strata-harness-bridge-')),calls=[];
  let legacy=false, revoked=false, pair;
  const bridge=await createBridge({directory,listen:'127.0.0.1',port:0,adminPort:0,advertiseHost:'127.0.0.1',qr:false,host:{async json(path,options){
    calls.push({path,...options});
    if(legacy)throw Object.assign(new Error('PRIVATE'),{status:404});
    if(options?.method==='POST') return {acknowledged:true,action:{...action,state:'reviewed',revision:action.revision+1,proof:'c'.repeat(64)},resumed:false,retried:false};
    if(revoked)bridge.authority.revoke(pair.session.id);
    return snapshot;
  }}});
  t.after(async()=>{await bridge.close();rmSync(directory,{recursive:true,force:true});});
  pair=bridge.authority.pair(bridge.authority.code,'Harness test'); const token=pair.token;
  assert.equal((await request(bridge,'/v1/bots/harness/actions')).status,401);assert.equal(calls.length,0);
  const get=await request(bridge,'/v1/bots/harness/actions',{token});assert.equal(get.status,200);assert.equal(get.text.includes('PRIVATE'),false);
  const path=`/v1/bots/harness/actions/${action.id}/review`;
  assert.equal((await request(bridge,path,{token,method:'POST',body:{...proof,expectedRevision:1}})).status,409);assert.equal(calls.filter(c=>c.method==='POST').length,0);
  assert.equal((await request(bridge,path,{token,method:'POST',body:proof})).status,200);assert.equal(calls.filter(c=>c.method==='POST').length,1);
  legacy=true;assert.equal((await request(bridge,'/v1/bots/harness/actions',{token})).json.available,false);legacy=false;
  revoked=true;assert.equal((await request(bridge,path,{token,method:'POST',body:proof})).status,401);assert.equal(calls.filter(c=>c.method==='POST').length,1);
});
