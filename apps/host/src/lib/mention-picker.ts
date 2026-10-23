/** @-mention query for a room composer. The token is inserted only; routing stays on the server. */

export type MentionMember = { id: string; name: string };
export type MentionQuery = { start: number; query: string };
export type MentionChoice = { kind: 'everyone' | 'member'; id: string; label: string };
export type MentionKeyAction = 'down' | 'up' | 'pick' | 'close' | 'noop';

const whitespace = /\s/;

export function mentionQuery(text: string, cursor: number): MentionQuery | null {
  const end = Math.max(0, Math.min(Number.isFinite(cursor) ? cursor : 0, text.length));
  let at = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    const character = text[index] ?? '';
    if (character === '@') { at = index; break; }
    if (whitespace.test(character)) return null;
  }
  if (at < 0) return null;
  if (at > 0 && !whitespace.test(text[at - 1] ?? '')) return null;
  const query = text.slice(at + 1, end);
  if (/[\s@]/.test(query)) return null;
  return { start: at, query };
}

export function roomMentionChoices(members: MentionMember[], query: string): MentionChoice[] {
  const needle = query.toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(needle);
  const choices: MentionChoice[] = [];
  if (matches('everyone') || (needle.length > 0 && 'all'.startsWith(needle))) choices.push({ kind: 'everyone', id: 'everyone', label: 'everyone' });
  for (const member of members) {
    const trimmed = member.name.trim();
    const label = trimmed.length ? trimmed : 'Unavailable bot';
    if (matches(label) || matches(member.id)) choices.push({ kind: 'member', id: member.id, label });
  }
  return choices;
}

const escapeMention = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The server matches @name only when a word boundary follows it. A short or punctuated name uses the id. */
export function mentionNameRoutes(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length <= 1) return false;
  return new RegExp(`(?:^|\\s)@${escapeMention(trimmed)}\\b`, 'i').test(`@${trimmed} `);
}

/** A name longer than one character matches the server mention. A shorter name uses the bot id. */
export function mentionInsertion(choice: Pick<MentionChoice, 'kind' | 'id'>, members: MentionMember[]): string {
  if (choice.kind === 'everyone') return '@everyone ';
  const name = members.find(member => member.id === choice.id)?.name.trim() ?? '';
  return mentionNameRoutes(name) ? `@${name} ` : `@${choice.id} `;
}

export function insertMention(text: string, query: Pick<MentionQuery, 'start'>, cursor: number, token: string): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(query.start, text.length));
  const end = Math.max(start, Math.min(Number.isFinite(cursor) ? cursor : text.length, text.length));
  return { text: text.slice(0, start) + token + text.slice(end), cursor: start + token.length };
}

export function mentionKeyAction(key: string): MentionKeyAction {
  if (key === 'ArrowDown') return 'down';
  if (key === 'ArrowUp') return 'up';
  if (key === 'Enter' || key === 'Tab') return 'pick';
  if (key === 'Escape' || key === ' ') return 'close';
  return 'noop';
}

/** Space closes by ending the query, so it still types. Escape, arrows, Enter and Tab are consumed. */
export function mentionKeyStops(key: string): boolean {
  const action = mentionKeyAction(key);
  return action === 'down' || action === 'up' || action === 'pick' || key === 'Escape';
}

export function moveMentionIndex(index: number, count: number, direction: 'up' | 'down'): number {
  if (count <= 0) return 0;
  const current = Math.max(0, Math.min(index, count - 1));
  return direction === 'down' ? Math.min(current + 1, count - 1) : Math.max(current - 1, 0);
}

export function mentionListVisible(active: Pick<MentionQuery, 'start'> | null, dismissedStart: number | null, choiceCount: number): boolean {
  return !!active && active.start !== dismissedStart && choiceCount > 0;
}

/** A whitespace-bounded @everyone or @all. An address such as email@everyone does not count. */
export function messageAddressesEveryone(text: string): boolean {
  return /(?:^|\s)@(?:everyone|all)\b/i.test(text.trim());
}

/** Recipient ids from the To: control win. A typed @everyone addresses the room only when that list is empty. */
export function roomMessageAudience(text: string, recipients: string[], memberIds: string[]): { recipientIds?: string[]; everyone?: true } {
  const addressedEveryone = recipients.length > 0 && recipients.length === memberIds.length && memberIds.every(id => recipients.includes(id));
  const namedEveryone = recipients.length === 0 && messageAddressesEveryone(text);
  return {
    ...(recipients.length ? { recipientIds: [...recipients] } : {}),
    ...(addressedEveryone || namedEveryone ? { everyone: true } : {}),
  };
}
