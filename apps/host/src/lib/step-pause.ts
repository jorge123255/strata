/** A bot that stopped because a run used its step budget. The number can change; the card does not. */

const STEP_PAUSE = /reached its (?:\d+-)?step limit|ran out of steps/i;

export function isStepPause(error: string | null | undefined) {
  return STEP_PAUSE.test(String(error ?? ''));
}

/** The limit sentence itself, including a “try sending again” tail. A real reply is longer than this notice. */
export function isPauseNotice(text: string | null | undefined) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value || value.length > 280) return false;
  return isStepPause(value) || /try sending the message again/i.test(value);
}

/** One line for the card: the steps it finished, then any reply it had already written. */
export function stepPauseSummary(message: { content?: string; tools?: readonly { state?: string }[] }) {
  const done = (message.tools ?? []).filter(tool => tool.state !== 'proposed' && tool.state !== 'running').length;
  const text = isPauseNotice(message.content) ? '' : String(message.content ?? '').replace(/\s+/g, ' ').trim();
  const body = text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
  const steps = done ? `Worked on ${done} ${done === 1 ? 'step' : 'steps'}.` : '';
  return [steps, body].filter(Boolean).join(' ') || 'The run paused before it finished.';
}
