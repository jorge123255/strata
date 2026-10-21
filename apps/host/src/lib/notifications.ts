import { useEffect, useSyncExternalStore } from 'react';
import { api } from './client';
import { DEFAULT_NOTIFICATION_PREFERENCES, destinationKey, isBotCompanionActivityDestination, isNotificationSettingsDestination, mergeNotificationInbox, notificationDestination, notificationHref, validNotification, type BotNotification, type NotificationDestination, type NotificationPreferences } from './notification-policy';

interface DesktopStatus { available: boolean; authorization?: string; detail?: string }
interface NotificationFeed { supported: boolean; journalId: string; cursor: number; nextCursor: number; hasMore: boolean; baseline?: boolean; events: BotNotification[]; settings: NotificationPreferences; desktop?: DesktopStatus; push?: { configured: boolean; detail: string } }
interface State { ready: boolean; supported: boolean; settings: NotificationPreferences; desktop: DesktopStatus; inbox: BotNotification[]; error: string; testStatus: string; busy: boolean; open: boolean }
let state: State = { ready: false, supported: false, settings: DEFAULT_NOTIFICATION_PREFERENCES, desktop: { available: false }, inbox: [], error: '', testStatus: '', busy: false, open: false };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const update = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
export const useNotifications = () => useSyncExternalStore(subscribe, () => state);
export function openNotifications(open = true) { update({ open }); }
let activeDestination: { owner: symbol; destination: NotificationDestination } | null = null;
export function useNotificationDestination(destination: NotificationDestination | null, visible = true) {
  const type = destination?.type, id = destination?.id;
  useEffect(() => {
    if (!visible || !type || !id) return;
    const owner = Symbol(); activeDestination = { owner, destination: { type, id } }; scheduleContext();
    return () => { if (activeDestination?.owner === owner) { activeDestination = null; scheduleContext(); } };
  }, [type, id, visible]);
}
function focusedDestination(): NotificationDestination | null {
  return !document.querySelector('[role="dialog"][aria-modal="true"]') && !new URLSearchParams(window.location.hash.split('?')[1]).has('settings') ? activeDestination?.destination ?? null : null;
}
let contextTimer: ReturnType<typeof setTimeout> | undefined, sentContext = '', queuedContext = '', contextPending = false;
function scheduleContext() {
  const snapshot = JSON.stringify({ destination: focusedDestination(), hash: window.location.hash || '#/' });
  if (queuedContext === snapshot && (contextPending || sentContext === snapshot)) return;
  queuedContext = snapshot;
  if (contextPending) return;
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    if (!running) return;
    const current = queuedContext; if (sentContext === current) return;
    contextPending = true;
    void api.post('/api/bots/notifications/context', JSON.parse(current)).then(() => { sentContext = current; }).catch(() => { sentContext = ''; }).finally(() => { contextPending = false; if (running && queuedContext !== current) scheduleContext(); });
  }, 80);
}
export function openNotificationDestination(value: unknown) {
  if (isNotificationSettingsDestination(value)) { openNotifications(); return; }
  if (isBotCompanionActivityDestination(value)) { update({ open: false }); window.location.hash = '#/bots/activity'; return; }
  const href = notificationHref(value); if (!href) return;
  update({ open: false }); window.location.hash = href;
}
const failure = (cause: unknown) => cause instanceof Error ? cause.message : 'Notifications could not be refreshed.';
let generation = 0, settingsGeneration = 0, running = false, pendingPoll: Promise<void> | null = null, cursor: number | null = null, journalId = '', inboxJournal = '';
const storageKey = () => `strata.notifications.inbox.v1:${window.location.origin}`;
function validateFeed(feed: NotificationFeed) {
  if (!feed || feed.supported !== true || typeof feed.journalId !== 'string' || !Number.isSafeInteger(feed.cursor) || !Number.isSafeInteger(feed.nextCursor) || feed.nextCursor < 0 || !Array.isArray(feed.events) || feed.events.some(row => !validNotification(row)) || feed.events.some((row, index) => index > 0 && row.sequence <= feed.events[index - 1].sequence) || !feed.settings || !Array.isArray(feed.settings.muted)) throw new Error('The notification feed was incomplete. Retry to refresh it.');
}
function poll(): Promise<void> {
  if (!running) return Promise.resolve();
  if (pendingPoll) return pendingPoll;
  const preference = settingsGeneration;
  const task = pollOnce().finally(() => { if (pendingPoll === task) { pendingPoll = null; if (running && preference !== settingsGeneration) void poll(); } });
  pendingPoll = task; return task;
}
async function pollOnce() {
  const selected = generation, preferenceVersion = settingsGeneration;
  try {
    await consumeNativeOpen(selected);
    scheduleContext();
    for (let page = 0; page < 10; page++) {
      const initial = cursor === null;
      const query = initial ? '' : `?after=${cursor}&journalId=${encodeURIComponent(journalId)}`;
      const feed = await api.get<NotificationFeed>(`/api/bots/notifications${query}`); validateFeed(feed);
      if (!running || selected !== generation || preferenceVersion !== settingsGeneration) return;
      const reset = initial || feed.baseline || feed.journalId !== journalId;
      update({ settings: feed.settings });
      update({ ready: true, supported: true, desktop: feed.desktop ?? { available: false }, error: '' });
      if (reset) {
        if (inboxJournal && feed.journalId !== inboxJournal) update({ inbox: [] });
      } else {
        const incoming = feed.events.filter(row => row.sequence > (cursor ?? 0));
        update({ inbox: mergeNotificationInbox(state.inbox, incoming) });
        // OS banners are delivered by the host even when this webview is
        // suspended. This feed only updates the in-app inbox.
      }
      journalId = feed.journalId; inboxJournal = feed.journalId; cursor = feed.nextCursor;
      try { localStorage.setItem(storageKey(), JSON.stringify({ journalId, cursor, inbox: state.inbox })); } catch { /* The feed remains canonical. */ }
      if (!feed.hasMore || reset) break;
    }
  } catch (cause) { if (running && selected === generation) update({ ready: true, error: failure(cause) }); }
}
export function startNotifications() {
  running = true; generation++; cursor = null; journalId = ''; pendingPoll = null;
  // Persisted entries are an inbox only. Never replay them as new OS alerts.
  inboxJournal = '';
  try { const saved = JSON.parse(localStorage.getItem(storageKey()) ?? '{}'); if (typeof saved.journalId === 'string' && Array.isArray(saved.inbox)) { inboxJournal = saved.journalId; update({ inbox: saved.inbox.filter(validNotification).slice(0, 100) }); } } catch { /* Start empty. */ }
  const click = () => { void consumeNativeOpen(generation); };
  window.addEventListener('strata:notification-open', click);
  window.addEventListener('hashchange', scheduleContext);
  const observer = new MutationObserver(scheduleContext); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden'] });
  sentContext = ''; scheduleContext();
  void poll(); const timer = setInterval(() => { void poll(); }, 4000);
  return () => { running = false; generation++; clearInterval(timer); clearTimeout(contextTimer); observer.disconnect(); window.removeEventListener('hashchange', scheduleContext); window.removeEventListener('strata:notification-open', click); };
}
async function consumeNativeOpen(selected: number) {
  try {
    const result = await api.post<{ destination: unknown }>('/api/bots/notifications/open', {});
    if (running && selected === generation && (notificationDestination(result.destination) || isNotificationSettingsDestination(result.destination) || isBotCompanionActivityDestination(result.destination))) openNotificationDestination(result.destination);
  } catch { /* Older carriers have no native click route. */ }
}
export async function refreshNotifications() { if (pendingPoll) await pendingPoll; await poll(); }
export async function saveNotificationPreferences(patch: Partial<NotificationPreferences>) {
  if (state.busy) return;
  settingsGeneration++; update({ busy: true, error: '' });
  try {
    const feed = await api.post<NotificationFeed>('/api/bots/notifications/settings', patch); validateFeed(feed);
    if (feed.settings.enabled !== state.settings.enabled) { cursor = null; journalId = ''; }
    update({ settings: feed.settings, desktop: feed.desktop ?? state.desktop, supported: true, ready: true });
  } catch (cause) { update({ error: failure(cause) }); }
  finally { update({ busy: false }); void poll(); }
}
export async function enableNotifications() {
  if (state.busy) return;
  settingsGeneration++; update({ busy: true, error: '' });
  try {
    const result = await api.post<DesktopStatus>('/api/bots/notifications/permission', {});
    const desktop = (result as DesktopStatus & { desktop?: DesktopStatus }).desktop ?? result;
    update({ desktop });
    if (!desktop.available || desktop.authorization !== 'authorized') { update({ error: desktop.detail ?? 'Allow Strata notifications in macOS System Settings, then try again.' }); return; }
    const feed = await api.post<NotificationFeed>('/api/bots/notifications/settings', { enabled: true }); validateFeed(feed);
    cursor = null; journalId = '';
    update({ settings: feed.settings, desktop: feed.desktop ?? desktop, supported: true, ready: true });
  } catch (cause) { update({ error: failure(cause) }); }
  finally { update({ busy: false }); void poll(); }
}
export async function toggleConversationMute(destination: NotificationDestination) {
  const key = destinationKey(destination), muted = state.settings.muted.includes(key);
  await saveNotificationPreferences({ muted: muted ? state.settings.muted.filter(item => item !== key) : [...state.settings.muted, key] });
}
export async function sendTestNotification() {
  if (state.busy || !state.settings.enabled || state.desktop.authorization !== 'authorized') return;
  update({ busy: true, testStatus: '', error: '' });
  try {
    const result = await api.post<{ delivered: boolean; detail?: string }>('/api/bots/notifications/test', {});
    update({ testStatus: result.delivered ? 'Test sent to macOS Notification Center. Click it to return here.' : result.detail ?? 'macOS did not accept the test notification. Check Strata in System Settings → Notifications.' });
  } catch (cause) { update({ error: failure(cause) }); }
  finally { update({ busy: false }); }
}
