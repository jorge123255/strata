import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
async function source(path) { const {code}=await transform(await readFile(new URL(path,import.meta.url),'utf8'),{loader:'ts',format:'esm'});return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`); }
const bots=await source('../src/lib/bots.ts'),connections=await source('../src/lib/bot-connections.ts');
test('team validation rejects missing members, stale bot identity, foreign coordinators and unbounded work',()=>{
  const draft={name:'Crew',memberIds:['a','b'],coordinatorId:'a',limits:{...bots.DEFAULT_BOT_TEAM_LIMITS}},roster=[{id:'a'},{id:'b'}];
  assert.equal(bots.botTeamDraftError(draft,roster),null);
  for(const changes of [{memberIds:[]},{memberIds:['a','a']},{memberIds:['a','removed']},{coordinatorId:'outside'},{limits:{...draft.limits,maxDurationMs:59999}},{limits:{...draft.limits,maxParallel:9}},{limits:{...draft.limits,maxDepth:1.5}}])assert.ok(bots.botTeamDraftError({...draft,...changes},roster));
  assert.equal(bots.botTeamRunActive('cleanup_pending'),true);assert.equal(bots.botTeamRunActive('cancelled'),false);assert.equal(bots.botActivityLabel('cleanup_pending'),'Checking cleanup');
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
