/**
 * Mark a bot or room read when its chat is opened.
 *
 * POST /api/bots/:id/read and POST /api/bots/teams/:id/read are the host cursors
 * from the summary API. They are sent only after that API has answered, so a
 * host without the route (404) stays on the placeholder and does not keep
 * posting. Listeners still run, and the sidebar marks the local chats.
 */
import { ApiError, api } from './client';

const BOT_ID = /^bot_[a-z0-9-]{1,80}$/i;
const TEAM_ID = /^team_[a-z0-9-]{1,80}$/i;

export function sidebarReadTarget(route: string, param: string | null, query: { get(name: string): string | null }): { kind: 'bot' | 'room'; id: string } | null {
  if (route !== 'bots' || !param) return null;
  if (param === 'teams') {
    if (query.get('new') === 'room') return null;
    const id = query.get('team');
    return id && TEAM_ID.test(id) ? { kind: 'room', id } : null;
  }
  return BOT_ID.test(param) ? { kind: 'bot', id: param } : null;
}

/** null: the summary route has not answered yet. */
export function readDelivery(known: boolean | null): 'post' | 'queue' | 'skip' {
  if (known === false) return 'skip';
  if (known === null) return 'queue';
  return 'post';
}

const listeners = new Set<(kind: 'bot' | 'room', id: string) => void>();
let summaryKnown: boolean | null = null;
const queued: Array<{ kind: 'bot' | 'room'; id: string }> = [];

export function onSidebarRead(listener: (kind: 'bot' | 'room', id: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called when GET /api/bots/summary answers. A 404 drops anything still queued. */
export function noteSidebarSummary(available: boolean) {
  summaryKnown = available;
  const pending = queued.splice(0);
  if (!available) return;
  for (const item of pending) void postRead(item.kind, item.id);
}

async function postRead(kind: 'bot' | 'room', id: string) {
  const path = kind === 'bot'
    ? `/api/bots/${encodeURIComponent(id)}/read`
    : `/api/bots/teams/${encodeURIComponent(id)}/read`;
  try {
    await api.post(path, {});
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) noteSidebarSummary(false);
  }
}

export async function markSidebarRead(kind: 'bot' | 'room', id: string, options?: { post?: boolean }): Promise<void> {
  for (const listener of listeners) listener(kind, id);
  if (options?.post === false) return;
  const delivery = readDelivery(summaryKnown);
  if (delivery === 'skip') return;
  if (delivery === 'queue') {
    if (!queued.some(item => item.kind === kind && item.id === id)) queued.push({ kind, id });
    if (queued.length > 20) queued.shift();
    return;
  }
  await postRead(kind, id);
}
