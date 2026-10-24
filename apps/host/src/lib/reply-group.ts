/** Room reply stacks. `replyGroupId` is the triggering message. A missing field falls back to consecutive replies. */

import { messageAddressesEveryone } from './mention-picker';

export const REPLY_GROUP_PREVIEW = 5;
export const REPLY_GROUP_STAGGER_MS = 60;
export const REPLY_GROUP_PREVIEW_CHARS = 160;

export interface ReplyGroupSource {
  id: string;
  kind: string;
  author: { type: string };
  content: string;
  replyToId?: string;
  replyGroupId?: string;
  recipientIds?: readonly string[];
  recovery?: unknown;
}

export interface ReplyGroup<T> {
  id: string;
  triggerId: string;
  messages: T[];
}

export type RoomFeedEntry<T> =
  | { kind: 'message'; message: T }
  | { kind: 'replies'; group: ReplyGroup<T> };

export function replyGroupLabel(replied: number, expected = 0): string {
  const count = Number.isFinite(replied) ? Math.max(0, Math.trunc(replied)) : 0;
  const total = Number.isFinite(expected) ? Math.max(0, Math.trunc(expected)) : 0;
  if (total > 0) return `${count} of ${total} bots replied`;
  return `${count} ${count === 1 ? 'bot' : 'bots'} replied`;
}

function uniqueIds(ids: readonly string[] | undefined): string[] {
  if (!ids) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Members named on the triggering message. Current members stand in when that list was not saved. */
export function replyGroupRoster(trigger: { recipientIds?: readonly string[] } | null | undefined, memberIds: readonly string[] = []): string[] {
  const saved = uniqueIds(trigger?.recipientIds);
  return saved.length ? saved : uniqueIds(memberIds);
}

/** How many roster members have a reply in this stack. */
export function replyGroupRepliedCount(messages: readonly { author?: { botId?: string } }[], roster: readonly string[]): number {
  const wanted = new Set(uniqueIds(roster));
  if (!wanted.size) return messages.length;
  const replied = new Set<string>();
  for (const message of messages) {
    const id = message.author?.botId?.trim();
    if (id && wanted.has(id)) replied.add(id);
  }
  return replied.size;
}

/** Roster members with no reply yet, in send-time order. */
export function replyGroupGaps(messages: readonly { author?: { botId?: string } }[], roster: readonly string[]): string[] {
  const replied = new Set<string>();
  for (const message of messages) {
    const id = message.author?.botId?.trim();
    if (id) replied.add(id);
  }
  return uniqueIds(roster).filter(id => !replied.has(id));
}

export type MemberReplyState = 'replied' | 'passed' | 'working' | 'absent';

/** A saved pass, or the same object on the team-channel event. It is not a message. */
export interface MemberPassRecord {
  kind?: string;
  teamId?: string;
  botId?: string;
  replyGroupId?: string;
  passed?: boolean;
  at?: string;
  sequence?: number;
}

export interface ChannelPass {
  kind: 'pass';
  teamId: string;
  botId: string;
  replyGroupId: string;
  passed: true;
  at: string;
  sequence?: number;
}

const passId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,160}$/.test(trimmed) ? trimmed : null;
};

/** A pass is kind `pass` with teamId, botId, replyGroupId, passed true, and at. */
export function readChannelPass(value: unknown, teamId?: string): ChannelPass | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as MemberPassRecord;
  if (row.kind !== 'pass' || row.passed !== true) return null;
  const savedTeam = passId(row.teamId);
  const botId = passId(row.botId);
  const replyGroupId = passId(row.replyGroupId);
  const at = typeof row.at === 'string' ? row.at.trim() : '';
  if (!savedTeam || !botId || !replyGroupId || !at) return null;
  if (teamId && savedTeam !== teamId) return null;
  const sequence = Number.isSafeInteger(row.sequence) && (row.sequence as number) >= 1 ? row.sequence : undefined;
  return { kind: 'pass', teamId: savedTeam, botId, replyGroupId, passed: true, at, ...(sequence ? { sequence } : {}) };
}

/** The live team-channel event may be the pass itself, or carry it on `pass`. */
export function passFromChannelEvent(detail: unknown, teamId: string): ChannelPass | null {
  const direct = readChannelPass(detail, teamId);
  if (direct) return direct;
  if (!detail || typeof detail !== 'object') return null;
  return readChannelPass((detail as { pass?: unknown }).pass, teamId);
}

/** Pull pass items out of the message list. They stay out of the bubbles and the reply count. */
export function partitionChannelFeed<T>(rows: readonly T[], teamId: string): { messages: T[]; passes: ChannelPass[] } {
  const messages: T[] = [];
  const passes: ChannelPass[] = [];
  for (const row of rows) {
    const pass = readChannelPass(row, teamId);
    if (pass) { passes.push(pass); continue; }
    if (row && typeof row === 'object' && (row as { kind?: unknown }).kind === 'pass') continue;
    messages.push(row);
  }
  return { messages, passes };
}

/** Keep one pass per member and reply group. A later `at` replaces an earlier one. */
export function mergeChannelPasses(current: readonly ChannelPass[], incoming: readonly ChannelPass[]): ChannelPass[] {
  if (!incoming.length) return current as ChannelPass[];
  const map = new Map(current.map(row => [`${row.botId}\0${row.replyGroupId}`, row]));
  let changed = false;
  for (const row of incoming) {
    const key = `${row.botId}\0${row.replyGroupId}`;
    const previous = map.get(key);
    if (previous && previous.at >= row.at) continue;
    map.set(key, row);
    changed = true;
  }
  if (!changed) return current as ChannelPass[];
  return [...map.values()].sort((a, b) => a.replyGroupId.localeCompare(b.replyGroupId) || a.botId.localeCompare(b.botId) || a.at.localeCompare(b.at));
}

/**
 * Whether this member chose not to answer this reply group.
 * A pass matches kind `pass`, passed true, and the same bot and replyGroupId.
 */
export function memberChoseToPass(botId: string, records: readonly MemberPassRecord[] = [], replyGroupId = ''): boolean {
  const id = passId(botId);
  const group = passId(replyGroupId);
  if (!id || !group) return false;
  return records.some(row => row.kind === 'pass' && row.passed === true && passId(row.botId) === id && passId(row.replyGroupId) === group && typeof row.at === 'string' && row.at.trim().length > 0);
}

/** Replied, passed, still working, or didn't reply. A pass wins over a live round. */
export function memberReplyState(input: { hasReply: boolean; roundLive: boolean; passed: boolean }): MemberReplyState {
  if (input.hasReply) return 'replied';
  if (input.passed) return 'passed';
  if (input.roundLive) return 'working';
  return 'absent';
}

/** Muted line under the member's name. */
export function memberReplyLine(state: MemberReplyState): string {
  if (state === 'passed') return 'passed';
  if (state === 'working') return 'Still working';
  return "didn't reply";
}

/** Spoken name for the muted row. */
export function memberReplyLabel(name: string, state: MemberReplyState): string {
  if (state === 'passed') return `${name} passed`;
  if (state === 'working') return `${name}. Still working`;
  return `${name} didn't reply`;
}

/** A round is live while its run is active, a reply is still streaming, or a missing teammate is queued or working. */
export function replyRoundIsLive(input: {
  triggerRunId?: string;
  activeRunIds: readonly string[];
  missingBotIds: readonly string[];
  presence?: readonly { botId?: string; state?: string; runId?: string }[];
  drafting?: boolean;
}): boolean {
  if (input.drafting) return true;
  const runId = input.triggerRunId?.trim() ?? '';
  if (runId && input.activeRunIds.some(id => id === runId)) return true;
  if (!input.missingBotIds.length || !input.presence?.length) return false;
  const missing = new Set(input.missingBotIds);
  return input.presence.some(row => {
    const botId = row.botId?.trim() ?? '';
    if (!botId || !missing.has(botId) || (row.state !== 'working' && row.state !== 'queued')) return false;
    const presenceRun = row.runId?.trim() ?? '';
    return !runId || !presenceRun || presenceRun === runId;
  });
}

export function replyGroupStaggerMs(index: number): number {
  return Math.max(0, index) * REPLY_GROUP_STAGGER_MS;
}

/** First non-empty line, kept short enough for two clamped lines. */
export function replyGroupPreview(content: string): string {
  const line = content.split('\n').map(row => row.trim()).find(Boolean) ?? '';
  if (line.length <= REPLY_GROUP_PREVIEW_CHARS) return line;
  return `${line.slice(0, REPLY_GROUP_PREVIEW_CHARS)}…`;
}

export function recipientIdsMatchMembers(recipientIds: readonly string[] | undefined, memberIds: readonly string[]): boolean {
  if (!recipientIds || memberIds.length === 0 || recipientIds.length !== memberIds.length) return false;
  const members = new Set(memberIds);
  if (members.size !== memberIds.length) return false;
  const seen = new Set<string>();
  for (const id of recipientIds) {
    if (!members.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return seen.size === members.size;
}

/** @everyone / @all in the text, or a recipient list that is the whole team. */
export function messageAddressesRoom(message: { content: string; recipientIds?: readonly string[] }, memberIds: readonly string[]): boolean {
  return messageAddressesEveryone(message.content) || recipientIdsMatchMembers(message.recipientIds, memberIds);
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
}

function canGroup(message: ReplyGroupSource): boolean {
  return message.author?.type === 'bot' && message.kind === 'message' && !message.recovery;
}

function fallbackRun<T extends ReplyGroupSource>(messages: readonly T[], start: number, memberIds: readonly string[], explicit: ReadonlySet<number>): number[] {
  const first = messages[start];
  if (!first || explicit.has(start) || !canGroup(first) || trimmed(first.replyGroupId)) return [];
  const replyTo = trimmed(first.replyToId);
  if (replyTo) {
    const target = messages.find(row => row.id === replyTo);
    if (!target || !messageAddressesRoom(target, memberIds)) return [];
    const run = [start];
    for (let cursor = start + 1; cursor < messages.length; cursor++) {
      const next = messages[cursor]!;
      if (explicit.has(cursor) || !canGroup(next) || trimmed(next.replyGroupId) || trimmed(next.replyToId) !== replyTo) break;
      run.push(cursor);
    }
    return run.length >= 2 ? run : [];
  }
  const previous = messages[start - 1];
  if (!previous || previous.author?.type !== 'user' || !messageAddressesRoom(previous, memberIds)) return [];
  const run = [start];
  for (let cursor = start + 1; cursor < messages.length; cursor++) {
    const next = messages[cursor]!;
    if (explicit.has(cursor) || !canGroup(next) || trimmed(next.replyGroupId) || trimmed(next.replyToId)) break;
    run.push(cursor);
  }
  return run.length >= 2 ? run : [];
}

/**
 * Live drafts join the saved feed only when their replyGroupId already has a partner.
 * A lone draft stays a streaming line. A draft with no replyGroupId stays out of this list.
 */
export function withLiveReplyDrafts<T extends ReplyGroupSource>(messages: readonly T[], drafts: readonly T[]): T[] {
  const savedIds = new Set(messages.map(row => row.id));
  const live = drafts.filter(row => trimmed(row.replyGroupId) && !savedIds.has(row.id) && canGroup(row));
  if (!live.length) return [...messages];
  const counts = new Map<string, number>();
  for (const row of [...messages, ...live]) {
    const groupId = trimmed(row.replyGroupId);
    if (!groupId || !canGroup(row)) continue;
    counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
  }
  const extra = live.filter(row => (counts.get(trimmed(row.replyGroupId)) ?? 0) >= 2);
  return extra.length ? [...messages, ...extra] : [...messages];
}

/** Group bot replies that share `replyGroupId`, even when another message sits between them. */
export function groupRoomReplies<T extends ReplyGroupSource>(messages: readonly T[], memberIds: readonly string[] = []): RoomFeedEntry<T>[] {
  const buckets = new Map<string, number[]>();
  messages.forEach((message, index) => {
    const groupId = trimmed(message.replyGroupId);
    if (!groupId || !canGroup(message)) return;
    const bucket = buckets.get(groupId);
    if (bucket) bucket.push(index);
    else buckets.set(groupId, [index]);
  });
  const explicit = new Set<number>();
  for (const indices of buckets.values()) {
    if (indices.length >= 2) for (const index of indices) explicit.add(index);
  }

  const items: RoomFeedEntry<T>[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    const groupId = trimmed(message.replyGroupId);
    if (groupId && explicit.has(index)) {
      const indices = buckets.get(groupId)!;
      if (indices[0] === index) {
        items.push({
          kind: 'replies',
          group: {
            id: messages[indices[0]!]!.id,
            triggerId: groupId,
            messages: indices.map(position => messages[position]!),
          },
        });
      }
      index += 1;
      continue;
    }
    const run = fallbackRun(messages, index, memberIds, explicit);
    if (run.length >= 2) {
      const first = messages[run[0]!]!;
      const replyTo = trimmed(first.replyToId);
      const previous = messages[index - 1];
      items.push({
        kind: 'replies',
        group: {
          id: first.id,
          triggerId: replyTo || previous?.id || first.id,
          messages: run.map(position => messages[position]!),
        },
      });
      index = run[run.length - 1]! + 1;
      continue;
    }
    items.push({ kind: 'message', message });
    index += 1;
  }
  return items;
}
