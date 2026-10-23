/**
 * Coucou-style chat motion, kept as plain functions so the timing can be tested
 * without a browser. The screen only paints what these functions decide.
 */

export type RoomDraft = { messageId: string; botId: string; seq: number; text: string; done: boolean; replyGroupId?: string };

export type Entrance = { id: string; ms: number; delay: number };

export type StreamStep = { shown: string; carry: number };

const revealed = new Map<string, string>();

export function rememberStream(id: string, shown: string) {
  revealed.set(id, shown);
}

export function recalledStream(id: string): string | undefined {
  return revealed.get(id);
}

export function hasLiveStream(id: string) {
  return revealed.has(id);
}

export function clearStreams() {
  revealed.clear();
}

export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced') return true;
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Chars per second. A short backlog stays near 30; a long one catches up at 60. */
export function streamCharsPerSecond(backlog: number): number {
  if (backlog <= 40) return 30;
  if (backlog >= 180) return 60;
  return 30 + (30 * (backlog - 40)) / 140;
}

/** Index just after the next word and the spaces that follow it. */
export function nextWordEnd(text: string, from: number): number {
  let index = Math.max(0, from);
  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  if (index >= text.length) return text.length;
  while (index < text.length && !/\s/.test(text[index] ?? '')) index += 1;
  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  return index;
}

/**
 * Reveal `target` a word at a time. `text` on a partial frame is the full reply
 * so far, so this only walks forward. Reduced motion, or a target that is not
 * an extension of what is already shown, snaps to the end.
 */
export function advanceStream(shown: string, target: string, elapsedMs: number, carry: number, reduced: boolean, done = false): StreamStep {
  if (reduced || !target.startsWith(shown)) return { shown: target, carry: 0 };
  if (shown.length >= target.length) return { shown: target, carry: 0 };
  const dt = Math.max(0, Math.min(elapsedMs, 80)) / 1000;
  const backlog = target.length - shown.length;
  const rate = done ? Math.max(streamCharsPerSecond(backlog), 120) : streamCharsPerSecond(backlog);
  let budget = carry + rate * dt;
  let cursor = shown.length;
  while (cursor < target.length && budget > 0) {
    const boundary = nextWordEnd(target, cursor);
    const size = boundary - cursor;
    if (size > 32) {
      if (budget < 1) break;
      const take = Math.min(size, Math.floor(budget));
      cursor += take;
      budget -= take;
      continue;
    }
    if (size > budget) break;
    cursor = boundary;
    budget -= size;
  }
  return { shown: target.slice(0, cursor), carry: cursor >= target.length ? 0 : Math.max(0, budget) };
}

/** The last revealed word, so the screen can fade that word in on its own. */
export function splitStreamTail(shown: string): { prefix: string; word: string } {
  let end = shown.length;
  while (end > 0 && /\s/.test(shown[end - 1] ?? '')) end -= 1;
  let start = end;
  while (start > 0 && !/\s/.test(shown[start - 1] ?? '')) start -= 1;
  if (start === 0) return { prefix: '', word: shown };
  return { prefix: shown.slice(0, start), word: shown.slice(start) };
}

/**
 * The first ready snapshot is history and does not animate. A full replacement
 * (no already-seen id remains) is history too. Only rows after the last
 * already-seen id animate, so an older id inserted in the middle stays still.
 * Own messages are 180ms; bot messages are 220ms, and a burst of them is
 * staggered by 40ms.
 */
export function planEntrances(seen: ReadonlySet<string>, rows: { id: string; own: boolean }[], primed: boolean, ready: boolean): { primed: boolean; seen: Set<string>; entrances: Entrance[] } {
  if (!ready) return { primed: false, seen: new Set(seen), entrances: [] };
  if (!primed) return { primed: true, seen: new Set(rows.map(row => row.id)), entrances: [] };
  let lastSeen = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (seen.has(rows[index].id)) { lastSeen = index; break; }
  }
  const next = new Set(seen);
  if (lastSeen < 0) {
    for (const row of rows) next.add(row.id);
    return { primed: true, seen: next, entrances: [] };
  }
  for (let index = 0; index <= lastSeen; index += 1) next.add(rows[index].id);
  const fresh = rows.slice(lastSeen + 1).filter(row => !next.has(row.id));
  const freshBots = fresh.filter(row => !row.own).length;
  const entrances: Entrance[] = [];
  let botIndex = 0;
  for (const row of fresh) {
    next.add(row.id);
    const delay = !row.own && freshBots > 1 ? botIndex * 40 : 0;
    if (!row.own) botIndex += 1;
    entrances.push({ id: row.id, ms: row.own ? 180 : 220, delay });
  }
  return { primed: true, seen: next, entrances };
}

/** Scroll to the latest line when the owner's own message is the new tail. */
export function shouldFollowOwnMessage(previousIds: readonly string[], next: readonly { id: string; own: boolean }[]): boolean {
  const last = next.at(-1);
  if (!last?.own) return false;
  return !previousIds.includes(last.id);
}

/** Keep the newest full text for a message. A stale or empty done frame drops the draft. */
export function applyMessagePartial(drafts: readonly RoomDraft[], frame: unknown, teamId: string): RoomDraft[] {
  if (!frame || typeof frame !== 'object') return [...drafts];
  const detail = frame as Record<string, unknown>;
  if (detail.teamId !== teamId) return [...drafts];
  const { messageId, botId, seq, text, done, replyGroupId: rawGroup } = detail;
  if (typeof messageId !== 'string' || messageId.length === 0 || typeof botId !== 'string' || botId.length === 0) return [...drafts];
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || typeof text !== 'string') return [...drafts];
  if (done === true && text === '') return drafts.filter(row => row.messageId !== messageId);
  const previous = drafts.find(row => row.messageId === messageId);
  if (previous && previous.seq >= seq) return [...drafts];
  const incomingGroup = typeof rawGroup === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(rawGroup) ? rawGroup : undefined;
  const replyGroupId = incomingGroup ?? previous?.replyGroupId;
  return [...drafts.filter(row => row.messageId !== messageId), { messageId, botId, seq, text, done: done === true, ...(replyGroupId ? { replyGroupId } : {}) }];
}

export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

/** Scroll offset after `elapsedMs` of a 200ms ease-out toward `target`. */
export function followOffset(start: number, target: number, elapsedMs: number, durationMs = 200): number {
  if (elapsedMs >= durationMs) return target;
  return start + (target - start) * easeOutCubic(elapsedMs / durationMs);
}

/** Smooth-follow the bottom of a scroller. Ignores its own scroll events via `owns`. */
export function createFollowScroller(reduced: () => boolean) {
  let frame = 0;
  let element: HTMLElement | null = null;
  let startTop = 0;
  let startedAt = 0;
  let ownedUntil = 0;
  const duration = 200;
  const tick = (now: number) => {
    if (!element) { frame = 0; return; }
    const target = Math.max(0, element.scrollHeight - element.clientHeight);
    ownedUntil = now + 80;
    if (reduced()) {
      element.scrollTop = target;
      frame = 0;
      return;
    }
    element.scrollTop = followOffset(startTop, target, now - startedAt, duration);
    if (now - startedAt < duration && target - element.scrollTop > 0.5) frame = requestAnimationFrame(tick);
    else { element.scrollTop = target; frame = 0; }
  };
  return {
    owns(now = typeof performance === 'undefined' ? Date.now() : performance.now()) { return now < ownedUntil; },
    stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      element = null;
    },
    follow(next: HTMLElement) {
      element = next;
      const target = Math.max(0, next.scrollHeight - next.clientHeight);
      if (reduced()) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        next.scrollTop = target;
        return;
      }
      if (frame) return;
      startTop = next.scrollTop;
      startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
      frame = requestAnimationFrame(tick);
    },
  };
}
