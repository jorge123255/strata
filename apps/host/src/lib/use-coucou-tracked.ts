import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { prefersReducedMotion } from './chat-motion';
import { Tracked, springEase } from './coucou-spring';

let installed = false;

/** Publish the open-spring curve so bot messages can use the same response and damping. */
export function installBotSpring() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const ease = springEase();
  document.documentElement.style.setProperty('--bot-spring-ease', ease.linear);
  document.documentElement.style.setProperty('--bot-spring-ms', `${ease.ms}ms`);
}

/** 0 when the details pane is shut, 1 when it is open. The first paint does not travel. */
export function useCoucouTracked(open: boolean) {
  const tracked = useRef<Tracked | null>(null);
  const seen = useRef<boolean | null>(null);
  const [value, setValue] = useState(() => (open ? 1 : 0));
  const [driving, setDriving] = useState(() => !prefersReducedMotion());

  useEffect(() => {
    installBotSpring();
    if (prefersReducedMotion()) {
      setDriving(false);
      tracked.current?.jump(open ? 1 : 0);
      setValue(open ? 1 : 0);
      seen.current = open;
      return;
    }
    setDriving(true);
    const motion = tracked.current ?? new Tracked(open ? 1 : 0);
    tracked.current = motion;
    if (seen.current === null || seen.current === open && !motion.animating) {
      seen.current = open;
      motion.jump(open ? 1 : 0);
      setValue(motion.value);
      return;
    }
    seen.current = open;
    const started = performance.now();
    if (open) motion.springTo(1);
    else motion.curveTowards(0, 340, started);
    let frame = 0;
    let last = started;
    const tick = (now: number) => {
      motion.step((now - last) / 1000, now);
      last = now;
      setValue(motion.value);
      if (motion.animating) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return { value, driving };
}

/** Width, fade and slide for the 300px details pane. */
export function coucouPaneStyle(value: number): CSSProperties {
  const v = Math.min(1, Math.max(0, value));
  return {
    flexBasis: `${v * 300}px`,
    width: `${v * 300}px`,
    minWidth: 0,
    opacity: v,
    transform: `translateX(${(1 - v) * 12}px)`,
    padding: `${14 * v}px ${18 * v}px ${28 * v}px`,
    borderLeftWidth: v > 0.04 ? 1 : 0,
    overflow: v > 0.98 ? 'auto' : 'hidden',
    pointerEvents: v < 0.2 ? 'none' : 'auto',
  };
}
