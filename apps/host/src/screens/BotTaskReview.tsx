import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/client';
import { botTeamRunActive, type BotTeamActivity, type BotTaskRecoveryPlan } from '../lib/bots';
import { Btn, Dialog, ErrorNotice } from '../components/ui';
import './BotTaskReview.css';

/** A read-only result view; review and recovery require separate explicit clicks. */
export function BotTaskReview({ row, disabled, onChanged }: { row: BotTeamActivity; disabled: boolean; onChanged: () => Promise<void> }) {
  const [selected, setSelected] = useState<BotTeamActivity | null>(null), [mode, setMode] = useState<'result'|'recovery'>('result');
  const [plan, setPlan] = useState<BotTaskRecoveryPlan | null>(null), [note, setNote] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0), key = useRef<string | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { generation.current++; setSelected(null); setPlan(null); setBusy(false); key.current = null; }, [row.id, row.teamId]);
  const path = `/api/bots/teams/${encodeURIComponent(row.teamId)}/jobs/${encodeURIComponent(row.id)}`;
  const work = selected?.work;
  const changed = !!selected && selected.work?.revision !== row.work?.revision;
  function close() { if (busy) return; generation.current++; setSelected(null); setPlan(null); setError(''); key.current = null; }
  function open() { setMode('result'); setSelected(structuredClone(row)); setNote(''); setError(''); }
  async function recovery() {
    if (disabled || busy) return;
    setSelected(structuredClone(row)); setMode('recovery'); setPlan(null); setError(''); setBusy(true); key.current = null;
    const token = ++generation.current;
    try { const result = await api.get<{plan:BotTaskRecoveryPlan}>(`${path}/recovery`); if (mounted.current && token === generation.current) setPlan(result.plan); }
    catch (cause) { if (mounted.current && token === generation.current) setError(message(cause)); }
    finally { if (mounted.current && token === generation.current) setBusy(false); }
  }
  async function review(decision: 'accept'|'reject') {
    if (disabled || busy || changed || !work || botTeamRunActive(row.state)) return;
    const token = ++generation.current; setBusy(true); setError('');
    try { await api.post(`${path}/review`, {expectedRevision:work.revision,decision,...(note.trim()?{note:note.trim()}: {})}); await onChanged(); if (mounted.current && token === generation.current) setSelected(null); }
    catch (cause) { if (mounted.current && token === generation.current) setError(message(cause)); }
    finally { if (mounted.current && token === generation.current) setBusy(false); }
  }
  async function resume() {
    if (disabled || busy || changed || !plan?.canResume || plan.expectedRevision !== row.work?.revision || Date.parse(plan.expiresAt) <= Date.now()) return;
    const token = ++generation.current; key.current ??= crypto.randomUUID(); setBusy(true); setError('');
    try { await api.post(`${path}/resume`, {planId:plan.id,expectedRevision:plan.expectedRevision,idempotencyKey:key.current}); await onChanged(); if (mounted.current && token === generation.current) setSelected(null); }
    catch (cause) { if (mounted.current && token === generation.current) setError(message(cause)); }
    finally { if (mounted.current && token === generation.current) setBusy(false); }
  }
  return <>
    <Btn size="sm" disabled={disabled} onClick={open}>Review task</Btn>
    {row.work && ['blocked','interrupted'].includes(row.work.status) && !row.work.recoveryJobId ? <Btn size="sm" disabled={disabled || busy} onClick={() => void recovery()}>Review recovery</Btn> : null}
    {selected ? <Dialog open title={mode==='result'?'Task results':'Review recovery'} onClose={close} actions={<><Btn disabled={busy} onClick={close}>Close</Btn>{mode==='result' && work?.status==='ready_for_review' && !botTeamRunActive(row.state) ? <><Btn disabled={busy || disabled || changed} onClick={() => void review('reject')}>Request changes</Btn><Btn variant="primary" disabled={busy || disabled || changed || !work.evidence.length} onClick={() => void review('accept')}>Mark verified</Btn></> : null}{mode==='recovery' && plan?.canResume ? <Btn variant="primary" disabled={busy || disabled || changed || plan.expectedRevision!==row.work?.revision || Date.parse(plan.expiresAt)<=Date.now()} onClick={() => void resume()}>Resume unfinished work</Btn> : null}</>}>
      <div className="bot-task-review">
        <h3>{selected.title}</h3>
        {changed ? <p role="alert">This task changed. Close and reopen it to review its latest results.</p> : null}
        {mode==='result' ? <>
          <p>Results below are reported by the bot. Mark verified after checking the actual deliverables.</p>
          <p className="bot-task-text">{work?.summary || 'No structured result has been submitted. The conversation remains available.'}</p>
          {work?.sourceJobId ? <p className="small muted">Continues a previous task. Earlier results remain in its history.</p> : null}
          {work?.evidence.map((item,index)=><article key={index} className="bot-task-evidence"><small>{item.kind}</small><strong>{item.label}</strong><p>{item.detail}</p></article>)}
          {work?.resultHistory && work.resultHistory.length>1 ? <details><summary>Earlier submitted results · {work.resultHistory.length-1}</summary>{work.resultHistory.slice(0,-1).map(item=><article key={item.id} className="bot-task-evidence"><strong>{item.summary}</strong>{item.evidence.map((entry,index)=><p key={index}>{entry.label}: {entry.detail}</p>)}</article>)}</details> : null}
          {work?.reviewHistory.map((item,index)=><article className="bot-task-evidence" key={index}><strong>{item.decision==='accept'?'Verified by you':'Changes requested'}</strong><p>{item.note}</p><small>{new Date(item.reviewedAt).toLocaleString()}</small></article>)}
          {work?.status==='ready_for_review' ? <label className="input-field"><span>Review note (optional)</span><textarea className="st-input" maxLength={2500} value={note} disabled={busy || changed} onChange={event=>setNote(event.target.value)}/></label> : null}
        </> : <>
          <p>Only this selected unfinished task will continue in a new conversation. The bot must inspect saved work before making further changes. Previously completed actions are not replayed automatically.</p>
          {work?.reviewHistory.at(-1)?.decision==='reject' ? <article className="bot-task-evidence"><strong>Requested changes</strong><p>{work.reviewHistory.at(-1)?.note || 'Review the previous result and address the remaining unfinished work.'}</p></article> : null}
          {busy && !plan ? <p role="status">Checking saved task settings…</p> : null}
          {plan ? <><dl><dt>Bot</dt><dd>{plan.botName}</dd><dt>Model</dt><dd>{plan.provider} · {plan.model}</dd><dt>Computer</dt><dd>{plan.computerLabel}</dd><dt>Working folder</dt><dd>{plan.workspace}</dd></dl><p className="bot-task-text">{plan.summary}</p>{!plan.canResume ? <p role="alert">{plan.blockedReason || 'This task cannot resume yet.'}</p> : null}{plan.completedReports.length ? <details><summary>Earlier completed reports · {plan.completedReports.length}</summary>{plan.completedReports.map(item=><p className="bot-task-text" key={item.jobId}>{item.summary}</p>)}</details> : null}<ul>{plan.steps.map((step,index)=><li key={index}>{step}</li>)}</ul><p className="small muted">Saved settings and permissions are checked again when you resume. Provider access is checked when work starts.</p><Btn size="sm" disabled={busy || disabled} onClick={() => void recovery()}>Refresh recovery check</Btn></> : null}
        </>}
        {error ? <ErrorNotice message={error} action="Dismiss" onRetry={()=>setError('')}/> : null}
      </div>
    </Dialog> : null}
  </>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
