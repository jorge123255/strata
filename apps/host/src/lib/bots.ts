/** Bot profiles are separate from model-serving connections and their credentials. */
import type { Session } from './types';
import type { NeedsChoiceEvent } from './room-choice';
export const BOT_PROVIDERS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'devin', name: 'Devin CLI' },
  { id: 'grok', name: 'Grok' },
  { id: 'kimi', name: 'Kimi' },
  { id: 'ollama', name: 'Ollama Cloud' },
] as const;

export const BOT_AVATARS = [
  { value: '🤖', label: 'Robot' }, { value: '🧑‍💻', label: 'Developer' },
  { value: '🦊', label: 'Fox' }, { value: '🧠', label: 'Brain' },
  { value: '🚀', label: 'Rocket' }, { value: '🛠️', label: 'Tools' },
  { value: '🌿', label: 'Leaf' }, { value: '✨', label: 'Sparkles' },
] as const;
export type BotProviderId = typeof BOT_PROVIDERS[number]['id'] | 'configured';
export type BotCapability = 'code' | 'computer' | 'both';
export type BotPolicy = 'manual' | 'plan' | 'bypass';
export interface BotExecution { kind: 'local' | 'ssh' | 'sandbox'; host?: string; user?: string; port?: number; name?: string }
export interface BotModelSource { connectionId: string; model: string }
export interface BotHostFolder { path: string; access: 'read' | 'read-write' }
export interface Bot {
  id: string;
  name: string;
  avatar?: string;
  avatarConfig?: { kind?: 'koala'|'fox'|'cat'|'robot'; shape?: 'orb'|'pebble'|'tile'|'diamond'|'spark'|'hexagon'|'classic'; color: 'cloud'|'violet'|'orange'|'sky'|'graphite'|'slate'; eyes: 'star'|'round'|'happy'|'calm'|'plus'|'delight'; ears: 'scalloped'|'round'|'small' };
  computerMode?: 'host' | 'cua';
  hostFolder?: BotHostFolder;
  paused?: boolean;
  instructions: string;
  provider: BotProviderId;
  model: string;
  effort?: string;
  modelSource?: BotModelSource;
  capabilities: BotCapability;
  policy: BotPolicy;
  workspace: string;
  execution: BotExecution;
  providerSettings?: { baseURL?: string; apiKeySet?: boolean };
  createdAt: string;
  updatedAt: string;
  conversations?: string[];
  available?: boolean;
  detail?: string;
}
export interface BotProvider { id: BotProviderId; name: string; available: boolean; detail: string; models?: string[] }
export interface BotComputer { id: string; name: string; kind: BotExecution['kind']; available: boolean; detail: string; execution?: BotExecution }
export interface BotConfiguredModel { id: string; connectionId: string; connectionName: string; model: string; name: string; available: boolean; detail?: string }
export interface BotComputerCheck { available: boolean; detail: string; prepared?: boolean; providers?: unknown }
export interface BotsSnapshot { bots: Bot[]; providers: BotProvider[]; computers: BotComputer[]; models?: BotConfiguredModel[]; avatarShapes?: string[]; hostFolderSupported?: boolean }

/** Collaboration records contain public identities and task links, never credentials. */
export interface BotTeamLimits { maxParallel: number; maxDepth: number; maxHops: number; maxTurns: number; maxDurationMs: number }
export type BotTeamExecution = { mode: 'individual' } | { mode: 'shared'; computerId: string; workspace: string };
export interface BotTeamComputer { id: string; name: string; label: string; computerMode: 'host' | 'cua'; workspace: string; available: boolean; memberId?: string; detail?: string }
export interface BotTeamMemberBriefing { botId: string; role: string; instructions: string }
/** Public instructions for this team. Private bot profiles are separate. */
export interface BotTeamBriefing { instructions: string; members: BotTeamMemberBriefing[] }
export interface BotTeam { id: string; name: string; memberIds: string[]; coordinatorId: string; enabled: boolean; limits: BotTeamLimits; createdAt: string; updatedAt: string; revision?: number; execution?: BotTeamExecution; briefing?: BotTeamBriefing; channelPreview?: BotTeamChannelPreview; talkativeness?: Record<string, number>; bidding?: boolean; selectorBotId?: string }
export type BotTeamRunState = 'queued'|'running'|'completed'|'error'|'cancelled'|'interrupted'|'stopping'|'cleanup_pending';
export interface BotTeamRun { id: string; teamId: string; rootChatId: string; rootBotId: string; state: BotTeamRunState; limits: BotTeamLimits; consumedTurns: number; createdAt: string; updatedAt: string; detail?: string; planId?: string }
export interface BotTaskEvidence { kind: 'file'|'test'|'link'|'note'; label: string; detail: string }
export interface BotTaskResult { id: string; summary: string; evidence: BotTaskEvidence[]; submittedAt: string; botId: string; outcome?: 'ready_for_review'|'blocked' }
export interface BotTaskWork { status: 'working'|'ready_for_review'|'verified'|'blocked'|'interrupted'; revision: number; summary?: string; evidence: BotTaskEvidence[]; resultHistory: BotTaskResult[]; reviewHistory: {decision:'accept'|'reject'; note?:string; reviewedAt:string; resultId:string}[]; sourceJobId?: string; recoveryJobId?: string; legacy?: boolean }
export interface BotTaskRecoveryPlan { id: string; jobId: string; sourceRunId: string; expectedRevision: number; expiresAt: string; canResume: boolean; blockedReason?: string; botId: string; botName: string; provider: string; model: string; computerLabel: string; workspace: string; summary: string; completedReports: {jobId: string; chatId: string; reportId?: string; summary: string}[]; steps: string[] }
export interface BotTeamActivity { id: string; type: 'run'|'delivery'|'subagent'; teamId: string; runId: string; botId?: string; chatId?: string; parentChatId?: string; title: string; state: string; fromBotId?: string; toBotId?: string; createdAt: string; updatedAt: string; detail?: string; work?: BotTaskWork }
export interface BotTeamsSnapshot { teams: BotTeam[]; runs: BotTeamRun[]; channelsSupported?: boolean; teamSettingsSupported?: boolean; teamInstructionsSupported?: boolean; teamUnrestrictedSupported?: boolean; teamContinuousSupported?: boolean; teamWorkReviewSupported?: boolean; teamCoordinatorWorkToolsSupported?: boolean; teamWorkflowsSupported?: boolean; teamWorkPlansSupported?: boolean; teamComputers?: BotTeamComputer[] }
export interface BotTeamActivitySnapshot { activity: BotTeamActivity[]; teamWorkReviewSupported?: boolean }
/** Opt-in, durable team workflows. Model checks remain reports until owner review. */
export type BotTeamWorkflowPhase = 'planning'|'building'|'evaluating'|'repairing'|'awaiting_review'|'completed'|'blocked'|'interrupted'|'stopping'|'stopped';
export type BotTeamWorkflowStepPhase = 'planning'|'building'|'evaluating'|'repairing';
export interface BotTeamWorkflowStep {
  id: string; phase: BotTeamWorkflowStepPhase; botId: string; chatId?: string; runId?: string;
  state: 'pending'|'running'|'completed'|'blocked'|'interrupted'|'stopped'; summary?: string;
  evidence?: BotTaskEvidence[]; startedAt?: string; completedAt?: string;
}
export interface BotTeamWorkflow {
  id: string; teamId: string; goal: string; plannerId: string; builderId: string; evaluatorId: string;
  criteria: {id: string; text: string}[]; phase: BotTeamWorkflowPhase; revision: number; proof: string;
  round: number; summary?: string; createdAt: string; updatedAt: string; steps: BotTeamWorkflowStep[];
  checks: {criterionId: string; passed: boolean; detail: string}[]; canResume: boolean; blockedReason?: string;
  plan?: {summary: string; items: string[]}; totalSteps: number; stepsTruncated: boolean;
}
export interface BotTeamWorkflowsSnapshot { teamWorkflowsSupported: boolean; available: boolean; workflows: BotTeamWorkflow[]; hasMore: boolean; error?: string }
export type BotTeamPlanPhase = 'planning'|'running'|'summarizing'|'awaiting_review'|'completed'|'blocked'|'interrupted'|'stopping'|'stopped';
export type BotTeamPlanTaskState = 'pending'|'queued'|'running'|'working'|'ready_for_review'|'blocked'|'interrupted'|'stopped';
export interface BotTeamPlanTask {
  id: string; key: string; title: string; instructions: string; instructionsTruncated?: boolean;
  ownerId: string; collaboratorIds: string[]; workspaceKey?: string; dependsOn: string[]; kind: 'work'|'review';
  criteria: {id: string; text: string}[]; state: BotTeamPlanTaskState; summary?: string; nextStep?: string;
  checks?: {criterionId: string; passed: boolean; detail: string}[]; evidence?: BotTaskEvidence[]; attemptId?: string; chatId?: string; jobId?: string;
}
export interface BotTeamPlanAttempt { id: string; kind: 'planning'|'task'|'synthesis'; taskId?: string; botId: string; state: 'pending'|'running'|'completed'|'blocked'|'interrupted'|'stopped'; chatId?: string; jobId?: string; summary?: string; startedAt?: string; completedAt?: string }
export interface BotTeamPlan {
  id: string; teamId: string; parentRunId: string; sourceMessageId?: string; goal: string; coordinatorId: string; memberIds: string[];
  phase: BotTeamPlanPhase; revision: number; proof: string; createdAt: string; updatedAt: string; summary?: string; blockedReason?: string;
  participation: {botId: string; role: string; reason: string}[]; tasks: BotTeamPlanTask[];
  counts: Record<BotTeamPlanTaskState, number>; totalTasks: number; tasksOffset: number; nextTaskOffset: number|null; tasksTruncated: boolean;
  attempts: BotTeamPlanAttempt[]; totalAttempts: number; attemptsTruncated: boolean; canResume: boolean;
}
export interface BotTeamPlansSnapshot { teamWorkPlansSupported: boolean; available: boolean; plans: BotTeamPlan[]; hasMore: boolean; nextBeforePlanId?: string|null; error?: string }
export function botTaskWorkLabel(status: string) { return ({working:'Working',ready_for_review:'Ready for review',verified:'Verified',blocked:'Blocked',interrupted:'Interrupted'} as Record<string,string>)[status] ?? 'Needs review'; }
/** Public, durable room messages are separate from each bot's private work chat. */
export interface BotTeamChannelAuthor { type: 'user'|'bot'|'system'; botId?: string; name: string; avatarConfig?: Bot['avatarConfig'] }
export interface BotTeamChannelMessage {
  id: string; sequence: number; teamId: string; kind: 'message'|'assignment'|'report'|'status';
  author: BotTeamChannelAuthor; content: string; createdAt: string; replyToId?: string;
  recipientIds?: string[]; runId?: string; chatId?: string; state?: string; workMode?: 'chat'|'work'; planId?: string;
}
export interface BotTeamChannelPreview { id: string; sequence: number; kind: BotTeamChannelMessage['kind']; author: Pick<BotTeamChannelAuthor, 'type'|'name'|'botId'>; content: string; createdAt: string }
export interface BotTeamPresence { botId: string; state: 'working' | 'queued'; runId: string; jobId: string }
export interface BotTeamChannelSnapshot { teamId: string; supported: boolean; messages: BotTeamChannelMessage[]; activeRuns: BotTeamRun[]; nextSequence: number; hasMore?: boolean; hasMoreBefore?: boolean; firstSequence?: number; presence?: BotTeamPresence[]; needsChoice?: NeedsChoiceEvent | null }
/** Sidebar summary from GET /api/bots/summary and the bot-summary stream. */
export interface BotRoomLastMessage { at: string; preview: string; authorName: string }
export interface BotRoomWorking { botId: string; name: string; state: 'working' | 'queued' }
export interface BotRoomSummary { id: string; name: string; memberCount: number; unreadCount: number; lastMessage: BotRoomLastMessage | null; working: BotRoomWorking[] }
export interface BotSummaryRow { id: string; name: string; status: 'idle' | 'working' | 'error'; unreadCount: number }
export interface BotSidebarSummary { rooms: BotRoomSummary[]; bots: BotSummaryRow[] }
/** Cursor pages may overlap; keep stable identities, order and only this room's rows. */
export function mergeBotTeamChannelMessages(previous: BotTeamChannelMessage[], incoming: BotTeamChannelMessage[], teamId: string): BotTeamChannelMessage[] {
  const rows = new Map(previous.filter(row => row.teamId === teamId).map(row => [row.id, row]));
  const sequences = new Map([...rows.values()].map(row => [row.sequence, row.id]));
  for (const row of incoming) if (row.teamId === teamId && Number.isSafeInteger(row.sequence) && row.sequence > 0 && row.id) {
    if (rows.has(row.id) && rows.get(row.id)!.sequence !== row.sequence || sequences.has(row.sequence) && sequences.get(row.sequence) !== row.id) throw new Error('The team channel changed a saved message sequence. Refresh before sending.');
    sequences.set(row.sequence, row.id); rows.set(row.id, row);
  }
  return [...rows.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

export interface BotSkill { id: string; name: string; description: string; body: string; triggers: string[]; source: 'library'|'draft'; status: 'draft'|'enabled'; revision: number|string; digest: string; botIds: string[]; onlyIn?:string|null; mainChatEnabled?:boolean; provenance?: unknown }
export interface BotSkillAssignment { botId: string; skillIds: string[] }
export interface BotSkillsSnapshot { skills: BotSkill[]; assignments: BotSkillAssignment[] }
/** Owner-reviewed commands. Saved drafts and access changes never execute them. */
export interface BotCreatedTool {
  id: string; name: string; description: string; command: string; inputSchema: Record<string, unknown>;
  timeoutSeconds: number; status: 'draft'|'enabled'; revision: number; digest: string;
  botIds: string[]; teamIds: string[]; createdAt: string; updatedAt: string;
  provenance?: { botId: string; chatId: string; turnId: string };
  requirements?: BotToolRequirements;
}
export interface BotToolRequirements { platforms?: Array<'darwin'|'linux'|'win32'>; executables?: string[]; workspaceFiles?: string[] }
export interface BotCreatedToolsSnapshot { tools: BotCreatedTool[]; createdToolsSupported?: boolean; createdToolReadinessSupported?: boolean; reason?: string }
export interface BotCreatedToolDraft { name: string; description: string; command: string; inputSchema: Record<string, unknown>; timeoutSeconds: number; requirements?: BotToolRequirements }
export interface BotConnectionTool { id: string; name: string; description: string; inputSchema: unknown; readOnly: boolean }
export interface BotConnectorFeatures { catalog?: boolean; httpCreation?: boolean; teamAccess?: boolean; oauth?: boolean; iphoneOAuth?: boolean }
export interface BotConnectorCatalogEntry { id: string; name: string; description: string; category: string; transport: 'http'; url?: string; authTypes: Array<'none'|'bearer'|'oauth'>; documentationURL?: string; setupNote?: string; setupState?: 'ready'|'configuration'|'managed'|'unavailable'; sourceURL?: string; phoneSignIn?: boolean; aliases?: string[] }
export interface BotConnectorCatalog { connectors: BotConnectorCatalogEntry[]; connectorFeatures?: BotConnectorFeatures }
export interface BotConnectorAuth { status: 'not_connected'|'connecting'|'connected'|'waiting'|'expired'|'error'; detail: string; authorizationURL?: string; expiresAt?: string; callbackTarget?: 'mac'|'iphone' }
export interface BotConnection { id: string; name: string; transport: 'stdio'|'http'; url?: string; command?: string; args?: string[]; envKeys: string[]; apiKeySet: boolean; botIds: string[]; enabledToolIds: string[]; readOnlyToolIds: string[]; inventoryDigest:string; status: 'unchecked'|'starting'|'connected'|'unavailable'; detail: string; checkedAt?: string; tools: BotConnectionTool[]; catalogId?: string; accountLabel?: string; authType?: 'none'|'bearer'|'oauth'; teamIds?: string[]; customInstructions?: string; enabled?: boolean; auth?: BotConnectorAuth; oauthClientIdSet?: boolean; oauthClientSecretSet?: boolean }
export interface BotConnectionsSnapshot { connections: BotConnection[]; connectorFeatures?: BotConnectorFeatures }
export interface BotProviderModel { id: string; name: string; efforts: string[]; defaultEffort?: string }
export interface BotProviderModels { provider: string; models: BotProviderModel[]; detail?: string }
export const TEAM_MEMBER_CAP = 12;
export const DEFAULT_BOT_TEAM_LIMITS: BotTeamLimits = { maxParallel: 2, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 };
export const CONTINUOUS_BOT_TEAM_LIMITS: BotTeamLimits = { maxParallel: 0, maxDepth: 0, maxHops: 0, maxTurns: 0, maxDurationMs: 0 };
export function botTeamWorkLabel(limits: BotTeamLimits, continuous = false, unrestricted = false) { return continuous ? 'All available teammates · Until finished or stopped' : `${botTeamParallelLabel(limits, unrestricted)} · ${limits.maxTurns} ${unrestricted ? 'work turns' : 'turns'} · ${Math.round(limits.maxDurationMs / 60000)} minute limit`; }
export function botTeamParallelLabel(limits: BotTeamLimits, unrestricted = false) { return unrestricted || limits.maxParallel === 0 ? 'All available teammates' : `${limits.maxParallel} parallel tasks`; }
export function botTeamRunActive(state: string) { return ['queued', 'running', 'stopping', 'cleanup_pending'].includes(state); }
export function teamRosterCount(memberIds: readonly string[] | undefined) { return Array.isArray(memberIds) ? memberIds.length : 0; }
export function teamRosterLabel(count: number) { return count === 1 ? '1 member' : `${count} members`; }
export function teamOverRosterCap(count: number) { return count > TEAM_MEMBER_CAP; }
export function botActivityLabel(state: string) { return ({ queued: 'Queued', running: 'Working', completed: 'Completed', error: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted', stopping: 'Stopping…', cleanup_pending: 'Checking cleanup', delivered: 'Delivered', pending: 'Waiting', accepted: 'Accepted', refused: 'Refused' } as Record<string, string>)[state] ?? state; }
export function botTeamDraftError(draft: Pick<BotTeam, 'name'|'memberIds'|'coordinatorId'|'limits'> & { execution?: BotTeamExecution; briefing?: BotTeamBriefing; talkativeness?: Record<string, number>; bidding?: boolean; selectorBotId?: string | null }, bots: Pick<Bot,'id'>[], computers?: BotTeamComputer[], unrestricted = false, continuous = false): string | null {
  if (!draft.name.trim() || draft.name.trim().length>80) return 'Give this team a name of up to 80 characters.';
  if (draft.memberIds.length < 2 || draft.memberIds.length > TEAM_MEMBER_CAP) return 'Choose from 2 to 12 team members.';
  if (new Set(draft.memberIds).size !== draft.memberIds.length || draft.memberIds.some(id => !bots.some(bot => bot.id === id))) return 'Choose available bots for this team.';
  if (!draft.memberIds.includes(draft.coordinatorId)) return 'Choose a coordinator from this team.';
  if (draft.bidding !== undefined && typeof draft.bidding !== 'boolean') return 'Choose whether teammates bid to speak.';
  if (draft.selectorBotId !== undefined && draft.selectorBotId !== null && draft.selectorBotId !== '' && !draft.memberIds.includes(draft.selectorBotId)) return 'Choose a teammate to pick the next speaker.';
  if (draft.talkativeness) {
    if (typeof draft.talkativeness !== 'object' || Array.isArray(draft.talkativeness)) return 'Choose a talkativeness from 0 to 100 for each teammate.';
    for (const [id, value] of Object.entries(draft.talkativeness)) if (!draft.memberIds.includes(id) || !Number.isInteger(value) || value < 0 || value > 100) return 'Choose a talkativeness from 0 to 100 for each teammate.';
  }
  if (draft.briefing) {
    const cleanText = (value: string, max: number) => typeof value === 'string' && value.length <= max && !value.includes('\0') && !Array.from(value).some(character => { const point = character.codePointAt(0)!; return point >= 0xD800 && point <= 0xDFFF; });
    if (!cleanText(draft.briefing.instructions, 8000) || !Array.isArray(draft.briefing.members) || draft.briefing.members.length > (unrestricted ? draft.memberIds.length : TEAM_MEMBER_CAP)) return 'Use team instructions of up to 8,000 characters.';
    const seen = new Set<string>();
    let total = draft.briefing.instructions.length;
    for (const member of draft.briefing.members) {
      if (!draft.memberIds.includes(member.botId) || seen.has(member.botId)) return 'Assign roles only to selected teammates.';
      seen.add(member.botId);
      if (!cleanText(member.role, 120) || !cleanText(member.instructions, 4000)) return 'Use a role of up to 120 characters and member instructions of up to 4,000 characters.';
      total += member.role.length + member.instructions.length;
    }
    if (total > 24000) return 'Keep all team instructions and roles within 24,000 characters in total.';
  }
  if (draft.execution?.mode === 'shared') {
    const execution = draft.execution;
    if (!execution.computerId) return 'Choose a shared team computer.';
    const computer = computers?.find(item => item.id === execution.computerId);
    if (computer?.computerMode === 'cua' && (!computer.memberId || !draft.memberIds.includes(computer.memberId))) return 'Keep the teammate hosting this shared CUA computer in the team, or choose another computer.';
    const path = draft.execution.workspace.trim();
    if (!path || path.length > 4096 || path.includes('\0') || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) return 'Use the full working folder path on the shared computer.';
    if (computer?.computerMode === 'cua' && !(path === '/workspace' || path.startsWith('/workspace/') && !path.split('/').includes('..'))) return 'Use /workspace or a folder inside /workspace on the shared CUA computer.';
  }
  if (continuous) return Object.keys(CONTINUOUS_BOT_TEAM_LIMITS).every(key => draft.limits[key as keyof BotTeamLimits] === 0) ? null : 'Use continuous team work settings.';
  if (!Number.isSafeInteger(draft.limits.maxParallel) || draft.limits.maxParallel < (unrestricted ? 0 : 1) || !unrestricted && draft.limits.maxParallel > 8) return 'Choose valid parallel work settings.';
  for (const [key, maximum] of [['maxDepth', 4], ['maxHops', 32], ['maxTurns', 100], ['maxDurationMs', 3600000]] as const) {
    if (!Number.isInteger(draft.limits[key]) || draft.limits[key] < (key === 'maxDurationMs' ? 60000 : 1) || draft.limits[key] > maximum) return 'Choose bounded team work limits.';
  }
  return null;
}
export function botTeamWorkplace(team: Pick<BotTeam, 'execution'>, computers: BotTeamComputer[] = [], bots: Pick<Bot, 'id' | 'name'>[] = []) {
  if (team.execution?.mode !== 'shared') return { shared: false, name: 'Each bot’s computer', label: 'Each teammate uses its saved computer.', workspace: 'Each bot’s saved working folder' };
  const execution = team.execution, computer = computers.find(item => item.id === execution.computerId), owner = bots.find(item => item.id === computer?.memberId);
  return { shared: true, name: computer?.name ?? (owner ? `${owner.name}’s computer` : 'Shared computer unavailable'), label: computer?.label ?? 'Shared team computer', workspace: team.execution.workspace };
}
export type BotDraft = Omit<Bot, 'id' | 'createdAt' | 'updatedAt' | 'conversations' | 'available' | 'detail' | 'providerSettings'> & {
  providerSettings?: { baseURL?: string; apiKey?: string; clearKey?: boolean };
};

export function blankBot(workspace: string): BotDraft {
  return { name: '', avatar: '🤖', computerMode: 'host', instructions: '', provider: 'claude', model: '', capabilities: 'both', policy: 'manual', workspace, execution: { kind: 'local' } };
}
export function botProviderName(id: string): string { return id === 'configured' ? 'Models connection' : BOT_PROVIDERS.find(provider => provider.id === id)?.name ?? id; }
export function botAvatar(value?: string): string { return BOT_AVATARS.find(avatar => avatar.value === value)?.value ?? '🤖'; }
export function configuredModel(source: BotModelSource | undefined, models: BotConfiguredModel[] = []): BotConfiguredModel | undefined {
  return source ? models.find(model => model.connectionId === source.connectionId && model.model === source.model) : undefined;
}
export function configuredModelLabel(model: BotConfiguredModel): string { return `${model.connectionName} · ${model.name || model.model}`; }
export function botCapabilityLabel(capability: BotCapability): string {
  return capability === 'code' ? 'Coding' : capability === 'computer' ? 'Computer control' : 'Coding + computer';
}
export function botPolicyLabel(policy: BotPolicy): string {
  return policy === 'plan' ? 'Plan · inspect only' : policy === 'bypass' ? 'Bypass approvals' : 'Ask before changes';
}

/** Activity comes from shared work, never from a prepared or running computer. */
export function botAvatarActivity(bot: Pick<Bot, 'id' | 'paused'>, sessions: Session[]): 'idle' | 'thinking' | 'working' | 'needsApproval' | 'paused' | 'error' {
  if (bot.paused) return 'paused';
  const chats = botConversations(sessions, bot.id);
  if (chats.some(chat => chat.messages.some(message => message.tools?.some(tool => tool.live && tool.state === 'proposed')))) return 'needsApproval';
  const active = chats.filter(chat => chat.active);
  if (active.length) return active.some(chat => chat.messages.some(message => message.tools?.some(tool => tool.live && ['running', 'approved'].includes(tool.state)))) ? 'working' : 'thinking';
  const latest = chats[0]?.messages.at(-1);
  return latest?.role === 'assistant' && latest.error ? 'error' : 'idle';
}

/** A reply produces one signal when finished; streaming tokens produce none. */
export function botReplySignal(botId: string, sessions: Session[]): string | undefined {
  for (const chat of botConversations(sessions, botId)) {
    if (chat.active) continue;
    const reply = [...chat.messages].reverse().find(message => message.role === 'assistant' && !message.streaming && !message.error);
    if (reply) return `${chat.id}:${reply.id}`;
  }
}

/** A roster preview uses the bot's own shared messages, never another model's chat. */
export function botRosterPreview(botId: string, sessions: Session[]): { text: string; updatedAt: string } | undefined {
  const chat = botPersonalConversations(sessions, botId)[0];
  if (!chat) return undefined;
  const message = [...chat.messages].reverse().find(row => row.content?.trim());
  const text = message?.content?.replace(/\s+/g, ' ').trim() || chat.title?.trim();
  return text ? { text, updatedAt: chat.updatedAt } : undefined;
}

/** One conversation list uses only each bot's direct chat or a team's public journal. */
export interface BotConversationRosterItem { kind: 'bot'|'team'; id: string; name: string; updatedAt: string; preview?: string; state: 'idle'|'working'|'attention'|'paused' }
export function botTeamRosterPreview(team: BotTeam): { text: string; updatedAt: string } | undefined {
  const row = team.channelPreview;
  if (!row || typeof row.content !== 'string' || !row.content.trim() || !Number.isFinite(Date.parse(row.createdAt)) || !row.author || typeof row.author.name !== 'string') return undefined;
  const author = row.author.type === 'user' ? 'You' : row.author.type === 'system' ? 'Team update' : row.author.name;
  return { text: `${author}: ${row.content.replace(/\s+/g, ' ').trim()}`, updatedAt: row.createdAt };
}
export function botConversationRoster(bots: Bot[], teams: BotTeamsSnapshot | null, sessions: Session[]): BotConversationRosterItem[] {
  const rows: BotConversationRosterItem[] = bots.map(bot => {
    const preview = botRosterPreview(bot.id, sessions), mood = botAvatarActivity(bot, sessions);
    return { kind: 'bot', id: bot.id, name: bot.name, updatedAt: preview?.updatedAt ?? bot.createdAt, preview: preview?.text,
      state: mood === 'paused' ? 'paused' : ['needsApproval', 'error'].includes(mood) ? 'attention' : ['thinking', 'working'].includes(mood) ? 'working' : 'idle' };
  });
  for (const team of teams?.teams ?? []) {
    const preview = botTeamRosterPreview(team), runs = (teams?.runs ?? []).filter(run => run.teamId === team.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    rows.push({ kind: 'team', id: team.id, name: team.name, updatedAt: preview?.updatedAt ?? team.createdAt, preview: preview?.text,
      state: runs.some(run => run.state === 'cleanup_pending') ? 'attention' : runs.some(run => ['queued', 'running', 'stopping'].includes(run.state)) ? 'working' : ['error', 'interrupted'].includes(runs[0]?.state) ? 'attention' : 'idle' });
  }
  const time = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  return rows.sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || a.name.localeCompare(b.name) || `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

export function botSetupStepError(step: number, draft: BotDraft): string | null {
  if (step === 0) return !draft.name.trim() ? 'Give this bot a name.' : draft.name.trim().length > 120 ? 'Use a name of up to 120 characters.' : null;
  if (step === 2 && draft.provider === 'configured' && (!draft.modelSource?.connectionId || !draft.modelSource.model)) return 'Choose a model from your saved Models connections.';
  if (step === 3) {
    if (draft.execution.kind !== 'local' && !draft.execution.host?.trim()) return draft.execution.kind === 'ssh' ? 'Enter the SSH host or alias.' : 'Enter the sandbox address.';
    if (draft.execution.port !== undefined && (!Number.isInteger(draft.execution.port) || draft.execution.port < 1 || draft.execution.port > 65535)) return 'Use an SSH port from 1 to 65535.';
    if (!draft.workspace.trim()) return 'Choose a workspace on the execution computer.';
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(draft.workspace.trim())) return 'Use the full workspace path on the execution computer.';
    if (draft.computerMode === 'cua' && draft.workspace.trim() !== '/workspace') return 'The isolated computer uses /workspace.';
  }
  return null;
}
export function botComputerLabel(execution: BotExecution): string {
  if (execution.kind === 'local') return 'This Mac';
  if (execution.name?.trim()) return execution.name.trim();
  const host = execution.host?.trim();
  if (execution.kind === 'sandbox') return host ? `Sandbox · ${host}` : 'Sandbox';
  if (!host) return 'SSH computer';
  return `${execution.user?.trim() ? `${execution.user.trim()}@` : ''}${host}${execution.port && execution.port !== 22 ? `:${execution.port}` : ''}`;
}

export function botComputerSelection(execution: BotExecution, computers: BotComputer[]): string {
  if (execution.kind === 'local') return 'local';
  if (execution.kind === 'sandbox') return 'sandbox';
  const found = computers.find(computer => computer.kind === 'ssh' && computer.execution?.host === execution.host && (computer.execution?.user ?? '') === (execution.user ?? '') && (computer.execution?.port ?? null) === (execution.port ?? null));
  return found?.id ?? 'custom-ssh';
}

/** All selection stays keyed by bot identity, never by the currently loaded model. */
export function botConversations<T extends { preferences?: { botId?: string }; updatedAt: string }>(sessions: T[], botId: string): T[] {
  return sessions.filter(session => session.preferences?.botId === botId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Opening a bot is a personal conversation; team workers remain in full history. */
export function botPersonalConversations<T extends { preferences?: { botId?: string; teamId?: string; teamRunId?: string; parentChatId?: string }; updatedAt: string }>(sessions: T[], botId: string): T[] {
  return botConversations(sessions, botId).filter(session => !session.preferences?.teamId && !session.preferences?.teamRunId && !session.preferences?.parentChatId);
}

/** Frozen public labels describe a chat; they are never parsed into credentials or execution settings. */
export function botConversationContext(bot: Bot, chat?: { id: string; workspace?: string; preferences?: { botId?: string; botComputerMode?: 'host' | 'cua'; botComputer?: string; botModel?: string } }, models: BotConfiguredModel[] = []) {
  if (chat) {
    const owned = chat.preferences?.botId === bot.id;
    return { chatId: chat.id, computerMode: owned ? chat.preferences?.botComputerMode : undefined,
      computer: owned && chat.preferences?.botComputer || 'Conversation computer', model: owned && chat.preferences?.botModel || 'Conversation model', workspace: owned ? chat.workspace || '' : '' };
  }
  const model = configuredModel(bot.modelSource, models);
  return { chatId: undefined, computerMode: bot.computerMode ?? 'host', computer: botComputerLabel(bot.execution), model: model ? configuredModelLabel(model) : `${botProviderName(bot.provider)} · ${bot.model || 'Provider default'}`, workspace: bot.workspace };
}

export function botDraftError(draft: BotDraft): string | null {
  const setupError = botSetupStepError(0, draft) || botSetupStepError(2, draft) || botSetupStepError(3, draft);
  if (setupError) return setupError;
  if (draft.avatar && !BOT_AVATARS.some(avatar => avatar.value === draft.avatar)) return 'Choose one of the available bot avatars.';
  if (draft.provider === 'configured' && (!draft.modelSource?.connectionId || !draft.modelSource.model)) return 'Choose a model from your saved Models connections.';
  if (draft.execution.kind !== 'local' && !draft.execution.host?.trim()) return draft.execution.kind === 'ssh' ? 'Enter the SSH host or alias.' : 'Enter the sandbox address.';
  if (draft.execution.port !== undefined && (!Number.isInteger(draft.execution.port) || draft.execution.port < 1 || draft.execution.port > 65535)) return 'Use an SSH port from 1 to 65535.';
  if (draft.providerSettings?.baseURL?.trim()) {
    try { const url = new URL(draft.providerSettings.baseURL); if (!['https:', 'http:'].includes(url.protocol)) return 'Use an HTTP or HTTPS provider address.'; }
    catch { return 'Use a complete provider address, including https://.'; }
  }
  return null;
}
