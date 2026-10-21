/** Disposable profile/policy fixtures. No model, SSH, browser or VM is contacted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createBotRoutes, createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotTools } from '../server/bots-tools.mjs';

const wait = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(predicate) { for (let n = 0; n < 500; n++) { if (predicate()) return; await wait(); } assert.fail('Fixture did not settle'); }
function fixture(t, script) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-profile-'));
  const providers = ['claude','codex','grok','kimi','ollama','devin'].map(id => ({ id, name:id, available:true }));
  const connections = [
    { id:'maya', name:'Maya separate', baseUrl:'https://maya.invalid/v1', protocol:'openai-chat', apiKey:'private-maya-key', models:[{ id:'same',name:'Maya' }] },
    { id:'strata', name:'Other Strata', baseUrl:'https://strata.invalid/v1', protocol:'openai-chat', apiKey:'private-strata-key', models:[{ id:'same',name:'Strata' }], modelManagement:{ transport:'ssh',host:'ssh-alias',user:'saved-user',port:2222 } },
  ];
  const calls = { run:[], probe:0,prepare:0,cua:0 };
  let chats, at = '2026-10-20T12:00:00.000Z';
  const runtime = { providers:async()=>structuredClone(providers),run:async input => { calls.run.push(input); await script?.(input); }, close(){} };
  const modelProviders = { list:()=>({connections:structuredClone(connections)}),resolve({connectionId,modelId}){ const connection = connections.find(c=>c.id===connectionId), model = connection?.models.find(m=>m.id===modelId); if(!model) throw Error('removed'); return {connection,model}; } };
  const remoteSSH = { probe:async()=>{calls.probe++;return {available:true,prepared:true,activeRuns:0,providers};}, prepare:async()=>{calls.prepare++;}, cua:async()=>{calls.cua++;} };
  const tools = createBotTools({directory});
  const bots = createBots({ directory,runtime,tools,modelProviders,remoteSSH,conversations:()=>chats,defaultWorkspace:()=>directory,now:()=>at });
  chats = createConversations({directory,enabled:()=>bots.hasProfiles(),validateSelection:s=>bots.validateSelection(s),pending:id=>bots.pending(id),stop:id=>bots.stop(id),approve:r=>bots.approve(r),execute:c=>bots.run(c)});
  t.after(async()=>{await bots.close();chats.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,bots,chats,calls,connections,providers,runtime,setTime:value=>{at=value;}, draft:more=>({name:'Fixture bot',provider:'codex',computerId:'local',workspace:directory,...more})};
}
test('saved-ID public profiles resolve exact model/computer identities without starting anything or changing Maya',async t=>{
  const f=fixture(t), before=structuredClone(f.connections), inventory=await f.bots.list();
  assert.equal(inventory.lifecycleSupported,true);assert.equal(inventory.defaultWorkspace,f.directory);
  const remote=inventory.computers.find(c=>c.kind==='ssh'), model=inventory.models.find(m=>m.connectionId==='strata');
  const idle = await f.bots.saveProfile(f.draft({computerId:remote.id,workspace:'/srv/project'}));
  assert.equal(idle.bots[0].available,false);
  await f.bots.checkComputer({computerId:remote.id});
  const created=await f.bots.saveProfile(f.draft({provider:'configured',computerId:remote.id,modelId:model.id,workspace:'/srv/project'}));
  assert.equal(created.bot.policy,'manual');assert.equal(created.bot.execution.host,'ssh-alias');
  assert.equal(created.bot.modelSource.connectionId,'strata');assert.equal(created.bot.computerId,remote.id);
  assert.equal(created.bots.length,2);assert.equal(f.chats.list().conversations.length,0);assert.equal(f.calls.run.length,0);assert.equal(f.calls.prepare,0);assert.equal(f.calls.cua,0);
  assert.deepEqual(f.connections,before);
  const saved=readFileSync(join(f.directory,'bots.json'),'utf8');assert.ok(!saved.includes('private-maya-key'));assert.ok(!saved.includes('private-strata-key'));
});
test('profile drafts reject arbitrary credentials/SSH, invalid fields and removed or mismatched inventory',async t=>{
  const f=fixture(t), model=(await f.bots.list()).models[0];
  for(const patch of [{execution:{kind:'ssh',host:'untrusted'}},{providerSettings:{apiKey:'x'}},{modelSource:{connectionId:'maya',model:'same'}},{unexpected:true},{policy:null},{workspace:'../relative'},{computerId:'removed'},{modelId:model.id},{provider:'configured',modelId:'missing'},{provider:'configured',modelId:model.id,model:'different'},{provider:'configured',modelId:model.id,effort:'high'},{computerMode:'cua',workspace:'/tmp'}]) await assert.rejects(f.bots.saveProfile(f.draft(patch)));
  f.providers.find(p=>p.id==='claude').available=false;
  const signedOut=await f.bots.saveProfile(f.draft({provider:'claude'}));
  assert.equal(signedOut.bots[0].available,false);
  assert.equal((await f.bots.list()).bots.length,1);assert.equal(f.calls.run.length,0);
});
test('profile edits compare updatedAt after awaited reads, preserve fields, and never silently overwrite concurrent Mac edits',async t=>{
  const f=fixture(t);const first=(await f.bots.saveProfile(f.draft({instructions:'Original'}))).bot;
  const edited=await f.bots.saveProfile({name:'Renamed',policy:'bypass',expectedUpdatedAt:first.updatedAt},first.id);
  assert.equal(edited.bot.instructions,'Original');assert.equal(edited.bot.policy,'bypass');assert.notEqual(edited.bot.updatedAt,first.updatedAt);
  await assert.rejects(f.bots.saveProfile({name:'Stale',expectedUpdatedAt:first.updatedAt},first.id),{status:409});
  // Hold inventory discovery, then simulate another normal Mac profile write.
  const original=f.runtime.providers;let entered,resume;const ready=new Promise(r=>{entered=r;}),hold=new Promise(r=>{resume=r;});
  f.runtime.providers=async()=>{entered();await hold;return original();};
  const pending=f.bots.saveProfile({instructions:'Stale phone draft',expectedUpdatedAt:edited.bot.updatedAt},first.id);
  await ready;f.bots.update(first.id,{name:'Concurrent Mac edit'});resume();
  await assert.rejects(pending,{status:409});f.runtime.providers=original;
  assert.equal((await f.bots.list()).bots[0].name,'Concurrent Mac edit');assert.equal((await f.bots.list()).bots[0].instructions,'Original');
});
test('Ask pending approvals cannot be changed by profile editing; Bypass is explicit only for a new frozen chat',async t=>{
  let executed=0;
  const f=fixture(t,async c=>{if(await c.requestPermission({id:'approval',name:'fixture mutation'}))executed++;});
  const bot=(await f.bots.saveProfile(f.draft())).bot,chat=f.bots.createConversation(bot.id).conversation;
  f.chats.send(chat.id,'fixture');await until(()=>f.bots.pending(chat.id).length===1);
  await assert.rejects(f.bots.saveProfile({policy:'bypass',expectedUpdatedAt:bot.updatedAt},bot.id),{status:409});
  assert.equal(f.bots.pending(chat.id).length,1);assert.equal(executed,0);
  await f.chats.approval(chat.id,'approval','deny');await until(()=>!f.chats.detail(chat.id).conversation.active);
  await f.bots.saveProfile({policy:'bypass',expectedUpdatedAt:bot.updatedAt},bot.id);
  f.chats.send(chat.id,'original remains Ask');await until(()=>f.bots.pending(chat.id).length===1);assert.equal(executed,0);await f.chats.stop(chat.id);
  const next=f.bots.createConversation(bot.id,{policy:'bypass'}).conversation;assert.equal(next.preferences.mode,'bypass');f.chats.send(next.id,'bypass fixture');await until(()=>!f.chats.detail(next.id).conversation.active);assert.equal(executed,1);
  const manual=f.bots.createConversation(bot.id,{policy:'manual'}).conversation;assert.equal(manual.preferences.mode,'manual');
  assert.equal((await f.bots.list()).bots[0].policy,'bypass');
  for(const policy of ['auto',null,true])assert.throws(()=>f.bots.createConversation(bot.id,{policy}),{status:400});
});
test('all six providers and configured models receive frozen Ask/Plan/Bypass for local and saved SSH execution',async t=>{
  const observed=[];
  const f=fixture(t,async c=>{observed.push({provider:c.bot.provider,kind:c.bot.execution.kind,policy:c.bot.policy,allowed:await c.requestPermission({id:'probe',name:'fixture action'})});});
  const catalog=await f.bots.list(),remote=catalog.computers.find(c=>c.kind==='ssh'),model=catalog.models.find(m=>m.connectionId==='strata');await f.bots.checkComputer({computerId:remote.id});
  for(const provider of ['claude','codex','grok','kimi','ollama','devin','configured'])for(const computerId of ['local',remote.id]){
    const bot=(await f.bots.saveProfile(f.draft({provider,computerId,workspace:computerId==='local'?f.directory:'/srv/project',...(provider==='configured'?{modelId:model.id}:{})}))).bot;
    for(const policy of ['plan','bypass']){const chat=f.bots.createConversation(bot.id,{policy}).conversation;f.chats.send(chat.id,'fixture');await until(()=>!f.chats.detail(chat.id).conversation.active);}
  }
  assert.equal(observed.length,28);for(const row of observed)assert.equal(row.allowed,row.policy==='bypass');
  assert.equal(f.connections[0].name,'Maya separate');assert.equal(f.calls.prepare,0);assert.equal(f.calls.cua,0);
});
test('local host profile routes create and CAS-edit the same profile and reject foreign origins',async t=>{
  const f=fixture(t);let port;const routes=createBotRoutes({bots:f.bots,port:()=>port});
  const server=http.createServer((req,res)=>routes(req,res,new URL(req.url,`http://${req.headers.host}`)));await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const origin=`http://127.0.0.1:${port}`, send=(path,body,headers={})=>fetch(origin+path,{method:path==='/api/bots/profile'?'POST':'PATCH',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await send('/api/bots/profile',f.draft(),{origin:'https://untrusted.invalid'})).status,403);
  const response=await send('/api/bots/profile',f.draft());assert.equal(response.status,201);const created=await response.json();assert.equal(created.lifecycleSupported,true);
  const path=`/api/bots/${created.bot.id}/profile`;const saved=await send(path,{policy:'bypass',expectedUpdatedAt:created.bot.updatedAt});assert.equal(saved.status,200);assert.equal((await saved.json()).bot.policy,'bypass');
  assert.equal((await send(path,{policy:'manual',expectedUpdatedAt:created.bot.updatedAt})).status,409);assert.equal(f.calls.run.length,0);assert.equal(f.chats.list().conversations.length,0);
});
