/**
 * Sidebar presence for bots and rooms.
 *
 * The live source is GET /api/bots/summary (and /api/bots/summary/stream):
 * `applySidebarSummary` maps that payload onto these rows. `parseSidebarSummary`
 * accepts only that shape. A `message.partial` frame on the same stream is not a
 * summary and does not change unread. Unread counts the host's finished rows.
 *
 * PLACEHOLDER, used when that endpoint returns 404: status, unread count, room
 * member count, last message and typing are derived from the bot list, team
 * list, team runs and chats already on screen. The same names on a bot or team
 * object still replace the derived values, so a host that embeds them keeps
 * working before the summary route exists. The row shape stays the same either way.
 *
 * Placeholder fields on a bot: `status`, `statusLine`, `workingOn`, `unread`.
 * Placeholder fields on a team: `memberCount`, `unread`, `typing`, `typingNames`, `lastMessage`.
 */
import { botAvatarActivity, botPersonalConversations, botTeamRosterPreview } from './bots';
import type { Bot, BotRoomSummary, BotSidebarSummary, BotSummaryRow, BotTeam } from './bots';

export type SidebarBotStatus = 'working' | 'idle' | 'paused' | 'error';

export interface SidebarBotRow {
  id: string;
  name: string;
  avatarConfig?: Bot['avatarConfig'];
  status: SidebarBotStatus;
  statusLine: string;
  unread: number;
  updatedAt: string;
}

export interface SidebarRoomFace {
  id: string;
  name: string;
  avatarConfig?: Bot['avatarConfig'];
}

export interface SidebarRoomRow {
  id: string;
  name: string;
  faces: SidebarRoomFace[];
  extra: number;
  memberCount: number;
  unread: number;
  typing: boolean;
  typingLabel: string;
  lastMessage?: string;
  updatedAt: string;
}

export interface SidebarChat {
  id: string;
  updatedAt: string;
  lastReadAt?: string;
  active?: boolean;
  title?: string;
  messages: Array<{ id?: string; role?: string; content?: string; error?: string; streaming?: boolean; tools?: Array<{ live?: boolean; state?: string }> }>;
  preferences?: { botId?: string; teamId?: string; teamRunId?: string; parentChatId?: string };
}

export interface SidebarRosterBot {
  id: string;
  name: string;
  paused?: boolean;
  avatarConfig?: Bot['avatarConfig'];
  createdAt?: string;
  updatedAt?: string;
  /** Host field. One of working, idle, paused, error. */
  status?: unknown;
  /** Host field. The one-line status, used as written. */
  statusLine?: unknown;
  /** Host field. Folded into "Working on …" when statusLine is absent. */
  workingOn?: unknown;
  /** Host field. Unread count for this bot. */
  unread?: unknown;
}

export interface SidebarRosterRoom {
  id: string;
  name: string;
  memberIds: string[];
  channelPreview?: BotTeam['channelPreview'];
  createdAt?: string;
  updatedAt?: string;
  /** Host field. */
  memberCount?: unknown;
  /** Host field. */
  unread?: unknown;
  /** Host field. True while any member is replying. */
  typing?: unknown;
  /** Host field. Names of members who are replying. */
  typingNames?: unknown;
  /** Host field. */
  lastMessage?: unknown;
}

export interface SidebarRosterRun {
  teamId: string;
  state: string;
  rootBotId?: string;
}

export interface SidebarRosterSource {
  bots: SidebarRosterBot[];
  teams: SidebarRosterRoom[];
  runs?: SidebarRosterRun[];
  sessions?: SidebarChat[];
  activeSession?: string | null;
}

const STATUSES: readonly SidebarBotStatus[] = ['working', 'idle', 'paused', 'error'];

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function oneLine(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function statusOf(value: unknown): SidebarBotStatus | undefined {
  return STATUSES.find(status => status === value);
}

function lineFor(status: SidebarBotStatus, subject?: string): string {
  if (status === 'working') return subject ? `Working on ${oneLine(subject)}` : 'Working';
  if (status === 'paused') return 'Paused';
  if (status === 'error') return 'Error';
  return 'Idle';
}

/** Same rule as a workspace chat: updated since it was last on screen, and never the open one. */
function chatUnread(chat: SidebarChat, activeSession?: string | null): boolean {
  if (chat.id === activeSession) return false;
  if (!chat.lastReadAt) return chat.messages.length > 0;
  return chat.updatedAt > chat.lastReadAt;
}

function workingSubject(sessions: SidebarChat[], botId: string): string | undefined {
  const chat = botPersonalConversations(sessions, botId)[0];
  const message = [...(chat?.messages ?? [])].reverse().find(row => row.role === 'user' && row.content?.trim());
  return message?.content ? oneLine(message.content) : undefined;
}

function derivedStatus(bot: SidebarRosterBot, sessions: SidebarChat[]): SidebarBotStatus {
  const activity = botAvatarActivity({ id: bot.id, paused: !!bot.paused }, sessions as never);
  if (activity === 'paused') return 'paused';
  if (activity === 'error' || activity === 'needsApproval') return 'error';
  if (activity === 'working' || activity === 'thinking') return 'working';
  return 'idle';
}

function typingLabel(names: string[], typing: boolean): string {
  if (!typing) return '';
  if (names.length === 0) return 'Typing…';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]} and ${names.length - 1} more are typing…`;
}

function derivedTyping(team: SidebarRosterRoom, runs: SidebarRosterRun[], sessions: SidebarChat[], bots: SidebarRosterBot[]): { typing: boolean; names: string[] } {
  const names: string[] = [];
  const push = (id?: string) => {
    if (!id || names.length >= 8) return;
    const name = bots.find(bot => bot.id === id)?.name;
    if (name && !names.includes(name)) names.push(name);
  };
  const running = runs.filter(run => run.teamId === team.id && run.state === 'running');
  for (const run of running) push(run.rootBotId);
  const replying = sessions.filter(chat => chat.active && chat.preferences?.teamId === team.id && !chat.preferences.parentChatId && !chat.preferences.teamRunId);
  for (const chat of replying) push(chat.preferences?.botId);
  return { typing: running.length > 0 || replying.length > 0, names };
}

const ID = /^[A-Za-z0-9_-]{1,120}$/;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > max || clean.includes('\0')) return undefined;
  return clean;
}

/** Host captions are already trimmed. An empty author or preview is still a last line. */
function caption(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length > max) return undefined;
  return clean;
}

function summaryBot(value: unknown): BotSummaryRow | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 120);
  const name = text(row.name, 120);
  const status = row.status === 'idle' || row.status === 'working' || row.status === 'error' ? row.status : undefined;
  const unreadCount = count(row.unreadCount);
  if (!id || !ID.test(id) || !name || !status || unreadCount === undefined) return undefined;
  return { id, name, status, unreadCount };
}

function summaryRoom(value: unknown): BotRoomSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 120);
  const name = text(row.name, 120);
  const memberCount = count(row.memberCount);
  const unreadCount = count(row.unreadCount);
  if (!id || !ID.test(id) || !name || memberCount === undefined || unreadCount === undefined) return undefined;
  let lastMessage: BotRoomSummary['lastMessage'] = null;
  if (row.lastMessage !== null && row.lastMessage !== undefined) {
    if (!row.lastMessage || typeof row.lastMessage !== 'object' || Array.isArray(row.lastMessage)) return undefined;
    const message = row.lastMessage as Record<string, unknown>;
    const at = text(message.at, 40);
    const preview = caption(message.preview, 300);
    const authorName = caption(message.authorName, 120);
    if (!at || !Number.isFinite(Date.parse(at)) || preview === undefined || authorName === undefined) return undefined;
    lastMessage = { at, preview, authorName };
  }
  if (!Array.isArray(row.working)) return undefined;
  const working: BotRoomSummary['working'] = [];
  for (const item of row.working) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const member = item as Record<string, unknown>;
    const botId = text(member.botId, 120);
    const memberName = text(member.name, 120);
    const state = member.state === 'working' || member.state === 'queued' ? member.state : undefined;
    if (!botId || !ID.test(botId) || !memberName || !state) return undefined;
    working.push({ botId, name: memberName, state });
  }
  return { id, name, memberCount, unreadCount, lastMessage, working };
}

/** Returns the summary payload, or null when the body is not that document. */
export function parseSidebarSummary(value: unknown): BotSidebarSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.rooms) || !Array.isArray(body.bots)) return null;
  const rooms: BotRoomSummary[] = [];
  const bots: BotSummaryRow[] = [];
  for (const row of body.rooms) {
    const room = summaryRoom(row);
    if (!room) return null;
    rooms.push(room);
  }
  for (const row of body.bots) {
    const bot = summaryBot(row);
    if (!bot) return null;
    bots.push(bot);
  }
  return { rooms, bots };
}

/**
 * One SSE frame from /api/bots/summary/stream.
 * `message.partial` is a draft reply `{messageId, botId, seq, text, delta, done, replyGroupId?}`.
 * It is not a saved team-channel line, so the summary (and its unread count) stays put.
 * Only a parsed `bot-summary` replaces the document. A bad frame keeps the last good one.
 */
export function sidebarStreamSummary(current: BotSidebarSummary | null, event: string, data: unknown): BotSidebarSummary | null {
  if (event !== 'bot-summary') return current;
  return parseSidebarSummary(data) ?? current;
}

function facesFor(memberIds: string[], memberCount: number, bots: SidebarRosterBot[]): SidebarRoomFace[] {
  return memberIds.slice(0, Math.min(3, memberCount)).map(id => {
    const member = bots.find(bot => bot.id === id);
    return { id, name: member?.name ?? 'Bot', avatarConfig: member?.avatarConfig };
  });
}

/**
 * Host summary wins for status, unread, member count, last message and who is replying.
 * A paused bot stays Paused while the summary still says idle: the summary has no paused state.
 * Someone queued in a room is not typing.
 */
export function applySidebarSummary(
  derived: { bots: SidebarBotRow[]; rooms: SidebarRoomRow[] },
  summary: BotSidebarSummary,
  catalog: { bots: SidebarRosterBot[]; teams: SidebarRosterRoom[] },
): { bots: SidebarBotRow[]; rooms: SidebarRoomRow[] } {
  const seenBots = new Set<string>();
  const bots = derived.bots.map(row => {
    const live = summary.bots.find(bot => bot.id === row.id);
    if (!live) return row;
    seenBots.add(row.id);
    const paused = catalog.bots.find(bot => bot.id === row.id)?.paused === true;
    const status: SidebarBotStatus = paused && live.status === 'idle' ? 'paused' : live.status;
    return { ...row, name: live.name || row.name, status, statusLine: lineFor(status), unread: live.unreadCount };
  });
  for (const live of summary.bots) {
    if (seenBots.has(live.id)) continue;
    const catalogBot = catalog.bots.find(bot => bot.id === live.id);
    const status: SidebarBotStatus = catalogBot?.paused === true && live.status === 'idle' ? 'paused' : live.status;
    bots.push({
      id: live.id,
      name: live.name,
      avatarConfig: catalogBot?.avatarConfig,
      status,
      statusLine: lineFor(status),
      unread: live.unreadCount,
      updatedAt: catalogBot?.updatedAt || catalogBot?.createdAt || '',
    });
  }
  const seenRooms = new Set<string>();
  const rooms = derived.rooms.map(row => {
    const live = summary.rooms.find(room => room.id === row.id);
    if (!live) return row;
    seenRooms.add(row.id);
    return overlayRoom(row, live, catalog);
  });
  for (const live of summary.rooms) {
    if (seenRooms.has(live.id)) continue;
    rooms.push(overlayRoom(undefined, live, catalog));
  }
  return { bots, rooms };
}

/** The open bot or room shows no unread badge. Leaving it lets a newer summary count again. */
export function openedSidebarRead<T extends { bots: SidebarBotRow[]; rooms: SidebarRoomRow[] }>(rows: T, open: { kind: 'bot' | 'room'; id: string } | null): T {
  if (!open) return rows;
  if (open.kind === 'bot') return { ...rows, bots: rows.bots.map(bot => bot.id === open.id && bot.unread > 0 ? { ...bot, unread: 0 } : bot) };
  return { ...rows, rooms: rows.rooms.map(room => room.id === open.id && room.unread > 0 ? { ...room, unread: 0 } : room) };
}

/** A chat that was just opened reads as caught up until the summary says otherwise. */
export function clearSummaryUnread(summary: BotSidebarSummary, kind: 'bot' | 'room', id: string): BotSidebarSummary {
  if (kind === 'bot') return { ...summary, bots: summary.bots.map(bot => bot.id === id ? { ...bot, unreadCount: 0 } : bot) };
  return { ...summary, rooms: summary.rooms.map(room => room.id === id ? { ...room, unreadCount: 0 } : room) };
}

function overlayRoom(row: SidebarRoomRow | undefined, live: BotRoomSummary, catalog: { bots: SidebarRosterBot[]; teams: SidebarRosterRoom[] }): SidebarRoomRow {
  const team = catalog.teams.find(item => item.id === live.id);
  const faces = facesFor(team?.memberIds ?? [], live.memberCount, catalog.bots);
  const names = live.working.filter(member => member.state === 'working').map(member => member.name).filter((name, index, all) => all.indexOf(name) === index).slice(0, 8);
  const typing = names.length > 0;
  const author = live.lastMessage?.authorName ?? '';
  const preview = live.lastMessage?.preview ?? '';
  const written = author && preview ? `${author}: ${preview}` : author || preview || undefined;
  return {
    id: live.id,
    name: live.name || row?.name || 'Room',
    faces,
    extra: Math.max(0, live.memberCount - faces.length),
    memberCount: live.memberCount,
    unread: live.unreadCount,
    typing,
    typingLabel: typingLabel(names, typing),
    ...(written ? { lastMessage: written } : {}),
    updatedAt: live.lastMessage?.at || row?.updatedAt || team?.updatedAt || team?.createdAt || '',
  };
}

export function sidebarRoster(source: SidebarRosterSource): { bots: SidebarBotRow[]; rooms: SidebarRoomRow[] } {
  const sessions = source.sessions ?? [];
  const runs = source.runs ?? [];
  const bots = source.bots.map(bot => {
    const liveStatus = statusOf(bot.status);
    const written = typeof bot.statusLine === 'string' && bot.statusLine.trim() ? bot.statusLine.trim() : undefined;
    const workingOn = typeof bot.workingOn === 'string' && bot.workingOn.trim() ? oneLine(bot.workingOn) : undefined;
    const status = liveStatus ?? derivedStatus(bot, sessions);
    const statusLine = written ?? (workingOn ? `Working on ${workingOn}` : lineFor(status, status === 'working' ? workingSubject(sessions, bot.id) : undefined));
    const unread = count(bot.unread) ?? botPersonalConversations(sessions, bot.id).filter(chat => chatUnread(chat, source.activeSession)).length;
    return {
      id: bot.id,
      name: bot.name,
      avatarConfig: bot.avatarConfig,
      status,
      statusLine,
      unread,
      updatedAt: bot.updatedAt || bot.createdAt || '',
    };
  });
  const rooms = source.teams.map(team => {
    const liveCount = count(team.memberCount);
    const memberCount = liveCount ?? team.memberIds.length;
    const faces = team.memberIds.slice(0, Math.min(3, memberCount)).map(id => {
      const member = source.bots.find(bot => bot.id === id);
      return { id, name: member?.name ?? 'Bot', avatarConfig: member?.avatarConfig };
    });
    const derived = derivedTyping(team, runs, sessions, source.bots);
    const liveNames = Array.isArray(team.typingNames) ? team.typingNames.filter((name): name is string => typeof name === 'string' && !!name.trim()).map(name => name.trim()) : undefined;
    const typing = typeof team.typing === 'boolean' ? team.typing : derived.typing;
    const names = liveNames ?? derived.names;
    const written = typeof team.lastMessage === 'string' && team.lastMessage.trim() ? team.lastMessage.trim() : undefined;
    const preview = botTeamRosterPreview(team as BotTeam)?.text;
    const roomSessions = sessions.filter(chat => chat.preferences?.teamId === team.id && !chat.preferences.parentChatId && !chat.preferences.teamRunId);
    return {
      id: team.id,
      name: team.name,
      faces,
      extra: Math.max(0, memberCount - faces.length),
      memberCount,
      unread: count(team.unread) ?? roomSessions.filter(chat => chatUnread(chat, source.activeSession)).length,
      typing,
      typingLabel: typingLabel(names, typing),
      ...(written || preview ? { lastMessage: written || preview } : {}),
      updatedAt: team.updatedAt || team.channelPreview?.createdAt || team.createdAt || '',
    };
  });
  return { bots, rooms };
}
