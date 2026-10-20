/** Bot profiles are separate from model-serving connections and their credentials. */
export const BOT_PROVIDERS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'grok', name: 'Grok' },
  { id: 'kimi', name: 'Kimi' },
  { id: 'ollama', name: 'Ollama Cloud' },
] as const;

export type BotProviderId = typeof BOT_PROVIDERS[number]['id'];
export type BotCapability = 'code' | 'computer' | 'both';
export type BotPolicy = 'manual' | 'plan' | 'bypass';
export interface BotExecution { kind: 'local' | 'ssh' | 'sandbox'; host?: string; user?: string; port?: number }
export interface Bot {
  id: string;
  name: string;
  instructions: string;
  provider: BotProviderId;
  model: string;
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
export interface BotComputer { id: string; name: string; kind: BotExecution['kind']; available: boolean; detail: string }
export interface BotsSnapshot { bots: Bot[]; providers: BotProvider[]; computers: BotComputer[] }
export type BotDraft = Omit<Bot, 'id' | 'createdAt' | 'updatedAt' | 'conversations' | 'available' | 'detail' | 'providerSettings'> & {
  providerSettings?: { baseURL?: string; apiKey?: string; clearKey?: boolean };
};

export function blankBot(workspace: string): BotDraft {
  return { name: '', instructions: '', provider: 'claude', model: '', capabilities: 'both', policy: 'manual', workspace, execution: { kind: 'local' } };
}
export function botProviderName(id: string): string { return BOT_PROVIDERS.find(provider => provider.id === id)?.name ?? id; }
export function botCapabilityLabel(capability: BotCapability): string {
  return capability === 'code' ? 'Coding' : capability === 'computer' ? 'Computer control' : 'Coding + computer';
}
export function botPolicyLabel(policy: BotPolicy): string {
  return policy === 'plan' ? 'Plan first' : policy === 'bypass' ? 'Automatic' : 'Ask before changes';
}
export function botComputerLabel(execution: BotExecution): string {
  if (execution.kind === 'local') return 'This Mac';
  const host = execution.host?.trim();
  if (execution.kind === 'sandbox') return host ? `Sandbox · ${host}` : 'Sandbox';
  if (!host) return 'SSH computer';
  return `${execution.user?.trim() ? `${execution.user.trim()}@` : ''}${host}${execution.port && execution.port !== 22 ? `:${execution.port}` : ''}`;
}

/** All selection stays keyed by bot identity, never by the currently loaded model. */
export function botConversations<T extends { preferences?: { botId?: string }; updatedAt: string }>(sessions: T[], botId: string): T[] {
  return sessions.filter(session => session.preferences?.botId === botId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function botDraftError(draft: BotDraft): string | null {
  if (!draft.name.trim()) return 'Give this bot a name.';
  if (!draft.workspace.trim()) return 'Choose a workspace on the execution computer.';
  if (draft.execution.kind !== 'local' && !draft.execution.host?.trim()) return draft.execution.kind === 'ssh' ? 'Enter the SSH host or alias.' : 'Enter the sandbox address.';
  if (draft.execution.port !== undefined && (!Number.isInteger(draft.execution.port) || draft.execution.port < 1 || draft.execution.port > 65535)) return 'Use an SSH port from 1 to 65535.';
  if (draft.providerSettings?.baseURL?.trim()) {
    try { const url = new URL(draft.providerSettings.baseURL); if (!['https:', 'http:'].includes(url.protocol)) return 'Use an HTTP or HTTPS provider address.'; }
    catch { return 'Use a complete provider address, including https://.'; }
  }
  return null;
}
