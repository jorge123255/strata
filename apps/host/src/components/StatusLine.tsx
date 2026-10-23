import { useEffect, useState } from 'react';
import { ShimmerText, useOnScreen } from './ChatMotion';
import { tr } from '../lib/i18n';
import { elapsedText, isPlayful, statusWords, useLiveStatus } from '../lib/live-status';

/**
 * The line under the newest message while the model works: a small pulse, what it is doing (a playful word while it only thinks,
 * the real action once a tool runs), how long, and how many tokens. It shows the latest status frame only and nothing older.
 */
export function StatusLine({ sessionId, startedAt, tokens }: { sessionId: string | null; startedAt: number; tokens?: number }) {
  const frame = useLiveStatus(sessionId);
  const screen = useOnScreen<HTMLDivElement>();
  const [now, setNow] = useState(() => Date.now());
  const [rotation, setRotation] = useState(0);
  useEffect(() => {
    if (!frame) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [!!frame]);
  const playful = !!frame && isPlayful(frame);
  useEffect(() => {
    if (!playful) return;
    const spin = setInterval(() => setRotation(r => r + 1), 3500);
    return () => clearInterval(spin);
  }, [playful]);
  if (!frame) return null;
  const count = frame.tokens ?? tokens;
  const verb = statusWords(frame, rotation);
  return <div ref={screen.ref} className="live-status" data-phase={frame.phase} data-visible={screen.visible || undefined} aria-live="off">
    <span className="live-status__pulse" aria-hidden="true"><i/><i/></span>
    <ShimmerText className="live-status__verb" key={playful ? rotation : frame.code + String(frame.args?.target ?? '')} title={verb} text={verb}/>
    <span className="live-status__time">{elapsedText(startedAt, now)}</span>
    <span className="live-status__tokens">{count ? tr('{0} tokens', [count.toLocaleString()]) : ''}</span>
  </div>;
}
