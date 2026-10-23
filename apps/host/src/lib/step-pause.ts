/** A leftover step-limit sentence. The pause card itself comes from `recovery`, not from this text. */

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
