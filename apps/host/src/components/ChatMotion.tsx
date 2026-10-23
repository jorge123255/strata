import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/format';
import {
  advanceStream,
  hasLiveStream,
  planEntrances,
  prefersReducedMotion,
  recalledStream,
  rememberStream,
  splitStreamTail,
  type Entrance,
} from '../lib/chat-motion';

export function useOnScreen<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, visible };
}

/** History stays still. Messages that arrive after the screen is ready rise in. */
export function useMessageEntrances(scope: string, rows: { id: string; own: boolean }[], ready: boolean) {
  const book = useRef<{ scope: string; primed: boolean; seen: Set<string>; entrances: Map<string, Entrance> }>({
    scope: '', primed: false, seen: new Set(), entrances: new Map(),
  });
  const signature = `${scope}\0${ready ? 1 : 0}\0${rows.map(row => `${row.own ? 1 : 0}:${row.id}`).join('\n')}`;
  const signatureRef = useRef('');
  if (book.current.scope !== scope) {
    book.current = { scope, primed: false, seen: new Set(), entrances: new Map() };
    signatureRef.current = '';
  }
  if (signatureRef.current !== signature) {
    const result = planEntrances(book.current.seen, rows, book.current.primed, ready);
    book.current.primed = result.primed;
    book.current.seen = result.seen;
    book.current.entrances = new Map(result.entrances.map(item => [item.id, item]));
    signatureRef.current = signature;
  }
  return book.current.entrances;
}

export function useSmoothStream(id: string, target: string, done: boolean) {
  const reduced = prefersReducedMotion();
  const [shown, setShown] = useState(() => recalledStream(id) ?? (reduced ? target : ''));
  const shownRef = useRef(shown);
  const carry = useRef(0);
  shownRef.current = shown;
  useEffect(() => {
    if (reduced) {
      shownRef.current = target;
      rememberStream(id, target);
      setShown(target);
      return undefined;
    }
    rememberStream(id, shownRef.current);
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = advanceStream(shownRef.current, target, now - last, carry.current, false, done);
      last = now;
      carry.current = next.carry;
      if (next.shown !== shownRef.current) {
        shownRef.current = next.shown;
        rememberStream(id, next.shown);
        setShown(next.shown);
      }
      if (next.shown.length < target.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [id, target, done, reduced]);
  return { shown, caughtUp: shown.length >= target.length };
}

export function TypingDots({ label, hiddenLabel = false }: { label: string; hiddenLabel?: boolean }) {
  const { ref, visible } = useOnScreen<HTMLSpanElement>();
  return <span ref={ref} className="typing" data-visible={visible || undefined} role={hiddenLabel ? undefined : 'status'} aria-hidden={hiddenLabel || undefined} aria-label={hiddenLabel ? undefined : label}><i /><i /><i /></span>;
}

export function ShimmerText({ text, className, title }: { text: string; className?: string; title?: string }) {
  const { ref, visible } = useOnScreen<HTMLSpanElement>();
  return <span ref={ref} className={cx('shimmer', className)} data-visible={visible || undefined} title={title}>{text}</span>;
}

export function StatusDot({ status }: { status: 'idle' | 'working' | 'paused' | 'error' | 'attention' }) {
  const breathe = status === 'idle' || status === 'working';
  const { ref, visible } = useOnScreen<HTMLSpanElement>();
  return <span ref={ref} className="status-dot" data-status={status} data-breathe={breathe || undefined} data-visible={breathe && visible || undefined} aria-hidden="true" />;
}

export function PaneCollapse({ open, children }: { open: boolean; children: ReactNode }) {
  return <div className="pane-collapse" data-open={open || undefined}><div className="pane-collapse__clip" inert={open ? undefined : true}>{children}</div></div>;
}

export function StreamedBody({ id, text, done, render }: { id: string; text: string; done: boolean; render: (text: string) => ReactNode }) {
  const { shown, caughtUp } = useSmoothStream(id, text, done);
  if (!hasLiveStream(id) && done) return <>{render(text)}</>;
  if (!shown) return <TypingDots label="Typing" hiddenLabel />;
  const parts = splitStreamTail(shown);
  const settled = done && caughtUp;
  return <>
    {settled ? render(text) : <>
      {parts.prefix ? render(parts.prefix) : null}
      {parts.word ? <span className="stream-word" key={`${id}:${parts.prefix.length}`}>{parts.word}</span> : null}
    </>}
    {!settled ? <span className="caret" aria-hidden="true" /> : null}
  </>;
}
