/** Buttons for a failed team task. Labels and the sentence come from the host. */
export type RoomChoiceStyle = 'primary' | 'neutral' | 'danger';
export type RecoveryChoiceId = 'retry' | 'skip' | 'different' | 'continue';

export interface RoomChoiceOption {
  id: string;
  label: string;
  style?: RoomChoiceStyle;
}

/** Saved on the channel message as `recovery`. `choice` appears only after a tap. */
export interface MessageRecovery {
  jobId: string;
  runId: string;
  question: string;
  options: RoomChoiceOption[];
  choice?: RecoveryChoiceId;
  text?: string;
  /** A long run that paused. `continue` posts `{ choice: 'continue' }`. */
  kind?: 'paused';
}

/** Live `task.recovery` and the web event `strata:task-recovery`. */
export interface TaskRecoveryEvent {
  teamId: string;
  messageId: string;
  jobId: string;
  runId: string;
  text: string;
  question: string;
  options: RoomChoiceOption[];
  /** A long run that paused. The card is a calm pause, not a failure. */
  kind?: 'paused';
}

export interface RecoveryPresentation {
  messageId: string;
  teamId: string;
  jobId: string;
  runId: string;
  text: string;
  question: string;
  options: RoomChoiceOption[];
  choice?: RecoveryChoiceId;
  kind?: 'paused';
}

const CHOICE_IDS: readonly RecoveryChoiceId[] = ['retry', 'skip', 'different', 'continue'];

function textOf(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function choiceId(value: unknown): RecoveryChoiceId | undefined {
  return CHOICE_IDS.find(id => id === value);
}

function pausedKind(value: unknown): 'paused' | undefined {
  return value === 'paused' ? 'paused' : undefined;
}

function cleanOptions(value: unknown): RoomChoiceOption[] {
  if (!Array.isArray(value)) return [];
  const options: RoomChoiceOption[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const item = row as { id?: unknown; label?: unknown; style?: unknown };
    const id = textOf(item.id);
    const label = textOf(item.label);
    if (!id || !label) continue;
    const option: RoomChoiceOption = { id, label };
    if (item.style === 'primary' || item.style === 'neutral' || item.style === 'danger') option.style = item.style;
    else if (id === 'continue') option.style = 'primary';
    options.push(option);
  }
  return options;
}

export function recoveryFromEvent(detail: unknown): TaskRecoveryEvent | null {
  if (!detail || typeof detail !== 'object') return null;
  const row = detail as Record<string, unknown>;
  const nested = row.recovery && typeof row.recovery === 'object' && !Array.isArray(row.recovery) ? row.recovery as Record<string, unknown> : undefined;
  const teamId = textOf(row.teamId);
  const messageId = textOf(row.messageId);
  const jobId = textOf(row.jobId) || textOf(nested?.jobId);
  const runId = textOf(row.runId) || textOf(nested?.runId);
  const question = textOf(row.question) || textOf(nested?.question);
  const text = textOf(row.text) || textOf(nested?.text) || question;
  const options = cleanOptions(row.options ?? nested?.options);
  const kind = pausedKind(row.kind) ?? pausedKind(nested?.kind);
  if (!teamId || !messageId || !jobId || !runId || !text || !options.length) return null;
  return { teamId, messageId, jobId, runId, text, question: question || text, options, ...(kind ? { kind } : {}) };
}

export function recoveryFromMessage(message: { id?: string; teamId?: string; content?: string; recovery?: unknown } | null | undefined): RecoveryPresentation | null {
  if (!message?.recovery || typeof message.recovery !== 'object') return null;
  const recovery = message.recovery as Record<string, unknown>;
  const messageId = textOf(message.id);
  const teamId = textOf(message.teamId);
  const jobId = textOf(recovery.jobId);
  const runId = textOf(recovery.runId);
  const question = textOf(recovery.question);
  const options = cleanOptions(recovery.options);
  if (!messageId || !teamId || !jobId || !runId || !question || !options.length) return null;
  const text = textOf(recovery.text) || textOf(message.content) || question;
  const choice = choiceId(recovery.choice);
  const kind = pausedKind(recovery.kind);
  return {
    messageId, teamId, jobId, runId, text, question, options,
    ...(choice && options.some(option => option.id === choice) ? { choice } : {}),
    ...(kind ? { kind } : {}),
  };
}

/** A live event fills the card immediately. A saved choice still wins. */
export function presentRecovery(message: { id?: string; teamId?: string; content?: string; recovery?: unknown }, live?: TaskRecoveryEvent | null): RecoveryPresentation | null {
  const saved = recoveryFromMessage(message);
  if (live && live.messageId === textOf(message.id) && live.teamId === textOf(message.teamId)) {
    const kind = live.kind ?? saved?.kind;
    return { ...live, ...(saved?.choice ? { choice: saved.choice } : {}), ...(kind ? { kind } : {}) };
  }
  return saved;
}

export function choicePayload(optionId: string): { choice: RecoveryChoiceId } | null {
  const choice = choiceId(optionId);
  return choice ? { choice } : null;
}
