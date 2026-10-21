export type NotificationDestination = { type: 'chat' | 'team'; id: string };
export type NotificationKind = 'reply' | 'team_message' | 'completed' | 'failed' | 'approval';
export interface BotNotification { id: string; sequence: number; kind: NotificationKind; createdAt: string; title: string; body: string; destination: NotificationDestination; botId?: string }
export interface NotificationPreferences { enabled: boolean; replies: boolean; teams: boolean; work: boolean; approvals: boolean; previews: boolean; sound: boolean; muted: string[] }
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = { enabled: false, replies: true, teams: true, work: true, approvals: true, previews: false, sound: true, muted: [] };
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
export function notificationDestination(value: unknown): NotificationDestination | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && (row.type === 'chat' || row.type === 'team') && id(row.id) ? { type: row.type, id: row.id } : null;
}
export function isNotificationSettingsDestination(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && row.type === 'notifications' && row.id === 'settings';
}
/** Internal native-panel navigation only. Never a notification or permission destination. */
export function isBotCompanionActivityDestination(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && row.type === 'bots' && row.id === 'activity';
}
export function destinationKey(value: NotificationDestination): string { return `${value.type}:${value.id}`; }
export function notificationHref(value: unknown): string | null {
  const destination = notificationDestination(value); if (!destination) return null;
  return destination.type === 'team' ? `#/bots/teams?team=${encodeURIComponent(destination.id)}` : `#/chat/${encodeURIComponent(destination.id)}`;
}
export function validNotification(value: unknown): value is BotNotification {
  if (!value || typeof value !== 'object') return false;
  const row = value as BotNotification;
  return id(row.id) && Number.isSafeInteger(row.sequence) && row.sequence > 0 && ['reply', 'team_message', 'completed', 'failed', 'approval'].includes(row.kind) && Number.isFinite(Date.parse(row.createdAt)) && typeof row.title === 'string' && row.title.length <= 400 && typeof row.body === 'string' && row.body.length <= 2000 && !!notificationDestination(row.destination);
}
export function shouldNotify(event: BotNotification, preferences: NotificationPreferences, focused: NotificationDestination | null): boolean {
  if (!preferences.enabled || preferences.muted.includes(destinationKey(event.destination)) || focused && destinationKey(focused) === destinationKey(event.destination)) return false;
  return event.kind === 'reply' ? preferences.replies : event.kind === 'team_message' ? preferences.teams : event.kind === 'approval' ? preferences.approvals : preferences.work;
}
export function mergeNotificationInbox(previous: BotNotification[], incoming: BotNotification[]): BotNotification[] {
  const rows = new Map(previous.map(row => [row.id, row]));
  for (const row of incoming) if (validNotification(row)) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => b.sequence - a.sequence).slice(0, 100);
}
