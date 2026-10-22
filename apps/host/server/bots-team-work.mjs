/** Additive owner-reviewed task results. Evidence is a bot claim, never a verifier. */
const fault = (status, message) => Object.assign(new Error(message), { status });
const copy = value => structuredClone(value);
const statuses = new Set(['working', 'ready_for_review', 'verified', 'blocked', 'interrupted']);
const kinds = new Set(['file', 'test', 'link', 'note']);
const valueText = (value, max, label) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) throw fault(400, `Enter a valid ${label}.`); return value.trim(); };
export function normalizeResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['summary', 'evidence', 'outcome'].includes(key))) throw fault(400, 'Submit a result summary and labeled evidence.');
  const summary = valueText(input.summary, 8000, 'result summary');
  const outcome = input.outcome ?? 'ready_for_review'; if (!['ready_for_review', 'blocked'].includes(outcome)) throw fault(400, 'Choose ready for review or blocked.');
  const rows = input.evidence ?? (outcome === 'blocked' ? [] : undefined);
  if (!Array.isArray(rows) || rows.length < (outcome === 'blocked' ? 0 : 1) || rows.length > 32) throw fault(400, 'Include between one and 32 pieces of evidence.');
  const evidence = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['kind', 'label', 'detail'].includes(key)) || !kinds.has(row.kind)) throw fault(400, 'Choose file, test, link or note evidence.');
    const label = valueText(row.label, 160, 'evidence label'), detail = valueText(row.detail, 4000, 'evidence detail');
    if (row.kind === 'link') { let url; try { url = new URL(detail); } catch {} if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fault(400, 'Use a public HTTP or HTTPS evidence link without embedded credentials.'); }
    return { kind: row.kind, label, detail };
  });
  return { summary, evidence, outcome };
}
export const initialWork = () => ({ status: 'working', revision: 1, evidence: [], resultHistory: [], reviewHistory: [] });
export function nextWork(old, patch) { return { ...copy(old), ...copy(patch), revision: old.revision + 1 }; }
export function publicWork(job) {
  if (job.work) {
    const work = copy(job.work);
    // Presentation provenance is derived here, never accepted from saved work.
    delete work.legacy;
    return work;
  }
  // Legacy transport completion did not prove work was delivered. Do not rewrite
  // old journals to invent evidence, verification or a recoverable authority pin.
  return { ...initialWork(), legacy: true, status: ['queued', 'running', 'stopping'].includes(job.state) ? 'working' : ['cancelled', 'interrupted'].includes(job.state) ? 'interrupted' : 'blocked', summary: 'This older task has no structured result. Review its linked conversation.' };
}
export function validateSavedWork(work) {
  if (work === undefined) return;
  try {
    if (!work || typeof work !== 'object' || Array.isArray(work) || !statuses.has(work.status) || !Number.isSafeInteger(work.revision) || work.revision < 1 || !Array.isArray(work.resultHistory) || work.resultHistory.length > 16 || !Array.isArray(work.reviewHistory) || work.reviewHistory.length > 32 || !Array.isArray(work.evidence)) throw new Error();
    if (work.summary !== undefined) valueText(work.summary, 8000, 'result summary');
    if (work.evidence.length) normalizeResult({ summary: work.summary, evidence: work.evidence });
    for (const row of work.resultHistory) { normalizeResult({ summary: row.summary, evidence: row.evidence, outcome: row.outcome }); if (typeof row.id !== 'string' || typeof row.botId !== 'string' || !Number.isFinite(Date.parse(row.submittedAt))) throw new Error(); }
    for (const row of work.reviewHistory) if (!row || !['accept', 'reject'].includes(row.decision) || typeof row.resultId !== 'string' || !Number.isFinite(Date.parse(row.reviewedAt)) || row.note !== undefined && (typeof row.note !== 'string' || row.note.length > 2500)) throw new Error();
    if (work.status === 'verified' && (!work.resultHistory.length || work.reviewHistory.at(-1)?.decision !== 'accept' || work.reviewHistory.at(-1).resultId !== work.resultHistory.at(-1).id)) throw new Error();
  } catch { throw fault(503, 'A saved team result is invalid. Its file was left unchanged.'); }
}
