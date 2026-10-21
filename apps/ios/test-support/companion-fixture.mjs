import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOT_AVATAR_SHAPES, normalizeBotAvatar } from '../../host/server/bots.mjs';

// An explicit test host is always supplied. This fixture cannot discover or call
// a person's running Strata app, even when one is open on the same Mac.
const moduleURL = process.env.STRATA_TEST_BRIDGE_MODULE
  ? pathToFileURL(resolve(process.env.STRATA_TEST_BRIDGE_MODULE))
  : new URL('../../companion-bridge/bridge.mjs', import.meta.url);
const { createBridge } = await import(moduleURL.href);
const root = mkdtempSync(join(tmpdir(), 'strata-ios-ui-'));
chmodSync(root, 0o700);

const calls = [];
const photoSimulator = ['--test-bot-photos', '--test-team-channel-layout', '--test-group-chat-layout'].includes(process.argv[2]) ? /(?:^|,)id=([A-Fa-f0-9-]{36})(?:,|$)/.exec(process.argv[3] ?? '')?.[1] : undefined;
let originalSimulatorAppearance;
if (photoSimulator) {
  const appearance = execFileSync('/usr/bin/xcrun', ['simctl', 'ui', photoSimulator, 'appearance'], { encoding: 'utf8' }).trim().toLowerCase();
  if (!['light', 'dark'].includes(appearance)) throw new Error('Unknown scratch simulator appearance.');
  originalSimulatorAppearance = appearance;
}

const intro = 'Earlier Mac history is available on the phone.';
const follow = '\n\nNow I am checking the workspace.';
const reasoning = 'Inspect the existing conversation.\nI am reviewing the Mac workspace.';
const progressBlocks = (toolIds = []) => [
  { kind: 'text', text: intro },
  { kind: 'group', id: 'fixture-group-earlier', line: 'Ran 3 commands', closed: true, toolIds: [] },
  { kind: 'text', text: follow },
  { kind: 'group', id: 'fixture-group-live', line: 'Ran 3 commands, edited a file', closed: false, added: 8, removed: 2, toolIds },
];
const assistant = {
  id: 'fixture-assistant', role: 'assistant', content: intro + follow,
  reasoning, reasoningMs: 2400, streaming: false, blocks: progressBlocks(), tools: [],
};
const conversation = {
  id: 'fixture-mac-research', title: 'Mac browser research', updatedAt: new Date().toISOString(),
  workspace: join(root, 'Strata UI fixture'), modelName: 'Fixture model', mode: 'manual', active: false, status: 'Ready',
  messages: [{ id: 'fixture-user', role: 'user', content: 'Research this topic on the Mac.' }, assistant],
};
const pending = [];
let createdBotConversation;
const lifecycleMode = ['--test-bot-lifecycle', '--test-bot-avatar-states', '--test-bot-photos'].includes(process.argv[2]);
const workspaceFlags = ['--test-notifications', '--test-group-chat-layout', '--test-team-channel-layout', '--test-team-channel', '--test-bot-photos', '--test-bot-lifecycle', '--test-bot-avatar-states', '--test-workspace-skills', '--test-workspace-connections', '--test-workspace-teams', '--test-facelift'];
const workspaceMode = workspaceFlags.includes(process.argv[2]);
let teamConversation, savedTeam, teamRun;
const teamLimits = { maxParallel: 2, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 };
const skillDrafts = [];
const skillAssignments = { 'fixture-bot': ['library.review'] };
const skillCatalog = () => ({ skills: [{ id: 'library.review', name: 'Library review', description: 'Existing shared library instructions', body: 'Review changes carefully.', triggers: [], source: 'library', status: 'enabled', revision: 'library-digest', digest: 'library-digest' }, ...skillDrafts].map(skill => ({ ...skill, botIds: Object.entries(skillAssignments).filter(([, ids]) => ids.includes(skill.id)).map(([id]) => id) })), assignments: Object.entries(skillAssignments).map(([botId, skillIds]) => ({ botId, skillIds })) });
const mcpConnection = { id: 'mcpc_fixture', name: 'Fixture tools', transport: 'stdio', inventoryDigest: 'a'.repeat(64), command: '/fixture/never-executed', args: [], env: { TEST_SECRET: 'PRIVATE-FIXTURE-SECRET' }, apiKey: 'PRIVATE-FIXTURE-KEY', apiKeySet: true, status: 'unchecked', detail: 'Synthetic connection; no program runs.', botIds: ['fixture-bot'], enabledToolIds: ['tool_read'], readOnlyToolIds: ['tool_read'], tools: [{ id: 'tool_read', name: 'Read workspace', description: 'Synthetic read-only inventory', readOnly: true }, { id: 'tool_write', name: 'Write workspace', description: 'Synthetic write inventory; approval policy applies', readOnly: false }] };
const fixtureComputerMode = process.argv[2] === '--test-computer' ? 'cua' : 'host';
const configuredFixtureName = ['--test-bot-photos', '--test-team-channel-layout', '--test-group-chat-layout'].includes(process.argv[2]) ? 'Configured fixture / Qwen extended long model name for a separate remote Strata computer' : 'Configured fixture';
let botFace = { color: 'sky', eyes: 'star', ears: 'scalloped' };
if (process.argv[2] === '--test-bot-avatar-states') {
  conversation.preferences = { botId: 'fixture-bot', botName: 'Workspace companion', botAvatarConfig: structuredClone(botFace),
    botComputerMode: 'host', botComputer: 'Fixture Mac', botModel: 'Fixture model' };
}
let computerRunning = false;
let computerControl;
const computerImage = readFileSync(new URL('./computer-fixture.png', import.meta.url)).toString('base64');
const computerState = () => ({ available: true, running: computerRunning, computerName: 'Fixture isolated computer',
  detail: computerRunning ? 'Synthetic isolated computer. No VM, provider or SSH session is running.' : 'Prepared fixture. Start explicitly to see the synthetic screen.',
  ...(computerRunning ? { width: 640, height: 400, image: { mimeType: 'image/png', data: computerImage } } : {}),
  control: { active: !!computerControl, owned: !!computerControl, ...(computerControl ? { expiresAt: computerControl.expiresAt } : {}) } });
const botsCatalog = () => ({
  avatarShapes: [...BOT_AVATAR_SHAPES],
  bots: [{ id: 'fixture-bot', name: 'Workspace companion', avatar: '🦊', avatarConfig: botFace, computerMode: fixtureComputerMode, provider: 'codex', model: 'Fixture model', workspace: fixtureComputerMode === 'cua' ? '/workspace' : '/fixture/default', capabilities: 'both', policy: 'manual', execution: { kind: 'local' },
    conversations: [conversation.id, ...(createdBotConversation?.preferences?.botId === 'fixture-bot' ? [createdBotConversation.id] : []), ...(teamConversation ? [teamConversation.id] : [])] },
    ...(workspaceMode ? [{ id: 'fixture-reviewer', name: 'Review companion', avatarConfig: { color: 'violet', eyes: 'happy', ears: 'round', kind: 'cat' }, computerMode: 'host', provider: 'claude', model: 'Fixture reviewer', workspace: '/fixture/default', capabilities: 'code', policy: 'manual', execution: { kind: 'local' }, conversations: [] }] : [])],
  providers: ['claude', 'codex', 'grok', 'kimi', 'ollama', 'configured'].map(id => ({ id, name: ({ claude: 'Claude Code', codex: 'Codex', grok: 'Grok', kimi: 'Kimi', ollama: 'Ollama Cloud', configured: 'Configured models' })[id], available: true, detail: 'Synthetic provider. No account or model is used.' })),
  computers: [{ id: 'local', name: 'Fixture Mac', kind: 'local', available: true, detail: 'Synthetic computer. No tools are executed.' },
    { id: 'ssh_fixture', name: 'Remote fixture computer', kind: 'ssh', available: true, detail: 'Prepared synthetic target. No SSH connection is made.' }],
  models: [{ id: 'bm_fixture', connectionId: 'fixture-provider', connectionName: 'Fixture connection', model: 'configured-model', name: configuredFixtureName, available: true, detail: 'Synthetic configured model. Existing serving choices are unchanged.' }],
});
// The lifecycle UI fixture uses the actual host profile service in a private
// directory, with injected inert providers. No provider/SSH/VM runtime is created.
let lifecycleProfiles;
const lifecycleWorkspace = join(root, 'profile-workspace');
const lifecycleReloadedWorkspace = join(root, 'reloaded-workspace');
if (lifecycleMode) {
  mkdirSync(lifecycleWorkspace); mkdirSync(lifecycleReloadedWorkspace);
  const { createBots } = await import('../../host/server/bots.mjs');
  lifecycleProfiles = createBots({ directory: join(root, 'private-profile-store'),
    runtime: { providers: async () => botsCatalog().providers.filter(p => p.id !== 'configured'),
      run: async () => { throw new Error('A profile fixture must never run inference'); } },
    tools: {}, defaultWorkspace: () => lifecycleWorkspace,
    modelProviders: {
      list: () => ({ connections: [{ id: 'fixture-provider', name: 'Fixture connection', models: [{ id: 'configured-model', name: configuredFixtureName }] }] }),
      resolve({ connectionId, modelId }) {
        if (connectionId !== 'fixture-provider' || modelId !== 'configured-model') throw new Error('Unknown fixture model');
        return { connection: { id: connectionId, name: 'Fixture connection', baseUrl: 'https://fixture.invalid/v1' }, model: { id: modelId, name: configuredFixtureName } };
      },
    },
  });
}
// The new room acceptance uses the real durable bot/team/conversation services.
// Only model output is scripted. No provider, shell, SSH, browser or VM exists.
const teamChannelMode = ['--test-team-channel', '--test-team-channel-layout', '--test-group-chat-layout'].includes(process.argv[2]);
let roomBots, roomChats, roomTeam, roomEmptyTeam, roomMembers = [], roomTurns = [];
if (teamChannelMode) {
  const { createBots } = await import('../../host/server/bots.mjs');
  const { createConversations } = await import('../../host/server/conversations.mjs');
  const directory = join(root, 'actual-team-service');
  mkdirSync(directory, { mode: 0o700 });
  roomBots = createBots({ directory, defaultWorkspace: () => directory,
    conversations: () => roomChats,
    tools: { definitions: () => [], execute: () => { throw new Error('No external tools in native Team fixture'); }, finish: async () => {} },
    runtime: { providers: async () => [], close() {}, async run(input) {
      roomTurns.push({ botId: input.bot.id, mode: input.bot.teamContext?.channelMode, message: input.message, toolNames: input.tools.map(tool => tool.name) });
      input.onFrame({ type: 'reasoning', text: 'Review the shared team channel and answer as the named teammate.' });
      const mode = input.bot.teamContext?.channelMode;
      if (mode === 'routing') {
        if (input.message.includes('[Strata teammate result')) {
          input.onFrame({ type: 'delta', text: 'The team report is recorded. The fixture task is complete.' });
        } else if (input.message.includes('finished their public bids')) {
          await input.executeTool('assign_team_task', { botId: roomMembers[1].id, message: 'Implement the bounded fixture task and report in the channel.' }, 'fixture_assign');
          input.onFrame({ type: 'delta', text: 'Builder owns the fixture task. Reviewer will help with checks.' });
        } else if (input.message.toLowerCase().includes('who wants')) {
          await input.executeTool('invite_teammates', { botIds: roomMembers.slice(1).map(bot => bot.id), message: 'Who can own this bounded fixture task?', purpose: 'bid' }, 'fixture_bids');
          input.onFrame({ type: 'delta', text: 'Who can take this? Please share your fit here.' });
        } else if (input.message.toLowerCase().includes('hold')) {
          await input.executeTool('assign_team_task', { botId: roomMembers[1].id, message: 'Hold this synthetic task until Stop.' }, 'fixture_hold');
          input.onFrame({ type: 'delta', text: 'Builder is holding the synthetic task.' });
        } else {
          await input.executeTool('invite_teammates', { botIds: roomMembers.slice(1).map(bot => bot.id), message: 'Say hello to the team once.', purpose: 'conversation' }, 'fixture_hello');
          input.onFrame({ type: 'delta', text: 'Hi! I am Coordinator. We can work together here.' });
        }
      } else if (mode === 'bid') {
        input.onFrame({ type: 'delta', text: input.bot.name === 'Builder' ? 'I can implement it and report back here.' : 'I can review the implementation and help Builder.' });
      } else if (mode === 'task') {
        if (input.message.includes('Hold this')) await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
        else {
          await input.executeTool('invite_teammates', { botIds: [roomMembers[2].id], message: 'Reviewer, can you review my approach?', purpose: 'conversation' }, 'fixture_peer_question');
          input.onFrame({ type: 'delta', text: 'The fixture task is complete. Coordinator, the checks passed.' });
        }
      } else {
        input.onFrame({ type: 'delta', text: input.message.includes('review my approach') ? 'Builder, your approach looks good. I can help with the checks.' : `Hi everyone! I am ${input.bot.name}. Ready to help the team.` });
      }
    } },
  });
  roomChats = createConversations({ directory, enabled: () => true, pending: id => roomBots.pending(id), stop: id => roomBots.stop(id), approve: input => roomBots.approve(input), validateSelection: selection => roomBots.validateSelection(selection), execute: input => roomBots.run(input) });
  roomMembers = ['Coordinator', 'Builder', 'Reviewer'].map((name, index) => roomBots.create({ name, provider: 'codex', model: 'Fixture model', workspace: directory, policy: 'bypass', avatarConfig: { color: ['sky', 'orange', 'violet'][index], eyes: 'round', ears: 'round', shape: ['orb', 'tile', 'spark'][index] } }).bot);
  roomTeam = roomBots.team.create({ name: 'Engineering', memberIds: roomMembers.map(bot => bot.id), coordinatorId: roomMembers[0].id, enabled: true }).team;
  if (['--test-team-channel-layout', '--test-group-chat-layout'].includes(process.argv[2])) {
    // Layout-only UI reads an actual saved journal seeded by the inert fixture.
    // These setup turns have no provider or external tools and precede pairing.
    const until = async predicate => { const deadline = Date.now() + 5_000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Inert layout seed did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } };
    roomBots.team.message(roomTeam.id, { message: 'Hi everyone', requestId: 'seed_greeting' });
    await until(() => roomBots.team.channel(roomTeam.id).activeRuns.length === 0);
    const held = roomBots.team.message(roomTeam.id, { message: 'Hold this synthetic task', requestId: 'seed_hold' });
    await until(() => roomTurns.some(turn => turn.mode === 'task' && turn.message.includes('Hold this')));
    await roomBots.team.stop(roomTeam.id, held.run.id);
  }
  if (process.argv[2] === '--test-group-chat-layout') roomEmptyTeam = roomBots.team.create({ name: 'Design circle', memberIds: roomMembers.map(bot => bot.id), coordinatorId: roomMembers[0].id, enabled: true }).team;
}
const currentBotsCatalog = async () => {
  const base = botsCatalog();
  if (roomBots) return { ...base, ...await roomBots.list() };
  if (!lifecycleProfiles) return base;
  const real = await lifecycleProfiles.list();
  return { ...base, ...real, bots: [...base.bots, ...real.bots], selectionSupported: true,
    providers: base.providers, defaultPolicy: 'manual' };
};
const remoteTargetId = 'remote-aaaaaaaaaaaaaaaaaaaaaaaa';
const downloadJobs = new Map([['local', []], [remoteTargetId, []]]);
const downloadPlans = new Map();
let nextPlan = 0;
let nextDownload = 0;
let newestDownload;
let managementUnsupported = false;
const targetName = target => target === 'local' ? 'Fixture Mac' : 'Remote Strata';
const catalogModels = target => [{ id: 'catalog-native', name: 'Synthetic native model', sizeGb: 12,
  state: downloadJobs.get(target).some(job => job.modelId === 'catalog-native' && job.state === 'done') ? 'installed' : 'available',
  readPictures: true, detail: 'Synthetic catalog item. No model files are downloaded.' }];
const latestDownload = () => newestDownload;
const detail = () => structuredClone({ conversation, pending });
const tool = (id, state) => ({
  id, name: 'mcp__browser__browser_navigate', state, verb: 'Opened a page',
  target: 'https://example.com/research', preview: 'Read the example research page',
  effect: 'Use the browser on the Mac', scope: 'connected',
  result: 'Page title: Example research. Synthetic browser activity for UI verification.', live: true,
  ask: { why: 'Read this page in the Mac browser', detail: 'Synthetic approval request for a test fixture.' },
});
const notificationMode = process.argv[2] === '--test-notifications';
let notificationService;
const notificationMessages = [];
if (notificationMode) {
  const { createBotNotifications } = await import('../../host/server/bot-notifications.mjs');
  savedTeam = { id: 'team_notification', name: 'Notification team', memberIds: ['fixture-bot', 'fixture-reviewer'], coordinatorId: 'fixture-bot', enabled: true, limits: teamLimits, createdAt: new Date().toISOString() };
  notificationService = createBotNotifications({ directory: join(root, 'notification-service'), start: false,
    apns: { status: () => ({ configured: false, detail: 'Synthetic fixture: Apple push is not configured.' }) },
    native: { status: async () => ({ available: false }), setBridge() {} },
    sources: () => ({ conversations: [conversation], teams: [{ ...savedTeam, messages: notificationMessages }], approvals: pending.map(value => ({ ...value, chatId: conversation.id, botId: 'fixture-bot' })) }),
  });
  notificationService.reconcile();
}
const host = {
  async json(path, options = {}) {
    calls.push({ path, method: options.method ?? 'GET', body: options.body ?? null });
    if (notificationService) {
      const route = new URL(path, 'http://fixture.invalid');
      if (route.pathname === '/api/bots/notifications') return notificationService.feed(options.deviceId, { after: route.searchParams.has('after') ? Number(route.searchParams.get('after')) : undefined, journalId: route.searchParams.get('journalId') ?? undefined });
      if (route.pathname === '/api/bots/notifications/settings') return notificationService.settings(options.deviceId, options.body);
      if (route.pathname === '/api/bots/notifications/registration') return options.method === 'DELETE' ? notificationService.revoke(options.deviceId) : notificationService.registration(options.deviceId, options.body);
      if (route.pathname === '/api/bots/teams/team_notification/channel') return { supported: true, teamId: savedTeam.id, messages: notificationMessages, activeRuns: [], nextSequence: notificationMessages.length, hasMore: false, hasMoreBefore: false };
    }
    if (roomBots) {
      const route = new URL(path, 'http://fixture.invalid');
      if (route.pathname === '/api/bots/teams') return roomBots.team.list();
      const room = /^\/api\/bots\/teams\/([^/]+)\/(channel|messages)(?:\/([^/]+)\/(stop))?$/.exec(route.pathname);
      if (room) {
        if (room[2] === 'channel') return roomBots.team.channel(room[1], Object.fromEntries([...route.searchParams].map(([key, value]) => [key, Number(value)])));
        if (room[2] === 'messages') return roomBots.team.message(room[1], options.body);
      }
      const stop = /^\/api\/bots\/teams\/([^/]+)\/runs\/([^/]+)\/stop$/.exec(route.pathname);
      if (stop) return roomBots.team.stop(stop[1], stop[2]);
      if (path === '/api/bots/activity') return roomBots.team.activity();
      if (path === '/api/companion/conversations') return roomChats.list();
      const chat = /^\/api\/companion\/conversations\/([^/]+)$/.exec(route.pathname);
      if (chat) return roomChats.detail(chat[1]);
    }
    if (path === '/api/models') return { variants: [], loaded: null };
    if (path === '/api/native') return { instances: [], catalog: { families: [] } };
    if (path === '/api/monitor') return { phase: 'idle', outputTps: 12, hardware: { ramUsedGb: 8, ramTotalGb: 48 } };
    if (path === '/api/serving') return { requests: [] };
    if (path === '/api/model-providers') return { connections: [{ id: 'fixture-provider', name: 'Fixture Mac', models: [{ id: 'fixture-model', name: 'Fixture model' }] }] };
    if (path === '/api/bots') return currentBotsCatalog();
    const profileWrite = /^\/api\/bots(?:\/(bot_[a-f0-9-]+))?\/profile$/.exec(path);
    if (lifecycleProfiles && profileWrite) {
      const saved = await lifecycleProfiles.saveProfile(options.body, profileWrite[1]);
      return { ...await currentBotsCatalog(), bot: saved.bot };
    }
    const profileChat = /^\/api\/bots\/(bot_[a-f0-9-]+)\/conversations$/.exec(path);
    if (lifecycleProfiles && profileChat) {
      const bot = (await lifecycleProfiles.list()).bots.find(value => value.id === profileChat[1]);
      if (!bot) throw Object.assign(new Error('Missing saved profile'), { status: 404 });
      const policy = options.body?.policy ?? bot.policy;
      if (!['manual', 'plan', 'bypass'].includes(policy)) throw Object.assign(new Error('Unsupported approval mode'), { status: 400 });
      createdBotConversation = { id: 'fixture-bot-created', title: bot.name + ' conversation', active: false, mode: policy,
        workspace: bot.workspace, modelName: bot.model, messages: [],
        preferences: { botId: bot.id, botName: bot.name, botAvatarConfig: bot.avatarConfig, botComputerMode: bot.computerMode,
          botComputer: 'Fixture Mac', botModel: bot.model } };
      return { conversation: createdBotConversation, pending: [] };
    }
    if (path === '/api/bots/provider-models?provider=codex') return { provider: 'codex', models: [{ id: 'Fixture model', name: 'Fixture model', efforts: ['low', 'high'] }] };
    if (workspaceMode && path === '/api/bots/teams') {
      if (options.method === 'POST') { savedTeam = { id: 'team_fixture', ...structuredClone(options.body), enabled: false, limits: options.body.limits ?? teamLimits }; return { team: savedTeam }; }
      return { teams: savedTeam ? [savedTeam] : [], runs: teamRun ? [teamRun] : [] };
    }
    if (workspaceMode && path.startsWith('/api/bots/teams/team_fixture/channel')) throw Object.assign(new Error('Shared channels require the new host'), { status: 404 });
    if (workspaceMode && path === '/api/bots/teams/team_fixture' && options.method === 'PATCH') { Object.assign(savedTeam, options.body); return { team: savedTeam }; }
    if (workspaceMode && path === '/api/bots/teams/team_fixture/runs') {
      if (!savedTeam?.enabled) throw Object.assign(new Error('Review and enable fixture team first'), { status: 409 });
      teamRun = { id: 'run_fixture', teamId: savedTeam.id, rootChatId: 'fixture-team-chat', rootBotId: savedTeam.coordinatorId, state: 'running', limits: savedTeam.limits, consumedTurns: 2 };
      teamConversation = { id: 'fixture-team-chat', title: 'Team review task', active: true, status: 'Working with reviewer', mode: 'manual', workspace: '/fixture/default', preferences: { botId: savedTeam.coordinatorId, botName: 'Workspace companion', botAvatarConfig: botFace, botComputerMode: 'host', botComputer: 'Fixture Mac', botModel: 'Fixture model', teamId: savedTeam.id, teamRunId: teamRun.id }, messages: [{ id: 'team-user', role: 'user', content: options.body.message }, { id: 'team-assistant', role: 'assistant', content: 'The reviewer is checking the workspace.', reasoning: 'Delegate a focused review and retain the shared conversation.', reasoningMs: 1000, streaming: true }] };
      return { run: teamRun, conversation: teamConversation, pending: [] };
    }
    if (workspaceMode && path === '/api/bots/teams/team_fixture/runs/run_fixture/stop') { teamRun.state = 'cancelled'; teamConversation.active = false; teamConversation.messages.forEach(message => { message.streaming = false; }); return { run: teamRun }; }
    if (workspaceMode && path === '/api/bots/activity') return { activity: teamRun ? [{ id: 'activity-message', type: 'delivery', title: 'Coordinator message', state: 'delivered', teamId: savedTeam.id, runId: teamRun.id, fromBotId: savedTeam.coordinatorId, toBotId: 'fixture-reviewer', chatId: teamConversation.id }, { id: 'activity-subagent', type: 'subagent', title: 'Reviewer subagent', state: teamRun.state, teamId: savedTeam.id, runId: teamRun.id, botId: 'fixture-reviewer', parentChatId: teamConversation.id, chatId: teamConversation.id, detail: 'Durable synthetic delegation. No provider or computer was started.' }] : [] };
    if (workspaceMode && path === '/api/bots/skills') {
      if (options.method === 'POST') { const skill = { id: 'skill_created', ...structuredClone(options.body), source: 'draft', status: 'draft', revision: 1, digest: 'draft-digest' }; skillDrafts.push(skill); return { skill: { ...skill, botIds: [] } }; }
      return skillCatalog();
    }
    if (workspaceMode && path === '/api/bots/skills/skill_created' && options.method === 'PATCH') { const skill = skillDrafts[0]; Object.assign(skill, options.body); skill.revision++; return { skill: { ...skill, botIds: skillCatalog().skills.find(s => s.id === skill.id).botIds } }; }
    if (workspaceMode && path === '/api/bots/skills/assign') { skillAssignments[options.body.botId] = [...options.body.skillIds]; return skillCatalog(); }
    if (workspaceMode && path === '/api/bots/connections') return { connections: [mcpConnection] };
    if (workspaceMode && path === '/api/bots/connections/mcpc_fixture/check') { mcpConnection.status = 'connected'; mcpConnection.detail = 'Two synthetic tools available. No program was executed.'; mcpConnection.checkedAt = new Date().toISOString(); return { connection: mcpConnection }; }
    if (workspaceMode && path === '/api/bots/connections/mcpc_fixture' && options.method === 'PATCH') { Object.assign(mcpConnection, options.body); return { connection: mcpConnection }; }
    if (teamConversation && path.startsWith(`/api/companion/conversations/${teamConversation.id}`)) return { conversation: teamConversation, pending: [] };
    if (path === '/api/bots/fixture-bot' && options.method === 'PATCH') { botFace = normalizeBotAvatar(options.body.avatarConfig, botFace); return {}; }
    const computer = /^\/api\/bots\/fixture-bot\/computer(?:\/(start|stop|takeover|control|release))?(?:\?chatId=([A-Za-z0-9_-]+))?$/.exec(path);
    if (computer) {
      const action = computer[1];
      if (action === 'start') computerRunning = true;
      if (action === 'stop') { computerRunning = false; computerControl = null; return { stopped: true }; }
      if (action === 'takeover') { if (!computerRunning) throw Object.assign(new Error('Start fixture first'), { status: 409 }); computerControl = { leaseToken: 'fixture_lease_0123456789', expiresAt: Date.now() + 120_000 }; return { ...computerState(), ...computerControl }; }
      if (action === 'control') { if (!computerControl || options.body.leaseToken !== computerControl.leaseToken) throw Object.assign(new Error('No control'), { status: 403 }); return { accepted: true }; }
      if (action === 'release') { computerControl = null; return { released: true }; }
      return computerState();
    }
    if (path === '/api/bots/fixture-bot/conversations') {
      createdBotConversation = { id: 'fixture-bot-created', title: 'New Workspace companion conversation', active: false, mode: 'manual',
        workspace: options.body?.workspace ?? '/fixture/default',
        preferences: { botId: 'fixture-bot', botName: 'Workspace companion', botAvatar: '🦊', botAvatarConfig: structuredClone(botFace), botComputerMode: fixtureComputerMode,
          botComputer: options.body?.computerId === 'ssh_fixture' ? 'Remote fixture computer' : 'Fixture Mac',
          botModel: options.body?.modelId === 'bm_fixture' ? 'Configured fixture' : 'Fixture model' },
        modelName: options.body?.modelId === 'bm_fixture' ? 'Configured fixture' : 'Fixture model', messages: [] };
      return structuredClone({ conversation: createdBotConversation, pending: [] });
    }
    if (createdBotConversation && path.startsWith(`/api/companion/conversations/${createdBotConversation.id}`)) {
      if (path.endsWith('/messages')) {
        createdBotConversation.messages.push({ id: 'bot-user', role: 'user', content: options.body.message },
          { id: 'bot-assistant', role: 'assistant', content: 'BOT_SAME_SESSION_CONTINUED', reasoning: 'Review the requested change.', reasoningMs: 1200, streaming: true });
        createdBotConversation.active = true;
      } else if (path.endsWith('/stop')) {
        createdBotConversation.active = false;
        for (const message of createdBotConversation.messages) message.streaming = false;
      }
      return structuredClone({ conversation: createdBotConversation, pending: [] });
    }
    if (path === '/api/model-management/targets') {
      if (managementUnsupported) throw Object.assign(new Error('Unsupported management endpoint'), { status: 404 });
      return { targets: [{ id: 'local', name: 'Fixture Mac', kind: 'local' }, { id: remoteTargetId, name: 'Remote Strata', kind: 'remote' }] };
    }
    const management = /^\/api\/model-management\/targets\/(local|remote-[a-f0-9]{24})(?:\/(plan|downloads)(?:\/([a-zA-Z0-9_-]+)\/cancel)?)?$/.exec(path);
    if (management) {
      const [, target, action, jobId] = management;
      if (!downloadJobs.has(target)) throw new Error('Unknown synthetic target');
      if (!action) return structuredClone({ supported: true, targetName: targetName(target), capabilities: { downloads: true, imports: false }, models: catalogModels(target), jobs: downloadJobs.get(target) });
      if (action === 'plan') {
        if (!catalogModels(target).some(model => model.id === options.body?.modelId) || typeof options.body?.readPictures !== 'boolean') throw new Error('Invalid typed synthetic plan request');
        const plan = { planId: `fixture-plan-${++nextPlan}`, targetName: targetName(target), modelName: 'Synthetic native model', downloadGb: 12, diskFreeGb: 100, diskNeededGb: 14,
          readPictures: options.body.readPictures, expiresAt: Date.now() + 60_000,
          warnings: ['Running native models will be unloaded before preparing files.', 'The engine may be downloaded or updated.', 'The model will not be loaded automatically.'] };
        downloadPlans.set(plan.planId, { ...plan, target, modelId: options.body.modelId });
        return plan;
      }
      if (jobId) {
        const job = downloadJobs.get(target).find(job => job.id === jobId);
        if (!job || !job.canCancel) throw new Error('Unknown or unowned synthetic job');
        job.state = 'cancelled'; job.summary = 'Download stopped. Completed files are kept.'; job.canCancel = false;
        return structuredClone({ job });
      }
      const plan = downloadPlans.get(options.body?.planId);
      if (!plan || plan.target !== target || plan.expiresAt <= Date.now()) throw new Error('Missing or expired synthetic plan');
      downloadPlans.delete(plan.planId);
      const job = { id: `fixture-download-${++nextDownload}`, modelId: plan.modelId, name: 'Synthetic native model', kind: 'download', state: 'running', summary: 'Downloading synthetic model files', percent: 10, doneGb: 1.2, totalGb: 12, canCancel: true };
      downloadJobs.get(target).unshift(job); newestDownload = job;
      return structuredClone({ job });
    }
    if (path === '/api/companion/conversations') return options.method === 'POST' ? detail() : { conversations: [conversation, ...(createdBotConversation ? [createdBotConversation] : []), ...(teamConversation ? [teamConversation] : [])], activeChatId: teamConversation?.active ? teamConversation.id : conversation.id };
    if (path === `/api/companion/conversations/${conversation.id}`) return detail();
    if (path === `/api/companion/conversations/${conversation.id}/messages`) {
      conversation.messages.push(
        { id: 'fixture-continued-user', role: 'user', content: options.body.message },
        { id: 'fixture-continued-assistant', role: 'assistant', content: 'SAME_MAC_SESSION_CONTINUED', streaming: true, tools: [] },
      );
      conversation.active = true; conversation.status = 'Working';
      return detail();
    }
    if (path === `/api/companion/conversations/${conversation.id}/approval`) {
      const current = pending.find(action => action.id === options.body.toolId);
      if (!current) throw new Error('Stale fixture approval');
      current.state = options.body.decision === 'approve' ? 'done' : 'denied';
      current.approved = options.body.decision === 'approve';
      pending.splice(pending.indexOf(current), 1);
      return detail();
    }
    if (path === `/api/companion/conversations/${conversation.id}/stop`) {
      conversation.active = false; conversation.status = 'Stopped';
      for (const message of conversation.messages) message.streaming = false;
      return detail();
    }
    throw new Error('Unexpected synthetic host path: ' + path);
  },
};

let bridge;
let control;
let testProcess;
let closing;
async function close() {
  if (photoSimulator && originalSimulatorAppearance) {
    execFileSync('/usr/bin/xcrun', ['simctl', 'ui', photoSimulator, 'appearance', originalSimulatorAppearance]);
    originalSimulatorAppearance = undefined;
  }
  closing ??= (async () => {
    try {
      if (testProcess && testProcess.exitCode === null) testProcess.kill('SIGTERM');
      if (control?.listening) await new Promise(resolve => control.close(resolve));
      notificationService?.close();
      await bridge?.close();
      await lifecycleProfiles?.close();
      await roomBots?.close(); roomChats?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  })();
  return closing;
}
for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, async () => { await close(); process.exit(status); });
}

try {
  bridge = await createBridge({ directory: join(root, 'bridge'), host, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false });
  control = http.createServer(async (request, response) => {
    try {
      const action = request.url;
      if (request.method === 'POST') {
        switch (action) {
        case '/notification-reply':
          if (!notificationService) throw new Error('Notification fixture required');
          conversation.messages.push({ id: 'notification-reply-' + conversation.messages.length, role: 'assistant', content: 'PRIVATE_NOTIFICATION_PREVIEW must remain inside the chat.', reasoning: 'PRIVATE_THINKING', streaming: false, at: new Date().toISOString() });
          notificationService.reconcile();
          break;
        case '/notification-team':
          if (!notificationService) throw new Error('Notification fixture required');
          notificationMessages.push({ id: 'team-message-' + notificationMessages.length, sequence: notificationMessages.length + 1, teamId: savedTeam.id, kind: 'message', author: { type: 'bot', botId: 'fixture-reviewer', name: 'Review companion', avatarConfig: { color: 'violet', eyes: 'happy', ears: 'round' } }, content: 'Hello from the notification team.', createdAt: new Date().toISOString() });
          notificationService.reconcile();
          break;
        case '/notification-approval':
          if (!notificationService) throw new Error('Notification fixture required');
          pending.push(tool('notification-approval-' + pending.length, 'proposed'));
          notificationService.reconcile();
          break;
        case '/state':
          break;
        case '/profile-change': {
          if (!lifecycleProfiles) throw new Error('Lifecycle fixture required');
          const bot = (await lifecycleProfiles.list()).bots[0];
          if (!bot) throw new Error('Create a fixture profile first');
          await lifecycleProfiles.saveProfile({ expectedUpdatedAt: bot.updatedAt, name: 'Mac reviewed bot', provider: 'codex', model: 'Fixture model', effort: 'high', policy: 'plan', computerId: 'local', workspace: lifecycleReloadedWorkspace }, bot.id);
          break;
        }
        case '/team-room-state':
          break;
        case '/team-progress':
          if (!teamRun) throw new Error('Start a synthetic team first');
          teamRun.consumedTurns = 7;
          break;
        case '/download-progress': {
          const job = latestDownload();
          if (!job) throw new Error('Start a synthetic download first');
          job.percent = 65; job.doneGb = 7.8; job.summary = 'Downloading picture reader';
          break;
        }
        case '/download-error': {
          const job = latestDownload();
          if (!job) throw new Error('Start a synthetic download first');
          job.state = 'error'; job.error = 'Synthetic network interruption. Completed files can be reused.'; job.canCancel = false;
          break;
        }
        case '/download-complete': {
          const job = latestDownload();
          if (!job) throw new Error('Start a synthetic download first');
          job.state = 'done'; job.summary = 'Model files are ready on the computer.'; job.percent = 100; job.doneGb = 12; job.canCancel = false; delete job.error;
          break;
        }
        case '/management-unsupported':
          managementUnsupported = true;
          break;
        case '/thinking':
          conversation.active = true; conversation.status = 'Thinking';
          assistant.content = ''; assistant.blocks = []; assistant.streaming = true; delete assistant.reasoningMs;
          break;
        case '/progress':
          conversation.active = true; conversation.status = 'Working';
          assistant.content = intro + follow; assistant.blocks = progressBlocks(); assistant.reasoningMs = 2400; assistant.streaming = true;
          break;
        case '/browser':
          conversation.active = true; conversation.status = 'Browsing the web';
          assistant.streaming = true; assistant.tools = [tool('browser-live', 'running')]; assistant.blocks = progressBlocks(['browser-live']);
          break;
        case '/allow':
        case '/deny': {
          const approval = tool(action === '/allow' ? 'helper-session:approve-action' : 'helper-session:deny-action', 'proposed');
          assistant.tools.push(approval); pending.push(approval);
          break;
        }
        case '/approval-resolved':
          for (const action of pending) action.state = 'denied'; pending.splice(0);
          break;
        case '/reply-error':
          conversation.active = false; assistant.streaming = false; assistant.error = 'Synthetic failed reply';
          break;
        case '/appearance-dark':
        case '/appearance-light':
          if (!photoSimulator || !originalSimulatorAppearance) throw new Error('Appearance controls require the explicit photo QA simulator.');
          execFileSync('/usr/bin/xcrun', ['simctl', 'ui', photoSimulator, 'appearance', action === '/appearance-dark' ? 'dark' : 'light']);
          break;
        case '/complete':
          conversation.active = false; conversation.status = 'Ready';
          if (assistant.tools[0]) assistant.tools[0].state = 'done';
          assistant.streaming = false; assistant.reasoningMs = 6500;
          assistant.blocks.find(block => block.id === 'fixture-group-live').closed = true;
          break;
        default: response.writeHead(404).end(); return;
        }
      } else if (request.method !== 'GET' || action !== '/state') {
        response.writeHead(404).end(); return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ conversation, createdBotConversation, pending, calls, ...(roomBots ? { teamChannel: roomBots.team.channel(roomTeam.id), roomTurns, roomTeam, roomEmptyTeam } : {}), ...(lifecycleProfiles ? { lifecycle: await lifecycleProfiles.list() } : {}), computerRunning, computerControlled: !!computerControl, botFace, downloadJobs: Object.fromEntries(downloadJobs), planCount: nextPlan, downloadCount: nextDownload }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
  const connection = { invitation: bridge.invitation(), control: `http://127.0.0.1:${control.address().port}` };
  if (['--test', '--test-downloads', '--test-bots', '--test-computer', ...workspaceFlags].includes(process.argv[2])) {
    const destination = process.argv[3];
    if (!destination) throw new Error('Supply an installed simulator destination after --test.');
    const platforms = destination.split(',').map(value => value.trim()).filter(value => value.startsWith('platform='));
    if (platforms.length !== 1 || platforms[0] !== 'platform=iOS Simulator') {
      throw new Error('The UI fixture requires an explicit platform=iOS Simulator destination. Physical devices are not supported.');
    }
    const project = fileURLToPath(new URL('../StrataMobile.xcodeproj', import.meta.url));
    const derivedData = process.env.STRATA_TEST_DERIVED_DATA ?? fileURLToPath(new URL('../build', import.meta.url));
    const status = await new Promise((resolve, reject) => {
      testProcess = spawn('xcodebuild', [
        '-project', project, '-scheme', 'StrataMobile', '-destination', destination,
        '-derivedDataPath', derivedData,
        '-only-testing:StrataMobileUITests/CompanionSmokeTests/' + ({ '--test': 'testSharedMacHistoryLiveBrowserApprovalAndContinuation', '--test-downloads': 'testModelDownloadReviewProgressCancelRetryAndTargetSelection', '--test-bots': 'testBotsSharedHistoryThinkingAndNewConversation', '--test-computer': 'testActualSampleAvatarAndIsolatedComputerControl', '--test-bot-photos': 'testPhotoLedBotsCreationAppearanceAndWorkspaceNavigation', '--test-bot-lifecycle': 'testPhoneBotCreationEditingCASAndApprovalModes', '--test-bot-avatar-states': 'testBotAvatarStatesInteractionAndRosterFilters', '--test-facelift': 'testFaceliftPrincipalScreensAndSharedHistory', '--test-workspace-skills': 'testReviewedSkillAssignmentAndWorkspaceNavigation', '--test-workspace-connections': 'testSavedConnectionCheckAndReviewedAccess', '--test-workspace-teams': 'testTeamExplicitTaskSharedThinkingStopAndActivity', '--test-team-channel': 'testNaturalTeamChannelPeersAssignmentsThinkingAndStop', '--test-team-channel-layout': 'testTeamChannelNormalDarkAndLargeTypeLayout', '--test-group-chat-layout': 'testGroupRosterAndRoomPhotoLayoutWithRealMenus', '--test-notifications': 'testNotificationPreferencesPrivateInboxRoutingMuteAndRelaunch' })[process.argv[2]],
        '-parallel-testing-enabled', 'NO', 'test',
      ], { stdio: 'inherit', env: { ...process.env,
        TEST_RUNNER_STRATA_TEST_INVITATION: connection.invitation,
        TEST_RUNNER_STRATA_SHARED_FIXTURE_CONTROL: connection.control,
        TEST_RUNNER_STRATA_MODEL_MANAGEMENT_FIXTURE_CONTROL: connection.control,
      } });
      testProcess.once('error', reject);
      testProcess.once('exit', code => resolve(code ?? 1));
    });
    process.exitCode = status;
    if (process.env.STRATA_TEST_STATE_OUTPUT) writeFileSync(process.env.STRATA_TEST_STATE_OUTPUT, JSON.stringify({ calls, ...(roomBots ? { teamChannel: roomBots.team.channel(roomTeam.id), roomTurns, roomTeam, roomEmptyTeam } : {}), ...(lifecycleProfiles ? { lifecycle: await lifecycleProfiles.list() } : {}), savedTeam, teamRun, skillAssignments, skills: skillCatalog(), connectionAccess: { botIds: mcpConnection.botIds, enabledToolIds: mcpConnection.enabledToolIds, readOnlyToolIds: mcpConnection.readOnlyToolIds } }), { mode: 0o600 });
    await close();
  } else {
    if (process.argv.length > 2) throw new Error('Usage: companion-fixture.mjs [--test|--test-downloads|--test-bots|--test-computer|--test-workspace-skills|--test-workspace-connections|--test-workspace-teams|--test-facelift|--test-bot-lifecycle|--test-bot-avatar-states <simulator destination>]');
    const connectionFile = join(root, 'connection.json');
    writeFileSync(connectionFile, JSON.stringify(connection), { mode: 0o600 });
    console.log(JSON.stringify({ connectionFile }));
  }
} catch (error) {
  await close();
  console.error(error.message);
  process.exitCode = 1;
}
