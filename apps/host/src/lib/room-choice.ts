/** A room choice card. The host can send this shape later; today's stalled tasks use the same props. */
export type RoomChoiceStyle = 'primary' | 'neutral' | 'danger';

export interface RoomChoiceOption {
  id: string;
  label: string;
  style?: RoomChoiceStyle;
}

export interface RoomChoice {
  question: string;
  options: RoomChoiceOption[];
}

/** Event the card reads. Bot Strata Dev can emit this after an automatic retry still needs the owner. */
export interface NeedsChoiceEvent {
  type: 'needs-choice';
  id?: string;
  teamId?: string;
  jobId?: string;
  runId?: string;
  question: string;
  options: Array<{ id: string; label: string; style?: string }>;
}

export interface StalledRecoveryTask {
  id: string;
  teamId: string;
  runId: string;
  title?: string;
  state?: string;
  updatedAt?: string;
  work?: { status?: string; revision?: number; recoveryJobId?: string; legacy?: boolean };
}

export type RoomChoiceAction =
  | { kind: 'resume'; teamId: string; jobId: string; revision?: number }
  | { kind: 'stop'; teamId: string; runId: string }
  | { kind: 'skip' }
  | { kind: 'different' };

export interface RoomChoicePresentation {
  key: string;
  source: 'event' | 'recovery';
  choice: RoomChoice;
  teamId: string;
  jobId?: string;
  runId?: string;
  revision?: number;
}

const STALLED_QUESTION = 'The work stopped partway through. Want me to try again?';
const ACTIVE_RUN = new Set(['queued', 'running', 'stopping', 'cleanup_pending']);

function cleanOption(value: unknown): RoomChoiceOption | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { id?: unknown; label?: unknown; style?: unknown };
  if (typeof row.id !== 'string' || !row.id.trim() || typeof row.label !== 'string' || !row.label.trim()) return null;
  const option: RoomChoiceOption = { id: row.id.trim(), label: row.label.trim() };
  if (row.style === 'primary' || row.style === 'neutral' || row.style === 'danger') option.style = row.style;
  return option;
}

export function roomChoiceFromEvent(event: NeedsChoiceEvent | null | undefined): RoomChoice | null {
  if (!event || event.type !== 'needs-choice') return null;
  const question = typeof event.question === 'string' ? event.question.trim() : '';
  const options = Array.isArray(event.options) ? event.options.flatMap(row => { const option = cleanOption(row); return option ? [option] : []; }) : [];
  if (!question || !options.length) return null;
  return { question, options };
}

function needsRecovery(task: StalledRecoveryTask, activeRunIds: ReadonlySet<string>) {
  const work = task.work;
  if (!work || work.legacy === true) return false;
  if (typeof work.recoveryJobId === 'string' && work.recoveryJobId.length > 0) return false;
  if (work.status !== 'blocked' && work.status !== 'interrupted') return false;
  if (ACTIVE_RUN.has(task.state ?? '') || activeRunIds.has(task.runId)) return false;
  return true;
}

function stalledChoice(tasks: readonly StalledRecoveryTask[], activeRunIds: readonly string[], dismissed: ReadonlySet<string>): RoomChoicePresentation | null {
  const active = new Set(activeRunIds);
  const rows = tasks.filter(task => needsRecovery(task, active) && !dismissed.has(`job:${task.id}`) && !dismissed.has(task.id));
  if (!rows.length) return null;
  const task = [...rows].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.id.localeCompare(a.id))[0]!;
  return {
    key: `job:${task.id}`,
    source: 'recovery',
    teamId: task.teamId,
    jobId: task.id,
    runId: task.runId,
    revision: typeof task.work?.revision === 'number' ? task.work.revision : undefined,
    choice: {
      question: STALLED_QUESTION,
      options: [
        { id: 'retry', label: 'Try again', style: 'primary' },
        { id: 'skip', label: 'Skip it', style: 'neutral' },
        { id: 'other', label: 'A different approach', style: 'neutral' },
      ],
    },
  };
}

export function resolveRoomChoice(input: {
  roomTeamId: string;
  event?: NeedsChoiceEvent | null;
  tasks?: readonly StalledRecoveryTask[];
  activeRunIds?: readonly string[];
  dismissedIds?: readonly string[];
}): RoomChoicePresentation | null {
  const dismissed = new Set(input.dismissedIds ?? []);
  const event = input.event;
  const fromEvent = roomChoiceFromEvent(event);
  if (event && fromEvent) {
    const key = (typeof event.id === 'string' && event.id.trim()) || `needs-choice:${event.jobId ?? fromEvent.question}`;
    const jobKey = event.jobId ? `job:${event.jobId}` : '';
    if (!dismissed.has(key) && !(jobKey && dismissed.has(jobKey))) {
      const match = (input.tasks ?? []).find(task => task.id === event.jobId);
      return {
        key,
        source: 'event',
        choice: fromEvent,
        teamId: event.teamId || input.roomTeamId,
        jobId: event.jobId,
        runId: event.runId,
        revision: typeof match?.work?.revision === 'number' ? match.work.revision : undefined,
      };
    }
  }
  return stalledChoice(input.tasks ?? [], input.activeRunIds ?? [], dismissed);
}

function actionId(id: string) {
  return id.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** Maps a card option onto a recovery call the app already makes. Unknown ids do nothing. */
export function choiceAction(optionId: string, context: { teamId?: string; jobId?: string; runId?: string; revision?: number }): RoomChoiceAction | null {
  const id = actionId(optionId);
  const teamId = context.teamId ?? '';
  if (id === 'retry' || id === 'try_again' || id === 'resume') {
    if (!teamId || !context.jobId) return null;
    return { kind: 'resume', teamId, jobId: context.jobId, ...(typeof context.revision === 'number' ? { revision: context.revision } : {}) };
  }
  if (id === 'skip' || id === 'dismiss') return { kind: 'skip' };
  if (id === 'other' || id === 'different' || id === 'different_approach') return { kind: 'different' };
  if (id === 'stop') {
    if (!teamId || !context.runId) return null;
    return { kind: 'stop', teamId, runId: context.runId };
  }
  return null;
}
