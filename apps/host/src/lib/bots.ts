/** Bot profiles are separate from model-serving connections and their credentials. */
import type { Session } from './types';
export const BOT_PROVIDERS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
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
export interface Bot {
  id: string;
  name: string;
  avatar?: string;
  avatarConfig?: { kind?: 'koala'|'fox'|'cat'|'robot'; shape?: 'orb'|'pebble'|'tile'|'diamond'|'spark'|'hexagon'|'classic'; color: 'cloud'|'violet'|'orange'|'sky'|'graphite'|'slate'; eyes: 'star'|'round'|'happy'|'calm'|'plus'|'delight'; ears: 'scalloped'|'round'|'small' };
  computerMode?: 'host' | 'cua';
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
export interface BotsSnapshot { bots: Bot[]; providers: BotProvider[]; computers: BotComputer[]; models?: BotConfiguredModel[]; avatarShapes?: string[] }

/** Collaboration records contain public identities and task links, never credentials. */
export interface BotTeamLimits { maxParallel: number; maxDepth: number; maxHops: number; maxTurns: number; maxDurationMs: number }
export type BotTeamExecution = { mode: 'individual' } | { mode: 'shared'; computerId: string; workspace: string };
export interface BotTeamComputer { id: string; name: string; label: string; computerMode: 'host' | 'cua'; workspace: string; available: boolean; memberId?: string; detail?: string }
export interface BotTeam { id: string; name: string; memberIds: string[]; coordinatorId: string; enabled: boolean; limits: BotTeamLimits; createdAt: string; updatedAt: string; revision?: number; execution?: BotTeamExecution; channelPreview?: BotTeamChannelPreview }
export type BotTeamRunState = 'queued'|'running'|'completed'|'error'|'cancelled'|'interrupted'|'stopping'|'cleanup_pending';
export interface BotTeamRun { id: string; teamId: string; rootChatId: string; rootBotId: string; state: BotTeamRunState; limits: BotTeamLimits; consumedTurns: number; createdAt: string; updatedAt: string; detail?: string }
export interface BotTeamActivity { id: string; type: 'run'|'delivery'|'subagent'; teamId: string; runId: string; botId?: string; chatId?: string; parentChatId?: string; title: string; state: string; fromBotId?: string; toBotId?: string; createdAt: string; updatedAt: string; detail?: string }
export interface BotTeamsSnapshot { teams: BotTeam[]; runs: BotTeamRun[]; channelsSupported?: boolean; teamSettingsSupported?: boolean; teamComputers?: BotTeamComputer[] }
/** Public, durable room messages are separate from each bot's private work chat. */
export interface BotTeamChannelAuthor { type: 'user'|'bot'|'system'; botId?: string; name: string; avatarConfig?: Bot['avatarConfig'] }
export interface BotTeamChannelMessage {
  id: string; sequence: number; teamId: string; kind: 'message'|'assignment'|'report'|'status';
  author: BotTeamChannelAuthor; content: string; createdAt: string; replyToId?: string;
  recipientIds?: string[]; runId?: string; chatId?: string; state?: string;
}
export interface BotTeamChannelPreview { id: string; sequence: number; kind: BotTeamChannelMessage['kind']; author: Pick<BotTeamChannelAuthor, 'type'|'name'|'botId'>; content: string; createdAt: string }
export interface BotTeamChannelSnapshot { teamId: string; supported: boolean; messages: BotTeamChannelMessage[]; activeRuns: BotTeamRun[]; nextSequence: number; hasMore?: boolean; hasMoreBefore?: boolean; firstSequence?: number }
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
export interface BotConnectionTool { id: string; name: string; description: string; inputSchema: unknown; readOnly: boolean }
export interface BotConnection { id: string; name: string; transport: 'stdio'|'http'; url?: string; command?: string; args?: string[]; envKeys: string[]; apiKeySet: boolean; botIds: string[]; enabledToolIds: string[]; readOnlyToolIds: string[]; inventoryDigest:string; status: 'unchecked'|'starting'|'connected'|'unavailable'; detail: string; checkedAt?: string; tools: BotConnectionTool[] }
export interface BotConnectionsSnapshot { connections: BotConnection[] }
export interface BotProviderModel { id: string; name: string; efforts: string[]; defaultEffort?: string }
export interface BotProviderModels { provider: string; models: BotProviderModel[]; detail?: string }
export const DEFAULT_BOT_TEAM_LIMITS: BotTeamLimits = { maxParallel: 2, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 };
export function botTeamRunActive(state: string) { return ['queued', 'running', 'stopping', 'cleanup_pending'].includes(state); }
export function botActivityLabel(state: string) { return ({ queued: 'Queued', running: 'Working', completed: 'Completed', error: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted', stopping: 'Stopping…', cleanup_pending: 'Checking cleanup', delivered: 'Delivered', pending: 'Waiting', accepted: 'Accepted', refused: 'Refused' } as Record<string, string>)[state] ?? state; }
export function botTeamDraftError(draft: Pick<BotTeam, 'name'|'memberIds'|'coordinatorId'|'limits'> & { execution?: BotTeamExecution }, bots: Pick<Bot,'id'>[], computers?: BotTeamComputer[]): string | null {
  if (!draft.name.trim() || draft.name.trim().length>80) return 'Give this team a name of up to 80 characters.';
  if (draft.memberIds.length<2 || draft.memberIds.length>12) return 'Choose from 2 to 12 team members.';
  if (new Set(draft.memberIds).size !== draft.memberIds.length || draft.memberIds.some(id => !bots.some(bot => bot.id === id))) return 'Choose available bots for this team.';
  if (!draft.memberIds.includes(draft.coordinatorId)) return 'Choose a coordinator from this team.';
  if (draft.execution?.mode === 'shared') {
    const execution = draft.execution;
    if (!execution.computerId) return 'Choose a shared team computer.';
    const computer = computers?.find(item => item.id === execution.computerId);
    if (computer?.computerMode === 'cua' && (!computer.memberId || !draft.memberIds.includes(computer.memberId))) return 'Keep the teammate hosting this shared CUA computer in the team, or choose another computer.';
    const path = draft.execution.workspace.trim();
    if (!path || path.length > 4096 || path.includes('\0') || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) return 'Use the full working folder path on the shared computer.';
    if (computer?.computerMode === 'cua' && !(path === '/workspace' || path.startsWith('/workspace/') && !path.split('/').includes('..'))) return 'Use /workspace or a folder inside /workspace on the shared CUA computer.';
  }
  for (const [key, maximum] of [['maxParallel', 8], ['maxDepth', 4], ['maxHops', 32], ['maxTurns', 100], ['maxDurationMs', 3600000]] as const) {
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
