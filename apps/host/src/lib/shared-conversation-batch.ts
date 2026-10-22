import type { Session } from './types';

export type SharedConversationUpdate = { conversation?: Session; deleted?: string };
export const sharedSessionSnapshot = (session: Session) => {
  const { revision, active, status, ...snapshot } = session;
  return snapshot;
};

/** Apply a host batch once. Transcripts stay complete; only the cache/render commit is shared. */
export function sharedConversationBatch(sessions: Session[], activeSession: string | null, updates: SharedConversationUpdate[], context: {
  revisions: Map<string, number>; snapshots: Map<string, string>; active: Set<string>; liveTurns: { has(id: string): boolean };
}) {
  const rows = new Map(sessions.map(session => [session.id, session]));
  let order = sessions.map(session => session.id), changed = false;
  for (const data of updates) {
    if (data.deleted) {
      context.active.delete(data.deleted); context.revisions.delete(data.deleted); context.snapshots.delete(data.deleted);
      if (rows.delete(data.deleted)) { order = order.filter(id => id !== data.deleted); changed = true; }
      if (activeSession === data.deleted) { activeSession = null; changed = true; }
      continue;
    }
    const session = data.conversation;
    if (!session || !Array.isArray(session.messages) || !session.id) continue;
    if (typeof session.revision === 'number' && session.revision < (context.revisions.get(session.id) ?? 0)) continue;
    context.revisions.set(session.id, session.revision ?? 0);
    if (session.active) context.active.add(session.id); else context.active.delete(session.id);
    // The renderer already projects its own stream. Never apply it twice.
    if (context.liveTurns.has(session.id)) continue;
    const snapshot = JSON.stringify(sharedSessionSnapshot(session)), current = rows.get(session.id);
    const unchanged = current && context.snapshots.get(session.id) === snapshot && current.revision === session.revision
      && current.active === session.active && current.status === session.status;
    context.snapshots.set(session.id, snapshot);
    if (unchanged) continue;
    if (!current) order.unshift(session.id);
    rows.set(session.id, session); changed = true;
  }
  return { changed, activeSession, sessions: changed ? order.map(id => rows.get(id)!) : sessions };
}
