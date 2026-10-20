/** Display only the completion opted into by a saved bot routine. */
export function botRoutineNotice(data: Record<string, unknown>): { tone: 'success' | 'error'; title: string; body: string } | null {
  const row = data.routineCompleted;
  if (!row || typeof row !== 'object') return null;
  const routine = row as Record<string, unknown>;
  if (typeof routine.id !== 'string' || typeof routine.title !== 'string' || !['done', 'error'].includes(String(routine.state))) return null;
  return { tone: routine.state === 'error' ? 'error' : 'success', title: routine.state === 'error' ? 'Bot routine failed' : 'Bot routine finished', body: routine.title.slice(0, 120) };
}
