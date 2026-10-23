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

export function replyGroupLabel(count: number): string {
  return `${count} ${count === 1 ? 'bot' : 'bots'} replied`;
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
