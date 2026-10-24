/** A bot keeps working past one provider chunk when it is still making progress. */

export const STEP_CHUNK = 32;
export const DEFAULT_STEP_CONTINUATIONS = 4;

export function continuationBudget(bot) {
  const raw = bot?.stepContinuations;
  if (Number.isInteger(raw) && raw >= 0 && raw <= 32) return raw;
  const fromEnv = Number(process.env.STRATA_BOT_STEP_CONTINUATIONS);
  if (Number.isInteger(fromEnv) && fromEnv >= 0 && fromEnv <= 32) return fromEnv;
  return DEFAULT_STEP_CONTINUATIONS;
}

export function toolSignature(name, args) {
  let stable = '';
  try {
    stable = JSON.stringify(args ?? {}, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  } catch { stable = ''; }
  return `${name}\0${stable}`;
}

export function pauseFields(text) {
  return { kind: 'paused', text, question: 'Keep going?', options: [{ id: 'continue', label: 'Keep going' }] };
}

export function stepLimitPause() {
  return pauseFields('I finished the work so far. The rest of this request is still left.');
}

export function isStepLimitMessage(error) {
  return /reached its \d+-step limit\b/i.test(String(error?.message ?? error ?? ''));
}

/** Tracks one run. A repeated tool call, or a chunk with nothing new, pauses. Progress spends one continuation and carries on. */
export function createStepTracker(bot, resume) {
  const budget = continuationBudget(bot);
  const prior = resume && typeof resume === 'object' ? resume : {};
  let used = Number.isInteger(prior.continuationsUsed) && prior.continuationsUsed >= 0 ? prior.continuationsUsed : 0;
  let previous = typeof prior.previousSignature === 'string' ? prior.previousSignature : null;
  const finished = new Set(Array.isArray(prior.finishedTools) ? prior.finishedTools.filter(name => typeof name === 'string') : []);
  let lastText = typeof prior.lastText === 'string' ? prior.lastText : '';
  let steps = 0;
  let chunkNew = false;
  return {
    budget,
    resumeMessages: Array.isArray(prior.messages) ? prior.messages : null,
    noteText(text) {
      const value = String(text ?? '').trim();
      if (!value || value === lastText) return;
      chunkNew = true;
      lastText = value.slice(0, 400);
    },
    noteTool(name, args) {
      const signature = toolSignature(name, args);
      const loop = signature === previous;
      previous = signature;
      if (!loop) chunkNew = true;
      finished.add(String(name).slice(0, 80));
      return loop ? 'loop' : 'run';
    },
    boundary() {
      steps += 1;
      if (steps % STEP_CHUNK !== 0) return 'run';
      const progressed = chunkNew;
      chunkNew = false;
      if (!progressed || used >= budget) return 'pause';
      used += 1;
      return 'continue';
    },
    sentence(looping) {
      const done = [...finished].slice(0, 6).join(', ') || 'the work so far';
      if (looping) return `I finished ${done}. The same step was repeating, so that part is still left.`;
      return `I finished ${done}. The rest of this request is still left.`;
    },
    summary() {
      const done = [...finished].slice(0, 6).join(', ') || 'the work so far';
      const note = lastText ? ` Last note: ${lastText}.` : '';
      return `Checkpoint. Finished so far: ${done}.${note} Continue from here and do not repeat a finished step.`;
    },
    checkpoint(messages) {
      return { messages, continuationsUsed: used, previousSignature: previous, finishedTools: [...finished], lastText };
    },
  };
}
