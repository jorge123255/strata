/** Conversations list width. Dragging stops at these edges. */
export const CONVERSATION_ROSTER_MIN = 240;
export const CONVERSATION_ROSTER_MAX = 420;
export const CONVERSATION_ROSTER_DEFAULT = 280;
export const CONVERSATION_ROSTER_WIDTH_KEY = 'strata.conversationRosterWidth';

export function clampConversationRosterWidth(value: number) {
  if (!Number.isFinite(value)) return CONVERSATION_ROSTER_DEFAULT;
  return Math.min(CONVERSATION_ROSTER_MAX, Math.max(CONVERSATION_ROSTER_MIN, Math.round(value)));
}

export function readConversationRosterWidth(storage: Pick<Storage, 'getItem'> | null) {
  if (!storage) return CONVERSATION_ROSTER_DEFAULT;
  const raw = storage.getItem(CONVERSATION_ROSTER_WIDTH_KEY);
  if (raw === null || raw === '') return CONVERSATION_ROSTER_DEFAULT;
  return clampConversationRosterWidth(Number(raw));
}
