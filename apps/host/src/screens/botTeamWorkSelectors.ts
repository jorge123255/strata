import { botTeamRunActive, type BotTeamActivity } from '../lib/bots';

export interface TeamWorkGroups {
  needsYou: BotTeamActivity[];
  working: BotTeamActivity[];
  continuing: BotTeamActivity[];
  history: BotTeamActivity[];
}

/** Presentation only. Every received task stays accessible; links confer no state. */
export function teamWorkGroups(rows: BotTeamActivity[], teamId: string): TeamWorkGroups {
  const groups: TeamWorkGroups = { needsYou: [], working: [], continuing: [], history: [] };
  const tasks = rows.filter(row => row.teamId === teamId && row.work).slice().sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  for (const row of tasks) {
    const work = row.work!;
    // Live cleanup and submitted-but-still-running turns must never disappear
    // into history, even when they came from an older host journal.
    if (botTeamRunActive(row.state)) groups.working.push(row);
    else if (work.status === 'ready_for_review') groups.needsYou.push(row);
    else if (work.status === 'working') groups.working.push(row);
    else if (work.legacy === true || work.status === 'verified') groups.history.push(row);
    else if (['blocked', 'interrupted'].includes(work.status) && work.recoveryJobId) groups.continuing.push(row);
    else groups.needsYou.push(row);
  }
  return groups;
}

export function teamTaskLabel(row: BotTeamActivity) {
  if (botTeamRunActive(row.state)) {
    if (row.state === 'cleanup_pending') return 'Checking cleanup';
    if (row.state === 'stopping') return 'Stopping…';
    if (row.state === 'queued') return 'Queued';
    return row.work?.status === 'ready_for_review' ? 'Finishing up' : 'Working';
  }
  if (row.work?.status === 'ready_for_review') return 'Ready for review';
  if (row.work?.status === 'working') return 'Working';
  if (row.work?.legacy === true) return 'Earlier turn';
  if (row.work?.status === 'verified') return 'Verified';
  if (['blocked', 'interrupted'].includes(row.work?.status ?? '') && row.work?.recoveryJobId) return 'Continuation created';
  return ({ working: 'Working', blocked: 'Blocked', interrupted: 'Interrupted' } as Record<string, string>)[row.work?.status ?? ''] ?? 'Needs review';
}

export function teamTaskEvidence(row: BotTeamActivity) {
  const counts = new Map<string, number>();
  for (const item of row.work?.evidence ?? []) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return (['file', 'test', 'link', 'note'] as const).filter(kind => counts.has(kind)).map(kind => {
    const count = counts.get(kind)!;
    const label = kind === 'test' ? 'test report' : kind;
    return `${count} ${label}${count === 1 ? '' : 's'}`;
  }).join(' · ');
}

/** Earlier records without a verified result remain distinct from current work. */
export function teamEarlierUnverifiedCount(groups: TeamWorkGroups) {
  return groups.history.filter(row => row.work?.legacy === true && row.work.status !== 'verified').length;
}
