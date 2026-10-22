/** Broker-only evidence. JSON/provider output cannot manufacture this symbol. */
export const BOT_TOOL_NO_EFFECT = Symbol('Strata broker confirmed no saved command effect');
const PROCESS_EXIT_OBSERVED = Symbol('Strata owned process exited and its process group is gone');
export const BOT_TOOL_COMPLETED_PROCESS_ERROR = Symbol('Strata broker observed a completed command error; effects may exist');

/** Only the owned process runner calls this after observing close and cleanup. */
export function markProcessExitObserved(result) {
  if (!result || !Number.isSafeInteger(result.code) || result.code < 0 || result.code > 0xffffffff) throw new Error('A completed process requires an observed exit code.');
  return Object.defineProperty(result, PROCESS_EXIT_OBSERVED, { value: result.code });
}

/** A failed completed process is not rollback, success, or permission to replay it. */
export function markCompletedProcessError(result, processResult) {
  const exitCode = processResult?.[PROCESS_EXIT_OBSERVED];
  if (result?.isError !== true || !Number.isSafeInteger(exitCode) || exitCode <= 0 || exitCode !== processResult.code) return result;
  return Object.defineProperty(result, BOT_TOOL_COMPLETED_PROCESS_ERROR, { value: Object.freeze({ exitCode }) });
}

export function markNoEffect(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('A broker outcome must be a tool result.');
  return Object.defineProperty({ ...result }, BOT_TOOL_NO_EFFECT, { value: true });
}
