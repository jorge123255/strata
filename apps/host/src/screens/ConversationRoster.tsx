import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ShimmerText, StatusDot } from '../components/ChatMotion';
import { clampConversationRosterWidth, CONVERSATION_ROSTER_DEFAULT, CONVERSATION_ROSTER_MAX, CONVERSATION_ROSTER_MIN } from '../lib/conversation-roster-width';

export type ConversationRosterStatus = 'idle' | 'working' | 'paused' | 'attention';

/** Avatar plus an 8px status dot. The dot never sits in the name column. */
export function ConversationRosterFace({ status, children }: { status: ConversationRosterStatus; children: ReactNode }) {
  return <span className="cua-roster-face">{children}<StatusDot status={status}/></span>;
}

/** Name stays on one line. A wide list may wrap at word boundaries, up to two lines. */
export function ConversationRosterCopy({ name, timeLabel, timeStamp, preview, shimmer, extra }: {
  name: string;
  timeLabel?: string;
  timeStamp?: string;
  preview: string;
  shimmer?: boolean;
  extra?: ReactNode;
}) {
  return <span className="cua-roster-copy">
    <span className="cua-roster-title"><strong title={name}>{name}</strong>{extra}{timeLabel ? <time dateTime={timeStamp}>{timeLabel}</time> : null}</span>
    <small>{shimmer ? <ShimmerText text={preview}/> : preview}</small>
  </span>;
}

export function ConversationRosterResize({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  function apply(next: number) { onChange(clampConversationRosterWidth(next)); }
  function start(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const origin = handle.parentElement?.getBoundingClientRect().left ?? event.clientX - width;
    handle.setPointerCapture(event.pointerId);
    handle.ownerDocument.documentElement.setAttribute('data-roster-resizing', 'true');
    const move = (ev: PointerEvent) => { if (ev.pointerId === event.pointerId) apply(ev.clientX - origin); };
    const stop = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      handle.ownerDocument.documentElement.removeAttribute('data-roster-resizing');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 16;
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = width + step;
    else if (event.key === 'ArrowLeft') next = width - step;
    else if (event.key === 'Home') next = CONVERSATION_ROSTER_MIN;
    else if (event.key === 'End') next = CONVERSATION_ROSTER_MAX;
    else if (event.key === 'Enter') next = CONVERSATION_ROSTER_DEFAULT;
    if (next === undefined) return;
    event.preventDefault();
    apply(next);
  }
  return <div className="cua-roster-resize" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize conversations" aria-valuemin={CONVERSATION_ROSTER_MIN} aria-valuemax={CONVERSATION_ROSTER_MAX} aria-valuenow={width} aria-valuetext={`${width} pixels`} title="Drag to resize conversations" onPointerDown={start} onKeyDown={key} onDoubleClick={() => apply(CONVERSATION_ROSTER_DEFAULT)}><span/></div>;
}
