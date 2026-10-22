import { useState } from 'react';
import { api } from '../lib/client';
import { Btn, ErrorNotice } from '../components/ui';
import { errorMessage, useBotsResource } from './BotsWorkspace';

interface ActionReceipt {
  id: string; chatId: string; toolName: string; state: string; revision: number; proof: string;
  origin: 'local'|'ssh-worker'; readOnly: boolean; updatedAt: string|number;
}
interface ActionSnapshot { available: boolean; actions: ActionReceipt[]; counts: Record<string,number>; hasMore: boolean }
export function BotHarnessActions({ onOpen }: { onOpen: (id: string) => Promise<void> }) {
  const resource = useBotsResource<ActionSnapshot>('/api/bots/harness/actions', 10000);
  const [reviewing, setReviewing] = useState<ActionReceipt|null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!resource.data && !resource.error) return null;
  const available = resource.data?.available === true;
  const actions = (resource.data?.actions ?? []).filter(action => ['uncertain','interrupted'].includes(action.state));
  const current = reviewing && resource.data?.actions.find(action => action.id === reviewing.id);
  const unchanged = current && current.revision === reviewing?.revision && current.proof === reviewing?.proof && ['uncertain','interrupted'].includes(current.state);
  async function acknowledge() {
    if (!reviewing || !unchanged || !available || busy || resource.error || resource.loading) return;
    setBusy(true); setError('');
    try {
      const result = await api.post<{acknowledged:boolean;action:ActionReceipt;resumed:boolean;retried:boolean}>(`/api/bots/harness/actions/${reviewing.id}/review`, {expectedRevision:reviewing.revision,expectedProof:reviewing.proof,decision:'acknowledge'});
      if (result.acknowledged !== true || result.resumed !== false || result.retried !== false || result.action?.id !== reviewing.id || result.action.revision !== reviewing.revision+1 || result.action.state !== 'reviewed' || result.action.origin !== 'local' || result.action.readOnly !== false || !/^[a-f0-9]{64}$/.test(result.action.proof) || result.action.proof === reviewing.proof) throw new Error('Strata did not confirm review of this exact action. Refresh its receipt before trying again.');
      setReviewing(null); await resource.refresh();
    } catch (cause) { setError(errorMessage(cause)); await resource.refresh(); }
    finally { setBusy(false); }
  }
  return <section className="bot-harness-actions" aria-label="Action recovery">
    <h3>Action recovery</h3><p className="small muted">Interrupted actions keep a receipt. Inspect their conversations before deciding what to do next. Strata does not replay them automatically.</p>
    {resource.error ? <ErrorNotice message="Action receipts could not be refreshed. The list below is the last known state."/> : null}
    {!available ? <p role="status">The action journal is unavailable or needs a host update. Review retained conversations; receipt acknowledgement is disabled. Refresh after checking Strata on the execution computer.</p> : null}
    {!available || resource.error ? <Btn size="sm" onClick={() => void resource.refresh()}>Refresh receipts</Btn> : null}
    {actions.length ? actions.map(action => <article key={action.id} className="bots-activity-card">
      <strong>{action.toolName.replaceAll('_',' ')}</strong><p>{action.state === 'uncertain' ? 'Outcome unconfirmed' : 'Interrupted'} · {action.origin === 'ssh-worker' ? 'SSH computer' : 'Host broker'}</p>
      <Btn size="sm" onClick={() => void onOpen(action.chatId).catch(cause => setError(errorMessage(cause)))}>Inspect conversation</Btn>
      {!action.readOnly && action.origin === 'local' ? <Btn size="sm" disabled={!available || busy || !!resource.error || resource.loading} onClick={() => setReviewing(action)}>Record review…</Btn> : <p className="xs muted">Remote receipt is read-only here. Review the selected computer before continuing. Cleanup holds remain in force.</p>}
    </article>) : available ? <p className="small">No interrupted actions need review in the retained journal.</p> : null}
    {reviewing ? <div className="bots-tool-review-warning" role="group" aria-label="Review interrupted action"><p>Have you inspected this action’s conversation and any changes it made? Recording review does not certify success, retry the command or resume a task.</p>{!unchanged ? <p>This receipt changed. Close and review its current state.</p> : null}<Btn disabled={busy} onClick={() => setReviewing(null)}>Cancel</Btn><Btn disabled={!available || !unchanged || busy || !!resource.error || resource.loading} onClick={() => void acknowledge()}>I reviewed the conversation</Btn></div> : null}
    {resource.data?.hasMore ? <p className="xs muted">Showing up to 200 receipts, with interrupted actions first.</p> : null}
    {error ? <ErrorNotice message={error}/> : null}
  </section>;
}
