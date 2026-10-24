import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
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
const routeMode = ['--test-connection-routes', '--test-route-tls'].includes(process.argv[2]);
const routeRequests = [];
const routeServers = [];
let routeAddresses;
const photoSimulator = ['--test-team-work-tools', '--test-team-work-overview', '--test-team-review', '--test-team-compact', '--test-supervision', '--test-direct-bots', '--test-team-settings', '--test-team-instructions', '--test-bot-photos', '--test-team-channel-layout', '--test-group-chat-layout'].includes(process.argv[2]) ? /(?:^|,)id=([A-Fa-f0-9-]{36})(?:,|$)/.exec(process.argv[3] ?? '')?.[1] : undefined;
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
const directCreatedConversations = [];
const lifecycleMode = ['--test-devin-provider', '--test-bot-lifecycle', '--test-bot-avatar-states', '--test-bot-photos'].includes(process.argv[2]);
const directBotsMode = process.argv[2] === '--test-direct-bots';
const connectorAccountsMode = process.argv[2] === '--test-connector-accounts';
const connectorMode = connectorAccountsMode || process.argv[2] === '--test-connectors';
const teamFollowMode = process.argv[2] === '--test-team-follow';
const teamPlansMode = process.argv[2] === '--test-team-plans';
const workflowMode = teamFollowMode || process.argv[2] === '--test-team-workflows';
const harnessMode = process.argv[2] === '--test-harness';
const supervisionMode = harnessMode || process.argv[2] === '--test-supervision';
const unrestrictedTeamsMode = process.argv[2] === '--test-unrestricted-teams';
const continuousTeamsMode = process.argv[2] === '--test-continuous-teams';
const compactTeamMode = process.argv[2] === '--test-team-compact';
const teamWorkToolsMode = process.argv[2] === '--test-team-work-tools';
const createdToolsMode = harnessMode || process.argv[2] === '--test-created-tools';
let teamWorkToolsSupported = true;
const taskOverviewMode = process.argv[2] === '--test-team-work-overview';
const teamReviewMode = taskOverviewMode || process.argv[2] === '--test-team-review';
const compactAssignment = 'Implement a small project improvement and report the verified result.\n' + 'Keep the workspace scoped and preserve existing features. '.repeat(25) + 'ASSIGNMENT END MARKER';
const compactReport = 'Implementation and verification report.\n' + 'The isolated fixture preserves the complete report for review, including every verification detail. '.repeat(27) + 'REPORT END MARKER';
const hostFolderMode = process.argv[2] === '--test-host-folder';
let sharedHostFolder, folderVersion = '2026-10-21T00:00:00.000Z';
const workspaceFlags = ['--test-team-plans', '--test-connection-routes', '--test-route-tls', '--test-team-follow', '--test-team-workflows', '--test-harness', '--test-created-tools', '--test-team-work-tools', '--test-team-work-overview', '--test-team-review', '--test-team-compact', '--test-continuous-teams', '--test-unrestricted-teams', '--test-host-folder', '--test-supervision', '--test-connector-accounts', '--test-connectors', '--test-devin-provider', '--test-direct-bots', '--test-team-settings', '--test-team-instructions', '--test-team-members', '--test-notifications', '--test-group-chat-layout', '--test-team-channel-layout', '--test-team-channel', '--test-bot-photos', '--test-bot-lifecycle', '--test-bot-avatar-states', '--test-workspace-skills', '--test-workspace-connections', '--test-workspace-teams', '--test-facelift'];
const workspaceMode = workspaceFlags.includes(process.argv[2]);
let teamConversation, savedTeam, teamRun;
const teamLimits = { maxParallel: 2, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 };
// Typed, inert workflow UI records exercise the real paired bridge. These are
// deliberately synthetic stages, never actual model execution or evaluation.
let workflowCapability = true, workflowFailure = false, workflowRecord;
const workflowTeamId = 'team_00000000-0000-4000-8000-000000000034';
const workflowId = 'wf_00000000-0000-4000-8000-000000000034';
const workflowIdentifier = (prefix, n) => `${prefix}_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workflowSeal = () => { workflowRecord.updatedAt = new Date().toISOString(); const value = { ...workflowRecord }; delete value.proof; workflowRecord.proof = createHash('sha256').update(JSON.stringify(value)).digest('hex'); return { workflow: structuredClone(workflowRecord) }; };
function workflowFixture(body) {
  const now = new Date().toISOString();
  const criteria = body.criteria.map((text, n) => ({ id: workflowIdentifier('wc', n + 1), text: text.trim() }));
  workflowRecord = { id: workflowId, teamId: workflowTeamId, goal: body.goal.trim(), plannerId: body.plannerId, builderId: body.builderId, evaluatorId: body.evaluatorId,
    criteria, phase: 'awaiting_review', revision: 1, round: 1, summary: 'Synthetic UI result is ready for owner review; no provider or command ran.', createdAt: now, updatedAt: now,
    plan: { summary: 'A bounded native UI fixture plan.', items: ['Inspect the saved context.', 'Build the requested change.', 'Evaluate each criterion independently.'] },
    steps: ['planning', 'building', 'evaluating'].map((phase, n) => ({ id: workflowIdentifier('ws', n + 1), phase, botId: phase === 'planning' ? body.plannerId : phase === 'evaluating' ? body.evaluatorId : body.builderId,
      chatId: conversation.id, state: 'completed', summary: `${phase} fixture stage, saved for inspection.`, evidence: [{ kind: 'note', label: 'Synthetic stage evidence', detail: 'This native UI fixture dispatches no provider, command, browser, SSH or guest operation.' }], startedAt: now, completedAt: now })),
    checks: criteria.map(criterion => ({ criterionId: criterion.id, passed: true, detail: 'Synthetic evaluator finding for native UI coverage; actual verification is tested by backend fixtures.' })), totalSteps: 3, stepsTruncated: false, canResume: false };
  return workflowSeal();
}
if (workflowMode || teamPlansMode) savedTeam = { id: workflowTeamId, name: 'Plan and verify team', memberIds: ['fixture-bot', 'fixture-reviewer'], coordinatorId: 'fixture-bot', enabled: true, limits: { maxParallel: 0, maxDepth: 0, maxHops: 0, maxTurns: 0, maxDurationMs: 0 }, revision: 1, createdAt: new Date().toISOString() };

// Native Team plan UI uses the real durable controller and paired projection,
// with an isolated scratch store and inert delivery. No model/tool is invoked.
let teamPlanController, teamPlanRecord, teamPlanFailure = false, teamPlanDispatches = 0;
if (teamPlansMode) {
  const { createTeamPlans } = await import('../../host/server/bots-team-plans.mjs');
  teamPlanController = createTeamPlans({ directory: join(root, 'team-plan-service'), teamFor: id => { if (id !== savedTeam.id) throw Error('Unknown synthetic team'); return savedTeam; },
    prepare: row => ({ authorities: Object.fromEntries(row.memberIds.map(id => [id, 'a'.repeat(64)])), resourceKeys: Object.fromEntries(row.memberIds.map(id => [id, 'fixture:' + id])) }),
    ensure() {}, dispatch(_row, attempt) { teamPlanDispatches++; return { chatId: 'fixture-plan-chat-' + attempt.id, jobId: 'fixture-plan-job-' + attempt.id }; }, stopRun: async () => ({ stopped: true }) });
  const created = teamPlanController.create(savedTeam.id, { requestId: 'native_plan_fixture', goal: 'Build and independently review the synthetic team fixture', sourceMessageId: 'fixture-plan-source' });
  const id = created.plan.id;
  const advance = (kind, submission, body) => {
    teamPlanController.pump(); const attempt = teamPlanController.detail(savedTeam.id, id).plan.attempts.find(a => a.kind === kind && a.state === 'pending');
    if (!attempt) throw Error('Missing synthetic plan stage: ' + kind);
    teamPlanController.beforeStart(id, attempt.id, attempt.chatId);
    teamPlanController.submission(submission, body, { ...teamPlanController.binding(id, attempt.id), chatId: attempt.chatId, botId: attempt.botId, assertLive() {}, hasVerificationEvidence: () => true });
    teamPlanController.finish(id, attempt.id, {});
  };
  advance('planning', 'submit_team_plan', { summary: 'A clearly synthetic two-member plan.', participation: savedTeam.memberIds.map((botId, n) => ({ botId, role: n ? 'Independent evaluator' : 'Builder', reason: n ? 'Inspects the builder result without contributing to its implementation.' : 'Owns the concrete authorized fixture change.' })), tasks: [
    { key: 'build', title: 'Build the fixture', instructions: 'Work only inside this synthetic test fixture.', ownerId: savedTeam.memberIds[0], dependsOn: [], kind: 'work', criteria: ['The fixture result can be inspected'] },
    { key: 'review', title: 'Independently review the fixture', instructions: 'Inspect the reported result and exact criterion.', ownerId: savedTeam.memberIds[1], dependsOn: ['build'], kind: 'review', criteria: ['The fixture result can be inspected'] },
  ] });
  advance('task', 'checkpoint_team_plan_task', { outcome: 'ready_for_review', summary: 'Synthetic build result, never owner accepted.', evidence: [{ kind: 'note', label: 'Fixture artifact', detail: 'This is synthetic UI evidence; no command or model ran.' }] });
  const review = teamPlanController.detail(savedTeam.id, id).plan.tasks.find(t => t.key === 'review');
  advance('task', 'checkpoint_team_plan_task', { outcome: 'ready_for_review', summary: 'Synthetic independent review.', evidence: [{ kind: 'test', label: 'Fixture check', detail: 'The test callback supplies verification evidence; no real command ran.' }], checks: review.criteria.map(c => ({ criterionId: c.id, passed: true, detail: 'Synthetic fixture check only.' })) });
  advance('synthesis', 'submit_team_plan_summary', { outcome: 'ready_for_review', summary: 'The synthetic team result is ready for your review, not yet accepted.' });
  teamPlanRecord = teamPlanController.detail(savedTeam.id, id).plan;
}
// Public rows only: the follow fixture has no bot runtime or command executor.
const followMessages = [];
function appendFollowMessage() {
  const sequence = followMessages.length + 1;
  followMessages.push({ id: `follow_msg_${sequence}`, sequence, teamId: workflowTeamId, kind: 'message',
    author: { type: 'bot', botId: 'fixture-bot', name: 'Builder', avatarConfig: { color: 'sky', eyes: 'happy', ears: 'round', shape: 'orb' } },
    content: `${sequence <= 40 ? 'Earlier' : 'Incoming'} team update ${sequence}. The shared team conversation keeps every reply in its saved order.`, createdAt: new Date().toISOString() });
}
if (teamFollowMode) {
  for (let n = 0; n < 40; n++) appendFollowMessage();
  workflowFixture({ goal: 'Inspect live team visibility', plannerId: 'fixture-bot', builderId: 'fixture-bot', evaluatorId: 'fixture-reviewer', criteria: ['Visible team state is accurate'] });
  workflowRecord.phase = 'repairing'; workflowRecord.round = 2; workflowRecord.revision++;
  workflowRecord.summary = 'A synthetic repair is active; the prior evaluation remains saved for inspection.'; workflowSeal();
}
const skillDrafts = [];
const skillAssignments = { 'fixture-bot': ['library.review'] };
const skillCatalog = () => ({ skills: [{ id: 'library.review', name: 'Library review', description: 'Existing shared library instructions', body: 'Review changes carefully.', triggers: [], source: 'library', status: 'enabled', revision: 'library-digest', digest: 'library-digest' }, ...skillDrafts].map(skill => ({ ...skill, botIds: Object.entries(skillAssignments).filter(([, ids]) => ids.includes(skill.id)).map(([id]) => id) })), assignments: Object.entries(skillAssignments).map(([botId, skillIds]) => ({ botId, skillIds })) });
// Configuration-only draft storage. No command runner or model is injected.
const createdToolDigest = tool => createHash('sha256').update(JSON.stringify({ name: tool.name, description: tool.description, command: tool.command, inputSchema: tool.inputSchema, timeoutSeconds: tool.timeoutSeconds, ...(tool.requirements ? { requirements: tool.requirements } : {}) })).digest('hex');
const createdTools = [];
if (createdToolsMode) {
  savedTeam = { id: 'team_tool_fixture', name: 'Tool review team', memberIds: ['fixture-bot', 'fixture-reviewer'], coordinatorId: 'fixture-bot', enabled: true, limits: teamLimits, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const draft = { id: 'tool_00000000-0000-4000-8000-000000000001', name: 'Workspace summary', description: 'A bot-created draft to review. This fixture never runs its command.', command: 'python3 summary.py', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, timeoutSeconds: 30, status: 'draft', revision: 1, botIds: [], teamIds: [], provenance: { botId: 'fixture-bot', chatId: 'fixture-mac-research', turnId: 'turn_tool_fixture' } };
  draft.digest = createdToolDigest(draft); createdTools.push(draft);
}
// Inert failures exercise the real durable journal, never a command/provider.
let harnessJournal, harnessDispatches = 0, harnessAvailable = true, harnessFailure = false;
if (harnessMode) {
  const { createBotActionJournal } = await import('../../host/server/bots-action-journal.mjs');
  harnessJournal = createBotActionJournal({ directory: join(root, 'harness-journal') });
  try {
    await harnessJournal.execute({ chatId: conversation.id, authority: 'a'.repeat(64), turnId: 'fixture-native-turn', toolCallId: 'fixture-native-call', name: 'run_command', args: { command: 'NEVER_EXECUTED' } }, async () => { harnessDispatches++; throw new Error('Synthetic lost action result; no command was run.'); });
  } catch { /* Deliberately retain an uncertain receipt for explicit owner review. */ }
  harnessJournal.observeRemote({ id: 'ba_' + 'b'.repeat(64), chatId: conversation.id, toolName: 'remote_command', state: 'uncertain', revision: 2, proof: 'c'.repeat(64), startedAt: Date.now() - 1000, updatedAt: Date.now() - 1000 }, conversation.id);
}
const mcpConnection = { id: 'mcpc_fixture', name: 'Fixture tools', transport: 'stdio', inventoryDigest: 'a'.repeat(64), command: '/fixture/never-executed', args: [], env: { TEST_SECRET: 'PRIVATE-FIXTURE-SECRET' }, apiKey: 'PRIVATE-FIXTURE-KEY', apiKeySet: true, status: 'unchecked', detail: 'Synthetic connection; no program runs.', botIds: ['fixture-bot'], enabledToolIds: ['tool_read'], readOnlyToolIds: ['tool_read'], tools: [{ id: 'tool_read', name: 'Read workspace', description: 'Synthetic read-only inventory', readOnly: true }, { id: 'tool_write', name: 'Write workspace', description: 'Synthetic write inventory; approval policy applies', readOnly: false }] };
let connectorService;
let connectorChecks = 0, connectorToolCalls = 0;
if (connectorMode) {
  savedTeam = { id: 'team_connector_fixture', name: 'Project fixture team', memberIds: ['fixture-bot', 'fixture-reviewer'], coordinatorId: 'fixture-bot', enabled: true, limits: teamLimits, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const { createBotMcp } = await import('../../host/server/bots-mcp.mjs');
  connectorService = createBotMcp({ directory: join(root, 'connector-store'),
    hasBot: id => ['fixture-bot', 'fixture-reviewer'].includes(id), hasTeam: id => id === savedTeam.id,
    teamAccess: () => false,
    ...(connectorAccountsMode ? { authOptions: {
      // This workflow deliberately exercises the old-host Mac-browser fallback.
      // All discovery/authorization producers are inert and make no requests.
      fetchImpl: async () => { throw new Error('Account UX fixture must never fetch an external service.'); },
      discoverResource: async () => ({ authorization_servers: ['https://auth.fixture.invalid'] }),
      authorize: async (provider, options) => {
        if (options.authorizationCode) throw new Error('Account UX fixture never exchanges an authorization code.');
        provider.saveCodeVerifier('synthetic-fixture-verifier-'.repeat(3));
        const address = new URL('https://auth.fixture.invalid/authorize');
        address.searchParams.set('state', await provider.state()); address.searchParams.set('redirect_uri', String(provider.redirectUrl));
        address.searchParams.set('code_challenge', 'synthetic-fixture-challenge'); address.searchParams.set('code_challenge_method', 'S256');
        provider.redirectToAuthorization(address); return 'REDIRECT';
      },
    } } : {}),
    clientFactory: async () => ({
      async listTools() { connectorChecks++; return { tools: [{ name: 'Read project', description: 'Read synthetic project data.', inputSchema: { type: 'object' } }, { name: 'Write project', description: 'Change synthetic project data. Uses normal bot approvals.', inputSchema: { type: 'object' } }] }; },
      async callTool() { connectorToolCalls++; throw new Error('This connector UI fixture must never call a tool.'); },
      async close() {},
    }),
  });
}
const fixtureComputerMode = process.argv[2] === '--test-computer' || hostFolderMode ? 'cua' : 'host';
const configuredFixtureName = ['--test-bot-photos', '--test-team-channel-layout', '--test-group-chat-layout'].includes(process.argv[2]) ? 'Configured fixture / Qwen extended long model name for a separate remote Strata computer' : 'Configured fixture';
let botFace = { color: 'sky', eyes: 'star', ears: 'scalloped' };
if (['--test-bot-avatar-states', '--test-bot-photos'].includes(process.argv[2]) || directBotsMode) {
  conversation.preferences = { botId: 'fixture-bot', botName: 'Workspace companion', botAvatarConfig: structuredClone(botFace),
    botComputerMode: 'host', botComputer: 'Fixture Mac', botModel: 'Fixture model' };
}
if (directBotsMode) teamConversation = { id: 'fixture-team-worker', title: 'Private team routing conversation', active: false, updatedAt: new Date(Date.now() + 60000).toISOString(), mode: 'manual', workspace: '/fixture/default', preferences: { botId: 'fixture-bot', botName: 'Workspace companion', teamId: 'team_direct_fixture', teamRunId: 'run_direct_fixture' }, messages: [{ id: 'private-team', role: 'assistant', content: 'PRIVATE_TEAM_WORKER_MUST_NOT_OPEN_FROM_ROSTER' }] };
let computerRunning = false;
let computerControl;
const computerImage = readFileSync(new URL('./computer-fixture.png', import.meta.url)).toString('base64');
const computerState = () => ({ available: true, running: computerRunning, computerName: 'Fixture isolated computer',
  detail: computerRunning ? 'Synthetic isolated computer. No VM, provider or SSH session is running.' : 'Prepared fixture. Start explicitly to see the synthetic screen.',
  ...(computerRunning ? { width: 640, height: 400, image: { mimeType: 'image/png', data: computerImage } } : {}),
  control: { active: !!computerControl, owned: !!computerControl, ...(computerControl ? { expiresAt: computerControl.expiresAt } : {}) } });
const botsCatalog = () => ({
  avatarShapes: [...BOT_AVATAR_SHAPES],
  ...(directBotsMode || hostFolderMode ? { lifecycleSupported: true } : {}),
  ...(hostFolderMode ? { hostFolderSupported: true } : {}),
  bots: [{ ...(hostFolderMode ? { updatedAt: folderVersion, computerId: 'local', ...(sharedHostFolder ? { hostFolder: sharedHostFolder } : {}) } : {}), id: 'fixture-bot', name: 'Workspace companion', avatar: '🦊', avatarConfig: botFace, computerMode: fixtureComputerMode, provider: 'codex', model: 'Fixture model', workspace: fixtureComputerMode === 'cua' ? '/workspace' : '/fixture/default', capabilities: 'both', policy: 'manual', execution: { kind: 'local' },
    conversations: [conversation.id, ...(createdBotConversation?.preferences?.botId === 'fixture-bot' ? [createdBotConversation.id] : []), ...(teamConversation ? [teamConversation.id] : [])] },
    ...(workspaceMode ? [{ id: 'fixture-reviewer', name: 'Review companion', avatarConfig: { color: 'violet', eyes: 'happy', ears: 'round', kind: 'cat' }, computerMode: 'host', provider: 'claude', model: 'Fixture reviewer', workspace: '/fixture/default', capabilities: 'code', policy: 'manual', execution: { kind: 'local' }, conversations: createdBotConversation?.preferences?.botId === 'fixture-reviewer' ? [createdBotConversation.id] : [] }] : [])],
  providers: ['claude', 'codex', 'devin', 'grok', 'kimi', 'ollama', 'configured'].map(id => ({ id, name: ({ claude: 'Claude Code', codex: 'Codex', devin: 'Devin CLI', grok: 'Grok', kimi: 'Kimi', ollama: 'Ollama Cloud', configured: 'Configured models' })[id], available: true, detail: 'Synthetic provider. No account or model is used.' })),
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
const teamSettingsMode = ['--test-team-settings', '--test-team-instructions', '--test-team-members'].includes(process.argv[2]);
const teamChannelMode = ['--test-team-work-tools', '--test-team-work-overview', '--test-team-review', '--test-team-compact', '--test-continuous-teams', '--test-unrestricted-teams', '--test-team-settings', '--test-team-instructions', '--test-team-members', '--test-team-channel', '--test-team-channel-layout', '--test-group-chat-layout'].includes(process.argv[2]);
let roomBots, roomChats, roomTeam, roomEmptyTeam, roomExtraMember, roomMembers = [], roomTurns = [];
let settingsHold;
const teamSettingsActions = [];
const teamSettingsFolder = join(root, 'shared-team-folder');
const teamSettingsOtherFolder = join(root, 'other-team-folder');
if (teamSettingsMode) { mkdirSync(teamSettingsFolder); mkdirSync(teamSettingsOtherFolder); }
if (teamChannelMode) {
  const { createBots } = await import('../../host/server/bots.mjs');
  const { createConversations } = await import('../../host/server/conversations.mjs');
  const directory = join(root, 'actual-team-service');
  mkdirSync(directory, { mode: 0o700 });
  roomBots = createBots({ directory, defaultWorkspace: () => directory,
    ...(teamSettingsMode ? { remoteSSH: { run: async () => { throw new Error('No SSH execution in Team settings fixture'); }, cua: async () => { throw new Error('No CUA execution in Team settings fixture'); } } } : {}),
    conversations: () => roomChats,
    tools: { definitions: () => [], execute: () => { throw new Error('No external tools in native Team fixture'); }, finish: async () => {} },
    runtime: { providers: async () => [], close() {}, async run(input) {
      if (teamSettingsMode && input.message === 'Hold settings fixture') {
        teamSettingsActions.push('held-inert-routing-turn');
        await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
        return;
      }
      roomTurns.push({ botId: input.bot.id, mode: input.bot.teamContext?.channelMode, message: input.message, toolNames: input.tools.map(tool => tool.name) });
      input.onFrame({ type: 'reasoning', text: 'Review the shared team channel and answer as the named teammate.' });
      const mode = input.bot.teamContext?.channelMode;
      if (teamWorkToolsMode) {
        if (input.message.startsWith('[The public conversation invitations have finished.')) return;
        const text = mode === 'task' ? 'Work fixture result: the coordinator received the explicit Work request.' : mode === 'routing' ? 'Chat fixture reply: the coordinator can talk without direct work tools.' : `${input.bot.name}: I can join this fixture conversation.`;
        input.onFrame({ type: 'delta', text });
        return;
      }
      if (compactTeamMode) {
        if (mode === 'routing' && !roomTurns.some(turn => turn.mode === 'task')) {
          await input.executeTool('assign_team_task', { botId: roomMembers[1].id, message: compactAssignment }, 'fixture_compact_assignment');
          input.onFrame({ type: 'delta', text: 'Builder is working on the improvement.' });
        } else input.onFrame({ type: 'delta', text: mode === 'task' ? compactReport : 'The completed work is ready to review.' });
        return;
      }
      if (mode === 'routing') {
        // The team settings fixture has no work after its seeded greeting.
        if (teamSettingsMode && input.message.startsWith('[The public conversation invitations have finished.')) return;
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
  roomMembers = ['Coordinator', 'Builder', 'Reviewer'].map((name, index) => roomBots.create({ name, provider: 'codex', model: 'Fixture model', workspace: teamSettingsMode ? '/workspace' : directory, ...(teamSettingsMode ? { computerMode: 'cua' } : {}), policy: 'bypass', avatarConfig: { color: ['sky', 'orange', 'violet'][index], eyes: 'round', ears: 'round', shape: ['orb', 'tile', 'spark'][index] } }).bot);
  if (unrestrictedTeamsMode) {
    for (let index = 4; index <= 15; index++) roomMembers.push(roomBots.create({ name: `Teammate ${String(index).padStart(2, '0')}`, provider: 'codex', model: 'Fixture model', workspace: directory, policy: 'manual' }).bot);
  }
  roomTeam = roomBots.team.create({ name: 'Engineering', memberIds: roomMembers.map(bot => bot.id), coordinatorId: roomMembers[0].id, enabled: true }).team;
  if (teamSettingsMode) roomExtraMember = roomBots.create({ name: 'Remote helper', provider: 'codex', model: 'Fixture model', workspace: '/srv/fixture-project', execution: { kind: 'ssh', host: 'fixture.invalid', user: 'fixture', name: 'Fixture SSH computer' }, policy: 'manual' }).bot;
  if (['--test-team-settings', '--test-team-instructions', '--test-team-members', '--test-team-channel-layout', '--test-group-chat-layout'].includes(process.argv[2])) {
    // Layout-only UI reads an actual saved journal seeded by the inert fixture.
    // These setup turns have no provider or external tools and precede pairing.
    const until = async predicate => { const deadline = Date.now() + 5_000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Inert layout seed did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } };
    roomBots.team.message(roomTeam.id, { message: 'Hi everyone', requestId: 'seed_greeting' });
    await until(() => roomBots.team.channel(roomTeam.id).activeRuns.length === 0);
    if (!teamSettingsMode) {
    const held = roomBots.team.message(roomTeam.id, { message: 'Hold this synthetic task', requestId: 'seed_hold' });
    await until(() => roomTurns.some(turn => turn.mode === 'task' && turn.message.includes('Hold this')));
    await roomBots.team.stop(roomTeam.id, held.run.id);
    }
  }
  if (compactTeamMode) {
    roomBots.team.message(roomTeam.id, { message: 'Please complete the project improvement.', requestId: 'seed_compact' });
    const deadline = Date.now() + 5000;
    while (roomBots.team.channel(roomTeam.id).activeRuns.length) {
      if (Date.now() > deadline) throw new Error('Compact room fixture did not settle');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (process.argv[2] === '--test-group-chat-layout') roomEmptyTeam = roomBots.team.create({ name: 'Design circle', memberIds: roomMembers.map(bot => bot.id), coordinatorId: roomMembers[0].id, enabled: true }).team;
}
// Saved task states for the native review/recovery workflow. These routes
// never start a provider, external tool, SSH process or computer.
const reviewEvidence = [{ kind: 'file', label: 'Changed source', detail: '/workspace/team project/Sources/Fix.swift' },
  { kind: 'test', label: 'Focused verification', detail: 'Eight focused checks passed. REVIEW EVIDENCE END MARKER' }];
const reviewTasks = teamReviewMode ? ['ready', 'interrupted'].map((state, index) => ({
  id: index ? 'tj_00000000-0000-4000-8000-000000000002' : 'tj_00000000-0000-4000-8000-000000000001', type: 'assignment', teamId: roomTeam.id, runId: 'run_saved_' + state,
  botId: roomMembers[1].id, chatId: 'fixture-task-' + state, title: index ? 'Continue unfinished renderer' : 'Review completed parser fix', state: index ? 'cancelled' : 'completed',
  detail: index ? 'The connection stopped after the saved checkpoint.' : 'Submitted for owner review.',
  work: { status: index ? 'interrupted' : 'ready_for_review', revision: 1, summary: index ? 'Finish the renderer using the retained parser result.' : 'The parser fix is ready for your review.',
    evidence: index ? [] : reviewEvidence, resultHistory: index ? [] : [{ id: 'result_review_fixture', summary: 'The parser fix is ready for your review.', evidence: reviewEvidence, submittedAt: '2026-10-21T00:00:00.000Z', botId: roomMembers[1].id }], reviewHistory: [] },
})) : [];
const overviewRequests = [];
if (taskOverviewMode) {
  const at = '2026-10-21T20:00:00.000Z';
  for (const task of reviewTasks) { task.createdAt = at; task.updatedAt = at; }
  reviewTasks[0].work.reviewHistory = [{ decision: 'reject', note: 'Confirm that the existing iPhone pairing is retained.', reviewedAt: at, resultId: reviewTasks[0].work.resultHistory[0].id }];
  const extra = (suffix, title, state, status, fields = {}) => ({ id: 'tj_00000000-0000-4000-8000-' + suffix.padStart(12, '0'), type: 'delivery', teamId: roomTeam.id, runId: 'tr_00000000-0000-4000-8000-000000000010', botId: roomMembers[1].id, chatId: 'fixture-overview-' + suffix, title, state, createdAt: at, updatedAt: at,
    work: { status, revision: 1, evidence: [], resultHistory: [], reviewHistory: [], ...fields } });
  reviewTasks.push(extra('4', 'Modern task working', 'running', 'working'));
  reviewTasks.push(extra('5', 'Earlier task without saved result', 'completed', 'blocked', { legacy: true, summary: 'Earlier activity is preserved in history.' }));
  reviewTasks.push(extra('6', 'Earlier task still running', 'running', 'working', { legacy: true }));
  reviewTasks.push(extra('7', 'Verified saved result', 'completed', 'verified', { evidence: reviewEvidence, resultHistory: structuredClone(reviewTasks[0].work.resultHistory), reviewHistory: [{ decision: 'accept', reviewedAt: at, resultId: reviewTasks[0].work.resultHistory[0].id }] }));
  reviewTasks.push(extra('8', 'Earlier continuation source', 'cancelled', 'interrupted', { recoveryJobId: reviewTasks[2].id }));
  overviewRequests.push({ id: 'tr_00000000-0000-4000-8000-000000000011', teamId: roomTeam.id, rootChatId: 'fixture-earlier-request', rootBotId: roomMembers[0].id, state: 'completed', consumedTurns: 3 });
}
let overviewUnavailable = false;
let overviewOnlyHistory = false;
let reviewPlan;
let reviewResumeKey;
let reviewResumedRun;
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
const supervisionChats = [];
if (supervisionMode) {
  conversation.active = true;
  conversation.preferences = { botId: 'fixture-bot', botName: 'Workspace companion', botComputer: 'Fixture Mac' };
  pending.push(tool('supervision-approval', 'proposed'));
  assistant.tools = [...pending];
  supervisionChats.push({ id: 'fixture-supervision-working', title: 'Review in the shared computer', active: true, updatedAt: new Date().toISOString(), preferences: { botId: 'fixture-reviewer', botName: 'Review companion', teamId: 'team_fixture', parentChatId: conversation.id, botComputer: 'Remote fixture computer' }, messages: [{ id: 'working-answer', role: 'assistant', content: '', streaming: true, tools: [tool('supervision-running', 'running')] }] });
  supervisionChats.push({ id: 'fixture-supervision-done', title: 'Finished personal conversation', active: false, updatedAt: new Date().toISOString(), preferences: { botId: 'fixture-reviewer', botName: 'Review companion', botComputer: 'Fixture Mac' }, messages: [{ id: 'done-answer', role: 'assistant', content: 'Completed synthetic work.', streaming: false }] });
}
const { botSupervisionSnapshot } = await import('../../host/server/bots-supervision.mjs');
const host = {
  async json(path, options = {}) {
    calls.push({ path, method: options.method ?? 'GET', body: options.body ?? null });
    // This legacy host fixture ignores the new read-only summary query.
    if (path === '/api/companion/conversations?summary=1') path = '/api/companion/conversations';
    if (teamPlansMode) {
      if (path === '/api/bots/teams') return { teams: [structuredClone(savedTeam)], runs: [], channelsSupported: true, teamWorkPlansSupported: true, teamCoordinatorWorkToolsSupported: true, teamWorkReviewSupported: true, teamContinuousSupported: true };
      if (path === '/api/bots/activity') return { activity: [], teamWorkReviewSupported: true };
      const url = new URL(path, 'http://isolated-fixture.invalid');
      if (url.pathname === `/api/bots/teams/${savedTeam.id}/channel`) return { supported: true, teamId: savedTeam.id, messages: [], activeRuns: [], nextSequence: 0, hasMore: false, hasMoreBefore: false };
      if (url.pathname === '/api/companion/conversations') {
        const attempts = teamPlanController.detail(savedTeam.id, teamPlanRecord.id).plan.attempts;
        return { conversations: [conversation, ...attempts.filter(a => a.chatId).map(a => ({ ...structuredClone(conversation), id: a.chatId, title: 'Synthetic plan ' + a.kind, preferences: { botId: a.botId, teamId: savedTeam.id } }))], activeChatId: conversation.id };
      }
      if (url.pathname.startsWith('/api/companion/conversations/fixture-plan-chat-')) { const value = detail(); value.conversation.id = url.pathname.split('/').at(-1); return value; }
      if (url.pathname === `/api/bots/teams/${savedTeam.id}/plans`) {
        if (teamPlanFailure) throw Object.assign(Error('Synthetic team plan service unavailable'), { status: 503 });
        return teamPlanController.list(savedTeam.id);
      }
      const planRoute = new RegExp(`^/api/bots/teams/${savedTeam.id}/plans/(tp_[a-f0-9-]{36})(?:/(resume|stop|review))?$`).exec(url.pathname);
      if (planRoute) {
        if (planRoute[2]) { const result = await teamPlanController[planRoute[2]](savedTeam.id, planRoute[1], options.body); teamPlanRecord = result.plan; return result; }
        return teamPlanController.detail(savedTeam.id, planRoute[1], { taskOffset: Number(url.searchParams.get('taskOffset') ?? 0) });
      }
    }
    if (workflowMode) {
      if (teamFollowMode) {
        if (path === '/api/bots/teams') return { teams: [structuredClone(savedTeam)], runs: [], teamWorkflowsSupported: true, teamWorkReviewSupported: true, teamCoordinatorWorkToolsSupported: true, teamContinuousSupported: true, teamUnrestrictedSupported: true };
        if (path === '/api/bots/activity') return { activity: [], teamWorkReviewSupported: true };
        if (path === '/api/bots/supervision') return { supported: true, sessions: [], counts: { waiting: 0, working: 0, completed: 0, errors: 0 }, hasMore: false };
        const channel = new URL(path, 'http://fixture');
        if (channel.pathname === `/api/bots/teams/${workflowTeamId}/channel`) {
          const after = Number(channel.searchParams.get('after') ?? 0);
          return { supported: true, teamId: workflowTeamId, messages: structuredClone(followMessages.filter(row => row.sequence > after)), activeRuns: [], nextSequence: followMessages.length, hasMore: false, hasMoreBefore: false };
        }
      }
      if (path === '/api/bots/teams') return { teams: [structuredClone(savedTeam)], runs: [], teamWorkflowsSupported: workflowCapability, teamContinuousSupported: true, teamUnrestrictedSupported: true };
      if (path === `/api/bots/teams/${workflowTeamId}/channel`) return { supported: true, teamId: workflowTeamId, messages: [], activeRuns: [], nextSequence: 0, hasMore: false, hasMoreBefore: false };
      if (path === '/api/bots/harness/actions') return { available: true, actions: [], counts: { pending: 0, succeeded: 0, error: 0, interrupted: 0, uncertain: 0, reviewed: 0 }, hasMore: false };
      const route = new RegExp(`^/api/bots/teams/${workflowTeamId}/workflows(?:/(${workflowId})(?:/(resume|stop|review))?)?$`).exec(path);
      if (route) {
        if (workflowFailure) throw Object.assign(new Error('Synthetic workflow list is temporarily unavailable.'), { status: 503 });
        if (!workflowCapability) throw Object.assign(new Error('Synthetic older host has no workflows.'), { status: 404 });
        if (!route[1]) {
          if (options.method === 'POST') return workflowRecord ? { workflow: structuredClone(workflowRecord) } : workflowFixture(options.body);
          return { teamWorkflowsSupported: true, available: true, workflows: workflowRecord ? [structuredClone(workflowRecord)] : [], hasMore: false };
        }
        if (!workflowRecord) throw Object.assign(new Error('Unknown synthetic workflow'), { status: 404 });
        if (!route[2]) return { workflow: structuredClone(workflowRecord) };
        const body = options.body;
        if (options.method !== 'POST' || body.expectedRevision !== workflowRecord.revision || body.expectedProof !== workflowRecord.proof) throw Object.assign(new Error('Synthetic workflow checkpoint changed.'), { status: 409 });
        if (route[2] === 'review') {
          if (workflowRecord.phase !== 'awaiting_review') throw Object.assign(new Error('Synthetic workflow is not awaiting review.'), { status: 409 });
          workflowRecord.phase = body.decision === 'accept' ? 'completed' : 'repairing'; workflowRecord.canResume = false;
        } else if (route[2] === 'resume') {
          if (!workflowRecord.canResume || body.inspected !== true || !body.requestId) throw Object.assign(new Error('Inspect before resuming.'), { status: 409 });
          workflowRecord.phase = 'repairing'; workflowRecord.canResume = false;
        } else { workflowRecord.phase = 'stopped'; workflowRecord.canResume = true; }
        workflowRecord.revision++; return workflowSeal();
      }
    }
    if (teamReviewMode) {
      if (path === '/api/bots/supervision') return { supported: true, sessions: [], counts: { waiting: 0, working: 0, completed: 0, errors: 0 }, hasMore: false };
      if (path === '/api/bots/activity') {
        if (overviewUnavailable) throw Object.assign(new Error('Synthetic activity refresh unavailable.'), { status: 503 });
        const visibleTasks = overviewOnlyHistory ? reviewTasks.filter(task => task.work.status === 'verified' || task.work.legacy === true && !['queued', 'running', 'stopping', 'cleanup_pending'].includes(task.state)) : reviewTasks;
        return { activity: structuredClone([...visibleTasks, ...overviewRequests.map(row => ({ ...row, runId: row.id, type: 'run', title: 'Earlier team request', chatId: row.rootChatId }))]), teamWorkReviewSupported: true };
      }
      const route = /^\/api\/bots\/teams\/([^/]+)\/jobs\/([^/]+)\/(review|recovery|resume)$/.exec(path);
      if (route) {
        const task = reviewTasks.find(task => task.id === route[2] && task.teamId === route[1]);
        if (!task) throw Object.assign(new Error('Unknown fixture task'), { status: 404 });
        const body = options.body;
        if (route[3] === 'review') {
          if (options.method !== 'POST' || task.work.status !== 'ready_for_review' || body.expectedRevision !== task.work.revision || !['accept', 'reject'].includes(body.decision)) throw Object.assign(new Error('The submitted result changed.'), { status: 409 });
          task.work.reviewHistory.push({ decision: body.decision, ...(body.note ? { note: body.note } : {}), reviewedAt: new Date().toISOString(), resultId: task.work.resultHistory.at(-1).id });
          task.work.status = body.decision === 'accept' ? 'verified' : 'blocked'; task.work.revision++;
          return { activity: structuredClone(task) };
        }
        if (route[3] === 'recovery') {
          if ((options.method ?? 'GET') !== 'GET') throw new Error('Recovery inspection must be GET');
          reviewPlan = { id: 'plan_native_review', jobId: task.id, sourceRunId: task.runId, expectedRevision: task.work.revision,
            expiresAt: new Date(Date.now() + 300_000).toISOString(), canResume: task.work.status === 'interrupted' && !task.work.recoveryJobId,
            botId: task.botId, botName: 'Builder', provider: 'codex', model: 'Fixture model', computerLabel: 'Saved isolated computer', workspace: '/workspace/team project',
            summary: task.work.summary, completedReports: [{ jobId: 'tj_00000000-0000-4000-8000-000000000001', chatId: 'fixture-task-ready', reportId: 'result_review_fixture', summary: 'The parser work is complete and will not be replayed.' }], steps: ['Read the retained teammate result.', 'Continue only the unfinished renderer.', 'Submit fresh evidence for owner review.'] };
          return { plan: structuredClone(reviewPlan) };
        }
        if (reviewResumeKey === body?.idempotencyKey && reviewResumedRun) return { run: reviewResumedRun, activity: structuredClone(reviewTasks.at(-1)) };
        if (options.method !== 'POST' || !reviewPlan || body.planId !== reviewPlan.id || body.expectedRevision !== task.work.revision || !reviewPlan.canResume || task.work.recoveryJobId) throw Object.assign(new Error('Prepare a fresh recovery plan.'), { status: 409 });
        reviewResumeKey = body.idempotencyKey;
        const newTask = { ...structuredClone(task), id: 'tj_00000000-0000-4000-8000-000000000003', runId: 'run_review_continuation', chatId: 'fixture-task-continuation', state: 'queued', title: 'Renderer continuation', work: { status: 'working', revision: 1, summary: 'Queued only this unfinished task.', evidence: [], resultHistory: [], reviewHistory: [], sourceJobId: task.id } };
        task.work.recoveryJobId = newTask.id; task.work.revision++; reviewTasks.push(newTask);
        reviewResumedRun = { id: newTask.runId, teamId: task.teamId, rootChatId: newTask.chatId, rootBotId: task.botId, state: 'queued', consumedTurns: 0 };
        return { run: reviewResumedRun, activity: structuredClone(newTask) };
      }
    }
    if (harnessMode && path === '/api/bots/harness/actions') { if (harnessFailure) throw Object.assign(new Error('Synthetic initial receipts failure'), { status: 503 }); return { ...harnessJournal.summary(), available: harnessAvailable }; }
    if (harnessMode && /^\/api\/bots\/harness\/actions\/ba_[a-f0-9]{64}\/review$/.test(path)) return harnessJournal.review(path.split('/')[5], options.body);
    if (supervisionMode && path === '/api/bots/supervision') {
      const snapshot = botSupervisionSnapshot({ bots: botsCatalog().bots, conversations: [conversation, ...supervisionChats].map(chat => ({ ...chat, messages: chat.messages.map(message => ({ ...message, hasContent: !!message.content?.trim() })) })), pendingCount: id => id === conversation.id ? pending.length : 0 });
      if (harnessMode) for (const session of snapshot.sessions) session.harness = { phase: 'model', elapsedMs: 4200, firstOutputMs: 1200, timings: { startingMs: 200, modelMs: 3000, approvalMs: 500, toolMs: 400, cleanupMs: 100 }, toolCalls: 2, toolErrors: 1, contextCompactions: 1, privateMarker: 'PRIVATE-HARNESS-NOT-PROJECTED' };
      return snapshot;
    }
    if (supervisionMode && path === '/api/companion/conversations') return { conversations: [conversation, ...supervisionChats], activeChatId: conversation.id };
    if (supervisionMode && supervisionChats.some(chat => path === '/api/companion/conversations/' + chat.id)) return { conversation: supervisionChats.find(chat => path.endsWith(chat.id)), pending: [] };
    if (notificationService) {
      const route = new URL(path, 'http://fixture.invalid');
      if (route.pathname === '/api/bots/notifications') return notificationService.feed(options.deviceId, { after: route.searchParams.has('after') ? Number(route.searchParams.get('after')) : undefined, journalId: route.searchParams.get('journalId') ?? undefined });
      if (route.pathname === '/api/bots/notifications/settings') return notificationService.settings(options.deviceId, options.body);
      if (route.pathname === '/api/bots/notifications/registration') return options.method === 'DELETE' ? notificationService.revoke(options.deviceId) : notificationService.registration(options.deviceId, options.body);
      if (route.pathname === '/api/bots/teams/team_notification/channel') return { supported: true, teamId: savedTeam.id, messages: notificationMessages, activeRuns: [], nextSequence: notificationMessages.length, hasMore: false, hasMoreBefore: false };
    }
    if (roomBots) {
      const route = new URL(path, 'http://fixture.invalid');
      const sharedComputer = /^\/api\/bots\/(bot_[a-f0-9-]+)\/computer$/.exec(route.pathname);
      if (teamSettingsMode && sharedComputer && roomMembers.some(member => member.id === sharedComputer[1]) && (options.method ?? 'GET') === 'GET') return computerState();
      // The paired phone edits this team's roster through the companion members
      // route; the same normalize()/update() validation as the host applies.
      const companionMembers = /^\/api\/companion\/teams\/(team_[a-f0-9-]+)\/members$/.exec(route.pathname);
      if (companionMembers) {
        if (options.method === 'GET') {
          const team = roomBots.team.list().teams.find(row => row.id === companionMembers[1]);
          if (!team) throw Object.assign(new Error('This team is unavailable.'), { status: 404 });
          const roster = (await roomBots.list()).bots.map(bot => ({ id: bot.id, name: bot.name, paused: bot.paused === true }));
          const memberRows = team.memberIds.map(id => {
            const bot = roster.find(row => row.id === id);
            return { id, name: bot?.name ?? 'Unavailable teammate', role: team.briefing?.members?.find(row => row.botId === id)?.role ?? '', paused: bot?.paused === true, available: !!bot && !bot.paused };
          });
          return { team: { id: team.id, name: team.name, memberIds: [...team.memberIds], coordinatorId: team.coordinatorId, revision: team.revision }, members: memberRows, roster };
        }
        if (options.method === 'PATCH') return roomBots.team.update(companionMembers[1], options.body);
        throw Object.assign(new Error('This companion team action is unavailable.'), { status: 405 });
      }
      if (route.pathname === '/api/bots/teams') {
        if (options.method === 'POST') return roomBots.team.create(options.body);
        const snapshot = structuredClone(roomBots.team.list());
        if (teamWorkToolsMode) { if (teamWorkToolsSupported) snapshot.teamCoordinatorWorkToolsSupported = true; else delete snapshot.teamCoordinatorWorkToolsSupported; }
        else delete snapshot.teamCoordinatorWorkToolsSupported;
        if (teamReviewMode) snapshot.teamWorkReviewSupported = true;
        if (taskOverviewMode) snapshot.runs.push(...structuredClone(overviewRequests));
        if (!continuousTeamsMode) {
          delete snapshot.teamContinuousSupported;
          for (const team of snapshot.teams) for (const key of ['maxDepth', 'maxHops', 'maxTurns', 'maxDurationMs']) if (team.limits[key] === 0) team.limits[key] = teamLimits[key];
        }
        if (!unrestrictedTeamsMode && !continuousTeamsMode) {
          delete snapshot.teamUnrestrictedSupported;
          for (const team of snapshot.teams) if (team.limits.maxParallel === 0) team.limits.maxParallel = 2;
        }
        return snapshot;
      }
      const settings = /^\/api\/bots\/teams\/([^/]+)$/.exec(route.pathname);
      if (settings && options.method === 'PATCH') return roomBots.team.update(settings[1], options.body);
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
    if (hostFolderMode && path === '/api/bots/fixture-bot/host-folder' && options.method === 'PUT') {
      if (options.body.expectedUpdatedAt !== folderVersion) throw Object.assign(new Error('Stale fixture folder version'), { status: 409 });
      sharedHostFolder = options.body.hostFolder;
      folderVersion = new Date(Date.parse(folderVersion) + 1).toISOString();
      const catalog = botsCatalog(); return { ...catalog, bot: catalog.bots[0] };
    }

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
    if (path === '/api/bots/provider-models?provider=devin') return { provider: 'devin', models: [{ id: 'fixture-devin-model', name: 'Devin fixture model', efforts: [] }] };
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
    if (createdToolsMode && path === '/api/bots/tools') {
      if (options.method === 'POST') {
        const draft = { ...structuredClone(options.body), id: 'tool_00000000-0000-4000-8000-000000000002', status: 'draft', revision: 1, botIds: [], teamIds: [] };
        draft.digest = createdToolDigest(draft); createdTools.push(draft); return { tool: structuredClone(draft) };
      }
      return { tools: structuredClone(createdTools), createdToolsSupported: true, ...(harnessMode ? { createdToolReadinessSupported: true } : {}) };
    }
    if (createdToolsMode && path.startsWith('/api/bots/tools/') && ['PATCH', 'DELETE'].includes(options.method)) {
      const tool = createdTools.find(item => path === '/api/bots/tools/' + item.id);
      if (!tool) throw Object.assign(new Error('No such synthetic tool'), { status: 404 });
      const body = options.body;
      if (body.expectedRevision !== tool.revision || body.expectedDigest !== tool.digest) throw Object.assign(new Error('Tool changed; review again.'), { status: 409 });
      if (options.method === 'DELETE') { createdTools.splice(createdTools.indexOf(tool), 1); return { removed: true }; }
      const content = ['name', 'description', 'command', 'inputSchema', 'timeoutSeconds', 'requirements'];
      for (const key of [...content, 'status', 'botIds', 'teamIds']) if (Object.hasOwn(body, key)) tool[key] = structuredClone(body[key]);
      if (content.some(key => Object.hasOwn(body, key))) tool.status = 'draft';
      if (Object.hasOwn(body, 'requirements')) { const { createdToolRequirements } = await import('../../host/server/bots-runtime/created-tools.mjs'); const requirements = createdToolRequirements(body.requirements); if (requirements) tool.requirements = requirements; else delete tool.requirements; }
      tool.revision++; tool.digest = createdToolDigest(tool); return { tool: structuredClone(tool) };
    }
    if (workspaceMode && path === '/api/bots/skills') {
      if (options.method === 'POST') { const skill = { id: 'skill_created', ...structuredClone(options.body), source: 'draft', status: 'draft', revision: 1, digest: 'draft-digest' }; skillDrafts.push(skill); return { skill: { ...skill, botIds: [] } }; }
      return skillCatalog();
    }
    if (workspaceMode && path === '/api/bots/skills/skill_created' && options.method === 'PATCH') { const skill = skillDrafts[0]; Object.assign(skill, options.body); skill.revision++; return { skill: { ...skill, botIds: skillCatalog().skills.find(s => s.id === skill.id).botIds } }; }
    if (workspaceMode && path === '/api/bots/skills/assign') { skillAssignments[options.body.botId] = [...options.body.skillIds]; return skillCatalog(); }
    if (connectorMode && (path.startsWith('/api/bots/connections') || path.startsWith('/api/bots/connectors/'))) {
      const value = await connectorService.handle(options.method ?? 'GET', new URL(path, 'http://fixture.invalid'), options.body);
      return connectorAccountsMode && value?.connectorFeatures ? {
        ...value, connectorFeatures: { ...value.connectorFeatures, iphoneOAuth: false },
        ...(Array.isArray(value.connectors) ? { connectors: [...value.connectors, { id: 'fixture-managed-service', name: 'Fixture managed connector', description: 'Synthetic managed service: review configuration without connecting.', category: 'Services', transport: 'http', authTypes: ['oauth'], setupState: 'managed', phoneSignIn: false, sourceURL: 'https://github.com/example/fixture-config', setupNote: 'Requires a managed account on Mac.' }] } : {}),
      } : value;
    }
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
    if (directBotsMode && path === '/api/bots/fixture-reviewer/conversations') {
      createdBotConversation = { id: directCreatedConversations.length ? 'fixture-reviewer-created-' + (directCreatedConversations.length + 1) : 'fixture-reviewer-created', title: 'Review companion conversation', updatedAt: new Date().toISOString(), active: false, mode: 'manual', workspace: '/fixture/default', modelName: 'Fixture reviewer', messages: [], preferences: { botId: 'fixture-reviewer', botName: 'Review companion', botComputerMode: 'host', botComputer: 'Fixture Mac', botModel: 'Fixture reviewer' } };
      directCreatedConversations.push(createdBotConversation);
      return structuredClone({ conversation: createdBotConversation, pending: [] });
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
    if (path === '/api/companion/conversations') return options.method === 'POST' ? detail() : { conversations: directBotsMode ? [teamConversation, ...[...directCreatedConversations].reverse(), conversation] : [conversation, ...(createdBotConversation ? [createdBotConversation] : []), ...(teamConversation ? [teamConversation] : [])], activeChatId: teamConversation?.active ? teamConversation.id : conversation.id };
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
      for (const server of routeServers) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      teamPlanController?.close();
      notificationService?.close();
      await bridge?.close();
      await lifecycleProfiles?.close();
      await connectorService?.close();
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
  if (routeMode) {
    const listen = async (identity, name, handler) => {
      const server = https.createServer({ key: identity.key, cert: identity.cert }, (request, response) => {
        routeRequests.push({ server: name, method: request.method, path: new URL(request.url, 'https://fixture.invalid').pathname, bearer: !!request.headers.authorization });
        handler(request, response);
      });
      routeServers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      return `https://127.0.0.1:${server.address().port}`;
    };
    const alias = await listen(bridge.identity, 'alias', (request, response) => bridge.secureServer.emit('request', request, response));
    const wrongDirectory = join(root, 'wrong-tls'); mkdirSync(wrongDirectory, { mode: 0o700 });
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(wrongDirectory, 'key.pem'), '-out', join(wrongDirectory, 'cert.pem'), '-days', '1', '-subj', '/CN=isolated-wrong-fixture'], { stdio: 'ignore' });
    const wrong = await listen({ key: readFileSync(join(wrongDirectory, 'key.pem')), cert: readFileSync(join(wrongDirectory, 'cert.pem')) }, 'wrong', (_request, response) => { response.writeHead(401).end(); });
    const redirect = await listen(bridge.identity, 'redirect', (_request, response) => { response.writeHead(302, { location: alias + '/v1/status' }).end(); });
    routeAddresses = { alias, wrong, redirect };
  }

  control = http.createServer(async (request, response) => {
    try {
      const action = request.url;
      if (request.method === 'POST') {
        switch (action) {
        case '/team-plan-failure':
          if (!teamPlansMode) throw Error('Team plan fixture required'); teamPlanFailure = true; break;
        case '/team-plan-clear-failure':
          if (!teamPlansMode) throw Error('Team plan fixture required'); teamPlanFailure = false; break;
        case '/team-follow-append':
          if (!teamFollowMode) throw new Error('Team follow fixture required'); appendFollowMessage(); break;
        case '/workflow-failure':
          if (!workflowMode) throw new Error('Workflow fixture required'); workflowFailure = true; break;
        case '/workflow-clear-failure':
          if (!workflowMode) throw new Error('Workflow fixture required'); workflowFailure = false; break;
        case '/workflow-interrupt':
          if (!workflowMode || !workflowRecord) throw new Error('Saved workflow required'); workflowRecord.phase = 'interrupted'; workflowRecord.canResume = true; workflowRecord.revision++; workflowSeal(); break;
        case '/workflow-unsupported':
          if (!workflowMode) throw new Error('Workflow fixture required'); workflowCapability = false; break;
        case '/harness-failure':
          if (!harnessMode) throw new Error('Harness fixture required'); harnessFailure = true; break;
        case '/harness-clear-failure':
          if (!harnessMode) throw new Error('Harness fixture required'); harnessFailure = false; break;
        case '/harness-unavailable':
          if (!harnessMode) throw new Error('Harness fixture required'); harnessAvailable = false; break;
        case '/harness-available':
          if (!harnessMode) throw new Error('Harness fixture required'); harnessAvailable = true; break;
        case '/team-work-tools-unsupported':
          if (!teamWorkToolsMode) throw new Error('Team work-tools fixture required');
          teamWorkToolsSupported = false;
          break;
        case '/overview-unavailable':
          if (!taskOverviewMode) throw new Error('Current-work fixture required');
          overviewUnavailable = true;
          break;
        case '/overview-history-only':
          if (!taskOverviewMode) throw new Error('Current-work fixture required');
          overviewOnlyHistory = true;
          break;
        case '/supervision-complete':
          if (!supervisionMode) throw new Error('Supervision fixture required');
          pending.length = 0; conversation.active = false; assistant.streaming = false;
          assistant.tools = assistant.tools.map(tool => ({ ...tool, state: 'done' }));
          break;
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
        case '/team-settings-change': {
          if (!teamSettingsMode) throw new Error('Team settings fixture required');
          const current = roomBots.team.list().teams.find(team => team.id === roomTeam.id);
          roomBots.team.update(roomTeam.id, { expectedRevision: current.revision, name: 'Mac revised team' });
          teamSettingsActions.push('external-settings-change');
          break;
        }
        case '/team-settings-active':
          if (!teamSettingsMode) throw new Error('Team settings fixture required');
          settingsHold = roomBots.team.message(roomTeam.id, { message: 'Hold settings fixture', requestId: 'settings_hold' });
          break;
        case '/team-settings-idle':
          if (!teamSettingsMode || !settingsHold) throw new Error('Team settings hold required');
          await roomBots.team.stop(roomTeam.id, settingsHold.run.id);
          teamSettingsActions.push('stopped-inert-routing-turn');
          break;
        case '/team-members-change':
          if (!teamSettingsMode) throw new Error('Team members fixture required');
          roomBots.team.update(roomTeam.id, { expectedRevision: roomBots.team.list().teams.find(row => row.id === roomTeam.id).revision, name: 'Mac revised team' });
          break;
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
      response.end(JSON.stringify({ ...(routeMode ? { routeAddresses, routeRequests, pairedDeviceCount: bridge.state().devices.length } : {}), ...(teamPlansMode ? { teamPlanRecord: teamPlanController.detail(savedTeam.id, teamPlanRecord.id).plan, teamPlanDispatches, providerDispatches: 0, pairedDeviceCount: bridge.state().devices.length } : {}), ...(workflowMode ? { workflowRecord, workflowCapability, workflowFailure } : {}), ...(teamFollowMode ? { followMessages, providerDispatches: 0 } : {}), ...(createdToolsMode ? { createdTools } : {}), ...(harnessMode ? { harness: harnessJournal.summary(), harnessDispatches, harnessAvailable } : {}), ...(teamReviewMode ? { reviewTasks, reviewPlan, overviewRequests } : {}), ...(connectorService ? { connectors: connectorService.list(), connectorChecks, connectorToolCalls } : {}), conversation, createdBotConversation, pending, calls, ...(roomBots ? { teamChannel: roomBots.team.channel(roomTeam.id), roomTurns, roomTeam, roomEmptyTeam, ...(compactTeamMode ? { compactAssignment, compactReport } : {}), ...((teamSettingsMode || unrestrictedTeamsMode || continuousTeamsMode) ? { teamSettings: roomBots.team.list(), roomMembers, roomExtraMember, teamSettingsFolder, teamSettingsOtherFolder, teamSettingsActions } : {}) } : {}), ...(lifecycleProfiles ? { lifecycle: await lifecycleProfiles.list() } : {}), computerRunning, computerControlled: !!computerControl, botFace, downloadJobs: Object.fromEntries(downloadJobs), planCount: nextPlan, downloadCount: nextDownload }));
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
        ...(process.env.STRATA_TEST_RESULT_BUNDLE ? ['-resultBundlePath', process.env.STRATA_TEST_RESULT_BUNDLE] : []),
        ...(process.argv[2] === '--test-route-tls' ? ['-only-testing:StrataMobileTests/ConnectionRoutingTLSTests'] : ['-only-testing:StrataMobileUITests/CompanionSmokeTests/' + ({ '--test-team-plans': 'testDurableTeamPlanShowsRealControllerTasksAndRequiresOwnerReview', '--test-connection-routes': 'testManualMacAddressUpdatePreservesPairingHistoryAndRelaunch', '--test-team-follow': 'testTeamIncomingRepliesFollowAndUnreadPreservesReadingPosition', '--test-team-workflows': 'testTeamWorkflowRolesEvidenceOwnerReviewAndExplicitContinuation', '--test-harness': 'testHarnessReadinessDiagnosticsAndReviewWithoutExecutingWork', '--test-created-tools': 'testCreatedToolDraftReviewBotAndTeamAccessWithoutExecution', '--test-team-work-tools': 'testTeamWorkIntentRequiresExplicitSendAndKeepsChatCompatible', '--test-team-work-overview': 'testCurrentWorkOverviewKeepsActiveLegacyAndRequiresExplicitHistoryExpansion', '--test-team-review': 'testSubmittedTaskReviewAndExplicitRecoveryWithoutReplayingFinishedWork', '--test-team-compact': 'testCompactTeamAssignmentsAndReportsExpandWithoutChangingHistory', '--test-continuous-teams': 'testContinuousTeamWorkHasNoNumericStopLimits', '--test-unrestricted-teams': 'testLargeTeamCreationUsesAllAvailableTeammates', '--test-host-folder': 'testScopedHostFolderSettingsGrantAndRevokeWithoutStartingWork', '--test-supervision': 'testLiveBotSupervisionFiltersExactConversationAndLargeType', '--test-connector-accounts': 'testConnectorAccountsDiscoverBearerSetupAndMacSignInFallback', '--test-connectors': 'testConnectorsHTTPSetupTeamAccessToolsAndPersistence', '--test-devin-provider': 'testPhoneCreatesDevinBotWithHostModelsAndNoImplicitRun', '--test-direct-bots': 'testDirectBotRosterChatProfileNewConversationAndRelaunch', '--test': 'testSharedMacHistoryLiveBrowserApprovalAndContinuation', '--test-downloads': 'testModelDownloadReviewProgressCancelRetryAndTargetSelection', '--test-bots': 'testBotsSharedHistoryThinkingAndNewConversation', '--test-computer': 'testActualSampleAvatarAndIsolatedComputerControl', '--test-bot-photos': 'testPhotoLedBotsCreationAppearanceAndWorkspaceNavigation', '--test-bot-lifecycle': 'testPhoneBotCreationEditingCASAndApprovalModes', '--test-bot-avatar-states': 'testBotAvatarStatesInteractionAndRosterFilters', '--test-facelift': 'testFaceliftPrincipalScreensAndSharedHistory', '--test-workspace-skills': 'testReviewedSkillAssignmentAndWorkspaceNavigation', '--test-workspace-connections': 'testSavedConnectionCheckAndReviewedAccess', '--test-workspace-teams': 'testTeamExplicitTaskSharedThinkingStopAndActivity', '--test-team-channel': 'testNaturalTeamChannelPeersAssignmentsThinkingAndStop', '--test-team-channel-layout': 'testTeamChannelNormalDarkAndLargeTypeLayout', '--test-group-chat-layout': 'testGroupRosterAndRoomPhotoLayoutWithRealMenus', '--test-team-members': 'testTeamMembersEditorAddRemoveCoordinatorPersistenceAndConflict', '--test-team-settings': 'testTeamMembershipSharedComputerFoldersConflictAndPersistence', '--test-team-instructions': 'testTeamPublicInstructionsRolesPersistenceAndConflict', '--test-notifications': 'testNotificationPreferencesPrivateInboxRoutingMuteAndRelaunch' })[process.argv[2]]]),
        '-parallel-testing-enabled', 'NO', 'test',
      ], { stdio: 'inherit', env: { ...process.env,
        TEST_RUNNER_STRATA_TEST_INVITATION: connection.invitation,
        ...(routeMode ? { TEST_RUNNER_STRATA_ROUTING_TLS: JSON.stringify({ ...routeAddresses, invitation: connection.invitation, control: connection.control }) } : {}),
        TEST_RUNNER_STRATA_SHARED_FIXTURE_CONTROL: connection.control,
        TEST_RUNNER_STRATA_MODEL_MANAGEMENT_FIXTURE_CONTROL: connection.control,
      } });
      testProcess.once('error', reject);
      testProcess.once('exit', code => resolve(code ?? 1));
    });
    process.exitCode = status;
    if (process.env.STRATA_TEST_STATE_OUTPUT) writeFileSync(process.env.STRATA_TEST_STATE_OUTPUT, JSON.stringify({ ...(routeMode ? { routeAddresses, routeRequests, pairedDeviceCount: bridge.state().devices.length } : {}), ...(teamPlansMode ? { teamPlanRecord: teamPlanController.detail(savedTeam.id, teamPlanRecord.id).plan, teamPlanDispatches, providerDispatches: 0, pairedDeviceCount: bridge.state().devices.length } : {}), ...(workflowMode ? { workflowRecord, workflowCapability, workflowFailure } : {}), ...(teamFollowMode ? { followMessages, providerDispatches: 0 } : {}), ...(createdToolsMode ? { createdTools } : {}), ...(harnessMode ? { harness: harnessJournal.summary(), harnessDispatches, harnessAvailable } : {}), ...(teamReviewMode ? { reviewTasks, reviewPlan, overviewRequests } : {}), ...(connectorService ? { connectors: connectorService.list(), connectorChecks, connectorToolCalls } : {}), calls, ...(directBotsMode || process.argv[2] === '--test-devin-provider' ? { conversation, createdBotConversation, directCreatedConversations, teamConversation, computerRunning, computerControlled: !!computerControl } : {}), ...(roomBots ? { teamChannel: roomBots.team.channel(roomTeam.id), roomTurns, roomTeam, roomEmptyTeam, ...(teamSettingsMode ? { teamSettings: roomBots.team.list(), roomMembers, roomExtraMember, teamSettingsFolder, teamSettingsOtherFolder, teamSettingsActions } : {}) } : {}), ...(lifecycleProfiles ? { lifecycle: await lifecycleProfiles.list() } : {}), savedTeam, teamRun, skillAssignments, skills: skillCatalog(), connectionAccess: { botIds: mcpConnection.botIds, enabledToolIds: mcpConnection.enabledToolIds, readOnlyToolIds: mcpConnection.readOnlyToolIds } }), { mode: 0o600 });
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
