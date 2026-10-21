import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, HostClient, publicBots, publicConversation } from '../bridge.mjs';
import { botProfileDraft } from '../bots-lifecycle.mjs';

const catalog = {
  bots: [{ id: 'bot_coder', name: 'Coder', provider: 'codex', model: 'default', capabilities: 'both', policy: 'manual',
    execution: { kind: 'ssh', host: 'SSH-SECRET', user: 'SSH-USER', identity: 'KEY-PATH' }, instructions: 'PRIVATE-INSTRUCTIONS',
    providerSettings: { apiKey: 'PROVIDER-SECRET', baseURL: 'PRIVATE-ENDPOINT' }, conversations: ['s_bot', '../invalid'] }],
  providers: [{ id: 'codex', name: 'Codex', available: true, detail: 'Ready on Mac', models: ['default'], token: 'TOKEN-SECRET' }],
  computers: [{ id: 'local', name: 'Your Mac', kind: 'local', available: true, detail: 'Ready', privateKey: 'PRIVATE-KEY' }],
};
const detail = {
  conversation: { id: 's_bot', title: 'Coder conversation', preferences: { botId: 'bot_coder', mode: 'manual', providerSettings: 'SECRET' },
    active: false, messages: [{ id: 'assistant', role: 'assistant', content: 'Earlier result', reasoning: 'Checked the files' }] }, pending: [],
};

function request(bridge, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function fixture(t, responder) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bots-test-'));
  const calls = [];
  const bridge = await createBridge({ directory, host: { async json(path, options) {
    calls.push({ path, ...options });
    return responder ? responder(path, options) : path === '/api/bots' ? structuredClone(catalog) : structuredClone(detail);
  } }, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, calls, ...bridge.authority.pair(bridge.authority.code, 'Bots fixture iPhone') };
}

test('bot catalog is a public projection with no provider credentials or SSH connection settings', () => {
  const clean = publicBots(catalog), encoded = JSON.stringify(clean);
  assert.deepEqual(clean.bots[0].execution, { kind: 'ssh' });
  assert.deepEqual(clean.bots[0].conversations, ['s_bot']);
  assert.equal(clean.bots[0].policy, 'manual'); assert.equal(clean.providers[0].available, true);
  for (const secret of ['SSH-SECRET', 'SSH-USER', 'KEY-PATH', 'PRIVATE-INSTRUCTIONS', 'PROVIDER-SECRET', 'PRIVATE-ENDPOINT', 'TOKEN-SECRET', 'PRIVATE-KEY']) assert.ok(!encoded.includes(secret), secret);
  assert.equal(publicConversation(detail.conversation).botId, 'bot_coder');
  assert.equal(publicConversation(detail.conversation, { summary: true }).botId, 'bot_coder');
  assert.equal(publicConversation({ ...detail.conversation, preferences: {} }).botId, undefined);
  assert.throws(() => publicBots({ bots: [] }), { status: 502 });
});

test('host permits only public bot listing and bounded saved-bot conversation selections', async () => {
  const calls = [];
  const host = new HostClient({ upstream: 'http://127.0.0.1:47831', fetcher: async (url, options) => { calls.push({ url, ...options }); return new Response('{}'); } });
  await host.request('/api/bots');
  await host.request('/api/bots/bot_coder/conversations', { method: 'POST', body: {} });
  await host.request('/api/bots/bot_coder/conversations', { method: 'POST', body: { policy: 'bypass' } });
  await host.request('/api/bots/bot_coder/conversations', { method: 'POST', body: { computerId: 'ssh_fixture', modelId: 'bm_fixture', workspace: '/srv/project' } });
  for (const [path, method, body] of [
    ['/api/bots', 'POST', {}], ['/api/bots/bot_coder', 'GET'], ['/api/bots/bot_coder', 'DELETE'],
    ['/api/bots/providers', 'PUT', { apiKey: 'secret' }], ['/api/bots/bot_coder/conversations', 'GET'],
    ['/api/bots/bot_coder/conversations', 'POST', { policy: 'invalid' }],
    ['/api/bots/bot_coder/conversations', 'POST', { computerId: 'https://external.test' }],
    ['/api/bots/bot_coder/conversations', 'POST', { modelSource: { connectionId: 'private' } }],
    ['/api/bots/bot_coder/conversations', 'POST', { workspace: 'relative' }],
    ['/api/bots', 'GET', {}],
    ['/api/bots?apiKey=true', 'GET'], ['/api/bots/../settings/conversations', 'POST', {}],
  ]) await assert.rejects(host.request(path, { method, body }), { status: 403 });
  assert.equal(calls.length, 4);
  assert.throws(() => new HostClient({ upstream: 'https://remote.test:443' }));
});

test('Devin phone profiles and catalog retain provider identity without account or SSH credentials', () => {
  const draft = { name: 'Devin partner', provider: 'devin', computerId: 'local', model: 'fixture-model', effort: '', workspace: '/workspace', policy: 'manual', capabilities: 'both' };
  assert.deepEqual(botProfileDraft(draft), draft);
  assert.throws(() => botProfileDraft({ ...draft, providerSettings: { apiKey: 'PRIVATE-DEVIN-KEY' } }), { status: 400 });
  const raw = structuredClone(catalog);
  raw.bots[0].provider = 'devin'; raw.providers[0].id = 'devin'; raw.providers[0].name = 'Devin CLI';
  raw.computers[0].providers = [{ id: 'devin', ready: true, credential: 'PRIVATE-DEVIN-KEY' }];
  const clean = publicBots(raw);
  assert.equal(clean.bots[0].provider, 'devin');
  assert.deepEqual(clean.providers[0], { id: 'devin', name: 'Devin CLI', available: true, detail: 'Ready on Mac', models: ['default'] });
  assert.deepEqual(clean.computers[0].providers, [{ id: 'devin', available: true }]);
  for (const secret of ['SSH-SECRET', 'SSH-USER', 'KEY-PATH', 'PROVIDER-SECRET', 'TOKEN-SECRET', 'PRIVATE-DEVIN-KEY']) assert.ok(!JSON.stringify(clean).includes(secret));
});

test('paired bot routes list without launching and create only a shared empty conversation', async t => {
  const { bridge, token, calls } = await fixture(t);
  assert.equal((await request(bridge, '/v1/bots')).status, 401);
  const listed = await request(bridge, '/v1/bots', { token });
  assert.equal(listed.status, 200); assert.equal(listed.json.bots[0].name, 'Coder');
  assert.deepEqual(calls, [{ path: '/api/bots' }], 'listing must not create a conversation or start a turn');
  const created = await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body: {} });
  assert.equal(created.status, 201); assert.equal(created.json.conversation.botId, 'bot_coder');
  assert.equal(created.json.conversation.messages[0].reasoning, 'Checked the files');
  assert.deepEqual(calls.at(-1), { path: '/api/bots/bot_coder/conversations', method: 'POST', body: {} });
  const count = calls.length;
  for (const body of [{ provider: 'kimi' }, { message: 'Run this' }, { execution: {} }, { policy: 'invalid' }, { apiKey: 'secret' }]) {
    assert.equal((await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body })).status, 400);
  }
  for (const path of ['/v1/bots/bot_coder', '/v1/bots/providers', '/v1/bots?include=credentials']) assert.equal((await request(bridge, path, { token })).status, 404);
  assert.equal(calls.length, count);
});

test('removed pairing cannot receive an in-flight bot catalog', async t => {
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { resume = resolve; });
  const { bridge, token, session } = await fixture(t, async () => { entered(); await blocked; return catalog; });
  const pending = request(bridge, '/v1/bots', { token });
  await waiting; bridge.authority.revoke(session.id); resume();
  const result = await pending;
  assert.equal(result.status, 401); assert.ok(!result.text.includes('Coder'));
});

test('old hosts explain unsupported bots and provider failures do not export raw diagnostic secrets', async t => {
  const { bridge, token } = await fixture(t, path => {
    throw Object.assign(new Error('INTERNAL-SECRET'), { status: path === '/api/bots' ? 404 : 409 });
  });
  const listed = await request(bridge, '/v1/bots', { token });
  assert.equal(listed.status, 200); assert.deepEqual(listed.json.bots, []); assert.match(listed.json.reason, /Update Strata/);
  const created = await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body: {} });
  assert.equal(created.status, 409); assert.ok(!created.text.includes('INTERNAL-SECRET'));
});

test('revocation while bot creation body arrives prevents any later host mutation', async t => {
  const { bridge, token, session, calls } = await fixture(t);
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const authorize = bridge.authority.authorize.bind(bridge.authority);
  bridge.authority.authorize = header => { const result = authorize(header); if (result) entered(); return result; };
  let finishBody;
  const pending = new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path: '/v1/bots/bot_coder/conversations', method: 'POST', agent: false, rejectUnauthorized: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text })); });
    req.on('error', reject); req.write('{'); finishBody = () => req.end('}');
  });
  await waiting; bridge.authority.revoke(session.id); finishBody();
  assert.equal((await pending).status, 401);
  assert.equal(calls.length, 0, 'revoked devices cannot create a bot conversation after the body finishes');
});

function selectableCatalog() {
  const value = structuredClone(catalog);
  value.bots[0] = { ...value.bots[0], provider: 'configured', avatar: '🦊', workspace: '/srv/project', modelSource: { connectionId: 'CONNECTION-PRIVATE', model: 'fixture-model' } };
  value.providers.push({ id: 'configured', name: 'Configured models', available: true, detail: 'Uses a saved model connection.' });
  value.computers.push({ id: 'ssh_fixture', name: 'Remote fixture', kind: 'ssh', available: true, detail: 'Ready', execution: { host: 'PRIVATE-HOST', user: 'PRIVATE-USER' } });
  value.models = [{ id: 'bm_fixture', connectionId: 'CONNECTION-PRIVATE', connectionName: 'Fixture connection', model: 'fixture-model', name: 'Configured fixture', available: true, detail: 'Ready', apiKey: 'MODEL-KEY', url: 'PRIVATE-ENDPOINT' }];
  return value;
}

test('avatars, configured models and computers expose only display data and stable catalog IDs', () => {
  const clean = publicBots(selectableCatalog()), encoded = JSON.stringify(clean);
  assert.equal(clean.selectionSupported, true); assert.equal(clean.bots[0].avatar, '🦊');
  assert.equal(clean.bots[0].modelId, 'bm_fixture'); assert.equal(clean.bots[0].provider, 'configured');
  assert.equal(clean.bots[0].workspace, '/srv/project');
  assert.deepEqual(clean.models[0], { id: 'bm_fixture', connectionName: 'Fixture connection', model: 'fixture-model', name: 'Configured fixture', available: true, detail: 'Ready' });
  for (const secret of ['CONNECTION-PRIVATE', 'PRIVATE-HOST', 'PRIVATE-USER', 'MODEL-KEY', 'PRIVATE-ENDPOINT']) assert.ok(!encoded.includes(secret), secret);
  const malformed = selectableCatalog(); malformed.bots[0].avatar = 'https://untrusted.test/avatar.png';
  assert.equal(publicBots(malformed).bots[0].avatar, '🤖');
  assert.equal(publicBots(catalog).selectionSupported, false, 'older hosts cannot silently ignore new selection fields');
  const frozen = publicConversation({ ...detail.conversation, preferences: { ...detail.conversation.preferences, botName: 'Original bot', botAvatar: '🧠', botComputer: 'Original computer', botModel: 'Original model' } });
  assert.equal(frozen.botName, 'Original bot'); assert.equal(frozen.botAvatar, '🧠');
  assert.equal(frozen.computerName, 'Original computer'); assert.equal(frozen.botModelName, 'Original model');
});

test('new conversation forwards only freshly cataloged target/model IDs and an absolute workspace', async t => {
  const { bridge, token, calls } = await fixture(t, path => path === '/api/bots' ? selectableCatalog() : detail);
  const body = { computerId: 'ssh_fixture', modelId: 'bm_fixture', workspace: '/srv/selected-project' };
  const result = await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body });
  assert.equal(result.status, 201);
  assert.deepEqual(calls, [{ path: '/api/bots' }, { path: '/api/bots/bot_coder/conversations', method: 'POST', body }]);
  assert.ok(!calls.some(call => /model-providers|native|prepare|serving|messages/.test(call.path)), 'selection does not change serving, prepare a server or start work');
  const before = calls.filter(call => call.method === 'POST').length;
  for (const body of [{ computerId: 'missing' }, { modelId: 'missing' }, { execution: { kind: 'ssh' } }, { modelSource: { connectionId: 'PRIVATE' } }, { workspace: '../relative' }, { workspace: '/tmp/\u0000invalid' }]) {
    const rejected = await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body });
    assert.ok([400, 409].includes(rejected.status));
  }
  assert.equal(calls.filter(call => call.method === 'POST').length, before);
});

test('unavailable targets and older hosts cannot accept model or folder overrides', async t => {
  const value = selectableCatalog(); value.computers[1].available = false; value.models[0].available = false;
  let old = false;
  const { bridge, token, calls } = await fixture(t, path => path === '/api/bots' ? old ? catalog : value : detail);
  for (const body of [{ computerId: 'ssh_fixture' }, { modelId: 'bm_fixture' }]) {
    assert.equal((await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body })).status, 409);
  }
  old = true;
  assert.equal((await request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body: { workspace: '/srv/project' } })).status, 409);
  assert.ok(calls.every(call => call.path === '/api/bots'));
});

test('revocation during selection catalog lookup prevents bot creation', async t => {
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { resume = resolve; });
  const { bridge, token, session, calls } = await fixture(t, async () => { entered(); await blocked; return selectableCatalog(); });
  const pending = request(bridge, '/v1/bots/bot_coder/conversations', { token, method: 'POST', body: { computerId: 'ssh_fixture' } });
  await waiting; bridge.authority.revoke(session.id); resume();
  assert.equal((await pending).status, 401);
  assert.deepEqual(calls, [{ path: '/api/bots' }]);
});

function editableCatalog() {
  const value = selectableCatalog();
  value.lifecycleSupported = true; value.defaultWorkspace = '/Users/fixture';
  value.bots[0] = { ...value.bots[0], instructions: 'Saved instructions', updatedAt: '2026-10-20T12:00:00.000Z', computerId: 'ssh_fixture', active: false };
  return value;
}
test('lifecycle capability exposes reviewed profile fields only on supporting hosts', () => {
  const clean = publicBots(editableCatalog());
  assert.equal(clean.lifecycleSupported, true); assert.equal(clean.defaultWorkspace, '/Users/fixture');
  assert.equal(clean.bots[0].instructions, 'Saved instructions'); assert.equal(clean.bots[0].updatedAt, '2026-10-20T12:00:00.000Z'); assert.equal(clean.bots[0].computerId, 'ssh_fixture');
  assert.equal(publicBots(catalog).lifecycleSupported, false); assert.equal(publicBots(catalog).bots[0].instructions, undefined);
  for (const secret of ['SSH-SECRET','PRIVATE-HOST','PRIVATE-USER','CONNECTION-PRIVATE','MODEL-KEY','PRIVATE-ENDPOINT']) assert.ok(!JSON.stringify(clean).includes(secret));
});
test('HostClient profile surface accepts bounded public drafts and rejects credentials or arbitrary SSH', async () => {
  const calls = []; const host = new HostClient({ upstream:'http://127.0.0.1:47831', fetcher:async(url,options)=>{calls.push({url,...options});return new Response('{}');} });
  await host.request('/api/bots/profile',{method:'POST',body:{name:'New',provider:'codex',computerId:'local'}});
  await host.request('/api/bots/bot_coder/profile',{method:'PATCH',body:{policy:'bypass',expectedUpdatedAt:'2026-10-20T12:00:00.000Z'}});
  for(const body of [{name:'Bad',provider:'codex',computerId:'local',execution:{host:'bad'}},{providerSettings:{apiKey:'bad'}},{expectedUpdatedAt:'2026-10-20T12:00:00.000Z',modelSource:{connectionId:'private'}},{expectedUpdatedAt:'2026-10-20T12:00:00.000Z',policy:null},{policy:'bypass'},{expectedUpdatedAt:'2026-10-20T12:00:00.000Z',avatarConfig:{kind:'web',url:'https://bad'}}]) await assert.rejects(host.request('/api/bots/bot_coder/profile',{method:'PATCH',body}),{status:403});
  assert.equal(calls.length,2);
});
test('paired phone creates and edits idle public bot profiles without preparing, starting or exposing private settings', async t => {
  const value = editableCatalog(); value.computers[1].available = false;
  const {bridge,token,calls}=await fixture(t,(path,options)=>{
    if(path==='/api/bots')return structuredClone(value);
    if(path==='/api/bots/profile'){
      const bot={...value.bots[0],id:'bot_new',name:options.body.name,policy:options.body.policy??'manual'};value.bots.push(bot);return {...structuredClone(value),bot};
    }
    if(path==='/api/bots/bot_new/profile'){
      const bot=value.bots.find(bot=>bot.id==='bot_new');Object.assign(bot,{instructions:options.body.instructions,policy:options.body.policy,updatedAt:'2026-10-20T12:00:00.001Z'});return {...structuredClone(value),bot};
    }
    throw Error('Unexpected mutation');
  });
  const draft={name:'Phone bot',provider:'configured',computerId:'ssh_fixture',modelId:'bm_fixture',workspace:'/srv/project',instructions:'Idle draft',capabilities:'both',computerMode:'host'};
  const created=await request(bridge,'/v1/bots',{token,method:'POST',body:draft});assert.equal(created.status,201);assert.equal(created.json.bot.policy,'manual');assert.equal(created.json.bots.length,2);
  assert.equal(created.json.bot.instructions,'Saved instructions');assert.ok(!JSON.stringify(created.json).includes('PRIVATE-HOST'));
  const edit={instructions:'Reviewed instructions',policy:'bypass',expectedUpdatedAt:created.json.bot.updatedAt};
  const saved=await request(bridge,'/v1/bots/bot_new',{token,method:'PATCH',body:edit});assert.equal(saved.status,200);assert.equal(saved.json.bot.policy,'bypass');assert.equal(saved.json.bot.instructions,'Reviewed instructions');
  assert.deepEqual(calls.map(c=>c.path),['/api/bots','/api/bots/profile','/api/bots','/api/bots/bot_new/profile']);
  assert.deepEqual(calls[1].body,draft);assert.deepEqual(calls[3].body,edit);
  assert.ok(!calls.some(c=>/prepare|serving|messages|computer\/start/.test(c.path)));
});
test('paired profile validation blocks stale or removed selections and old hosts before mutation', async t => {
  let value=editableCatalog();const {bridge,token,calls}=await fixture(t,()=>value);
  for(const body of [{name:'bad',provider:'codex',computerId:'removed'},{name:'bad',provider:'configured',computerId:'local',modelId:'removed'},{name:'bad',provider:'codex',computerId:'local',execution:{kind:'ssh'}},{name:'bad',provider:'codex',computerId:'local',providerSettings:{apiKey:'secret'}}]) assert.ok([400,409].includes((await request(bridge,'/v1/bots',{token,method:'POST',body})).status));
  const stale=await request(bridge,'/v1/bots/bot_coder',{token,method:'PATCH',body:{name:'stale',expectedUpdatedAt:'2026-10-19T12:00:00.000Z'}});assert.equal(stale.status,409);
  value=catalog;const old=await request(bridge,'/v1/bots',{token,method:'POST',body:{name:'new',provider:'codex',computerId:'local'}});assert.equal(old.status,409);assert.match(old.json.error,/Update Strata/);
  assert.ok(calls.every(c=>c.path==='/api/bots'));
});
test('pairing revocation during profile inventory read prevents a later save', async t => {
  let entered,resume;const ready=new Promise(r=>{entered=r;}),hold=new Promise(r=>{resume=r;});
  const {bridge,token,session,calls}=await fixture(t,async()=>{entered();await hold;return editableCatalog();});
  const pending=request(bridge,'/v1/bots',{token,method:'POST',body:{name:'new',provider:'codex',computerId:'local'}});
  await ready;bridge.authority.revoke(session.id);resume();assert.equal((await pending).status,401);assert.deepEqual(calls,[{path:'/api/bots'}]);
});
test('new-chat approval override stays bounded and reaches only the new conversation snapshot', async t => {
  const value=editableCatalog();const {bridge,token,calls}=await fixture(t,path=>path==='/api/bots'?value:detail);
  const created=await request(bridge,'/v1/bots/bot_coder/conversations',{token,method:'POST',body:{policy:'bypass'}});assert.equal(created.status,201);assert.deepEqual(calls.at(-1),{path:'/api/bots/bot_coder/conversations',method:'POST',body:{policy:'bypass'}});
  const before=calls.length;for(const policy of ['auto',null,true])assert.equal((await request(bridge,'/v1/bots/bot_coder/conversations',{token,method:'POST',body:{policy}})).status,400);assert.equal(calls.length,before);
});
test('older selection-capable hosts cannot silently ignore a new-chat approval override', async t => {
  const {bridge,token,calls}=await fixture(t,()=>selectableCatalog());
  for(const policy of ['manual','plan','bypass'])assert.equal((await request(bridge,'/v1/bots/bot_coder/conversations',{token,method:'POST',body:{policy}})).status,409);
  assert.ok(calls.every(call=>call.path==='/api/bots'));
});
