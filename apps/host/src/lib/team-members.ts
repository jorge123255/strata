import type { BotTeam } from './bots';
import * as teamStore from './store';

export const DELETED_BOT_NAME = 'Deleted bot';

export function sameTeamMembers(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every(id => right.includes(id));
}

/** PATCH the roster. expectedRevision is sent only for a saved positive revision. */
export function teamMemberRemovalRequest(team: Pick<BotTeam, 'id' | 'memberIds' | 'coordinatorId' | 'revision'>, botId: string): { path: string; body: { expectedRevision?: number; memberIds: string[]; coordinatorId: string } } | null {
  if (!team.memberIds.includes(botId)) return null;
  const memberIds = team.memberIds.filter(id => id !== botId);
  const coordinatorId = team.coordinatorId === botId ? memberIds[0] ?? '' : team.coordinatorId;
  if (!coordinatorId || !memberIds.includes(coordinatorId)) return null;
  const body: { expectedRevision?: number; memberIds: string[]; coordinatorId: string } = { memberIds, coordinatorId };
  if (Number.isSafeInteger(team.revision) && team.revision! > 0) body.expectedRevision = team.revision;
  return { path: `/api/bots/teams/${encodeURIComponent(team.id)}`, body };
}

/** Bodyless DELETE /api/bots/teams/:teamId. A success body is `{ deleted }`. */
export function teamDeleteRequest(teamId: string) {
  return { method: 'DELETE' as const, path: `/api/bots/teams/${encodeURIComponent(teamId)}` };
}

export function reportTeamMemberError(message: string) {
  if (typeof teamStore.pushToast === 'function') teamStore.pushToast('error', message);
}
