import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const { code } = await transform(await readFile(new URL('../src/lib/bots.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const bots = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('all five providers are independent from the model server registry', () => {
  assert.deepEqual(bots.BOT_PROVIDERS.map(provider => provider.id), ['claude', 'codex', 'grok', 'kimi', 'ollama']);
  const profile = bots.blankBot('/work/project');
  assert.equal(profile.policy, 'manual');
  assert.equal(profile.capabilities, 'both');
  assert.equal(profile.workspace, '/work/project');
  assert.deepEqual(profile.execution, { kind: 'local' });
  assert.equal(profile.providerSettings, undefined);
  assert.equal(profile.remoteModel, undefined);
  assert.equal(profile.avatar, '🤖');
});

test('avatars are curated values and configured models bind one connection without borrowing another', () => {
  assert.equal(bots.BOT_AVATARS.length, 8);
  assert.equal(bots.botAvatar('🦊'), '🦊');
  assert.equal(bots.botAvatar('https://example.test/avatar.png'), '🤖');
  const draft = { ...bots.blankBot('/work/project'), name: 'Builder', provider: 'configured' };
  assert.match(bots.botDraftError(draft), /saved Models connections/);
  assert.match(bots.botDraftError({ ...draft, avatar: '<img>', modelSource: { connectionId: 'maya', model: 'same-name' } }), /available bot avatars/);
  const models = [
    { id: 'maya-row', connectionId: 'maya', connectionName: 'Maya', model: 'same-name', name: 'Maya model' },
    { id: 'strata-row', connectionId: 'strata', connectionName: 'Strata', model: 'same-name', name: 'Strata model' },
  ];
  assert.equal(bots.configuredModel({ connectionId: 'maya', model: 'same-name' }, models).id, 'maya-row');
  assert.equal(bots.configuredModel({ connectionId: 'strata', model: 'same-name' }, models).id, 'strata-row');
  assert.equal(bots.configuredModel({ connectionId: 'removed', model: 'same-name' }, models), undefined);
  assert.equal(bots.botDraftError({ ...draft, model: 'same-name', modelSource: { connectionId: 'maya', model: 'same-name' } }), null);
});

test('saved SSH computer identity includes user and port, while custom targets stay explicit', () => {
  const computers = [{ id: 'ssh-garage', kind: 'ssh', execution: { kind: 'ssh', host: 'garage', user: 'operator', port: 22, name: 'Garage' } }];
  assert.equal(bots.botComputerSelection({ kind: 'ssh', host: 'garage', user: 'operator' }, computers), 'custom-ssh', 'Omitted port honors SSH configuration and must not become an explicit port 22.');
  assert.equal(bots.botComputerSelection({ kind: 'ssh', host: 'garage', user: 'operator', port: 22 }, computers), 'ssh-garage');
  assert.equal(bots.botComputerSelection({ kind: 'ssh', host: 'garage', user: 'other' }, computers), 'custom-ssh');
  assert.equal(bots.botComputerSelection({ kind: 'ssh', host: 'garage', user: 'operator', port: 2222 }, computers), 'custom-ssh');
  assert.equal(bots.botComputerSelection({ kind: 'local' }, computers), 'local');
});

test('bot history follows identity even when providers and computers overlap', () => {
  const sessions = [
    { id: 'regular', updatedAt: '2026-10-20', preferences: { remoteModel: { connectionId: 'maya', modelId: 'maya' } } },
    { id: 'old', updatedAt: '2026-10-18', preferences: { botId: 'bot-a' } },
    { id: 'other-bot', updatedAt: '2026-10-21', preferences: { botId: 'bot-b' } },
    { id: 'latest', updatedAt: '2026-10-20', preferences: { botId: 'bot-a' } },
  ];
  const before = structuredClone(sessions);
  assert.deepEqual(bots.botConversations(sessions, 'bot-a').map(session => session.id), ['latest', 'old']);
  assert.deepEqual(sessions, before);
});

test('profiles validate remote targets and provider addresses without requiring a fixed SSH username', () => {
  const draft = { ...bots.blankBot('/work/project'), name: 'Builder', execution: { kind: 'ssh', host: 'my-alias' } };
  assert.equal(bots.botDraftError(draft), null);
  assert.equal(bots.botComputerLabel(draft.execution), 'my-alias');
  assert.equal(bots.botComputerLabel({ kind: 'ssh', host: 'my-host', user: 'any-user', port: 2222 }), 'any-user@my-host:2222');
  assert.match(bots.botDraftError({ ...draft, execution: { kind: 'ssh' } }), /host or alias/);
  assert.match(bots.botDraftError({ ...draft, execution: { kind: 'ssh', host: 'my-alias', port: 0 } }), /1 to 65535/);
  assert.match(bots.botDraftError({ ...draft, execution: { kind: 'ssh', host: 'my-alias', port: 12.5 } }), /1 to 65535/);
  assert.match(bots.botDraftError({ ...draft, providerSettings: { baseURL: 'file:///tmp/model' } }), /HTTP or HTTPS/);
  assert.equal(bots.botDraftError({ ...draft, providerSettings: { baseURL: 'https://ollama.com/v1' } }), null);
});

test('embedded bot context follows immutable conversation labels and isolation after profile edits', () => {
  const profile = { ...bots.blankBot('/new-host-folder'), id: 'bot-a', name: 'Ada', provider: 'codex', model: 'new-model', computerMode: 'host' };
  const chat = { id: 'old-cua-chat', workspace: '/workspace', preferences: { botId: 'bot-a', botComputerMode: 'cua', botComputer: 'Chosen SSH computer', botModel: 'Maya · Maya-S24' } };
  const before = structuredClone([profile, chat]);
  assert.deepEqual(bots.botConversationContext(profile, chat), { chatId: 'old-cua-chat', computerMode: 'cua', computer: 'Chosen SSH computer', model: 'Maya · Maya-S24', workspace: '/workspace' });
  assert.deepEqual(bots.botConversationContext({ ...profile, computerMode: 'cua' }, { ...chat, workspace: '/old-host-folder', preferences: { ...chat.preferences, botComputerMode: 'host', botModel: 'grok · Provider default' } }), { chatId: 'old-cua-chat', computerMode: 'host', computer: 'Chosen SSH computer', model: 'grok · Provider default', workspace: '/old-host-folder' });
  assert.deepEqual([profile, chat], before);
});

test('missing or unrelated frozen settings never borrow the current profile computer or model', () => {
  const profile = { ...bots.blankBot('/new-folder'), id: 'bot-a', name: 'Ada', computerMode: 'cua', provider: 'codex', model: 'new' };
  const missing = bots.botConversationContext(profile, { id: 'old', preferences: { botId: 'bot-a' } });
  assert.equal(missing.computerMode, undefined); assert.equal(missing.computer, 'Conversation computer'); assert.equal(missing.model, 'Conversation model');
  const other = bots.botConversationContext(profile, { id: 'other', workspace: '/unrelated', preferences: { botId: 'bot-b', botComputerMode: 'cua', botComputer: 'Someone else', botModel: 'Other model' } });
  assert.equal(other.computerMode, undefined); assert.equal(other.computer, 'Conversation computer'); assert.equal(other.model, 'Conversation model'); assert.equal(other.workspace, '');
  const fresh = bots.botConversationContext(profile);
  assert.equal(fresh.computerMode, 'cua'); assert.equal(fresh.model, 'Codex · new'); assert.equal(fresh.workspace, '/new-folder');
});

test('approval vocabulary is explicit and guided setup validates the current stage', () => {
  assert.equal(bots.botPolicyLabel('bypass'), 'Bypass approvals');
  assert.equal(bots.botPolicyLabel('manual'), 'Ask before changes');
  const draft = { ...bots.blankBot('/work/project'), name: 'Builder' };
  assert.equal(bots.botSetupStepError(0, draft), null);
  assert.match(bots.botSetupStepError(0, { ...draft, name: ' '.repeat(5) }), /name/);
  assert.match(bots.botSetupStepError(2, { ...draft, provider: 'configured' }), /saved Models/);
  assert.match(bots.botSetupStepError(3, { ...draft, execution: {kind:'ssh'} }), /SSH host/);
  assert.match(bots.botSetupStepError(3, { ...draft, workspace:'relative/project' }), /full workspace path/);
  assert.equal(bots.botSetupStepError(3, { ...draft, workspace:'C:\\work\\project' }), null);
  assert.match(bots.botSetupStepError(3, { ...draft, computerMode:'cua' }), /\/workspace/);
  assert.equal(bots.blankBot('/work').policy, 'manual');
});

test('avatar activity follows shared thinking, live tool work and approvals, never computer availability', () => {
  const bot = { id:'bot-a', paused:false, available:true, computerMode:'cua' };
  const chat = { id:'chat-a', updatedAt:'2026-10-20', preferences:{botId:'bot-a'}, active:false, messages:[] };
  assert.equal(bots.botAvatarActivity(bot, [chat]), 'idle');
  const thinking = { ...chat, active:true, messages:[{id:'m1',role:'assistant',reasoning:'Working out the approach.',streaming:true}] };
  assert.equal(bots.botAvatarActivity(bot, [thinking]), 'thinking');
  const working = { ...thinking, messages:[{id:'m1',role:'assistant',tools:[{id:'t1',state:'running',live:true}]}] };
  assert.equal(bots.botAvatarActivity(bot, [working]), 'working');
  const pending = { ...chat, messages:[{id:'m1',role:'assistant',tools:[{id:'t1',state:'proposed',live:true}]}] };
  assert.equal(bots.botAvatarActivity(bot, [pending]), 'needsApproval');
  assert.equal(bots.botAvatarActivity({...bot,paused:true}, [working]), 'paused');
  assert.equal(bots.botAvatarActivity(bot, [{...chat,messages:[{id:'failed',role:'assistant',error:'Failed'}]}]), 'error');
  assert.equal(bots.botAvatarActivity(bot, [{...working,preferences:{botId:'someone-else'}}]), 'idle');
});

test('new reply signals are stable across streamed tokens and identify one completed bot reply', () => {
  const chat = { id:'chat-a', updatedAt:'2026-10-20', preferences:{botId:'bot-a'}, active:true, messages:[{id:'m1',role:'assistant',content:'Partial',streaming:true}] };
  assert.equal(bots.botReplySignal('bot-a', [chat]), undefined);
  const completed = {...chat,active:false,messages:[{id:'m1',role:'assistant',content:'Finished',streaming:false}]};
  assert.equal(bots.botReplySignal('bot-a', [completed]), 'chat-a:m1');
  assert.equal(bots.botReplySignal('bot-b', [completed]), undefined);
  assert.equal(bots.botReplySignal('bot-a', [{...completed,messages:[{...completed.messages[0],error:'Failed'}]}]), undefined);
});


test('roster previews belong to the latest bot conversation and use actual shared message text', () => {
  const sessions = [
    {id:'other',updatedAt:'2026-10-22',title:'Other title',preferences:{botId:'other'},messages:[{role:'assistant',content:'Do not borrow this preview.'}]},
    {id:'older',updatedAt:'2026-10-19',title:'Old title',preferences:{botId:'own'},messages:[{role:'assistant',content:'Old reply.'}]},
    {id:'latest',updatedAt:'2026-10-21',title:'Latest title',preferences:{botId:'own'},messages:[{role:'user',content:' Check\n this. '},{role:'assistant',content:' Actual shared\n reply. '}]},
  ];
  assert.deepEqual(bots.botRosterPreview('own',sessions),{text:'Actual shared reply.',updatedAt:'2026-10-21'});
  assert.equal(bots.botRosterPreview('missing',sessions),undefined);
  assert.deepEqual(bots.botRosterPreview('own',[{...sessions[2],messages:[]}]),{text:'Latest title',updatedAt:'2026-10-21'});
});

test('unified roster shows public team activity while keeping private team work out of direct captions', () => {
  const profiles = ['ava', 'iris'].map(id => ({id, name:id === 'ava' ? 'Ava' : 'Iris', createdAt:'2026-10-01T12:00:00Z', updatedAt:'2026-10-25T12:00:00Z'}));
  const sessions = [
    {id:'direct', updatedAt:'2026-10-21T12:00:00Z', preferences:{botId:'iris'}, messages:[{role:'assistant', content:'Direct review is ready.'}]},
    {id:'private-work', updatedAt:'2026-10-23T12:00:00Z', preferences:{botId:'iris', teamId:'crew', teamRunId:'run'}, messages:[{role:'user', content:'INTERNAL_ROUTER_MARKER'}]},
  ];
  const publicTeam = {id:'crew', name:'Product studio', createdAt:'2026-10-02T12:00:00Z', updatedAt:'2026-10-24T12:00:00Z', channelPreview:{id:'m9',sequence:9,kind:'message',author:{type:'bot',botId:'ava',name:'Ava'},content:'Public\n review is ready.',createdAt:'2026-10-22T12:00:00Z'}};
  const emptyTeam = {id:'empty',name:'Quiet room',createdAt:'2026-10-03T12:00:00Z',updatedAt:'2026-10-26T12:00:00Z'};
  const snapshot = {teams:[emptyTeam,publicTeam],runs:[{id:'run',teamId:'crew',state:'running',updatedAt:'2026-10-22T12:00:00Z'}]};
  const before=structuredClone({profiles,sessions,snapshot});
  const roster=bots.botConversationRoster(profiles,snapshot,sessions);
  assert.deepEqual(roster.map(row=>`${row.kind}:${row.id}`),['team:crew','bot:iris','team:empty','bot:ava']);
  assert.deepEqual(roster[0],{kind:'team',id:'crew',name:'Product studio',updatedAt:'2026-10-22T12:00:00Z',preview:'Ava: Public review is ready.',state:'working'});
  assert.equal(roster[1].preview,'Direct review is ready.');
  assert.equal(roster[2].preview,undefined);
  assert.equal(roster[2].updatedAt,emptyTeam.createdAt,'A settings edit is not conversation activity.');
  assert.equal(JSON.stringify(roster).includes('INTERNAL_ROUTER_MARKER'),false);
  assert.deepEqual(bots.botConversations(sessions,'iris').map(row=>row.id),['private-work','direct'],'Full existing bot history remains available.');
  assert.deepEqual({profiles,sessions,snapshot},before,'Deriving the roster does not change saved state.');
});

test('team previews validate real times and attribution, and mixed row activity comes from live runs', () => {
  const team={id:'crew',name:'Crew',createdAt:'2026-10-01',updatedAt:'2026-10-28',channelPreview:{id:'m1',sequence:1,kind:'message',author:{type:'user',name:'Device owner'},content:' Hello everyone. ',createdAt:'2026-10-21'}};
  assert.deepEqual(bots.botTeamRosterPreview(team),{text:'You: Hello everyone.',updatedAt:'2026-10-21'});
  assert.deepEqual(bots.botTeamRosterPreview({...team,channelPreview:{...team.channelPreview,author:{type:'system',name:'Strata'}}}),{text:'Team update: Hello everyone.',updatedAt:'2026-10-21'});
  assert.equal(bots.botTeamRosterPreview({...team,channelPreview:{...team.channelPreview,createdAt:'invalid'}}),undefined);
  assert.equal(bots.botTeamRosterPreview({...team,channelPreview:{...team.channelPreview,content:'  '}}),undefined);
  const state=runState=>bots.botConversationRoster([],{teams:[team],runs:[{id:'r',teamId:'crew',state:runState,updatedAt:'2026-10-21'}]},[])[0].state;
  assert.equal(state('cleanup_pending'),'attention');assert.equal(state('running'),'working');assert.equal(state('error'),'attention');assert.equal(state('cancelled'),'idle');
  assert.deepEqual(bots.botConversationRoster([],null,[]),[],'Older hosts without teams retain an empty group roster.');
});
