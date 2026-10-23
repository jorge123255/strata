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

/** A room row the pass check can read. The pass field itself is not named yet. */
export interface MemberPassRecord {
  author?: { botId?: string };
  kind?: string;
  state?: string;
  content?: string;
}

/**
 * Whether this member chose not to answer.
 * The host has not named that field. Until it does, a member with no message has not passed.
 */
export function memberChoseToPass(botId: string, records: readonly MemberPassRecord[] = []): boolean {
  const id = botId.trim();
  const saved = records.some(row => row.author?.botId?.trim() === id);
  if (!id || !saved) return false;
  // Read the named pass field on `records` here. Until then, a saved row is not a pass.
  return false;
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
