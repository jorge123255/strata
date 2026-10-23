import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
async function source(path) { const {code}=await transform(await readFile(new URL(path,import.meta.url),'utf8'),{loader:'ts',format:'esm'});return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`); }
const bots=await source('../src/lib/bots.ts'),connections=await source('../src/lib/bot-connections.ts');
test('capable hosts allow full team rosters and all available teammates while older hosts keep their protocol',()=>{
  const roster=Array.from({length:42},(_,i)=>({id:`member_${i}`}));
  const members=roster.slice(0,12);
  const draft={name:'Whole studio',memberIds:members.map(bot=>bot.id),coordinatorId:members[0].id,limits:{...bots.DEFAULT_BOT_TEAM_LIMITS,maxParallel:0},briefing:{instructions:'Work together',members:members.map(bot=>({botId:bot.id,role:'Teammate',instructions:''}))}};
  assert.equal(bots.botTeamDraftError(draft,roster,undefined,true),null);
  assert.ok(bots.botTeamDraftError(draft,roster,undefined,false));
  assert.ok(bots.botTeamDraftError({...draft,memberIds:roster.slice(0,13).map(bot=>bot.id)},roster,undefined,true));
  assert.equal(bots.botTeamDraftError({...draft,limits:{...draft.limits,maxParallel:42}},roster,undefined,true),null);
  for(const value of [-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.ok(bots.botTeamDraftError({...draft,limits:{...draft.limits,maxParallel:value}},roster,undefined,true));
  assert.ok(bots.botTeamDraftError({...draft,memberIds:[...draft.memberIds,roster[0].id]},roster,undefined,true));
  assert.ok(bots.botTeamDraftError({...draft,briefing:{...draft.briefing,members:[...draft.briefing.members,{botId:'outside',role:'',instructions:''}]}},roster,undefined,true));
  assert.equal(bots.botTeamParallelLabel(draft.limits),'All available teammates');
  assert.equal(bots.botTeamParallelLabel({...draft.limits,maxParallel:2},true),'All available teammates');
  assert.equal(bots.botTeamParallelLabel({...draft.limits,maxParallel:2}),'2 parallel tasks');
});
test('team validation rejects missing members, stale bot identity, foreign coordinators and unbounded work',()=>{
  const draft={name:'Crew',memberIds:['a','b'],coordinatorId:'a',limits:{...bots.DEFAULT_BOT_TEAM_LIMITS}},roster=[{id:'a'},{id:'b'}];
  assert.equal(bots.botTeamDraftError(draft,roster),null);
  assert.equal(bots.botTeamDraftError({...draft,talkativeness:{a:0,b:100},bidding:true},roster),null);
  assert.ok(bots.botTeamDraftError({...draft,talkativeness:{a:101}},roster));
  assert.ok(bots.botTeamDraftError({...draft,talkativeness:{a:-1}},roster));
  assert.ok(bots.botTeamDraftError({...draft,bidding:'yes'},roster));
  for(const changes of [{memberIds:[]},{memberIds:['a','a']},{memberIds:['a','removed']},{coordinatorId:'outside'},{limits:{...draft.limits,maxDurationMs:59999}},{limits:{...draft.limits,maxParallel:9}},{limits:{...draft.limits,maxDepth:1.5}}])assert.ok(bots.botTeamDraftError({...draft,...changes},roster));
  assert.equal(bots.botTeamRunActive('cleanup_pending'),true);assert.equal(bots.botTeamRunActive('cancelled'),false);assert.equal(bots.botActivityLabel('cleanup_pending'),'Checking cleanup');
});
test('continuous hosts require the exact zero shape and retain older protocol labels',()=>{
  const roster=[{id:'a'},{id:'b'}],draft={name:'Crew',memberIds:['a','b'],coordinatorId:'a',limits:{...bots.CONTINUOUS_BOT_TEAM_LIMITS}};
  assert.equal(bots.botTeamDraftError(draft,roster,undefined,true,true),null);
  assert.ok(bots.botTeamDraftError(draft,roster,undefined,true,false));
  for(const key of Object.keys(draft.limits))for(const value of [1,-1,NaN,Infinity,true,undefined])assert.ok(bots.botTeamDraftError({...draft,limits:{...draft.limits,[key]:value}},roster,undefined,true,true));
  assert.equal(bots.botTeamWorkLabel(draft.limits,true,true),'All available teammates · Until finished or stopped');
  assert.equal(bots.botTeamWorkLabel(bots.DEFAULT_BOT_TEAM_LIMITS,false,true),'All available teammates · 24 work turns · 10 minute limit');
  assert.equal(bots.botTeamWorkLabel(bots.DEFAULT_BOT_TEAM_LIMITS,false,false),'2 parallel tasks · 24 turns · 10 minute limit');
});
test('a saved roster keeps its length, and the header and sidebar share one member label', async () => {
  const ids = Array.from({ length: 17 }, (_, index) => `member_${index}`);
  assert.equal(bots.TEAM_MEMBER_CAP, 12);
  assert.equal(bots.teamRosterCount(ids), 17);
  assert.equal(bots.teamRosterCount(undefined), 0);
  assert.equal(bots.teamRosterLabel(1), '1 member');
  assert.equal(bots.teamRosterLabel(17), '17 members');
  assert.equal(bots.teamOverRosterCap(12), false);
  assert.equal(bots.teamOverRosterCap(17), true);
  const workspace = await readFile(new URL('../src/screens/BotsWorkspace.tsx', import.meta.url), 'utf8');
  const editor = await readFile(new URL('../src/screens/BotTeamEditor.tsx', import.meta.url), 'utf8');
  const screen = await readFile(new URL('../src/screens/Bots.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /teamRosterLabel\(/);
  assert.match(workspace, /teamOverRosterCap\(/);
  assert.match(workspace, /Choose who stays/);
  assert.match(workspace, /from before the limit of/);
  assert.doesNotMatch(workspace, /teammates ·/);
  assert.match(editor, /Uncheck members until/);
  assert.match(editor, /TEAM_MEMBER_CAP/);
  assert.doesNotMatch(editor, /memberIds\.slice\(0,\s*12\)/);
  assert.match(screen, /teamRosterLabel\(team\.memberIds\.length\)/);
});
test('MCP imports retain separate arguments and environment but never import bot or tool authority',()=>{
  const input={mcpServers:{local:{command:'/path with spaces/program',args:['--file','a b'],env:{TOKEN:'synthetic'},botIds:['foreign'],enabledToolIds:['everything']},remote:{url:'https://example.invalid/mcp',headers:{Authorization:'Bearer synthetic-key'}}}};
  const parsed=connections.parseBotConnectionImport(JSON.stringify(input));
  assert.deepEqual(parsed[0],{name:'local',transport:'stdio',url:'',command:'/path with spaces/program',args:['--file','a b'],env:{TOKEN:'synthetic'},botIds:[],enabledToolIds:[]});
  assert.equal(parsed[1].apiKey,'synthetic-key');assert.deepEqual(parsed[1].enabledToolIds,[]);
  assert.equal(connections.parseBotConnectionImport('{"name":"Single","url":"https://example.invalid/mcp"}')[0].name,'Single');
});
test('MCP imports reject malformed fields and unsupported authentication rather than silently losing credentials',()=>{
  for(const value of ['[]','null','{"broken":{}}','{"x":{"command":"p","args":"a b"}}','{"x":{"command":"p","env":{"N":1}}}','{"x":{"url":"https://example.invalid","headers":{"X-Key":"synthetic"}}}','{"x":{"url":"https://example.invalid","oauth":{}}}'])assert.throws(()=>connections.parseBotConnectionImport(value));
});


test('connector cancellation binds the single reviewed HTTPS state and rejects ambiguous or unsafe links', () => {
  const state='a'.repeat(64);
  assert.equal(connections.connectorAuthorizationState('https://auth.fixture.invalid/authorize?state='+state),state);
  for(const value of [undefined,'javascript:alert(1)','http://auth.fixture.invalid/?state='+state,'https://user:secret@auth.fixture.invalid/?state='+state,'https://auth.fixture.invalid/?state=short','https://auth.fixture.invalid/?state='+state+'&state='+state]) assert.equal(connections.connectorAuthorizationState(value),null);
});
