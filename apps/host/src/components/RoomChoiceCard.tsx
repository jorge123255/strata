import type { RoomChoiceOption } from '../lib/room-choice';

/** Plain question and buttons. The caller decides what each option id does. */
export function RoomChoiceCard({ question, options, busy = '', disabled = false, onChoose }: {
  question: string;
  options: RoomChoiceOption[];
  busy?: string;
  disabled?: boolean;
  onChoose: (id: string) => void;
}) {
  const prompt = question.trim();
  const rows = options.filter(option => option.id.trim() && option.label.trim());
  if (!prompt || !rows.length) return null;
  return <section className="bot-room-choice" role="group" aria-label="A choice for this room">
    <p>{prompt}</p>
    <div className="bot-room-choice-actions">{rows.map(option => <button key={option.id} type="button" data-style={option.style ?? 'neutral'} disabled={disabled || !!busy} onClick={() => onChoose(option.id)}>{busy === option.id ? 'Working…' : option.label}</button>)}</div>
  </section>;
}
