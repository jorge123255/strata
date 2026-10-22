/** Read-only timing of owned bot turns. Never authority to run, retry or approve. */
const phases = new Set(['starting', 'model', 'approval', 'tool', 'cleanup']);
const duration = n => Math.min(604800000, Math.max(0, Math.round(n)));
export function createHarnessObserver({ now = Date.now, capacity = 256 } = {}) {
  const turns = new Map();
  const elapsed = (row, at) => duration(at - row.started);
  function move(row, phase, at = now()) {
    if (row.finished || !phases.has(phase) || row.phase === phase) return;
    row.timings[row.phase] += duration(at - row.changed);
    row.phase = phase; row.changed = at;
  }
  function busy(row) {
    if (row.phase === 'cleanup') return;
    move(row, row.approvals.size ? 'approval' : row.running.size ? 'tool' : 'model');
  }
  function countOnce(row, collection, id, counter) {
    if (row[collection].has(id)) return;
    row[collection].add(id); row[counter] = Math.min(604800000, row[counter] + 1);
    // Display deduplication is bounded; it is never the execution receipt ledger.
    if (row[collection].size > 1024) row[collection].delete(row[collection].values().next().value);
  }
  return {
    start(chatId) {
      const previous = turns.get(chatId);
      if (previous && !previous.finished) throw new Error('A bot timing record is already active for this conversation.');
      for (const [id, row] of turns) if (row.finished && now() - row.changed > 86400000) turns.delete(id);
      while (turns.size >= capacity) {
        const oldest = [...turns].find(([, row]) => row.finished);
        if (!oldest) break; // Never evict a live turn to make a display limit.
        turns.delete(oldest[0]);
      }
      const at = now();
      turns.set(chatId, { started: at, changed: at, phase: 'starting', finished: false,
        timings: { starting: 0, model: 0, approval: 0, tool: 0, cleanup: 0 },
        approvals: new Set(), running: new Set(), seen: new Set(), failed: new Set(), toolCalls: 0, toolErrors: 0, contextCompactions: 0 });
    },
    phase(chatId, phase) { const row = turns.get(chatId); if (row) move(row, phase); },
    frame(chatId, frame) {
      const row = turns.get(chatId); if (!row || row.finished) return;
      if (['delta', 'reasoning'].includes(frame.type) && typeof frame.text === 'string' && frame.text) {
        row.firstOutputMs ??= elapsed(row, now());
        if (row.phase === 'starting') move(row, 'model');
      }
      if (frame.type === 'notice' && frame.context?.compacted === true) row.contextCompactions++;
      if (frame.type !== 'agent-tool' || typeof frame.tool?.id !== 'string') return;
      const { id, state } = frame.tool;
      if (state === 'proposed') row.approvals.add(id);
      else if (['running', 'approved'].includes(state)) { row.approvals.delete(id); row.running.add(id); countOnce(row,'seen',id,'toolCalls'); }
      else if (['done', 'error', 'denied', 'cancelled'].includes(state)) {
        row.approvals.delete(id); row.running.delete(id);
        if (state === 'error') countOnce(row,'failed',id,'toolErrors');
      }
      busy(row);
    },
    finish(chatId, { outcome = 'completed' } = {}) {
      const row = turns.get(chatId); if (!row || row.finished) return;
      const at = now(); row.timings[row.phase] += duration(at - row.changed);
      row.elapsedMs = elapsed(row, at); row.changed = at; row.finished = true;
      row.phase = ['completed', 'interrupted', 'error'].includes(outcome) ? outcome : 'error';
      row.approvals.clear(); row.running.clear(); row.seen.clear(); row.failed.clear();
    },
    snapshot(chatId) {
      const row = turns.get(chatId); if (!row) return undefined;
      const timings = { ...row.timings };
      if (!row.finished) timings[row.phase] += duration(now() - row.changed);
      return { phase: row.phase, elapsedMs: row.finished ? row.elapsedMs : elapsed(row, now()),
        ...(row.firstOutputMs === undefined ? {} : { firstOutputMs: row.firstOutputMs }),
        timings: Object.fromEntries(Object.entries(timings).map(([key, n]) => [`${key}Ms`, duration(n)])),
        toolCalls: row.toolCalls, toolErrors: row.toolErrors, contextCompactions: row.contextCompactions };
    },
  };
}
