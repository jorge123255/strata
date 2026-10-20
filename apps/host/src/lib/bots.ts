/** Bot profiles are separate from model-serving connections and their credentials. */
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
  avatarConfig?: { color: 'cloud'|'violet'|'orange'|'sky'|'graphite'|'slate'; eyes: 'star'|'round'|'happy'|'calm'|'plus'|'delight'; ears: 'scalloped'|'round'|'small' };
  computerMode?: 'host' | 'cua';
  paused?: boolean;
  instructions: string;
  provider: BotProviderId;
  model: string;
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
export interface BotsSnapshot { bots: Bot[]; providers: BotProvider[]; computers: BotComputer[]; models?: BotConfiguredModel[] }
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
  return policy === 'plan' ? 'Plan first' : policy === 'bypass' ? 'Automatic' : 'Ask before changes';
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
  if (!draft.name.trim()) return 'Give this bot a name.';
  if (!draft.workspace.trim()) return 'Choose a workspace on the execution computer.';
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
