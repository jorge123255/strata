/** Broker-only evidence. JSON/provider output cannot manufacture this symbol. */
export const BOT_TOOL_NO_EFFECT = Symbol('Strata broker confirmed no saved command effect');
export function markNoEffect(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('A broker outcome must be a tool result.');
  return Object.defineProperty({ ...result }, BOT_TOOL_NO_EFFECT, { value: true });
}
