/** Inert providers and temporary folders only; never contact SSH, models or a guest. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBotTeams } from '../server/bots-team.mjs';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotTools } from '../server/bots-tools.mjs';
import { cuaSandboxName } from '../server/bots-cua.mjs';

async function until(predicate) { const at=Date.now(); while (!predicate()) { if(Date.now()-at>4000) throw Error('Timed out'); await new Promise(r=>setTimeout(r,5)); } }
function fixture(t, execute = async()=>{}, options={}) {
 const directory=mkdtempSync(join(tmpdir(),'strata-team-settings-')); let chats;
 const seen=[], effects=[], realTools=createBotTools({directory});
 const bots=createBots({directory,defaultWorkspace:()=>directory,conversations:()=>chats,
  runtime:{providers:async()=>[],run:async input=>{seen.push(input);await execute(input);input.onFrame({type:'done'});},close(){}},
  tools:{definitions:bot=>realTools.definitions(bot),execute:async input=>{effects.push(input);return realTools.execute(input);},finish:id=>realTools.finish(id),close:()=>realTools.close()},
  cuaTools:{state:async()=>({available:true,frame:{width:1,height:1,mimeType:'image/png',data:'fixture'}})},
  remoteSSH:{run:async()=>assert.fail('Never contact SSH'),cua:async()=>({available:true,frame:{width:1,height:1,mimeType:'image/png',data:'fixture'}})},...options});
 chats=createConversations({directory,enabled:()=>true,pending:id=>bots.pending(id),stop:id=>bots.stop(id),approve:input=>bots.approve(input),validateSelection:input=>bots.validateSelection(input),execute:input=>bots.run(input)});
 const make=(name,patch={})=>bots.create({name,provider:'codex',workspace:directory,policy:'bypass',...patch}).bot;
 const a=make('Coordinator',{computerMode:'cua',workspace:'/workspace',model:'coordinator-model'}),b=make('Builder',{computerMode:'cua',workspace:'/workspace',model:'builder-model'}),c=make('Reviewer');
 const team=bots.team.create({name:'Fixture team',memberIds:[a.id,b.id],coordinatorId:a.id,enabled:true}).team;
 t.after(async()=>{await bots.close();chats.close();rmSync(directory,{recursive:true,force:true});});
 return {directory,bots,chats,a,b,c,team,seen,effects,make,done:run=>until(()=>!['queued','running'].includes(bots.team.detail(team.id,run.id).run.state))};
}
const say=(input,text)=>input.onFrame({type:'delta',text});

test('roster edits retain public history and immutable IDs, revision conflicts cannot overwrite another device',async t=>{
 let f; f=fixture(t,async input=>say(input,'Hello from the saved team'));
 assert.deepEqual(f.team.execution,{mode:'individual'});assert.equal(f.team.revision,1);
 const run=f.bots.team.message(f.team.id,{message:'Hello',requestId:'hello'}).run;await f.done(run);
 const before=f.bots.team.channel(f.team.id).messages;
 const updated=f.bots.team.update(f.team.id,{expectedRevision:1,memberIds:[f.a.id,f.c.id],coordinatorId:f.c.id}).team;
 assert.equal(updated.revision,2);assert.equal(updated.id,f.team.id);assert.equal(updated.createdAt,f.team.createdAt);
 assert.deepEqual(f.bots.team.channel(f.team.id).messages,before);
 assert.throws(()=>f.bots.team.update(f.team.id,{expectedRevision:1,name:'Stale overwrite'}),{status:409,code:'team_changed'});
 assert.throws(()=>f.bots.team.update(f.team.id,{expectedRevision:2,memberIds:[f.a.id,f.b.id]}),/coordinator/);
 assert.equal(f.bots.team.list().teams[0].name,'Fixture team');
});

test('shared catalog offers actual Mac and exact member guests without probing or exposing provider secrets',async t=>{
 const f=fixture(t);f.make('SSH guest',{computerMode:'cua',workspace:'/workspace',execution:{kind:'ssh',host:'fixture.invalid',user:'fixture'}});
 const {teamSettingsSupported,teamComputers}=f.bots.team.list();assert.equal(teamSettingsSupported,true);
 assert.ok(teamComputers.some(row=>row.id==='host:local'&&row.computerMode==='host'));
 assert.ok(teamComputers.some(row=>row.id.startsWith('host:ssh_')&&row.available));
 assert.ok(teamComputers.some(row=>row.id===`cua:${f.a.id}`&&row.memberId===f.a.id&&row.computerMode==='cua'));
 assert.ok(!JSON.stringify(teamComputers).includes('providerSettings'));assert.equal(f.seen.length,0);
 assert.throws(()=>f.bots.team.update(f.team.id,{execution:{mode:'shared',computerId:`cua:${f.c.id}`,workspace:'/workspace'}}),/owner in this team/);
 assert.throws(()=>f.bots.team.update(f.team.id,{execution:{mode:'shared',computerId:`cua:${f.a.id}`,workspace:'/Users/owner/botai'}}),/contained subfolder/);
 for(const workspace of ['/workspace/../escape','/workspace//project','/workspace/.','/workspaceX']) assert.throws(()=>f.bots.team.update(f.team.id,{execution:{mode:'shared',computerId:`cua:${f.a.id}`,workspace}}),{status:400});
});

test('filesystem verification routes to a real bounded task on shared Mac folder, preserving each bot model and profile',async t=>{
 let f;f=fixture(t,async input=>{
  if(input.message==='Do you see the project folder?'){
   assert.match(input.bot.instructions,/checking a file, folder, browser, website or computer/);
   assert.match(input.bot.instructions,/do not claim the team lacks access/);
   assert.match(input.bot.instructions,/invite_teammates.message is visible public speech/);
   assert.equal(input.tools.some(x=>x.name==='read_file'),false);
   await input.executeTool('assign_team_task',{botId:f.b.id,message:'Read marker.txt in the selected shared folder'},'inspect');say(input,'I assigned the folder check.');
  }else if(input.bot.id===f.b.id){
   assert.equal(input.bot.computerMode,'host');assert.equal(input.bot.workspace,resolve(join(f.directory,'project')));assert.equal(input.bot.model,'builder-model');
   const result=await input.executeTool('read_file',{path:'marker.txt'},'read');assert.match(result.content[0].text,/shared-folder-marker/);say(input,'The file is present.');
  }else say(input,'Verified the file from the teammate report.');
 });
 const folder=join(f.directory,'project');mkdirSync(folder);writeFileSync(join(folder,'marker.txt'),'shared-folder-marker');
 const profileBefore=(await f.bots.list()).bots.find(b=>b.id===f.b.id);
 f.bots.team.update(f.team.id,{expectedRevision:1,execution:{mode:'shared',computerId:'host:local',workspace:folder}});
 const started=f.bots.team.message(f.team.id,{message:'Do you see the project folder?',requestId:'inspect'});await f.done(started.run);
 assert.equal(f.effects.length,1);assert.equal(f.effects[0].bot.workspace,folder);assert.equal(f.effects[0].bot.id,f.b.id);
 assert.deepEqual((await f.bots.list()).bots.find(b=>b.id===f.b.id),{...profileBefore,conversations:(await f.bots.list()).bots.find(b=>b.id===f.b.id).conversations});
 assert.ok(f.bots.team.channel(f.team.id).messages.some(row=>row.kind==='report'&&row.content==='The file is present.'));
});

test('shared guest is one exact resource; tasks across runs serialize, human lease blocks both members, snapshots stay frozen',async t=>{
 let f,release,entered;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);let tasks=0;
 f=fixture(t,async input=>{
  if(input.bot.teamConversationOnly){if(!input.message.startsWith('[Strata teammate result'))await input.executeTool('assign_team_task',{botId:input.message==='second'?f.a.id:f.b.id,message:input.message},'assign');return;}
  tasks++;assert.equal(input.bot.computerOwnerId,f.a.id);assert.equal(input.bot.workspace,'/workspace/project');assert.equal(cuaSandboxName(input.bot),cuaSandboxName(f.a));
  if(tasks===1){entered();await held;}say(input,'Shared work finished');
 });
 f.bots.team.update(f.team.id,{execution:{mode:'shared',computerId:`cua:${f.a.id}`,workspace:'/workspace/project'}});
 const first=f.bots.team.message(f.team.id,{message:'first',requestId:'first'});await started;
 assert.throws(()=>f.bots.team.update(f.team.id,{memberIds:[f.a.id,f.c.id]}),{status:409,code:'team_busy'});
 assert.throws(()=>f.bots.update(f.a.id,{workspace:'/workspace/redirect'}),{status:409});
 const second=f.bots.team.message(f.team.id,{message:'second',requestId:'second'});await until(()=>f.seen.some(input=>input.message==='second'));await new Promise(r=>setTimeout(r,25));assert.equal(tasks,1);
 release();await f.done(first.run);await f.done(second.run);assert.equal(tasks,2);
 const child=f.bots.team.channel(f.team.id).messages.find(row=>row.kind==='assignment').chatId;
 const lease=await f.bots.computer.takeover(f.b.id,{chatId:child,owner:'fixture'});
 assert.throws(()=>f.bots.validateSelection({botId:f.b.id,chatId:child}),/person has control/);
 assert.throws(()=>f.bots.validateSelection({botId:f.a.id}),/person has control/);
 f.bots.computer.release(f.b.id,{chatId:child,leaseToken:lease.leaseToken},{owner:'fixture'});
 assert.throws(()=>f.bots.team.update(f.team.id,{memberIds:[f.b.id,f.c.id],coordinatorId:f.b.id}),/owner in this team/);
 assert.throws(()=>f.bots.remove(f.a.id),/shared computer/);
 f.bots.team.update(f.team.id,{execution:{mode:'individual'}});
 f.bots.update(f.a.id,{workspace:'/workspace/redirect'});
 f.chats.send(child,'Continue frozen assigned work');await until(()=>!f.chats.detail(child).conversation.active);assert.equal(tasks,3);
});

test('shared SSH choice freezes target and remote working folder without moving model connections or private identity',async t=>{
 let f;const seen=[];f=fixture(t,async input=>{seen.push(input.bot);say(input,'Fixture SSH input captured');});
 const remote=f.make('Saved SSH',{execution:{kind:'ssh',host:'fixture.invalid',user:'different-user',port:2222},workspace:'/home/fixture',computerMode:'host'});
 const target=f.bots.team.list().teamComputers.find(row=>row.id.startsWith('host:ssh_'));
 f.bots.team.update(f.team.id,{execution:{mode:'shared',computerId:target.id,workspace:'/srv/team-project'}});
 const result=f.bots.team.start(f.team.id,{message:'Capture frozen SSH task'});await f.done(result.run);
 assert.equal(seen[0].execution.host,'fixture.invalid');assert.equal(seen[0].execution.user,'different-user');assert.equal(seen[0].workspace,'/srv/team-project');assert.equal(seen[0].id,f.a.id);assert.equal(seen[0].model,'coordinator-model');assert.equal(seen[0].computerMode,'host');
 const original=(await f.bots.list()).bots.find(b=>b.id===f.a.id);assert.equal(original.execution.kind,'local');assert.equal(original.computerMode,'cua');
 assert.equal((await f.bots.list()).bots.find(b=>b.id===remote.id).workspace,'/home/fixture');
});

test('shared Computer Stop and Take over cancel active plus queued siblings after router yields; release never resumes them',async t=>{
 for(const action of ['stop','takeover']) await t.test(action,async sub=>{
  let f,entered;const running=new Promise(r=>entered=r);let tasks=0,guestStops=0;
  f=fixture(sub,async input=>{
   if(input.bot.teamConversationOnly){if(input.message==='split task'){
    await input.executeTool('assign_team_task',{botId:f.b.id,message:'Active child'},'first');
    await input.executeTool('assign_team_task',{botId:f.a.id,message:'Queued sibling'},'second');
   }return;}
   tasks++;entered();await new Promise(r=>{input.signal.addEventListener('abort',r,{once:true});if(input.signal.aborted)r();});
  },{cuaTools:{state:async()=>({available:true,frame:{width:1,height:1,mimeType:'image/png',data:'fixture'}}),stop:async()=>{guestStops++;return{available:false,stopped:true,cleanupConfirmed:true};}}});
  f.bots.team.update(f.team.id,{execution:{mode:'shared',computerId:`cua:${f.a.id}`,workspace:'/workspace'}});
  const started=f.bots.team.message(f.team.id,{message:'split task',requestId:action});await running;
  await until(()=>!f.chats.detail(started.run.rootChatId).conversation.active);
  assert.equal(tasks,1);
  const result=await f.bots.computer[action](f.a.id,{owner:'fixture'});
  assert.equal(f.bots.team.detail(f.team.id,started.run.id).run.state,'cancelled');
  if(action==='takeover')f.bots.computer.release(f.a.id,{leaseToken:result.leaseToken},{owner:'fixture'});
  f.bots.team.tick();await new Promise(r=>setTimeout(r,30));assert.equal(tasks,1);assert.equal(guestStops,action==='stop'?1:0);
 });
});


test('shared team settings and revision survive restart without replaying work or dropping public history', async t => {
 const f=fixture(t,async input=>say(input,'Persisted public report'));
 f.bots.team.update(f.team.id,{expectedRevision:1,execution:{mode:'shared',computerId:`cua:${f.a.id}`,workspace:'/workspace/persisted'}});
 const started=f.bots.team.message(f.team.id,{message:'Hello',requestId:'persisted'});await f.done(started.run);
 const before=f.bots.team.channel(f.team.id).messages;await f.bots.close();
 const profiles=JSON.parse(readFileSync(join(f.directory,'bots.json'),'utf8')).bots;
 const reopened=createBotTeams({directory:f.directory,requireBot:id=>{const bot=profiles.find(row=>row.id===id);if(!bot)throw Error('Missing');return bot;},conversations:()=>f.chats,createConversation:()=>assert.fail('Restart cannot create work'),stopDirect:async()=>{}});
 t.after(()=>reopened.close());
 const team=reopened.list().teams.find(row=>row.id===f.team.id);assert.equal(team.revision,2);assert.deepEqual(team.execution,{mode:'shared',computerId:`cua:${f.a.id}`,workspace:'/workspace/persisted'});assert.deepEqual(reopened.channel(f.team.id).messages,before);reopened.tick();assert.equal(f.seen.length,1);
});


test('failed atomic team save cannot publish a phantom roster/revision or create a phantom team', async t => {
 const notices=[];const f=fixture(t,undefined,{notify:(...args)=>notices.push(args)});
 const file=join(f.directory,'bot-teams.json'),retained=join(f.directory,'retained-teams.json');const old=readFileSync(file,'utf8'),before=f.bots.team.list(),noticeCount=notices.length;
 renameSync(file,retained);mkdirSync(file);
 try {
  assert.throws(()=>f.bots.team.update(f.team.id,{expectedRevision:1,name:'Rejected rename',memberIds:[f.a.id,f.c.id],execution:{mode:'shared',computerId:'host:local',workspace:f.directory}}));
  assert.deepEqual(f.bots.team.list(),before);assert.equal(readFileSync(retained,'utf8'),old);assert.equal(notices.length,noticeCount);
  assert.throws(()=>f.bots.team.create({name:'Rejected new team',memberIds:[f.a.id,f.b.id],coordinatorId:f.a.id}));
  assert.deepEqual(f.bots.team.list(),before);assert.equal(readFileSync(retained,'utf8'),old);assert.equal(notices.length,noticeCount);
 } finally {rmSync(file,{recursive:true});renameSync(retained,file);}
 const accepted=f.bots.team.update(f.team.id,{expectedRevision:1,name:'Accepted rename'}).team;assert.equal(accepted.revision,2);assert.equal(accepted.name,'Accepted rename');
});


test('one scheduler tick reserves a shared computer before async provider start, so different sibling bots queue rather than fail', async t => {
 let f;let tasks=0;f=fixture(t,async input=>{
  if(input.bot.teamConversationOnly){if(input.message==='two independent checks'){
   await input.executeTool('assign_team_task',{botId:f.b.id,message:'First child'},'first-child');await input.executeTool('assign_team_task',{botId:f.c.id,message:'Second child'},'second-child');
  }return;}
  tasks++;await new Promise(r=>setTimeout(r,15));say(input,'Completed '+input.bot.name);
 });
 f.bots.team.update(f.team.id,{memberIds:[f.a.id,f.b.id,f.c.id],execution:{mode:'shared',computerId:`cua:${f.a.id}`,workspace:'/workspace'}});
 const started=f.bots.team.message(f.team.id,{message:'two independent checks',requestId:'same-tick'});await f.done(started.run);
 assert.equal(tasks,2);assert.equal(f.bots.team.detail(f.team.id,started.run.id).run.state,'completed');
 const reports=f.bots.team.channel(f.team.id).messages.filter(row=>row.kind==='report');assert.equal(reports.length,2);assert.ok(reports.every(row=>row.state==='done'));
});
