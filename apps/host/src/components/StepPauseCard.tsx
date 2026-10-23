import { tr } from '../lib/i18n';
import { Btn } from './ui';

/** A long bot run that paused. Keep going continues the same conversation. */
export function StepPauseCard({ summary, busy, stopped, onContinue, onStop }: {
  summary: string;
  busy?: boolean;
  stopped?: boolean;
  onContinue: () => void;
  onStop: () => void;
}) {
  return <section className="bot-step-pause" role="status" aria-label={tr('Paused after a long run')}>
    <strong>{tr('Paused after a long run')}</strong>
    <p>{summary}</p>
    {stopped ? <p className="bot-step-pause-note">{tr('Stopped here.')}</p> : <div className="bot-step-pause-actions">
      <Btn size="sm" variant="primary" disabled={busy} onClick={onContinue}>{tr(busy ? 'Continuing…' : 'Keep going')}</Btn>
      <Btn size="sm" variant="ghost" disabled={busy} onClick={onStop}>{tr('Stop here')}</Btn>
    </div>}
  </section>;
}
