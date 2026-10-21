/** Real pinned-TLS companion to inert host, temporary owner state only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots, createBotRoutes } from '../../host/server/bots.mjs';
import { createConversations } from '../../host/server/conversations.mjs';
import { createBridge, HostClient } from '../bridge.mjs';
import { botWorkspaceRequest, publicBotWorkspace } from '../bots-workspace.mjs';

const baseTeam={id:'team_fixture',name:'Fixture',memberIds:['bot_one','bot_two'],coordinatorId:'bot_one',enabled:true,revision:4,execution:{mode:'shared',computerId:'host:local',workspace:'/fixture/folder',secret:'PRIVATE_SETTING'}};
test('paired settings admission and projections preserve typed target/revision without raw target or provider data',()=>{
 const path='/api/bots/teams/team_fixture', good={expectedRevision:4,execution:{mode:'shared',computerId:'host:local',workspace:'/fixture/project'}};
 assert.equal(botWorkspaceRequest(path,'PATCH',good).kind,'team');
 for(const body of [{...good,expectedRevision:0},{...good,expectedRevision:1.5},{execution:{mode:'shared',computerId:'root@owner',workspace:'/work'}},{execution:{mode:'shared',computerId:'host:local',workspace:'/work',execution:{kind:'ssh'}}},{execution:{mode:'individual',workspace:'/work'}},{computerOwnerId:'bot_one'}]) assert.throws(()=>botWorkspaceRequest(path,'PATCH',body),{status:403});
 const raw={teams:[baseTeam],runs:[],teamSettingsSupported:true,teamComputers:[{id:'host:local',name:'This Mac',label:'Direct Mac',computerMode:'host',workspace:'/fixture',available:true,execution:{secret:'PRIVATE_SSH_KEY'}},{id:'cua:bot_1111-1111',memberId:'bot_1111-1111',name:'Test’s computer',label:'Isolated CUA',computerMode:'cua',workspace:'/workspace',available:true,providerSettings:{apiKey:'PRIVATE_API'}},{id:'root@host',name:'PRIVATE_RAW',computerMode:'host',workspace:'/work',available:true}]};
 const result=publicBotWorkspace(raw,{kind:'teams'});assert.equal(result.teams[0].revision,4);assert.deepEqual(result.teams[0].execution,good.execution.mode==='shared'?{mode:'shared',computerId:'host:local',workspace:'/fixture/folder'}:null);
 assert.equal(result.teamSettingsSupported,true);assert.equal(result.teamComputers.length,2);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
 assert.equal(publicBotWorkspace({teams:[{...baseTeam,revision:undefined,execution:undefined}],runs:[]},{kind:'teams'}).teamSettingsSupported,undefined);
});

test('paired phone can save roster/shared Mac folder with revision conflict and revoked/unauthenticated mutations fail closed',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'strata-paired-team-settings-')),owner=join(directory,'owner'),pairing=join(directory,'pairing');mkdirSync(owner);let chats,server,bridge,hostReads=0,modelRuns=0,port;
 const bots=createBots({directory:owner,defaultWorkspace:()=>owner,conversations:()=>chats,runtime:{providers:async()=>[],run:async()=>{modelRuns++;assert.fail('Settings do not run a model');},close(){}},tools:{definitions:()=>[],close(){}}});
 chats=createConversations({directory:owner,enabled:()=>true});
 const make=name=>bots.create({name,provider:'codex',workspace:owner,computerMode:'host'}).bot;
 const a=make('Coordinator'),b=make('Builder'),c=make('Reviewer'),team=bots.team.create({name:'Preserved team',memberIds:[a.id,b.id],coordinatorId:a.id}).team;
 const routes=createBotRoutes({bots,port:()=>port});server=http.createServer((req,res)=>{hostReads++;void routes(req,res,new URL(req.url,`http://${req.headers.host}`));});await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
 bridge=await createBridge({directory:pairing,host:new HostClient({upstream:`http://127.0.0.1:${port}`}),listen:'127.0.0.1',advertiseHost:'127.0.0.1',port:0,adminPort:0,qr:false});
 t.after(async()=>{await bridge.close();server.closeAllConnections();await new Promise(r=>server.close(r));await bots.close();chats.close();rmSync(directory,{recursive:true,force:true});});
 const ca=readFileSync(join(pairing,'server-cert.pem'));
 const request=(path,method='GET',body,token)=>new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',port:bridge.port,path,method,ca,agent:false,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:`Bearer ${token}`}:{})}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(raw),raw}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
 const endpoint=`/v1/bots/teams/${team.id}`,body={expectedRevision:1,memberIds:[a.id,b.id,c.id],coordinatorId:c.id,execution:{mode:'shared',computerId:'host:local',workspace:owner}};
 assert.equal((await request(endpoint,'PATCH',body)).status,401);assert.equal(hostReads,0);
 const paired=bridge.authority.pair(bridge.authority.code,'Settings fixture');const token=paired.token;
 const catalog=await request('/v1/bots/teams','GET',undefined,token);assert.equal(catalog.json.teamSettingsSupported,true);assert.ok(catalog.json.teamComputers.some(row=>row.id==='host:local'));
 const saved=await request(endpoint,'PATCH',body,token);assert.equal(saved.status,200);assert.equal(saved.json.team.revision,2);assert.deepEqual(saved.json.team.memberIds,[a.id,b.id,c.id]);assert.deepEqual(saved.json.team.execution,body.execution);
 const stale=await request(endpoint,'PATCH',{...body,name:'stale'},token);assert.equal(stale.status,409);assert.equal(bots.team.list().teams[0].name,'Preserved team');
 bridge.authority.revoke(paired.session.id);
 assert.equal((await request(endpoint,'PATCH',{expectedRevision:2,name:'revoked'},token)).status,401);assert.equal(modelRuns,0);assert.equal(bots.team.list().teams[0].revision,2);
});
