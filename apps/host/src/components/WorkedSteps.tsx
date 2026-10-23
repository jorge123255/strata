import { useState } from 'react';

/** Finished tool calls, as one quiet line. A tap shows the step names. */
export function WorkedSteps({ tools }: { tools: readonly { id: string; name: string; verb?: string; target?: string }[] }) {
  const [open, setOpen] = useState(false);
  const count = tools.length;
  if (!count) return null;
  const label = `Worked on ${count} ${count === 1 ? 'step' : 'steps'}`;
  return <div className="bot-worked">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{label}</button>
    {open ? <ul>{tools.map(tool => <li key={tool.id}>{tool.verb || tool.name}{tool.target ? ` · ${tool.target}` : ''}</li>)}</ul> : null}
  </div>;
}
