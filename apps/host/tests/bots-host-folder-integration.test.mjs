/** Full profile/chat/team integration with inert providers and disposable files. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';

const until = async fn => { const end = Date.now()+8000; while (!fn()) { if(Date.now()>end) throw Error('Timed out'); await new Promise(r=>setTimeout(r,5)); } };
function fixture(t, execute = async () => {}) {
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'strata-folder-integration-'))), folder=join(directory,'project'); mkdirSync(folder); writeFileSync(join(folder,'marker.txt'),'synthetic host file');
 const maya=join(directory,'model-providers.json');writeFileSync(maya,'{"name":"Maya separate","fixture":true}');
 let chats; const seen=[];
 const bots=createBots({directory,defaultWorkspace:()=>directory,conversations:()=>chats,runtime:{providers:async()=>[],run:async input=>{seen.push(input);await execute(input);input.onFrame({type:'done'});},close(){}},tools:{definitions:()=>[],finish(){},close(){}},remoteSSH:{}});
 chats=createConversations({directory,enabled:()=>true,validateSelection:value=>bots.validateSelection(value),execute:value=>bots.run(value),pending:id=>bots.pending(id),approve:value=>bots.approve(value),stop:id=>bots.stop(id)});
 t.after(async()=>{await bots.close();chats.close();assert.equal(readFileSync(maya,'utf8'),'{"name":"Maya separate","fixture":true}');rmSync(directory,{recursive:true,force:true});});
 const make=name=>bots.create({name,provider:'codex',workspace:'/workspace',computerMode:'cua',policy:'bypass'}).bot;
 const grant=async(id,value)=>{const bot=(await bots.list()).bots.find(bot=>bot.id===id);return (await bots.setHostFolder(id,{expectedUpdatedAt:bot.updatedAt,hostFolder:value})).bot;};
 const frozen=id=>JSON.parse(readFileSync(join(directory,'bots.json'),'utf8')).chatProfiles.find(([key])=>key===id)[1];
 const run=async chat=>{chats.send(chat.id,'synthetic request');await until(()=>!chats.isRunning(chat.id));return chats.detail(chat.id).conversation;};
 return {directory,folder,bots,chats,seen,make,grant,frozen,run};
}

test('explicit grant is opt-in, frozen and preserved by ordinary profile edits; revocation cannot revive old chats',async t=>{
 const values=[];const f=fixture(t,async input=>{if(input.tools.some(tool=>tool.name==='host_read_file')) values.push(await input.executeHostTool('host_read_file',{path:'marker.txt'},'read'));});
 const bot=f.make('Isolated');const before=f.bots.createConversation(bot.id).conversation;
 assert.equal((await f.bots.list()).hostFolderSupported,true);assert.equal(f.frozen(before.id).hostFolder,undefined);
 await f.grant(bot.id,{path:f.folder,access:'read'});await f.run(before);assert.equal(values.length,0,'older chats do not acquire a new grant');
 const chat=f.bots.createConversation(bot.id).conversation;await f.run(chat);assert.equal(values[0].content[0].text,'synthetic host file');
 const saved=f.bots.update(bot.id,{name:'Renamed'}).bot;assert.equal(saved.hostFolder.path,f.folder);assert.equal(saved.hostFolderBinding,undefined);assert.equal(saved.hostFolderRevision,undefined);
 await f.grant(bot.id,null);await f.grant(bot.id,{path:f.folder,access:'read'});
 const failed=await f.run(chat);assert.match(failed.messages.at(-1).error,/changed or was revoked/);assert.equal(values.length,1);
 const fresh=f.bots.createConversation(bot.id).conversation;await f.run(fresh);assert.equal(values.length,2);
 assert.throws(()=>f.bots.update(bot.id,{hostFolder:{path:f.folder,access:'read-write'}}),/Shared host folder/);
});

test('team shares only its CUA owner grant; switching target or using a host team never carries another grant',async t=>{
 const f=fixture(t), anchor=f.make('Anchor'), worker=f.make('Worker');
 await f.grant(anchor.id,{path:f.folder,access:'read'});
 const other=join(f.directory,'other');mkdirSync(other);await f.grant(worker.id,{path:other,access:'read-write'});
 const team=f.bots.team.create({name:'Shared guest',memberIds:[anchor.id,worker.id],coordinatorId:anchor.id,enabled:true,execution:{mode:'shared',computerId:'cua:'+anchor.id,workspace:'/workspace'}}).team;
 const first=f.bots.team.message(team.id,{message:'Synthetic discussion',requestId:'one'}).run;
 const linked=f.bots.createConversation(worker.id,{}, {teamId:team.id,teamRunId:first.id,channelMode:'task'}).conversation;
 assert.equal(f.frozen(linked.id).hostFolderOwnerId,anchor.id);assert.equal(f.frozen(linked.id).hostFolder.path,f.folder);
 await until(()=>!['running','queued'].includes(f.bots.team.detail(team.id,first.id).run.state));
 f.bots.team.update(team.id,{execution:{mode:'shared',computerId:'host:local',workspace:f.directory}});
 const second=f.bots.team.message(team.id,{message:'Synthetic host discussion',requestId:'two'}).run;
 const host=f.bots.createConversation(worker.id,{}, {teamId:team.id,teamRunId:second.id,channelMode:'task'}).conversation;
 assert.equal(f.frozen(host.id).hostFolder,undefined);
 const remote=f.bots.createConversation(worker.id,{execution:{kind:'ssh',host:'fixture.invalid',user:'fixture'}}).conversation;
 assert.equal(f.frozen(remote.id).hostFolder,undefined,'a Mac grant never transfers to SSH');
});

test('stale/invalid grants fail closed and removal is allowed during an active synthetic turn',async t=>{
 let release,started;const entered=new Promise(r=>started=r), hold=new Promise(r=>release=r);
 const f=fixture(t,async()=>{started();await hold;}),bot=f.make('Held');
 t.after(()=>release());await f.grant(bot.id,{path:f.folder,access:'read'});
 const chat=f.bots.createConversation(bot.id).conversation;f.chats.send(chat.id,'hold');await entered;
 const stale=bot.updatedAt;
 await assert.rejects(f.bots.setHostFolder(bot.id,{hostFolder:null,expectedUpdatedAt:stale}),e=>e.status===409);
 await assert.rejects(f.grant(bot.id,{path:f.folder,access:'read-write'}),e=>e.status===409);
 await f.grant(bot.id,null);assert.equal((await f.bots.list()).bots[0].hostFolder,undefined);
 release();await until(()=>!f.chats.isRunning(chat.id));
 await assert.rejects(f.grant(bot.id,{path:'/',access:'read'}),e=>e.status===400);
 const current=(await f.bots.list()).bots[0];
 await assert.rejects(f.bots.setHostFolder(bot.id,{hostFolder:null,expectedUpdatedAt:current.updatedAt,hostFolderBinding:{}}),e=>e.status===400);
});
