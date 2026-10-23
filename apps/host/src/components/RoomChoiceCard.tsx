import type { RoomChoiceOption } from '../lib/room-choice';

/** The sentence and the button labels come from the host. A saved choice stays selected. */
export function RoomChoiceCard({ text, options, chosen = '', busy = '', disabled = false, error = '', onChoose, onRetry }: {
  text: string;
  options: RoomChoiceOption[];
  chosen?: string;
  busy?: string;
  disabled?: boolean;
  error?: string;
  onChoose: (id: string) => void;
  onRetry?: () => void;
}) {
  const body = text.trim();
  const rows = options.filter(option => option.id.trim() && option.label.trim());
  if (!body || !rows.length) return null;
  const locked = disabled || !!busy || !!chosen;
  return <section className="bot-room-choice" role="group" aria-label="A choice for this room">
    <p>{body}</p>
    <div className="bot-room-choice-actions">{rows.map(option => {
      const selected = chosen === option.id;
      return <button key={option.id} type="button" data-style={option.style ?? 'neutral'} data-chosen={selected || undefined} aria-pressed={selected} disabled={locked} onClick={() => onChoose(option.id)}>{busy === option.id ? 'Sending…' : option.label}</button>;
    })}</div>
    {error && !chosen ? <p className="bot-room-choice-error" role="alert"><span>{error}</span>{onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}</p> : null}
  </section>;
}
