/** Inert providers and disposable journals only: no owner accounts, machines or model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBotTeams, DEFAULT_TEAM_LIMITS } from '../server/bots-team.mjs';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { normalizeTeamBriefing } from '../server/bots-team-instructions.mjs';
const immediate = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { const deadline = Date.now()+7000; while (!fn()) { if(Date.now()>deadline) throw Error('Unrestricted fixture did not settle'); await new Promise(resolve=>setTimeout(resolve,5)); } }
const aborted = signal => new Promise(resolve => { signal.addEventListener('abort',resolve,{once:true}); if(signal.aborted) resolve(); });
function fixture(t,count,run) {
  const directory=mkdtempSync(join(tmpdir(),'strata-team-unrestricted-')); let chats;
  const seen=[]; const bots=createBots({directory,runtime:{providers:async()=>[],async run(input){seen.push(input);await run(input);input.onFrame({type:'done'});},close(){}},tools:{definitions:()=>[],finish:async()=>{}},defaultWorkspace:()=>directory,conversations:()=>chats});
  chats=createConversations({directory,enabled:()=>true,pending:id=>bots.pending(id),stop:id=>bots.stop(id),approve:input=>bots.approve(input),validateSelection:value=>bots.validateSelection(value),execute:input=>bots.run(input)});
  const members=Array.from({length:count},(_,i)=>bots.create({name:`Member ${i}`,provider:'codex',workspace:directory,policy:'bypass'}).bot);
  t.after(async()=>{await bots.close();chats.close();rmSync(directory,{recursive:true,force:true});});
  const team=(ids=members.map(b=>b.id),extra={})=>bots.team.create({name:'Large team',memberIds:ids,coordinatorId:ids[0],enabled:true,...extra}).team;
  return {directory,bots,chats,members,team,seen};
}
function journal(t,count=60) {
  const directory=mkdtempSync(join(tmpdir(),'strata-team-journal-unrestricted-'));const bots=new Map(Array.from({length:count},(_,i)=>[`bot_${i}`,{id:`bot_${i}`,name:`Member ${i}`,policy:'bypass'}]));let n=0;const chats=new Map(),sent=[],scheduled=[],cleanup={stop:async()=>{}};
  const options={directory,requireBot:id=>{if(!bots.has(id))throw Error('Unknown current bot');return bots.get(id);},conversations:()=>({detail:id=>({conversation:chats.get(id)}),send(id){sent.push(id);},stop:async()=>{}}),createConversation(botId){const conversation={id:`s_${++n}`,botId,messages:[]};chats.set(conversation.id,conversation);return{conversation};},stopDirect:async id=>cleanup.stop(id),schedule:fn=>scheduled.push(fn)};
  const teams=createBotTeams(options);t.after(async()=>{await teams.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,bots,chats,sent,teams,options,scheduled,cleanup};
}

test('large canonical roster, recipient and briefing inputs have no count cap; identity and text bounds remain',async t=>{
  const f=journal(t,601),ids=[...f.bots.keys()];const briefing={members:ids.map(botId=>({botId,role:'',instructions:''}))};
  const team=f.teams.create({name:'Large public roster',memberIds:ids,coordinatorId:ids[0],enabled:true,briefing}).team;
  assert.equal(team.memberIds.length,601);assert.equal(team.limits.maxParallel,0);assert.equal(f.teams.list().teamUnrestrictedSupported,true);
  assert.equal(f.teams.message(team.id,{message:'Hello',requestId:'large-address',recipientIds:ids}).run.requestedRecipientIds.length,601);
  const tools=f.teams.tools({...f.bots.get(ids[0]),teamContext:{teamId:team.id}},{roomMode:'routing'});
  assert.equal(tools.find(t=>t.name==='invite_teammates').inputSchema.properties.botIds.maxItems,undefined);
  assert.equal(tools.find(t=>t.name==='update_team_instructions').inputSchema.properties.briefing.properties.members.maxItems,undefined);
  assert.deepEqual(normalizeTeamBriefing(briefing,ids),{instructions:'',members:[]});
  assert.throws(()=>f.teams.create({name:'Invalid',memberIds:[ids[0],ids[0]],coordinatorId:ids[0]}),{status:400});
  assert.throws(()=>f.teams.create({name:'Invalid',memberIds:[ids[0],'missing'],coordinatorId:ids[0]}),/current bot/);
  assert.throws(()=>normalizeTeamBriefing({members:ids.map(botId=>({botId,instructions:'x'.repeat(1000)}))},ids),/24,000/);
});

test('legacy positive parallel settings are accepted but only team limits canonicalize on disk; historical run limits stay exact',async t=>{
  const f=journal(t);const team=f.teams.create({name:'Legacy',memberIds:['bot_0','bot_1'],coordinatorId:'bot_0',enabled:true,limits:{maxParallel:8}}).team;
  assert.equal(team.limits.maxParallel,0);assert.equal(f.teams.update(team.id,{limits:{maxParallel:1000}}).team.limits.maxParallel,0);
  for(const value of [-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>f.teams.update(team.id,{limits:{maxParallel:value}}),{status:400});
  const run=f.teams.start(team.id,{message:'Historical request'}).run;await f.teams.stop(team.id,run.id);await f.teams.close();
  const file=join(f.directory,'bot-teams.json'),legacy=JSON.parse(readFileSync(file));legacy.teams[0].limits.maxParallel=2;legacy.runs[0].limits.maxParallel=1;writeFileSync(file,JSON.stringify(legacy));
  const restored=createBotTeams(f.options);t.after(()=>restored.close());const actual=JSON.parse(readFileSync(file));const expected=structuredClone(legacy);expected.teams[0].limits.maxParallel=0;
  assert.deepEqual(actual,expected);assert.equal(restored.list().teams[0].limits.maxParallel,0);assert.equal(restored.detail(team.id,run.id).run.limits.maxParallel,1);
});

test('fifty members each greet exactly once with continuous team settings and no execution tools',async t=>{
  let f;f=fixture(t,50,async input=>{
    assert.equal(input.bot.teamConversationOnly,true);assert.equal(input.tools.some(t=>t.name==='shell'),false);
    if(input.message==='Hi everyone')await input.executeTool('invite_teammates',{botIds:f.members.slice(1).map(b=>b.id),message:'Please greet everyone once.'},'all-members');
    if(!input.message.startsWith('[The public conversation invitations'))input.onFrame({type:'delta',text:`Hello from ${input.bot.id}`});
  });const team=f.team(),run=f.bots.team.message(team.id,{message:'Hi everyone',requestId:'fifty',recipientIds:team.memberIds}).run;
  await until(()=>f.bots.team.detail(team.id,run.id).run.state==='completed');const finished=f.bots.team.detail(team.id,run.id).run;
  const replies=f.bots.team.channel(team.id).messages.filter(m=>m.content.startsWith('Hello from'));
  assert.equal(new Set(replies.map(m=>m.author.botId)).size,50);assert.equal(f.seen.length,51);assert.equal(finished.consumedTurns,51);assert.equal(finished.rosterFanoutTurns,undefined);assert.equal(finished.limits.maxTurns,0);
});

test('more than eight independent tasks run together even for a legacy maxParallel1 request; Stop awaits all and preserves unrelated work',async t=>{
  let f,releaseCleanup,cleanupEntered=false,stopped=false;const cleanup=new Promise(resolve=>{releaseCleanup=resolve;});
  f=fixture(t,15,async input=>{
    if(input.message==='Coordinate')for(const bot of f.members.slice(1,13))await input.executeTool('spawn_subagent',{botId:bot.id,message:'Independent bounded task'},`task-${bot.id}`);
    await aborted(input.signal);if(input.bot.id===f.members[1].id){cleanupEntered=true;await cleanup;}
  });const independent=f.bots.createConversation(f.members[14].id).conversation.id;f.chats.send(independent,'Unrelated');
  const team=f.team(f.members.slice(0,13).map(b=>b.id),{limits:{maxParallel:1}}),run=f.bots.team.start(team.id,{message:'Coordinate'}).run;
  await until(()=>f.seen.length===14);assert.equal(f.bots.team.activity().activity.filter(row=>row.runId===run.id&&row.type==='subagent'&&row.state==='running').length,12);
  const stopping=f.bots.team.stop(team.id,run.id).then(result=>{stopped=true;return result;});await until(()=>cleanupEntered);await immediate();assert.equal(stopped,false);
  assert.equal(f.chats.detail(independent).conversation.active,true);releaseCleanup();assert.equal((await stopping).run.state,'cancelled');assert.equal(f.chats.detail(independent).conversation.active,true);
  assert.equal(f.bots.team.activity().activity.some(row=>row.runId===run.id&&['running','queued','stopping'].includes(row.state)),false);
});

test('more than eight independent team runs are admitted and work concurrently',async t=>{
  const f=fixture(t,20,async input=>{await aborted(input.signal);});const runs=[];
  for(let i=0;i<10;i++){const team=f.team([f.members[i*2].id,f.members[i*2+1].id]);runs.push({team,run:f.bots.team.start(team.id,{message:'Independent team request'}).run});}
  await until(()=>f.seen.length===10);assert.equal(f.bots.team.activeCount(),10);
  await f.bots.team.stop(runs[0].team.id,runs[0].run.id);assert.equal(f.bots.team.activeCount(),9);assert.equal(f.seen.filter(input=>input.signal.aborted).length,1);
});

test('live runs are not a terminal-history count limit and restart interrupts without replay',async t=>{
  const f=journal(t),team=f.teams.create({name:'Queued rooms',memberIds:['bot_0','bot_1'],coordinatorId:'bot_0',enabled:true}).team;
  for(let i=0;i<205;i++)f.teams.start(team.id,{message:`Explicit request ${i}`,requestId:`request-${i}`});
  assert.equal(f.teams.activeCount(),205);assert.equal(f.teams.list().runs.length,205);const file=join(f.directory,'bot-teams.json');assert.equal(JSON.parse(readFileSync(file)).runs.length,205);
  const restored=createBotTeams(f.options);t.after(()=>restored.close());assert.equal(restored.activeCount(),0);assert.equal(f.sent.length,0);assert.equal(JSON.parse(readFileSync(file)).runs.length,200);
});

test('a busy bot stays single-owner across uncapped runs and rotating admission lets another run proceed',async t=>{
  const f=journal(t),team=f.teams.create({name:'Fair queue',memberIds:['bot_0','bot_1'],coordinatorId:'bot_0',enabled:true}).team;
  const first=f.teams.start(team.id,{message:'First'}).run;f.teams.tick();const second=f.teams.start(team.id,{message:'Second'}).run;f.teams.tick();assert.deepEqual(f.sent,[first.rootChatId]);
  f.teams.begin({chatId:first.rootChatId,turnId:'first'});f.teams.end({turnId:'first'});f.teams.tick();assert.deepEqual(f.sent,[first.rootChatId,second.rootChatId]);
});

test('continuous conversation invitations deduplicate identical deliveries without a hidden turn budget',async t=>{
  const f=journal(t,50),ids=[...f.bots.keys()];const team=f.teams.create({name:'Continuous opening',memberIds:ids,coordinatorId:ids[0],enabled:true,limits:{maxTurns:3}}).team;
  const run=f.teams.message(team.id,{message:'Hello everyone',requestId:'continuous-opening'}).run;f.teams.tick();
  const context={bot:f.bots.get(ids[0]),chatId:run.rootChatId,turnId:'opening-root',toolCallId:'hello',assertLive(){}};f.teams.begin(context);
  const invited=await f.teams.execute('invite_teammates',{botIds:ids.slice(1),message:'Please greet once.'},context);
  const duplicate=await f.teams.execute('invite_teammates',{botIds:ids.slice(1),message:'Another wording of the same addressed greeting'},{...context,toolCallId:'duplicate'});
  assert.deepEqual(duplicate.deliveryIds,invited.deliveryIds);assert.match(duplicate.notice,/not woken twice/);
  const saved=JSON.parse(readFileSync(join(f.directory,'bot-teams.json')));assert.equal(saved.jobs.length,50);assert.equal(saved.jobs.some(job=>job.rosterFanout),false);
  assert.equal(f.teams.detail(team.id,run.id).run.limits.maxTurns,0);
});

test('catalog exposes every live run including cleanup states while bounding only terminal history and preserving newest-first order',async t=>{
  const f=journal(t),team=f.teams.create({name:'All live work',memberIds:['bot_0','bot_1'],coordinatorId:'bot_0',enabled:true}).team;
  const first=f.teams.start(team.id,{message:'Seed terminal record'}).run;await f.teams.stop(team.id,first.id);await f.teams.close();
  const file=join(f.directory,'bot-teams.json'),base=JSON.parse(readFileSync(file));base.jobs=[];
  base.runs=Array.from({length:205},(_,i)=>({...base.runs[0],id:`tr_${i.toString(16)}`,state:'completed'}));writeFileSync(file,JSON.stringify(base));
  const restored=createBotTeams(f.options);t.after(()=>restored.close());const active=[];
  for(let i=0;i<205;i++)active.push(restored.start(team.id,{message:`Live work ${i}`}).run);
  restored.tick();let view=restored.list().runs;
  assert.equal(view.length,405);assert.equal(view.filter(run=>run.state==='completed').length,200);
  assert.deepEqual(view.filter(run=>run.state!=='completed').map(run=>run.id),active.map(run=>run.id).reverse());
  assert.equal(new Set(view.map(run=>run.id)).size,405);
  f.cleanup.stop=async()=>{throw Error('Unconfirmed cleanup fixture');};
  assert.equal((await restored.stop(team.id,active[0].id)).run.state,'cleanup_pending');
  const otherTeam=restored.create({name:'Held stop',memberIds:['bot_1','bot_2'],coordinatorId:'bot_1',enabled:true}).team;
  const other=restored.start(otherTeam.id,{message:'Wait for cleanup'}).run;restored.tick();
  let release;const held=new Promise(resolve=>{release=resolve;});f.cleanup.stop=async()=>held;
  const stopping=restored.stop(otherTeam.id,other.id);view=restored.list().runs;
  assert.equal(view.length,406);assert.equal(view.find(run=>run.id===active[0].id).state,'cleanup_pending');
  assert.equal(view.find(run=>run.id===other.id).state,'stopping');assert.equal(view.filter(run=>run.state==='queued').length,204);
  release();await stopping;f.cleanup.stop=async()=>{};
  view=restored.list().runs;assert.equal(view.length,405);assert.equal(view.filter(run=>['completed','cancelled'].includes(run.state)).length,200);
});
