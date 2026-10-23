import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from './client';
import { botPersonalConversations } from './bots';
import { getState, isUnread, markRead, useStore } from './store';
import type { Bot, BotSidebarSummary, BotTeam, BotTeamRun, BotsSnapshot, BotTeamsSnapshot } from './bots';
import { applySidebarSummary, clearSummaryUnread, openedSidebarRead, parseSidebarSummary, sidebarRoster, type SidebarBotRow, type SidebarRoomRow } from './sidebar-presence';
import { noteSidebarSummary, onSidebarRead, sidebarReadTarget } from './sidebar-reads';
import { useLocation } from './router';
import type { SidebarCatalogItem } from './sidebar-sections';

const SUMMARY = '/api/bots/summary';
const SUMMARY_STREAM = '/api/bots/summary/stream';
const HOST = (globalThis as { __STRATA_HOST__?: string }).__STRATA_HOST__ ?? '';

/**
 * Bots and rooms for the sidebar.
 *
 * Live status, unread, room member count, last message and who is replying come
 * from GET /api/bots/summary. /api/bots/summary/stream pushes the same document.
 * If that socket drops, the summary is polled until the stream returns.
 *
 * PLACEHOLDER: a 404 on the summary route keeps the derived rows from
 * sidebarRoster (bot list, team list, runs and chats). The summary is tried
 * again on the same timer, so a host that gains the route starts feeding the
 * sidebar without a reload.
 */
function markLocalChats(kind: 'bot' | 'room', id: string) {
  if (typeof getState !== 'function' || typeof isUnread !== 'function' || typeof markRead !== 'function') return;
  const state = getState();
  const active = state.activeSession;
  const rows = kind === 'bot'
    ? botPersonalConversations(state.sessions, id)
    : state.sessions.filter(session => session.preferences?.teamId === id && !session.preferences.parentChatId && !session.preferences.teamRunId);
  for (const session of rows) if (isUnread(session, active)) markRead(session.id);
}

export function useSidebarRoster(): {
  bots: SidebarBotRow[];
  rooms: SidebarRoomRow[];
  items: SidebarCatalogItem[];
  loading: boolean;
  error: string;
  refresh: () => void;
} {
  const sessions = useStore(state => state.sessions);
  const activeSession = useStore(state => state.activeSession);
  const location = useLocation();
  const [bots, setBots] = useState<Bot[]>([]);
  const [teams, setTeams] = useState<BotTeam[]>([]);
  const [runs, setRuns] = useState<BotTeamRun[]>([]);
  const [summary, setSummary] = useState<BotSidebarSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const summaryRef = useRef<BotSidebarSummary | null>(null);
  const mode = useRef<'unknown' | 'live' | 'polling' | 'missing'>('unknown');
  const loadCatalog = useCallback(async () => {
    const [botResult, teamResult] = await Promise.allSettled([
      api.get<BotsSnapshot>('/api/bots'),
      api.get<BotTeamsSnapshot>('/api/bots/teams'),
    ]);
    if (!alive.current) return;
    if (botResult.status === 'fulfilled') setBots(Array.isArray(botResult.value?.bots) ? botResult.value.bots : []);
    if (teamResult.status === 'fulfilled') {
      setTeams(Array.isArray(teamResult.value?.teams) ? teamResult.value.teams : []);
      setRuns(Array.isArray(teamResult.value?.runs) ? teamResult.value.runs : []);
    }
    const failed = [botResult, teamResult].find(result => result.status === 'rejected');
    setError(failed && failed.status === 'rejected' ? (failed.reason instanceof Error ? failed.reason.message : 'Bots could not be loaded.') : '');
    setLoading(false);
  }, []);
  const loadSummary = useCallback(async () => {
    try {
      const parsed = parseSidebarSummary(await api.get<unknown>(SUMMARY));
      if (!alive.current || !parsed) return false;
      summaryRef.current = parsed;
      setSummary(parsed);
      noteSidebarSummary(true);
      if (mode.current === 'missing') mode.current = 'polling';
      return true;
    } catch (reason) {
      if (!alive.current) return false;
      if (reason instanceof ApiError && reason.status === 404) {
        mode.current = 'missing';
        summaryRef.current = null;
        setSummary(null);
        noteSidebarSummary(false);
      }
      return false;
    }
  }, []);
  const refresh = useCallback(async () => {
    await loadCatalog();
    if (mode.current !== 'live') await loadSummary();
  }, [loadCatalog, loadSummary]);
  useEffect(() => {
    alive.current = true;
    let source: EventSource | null = null;
    let poll: number | undefined;
    const stopPoll = () => { if (poll) window.clearInterval(poll); poll = undefined; };
    const startPoll = () => {
      if (poll || mode.current === 'missing') return;
      mode.current = 'polling';
      poll = window.setInterval(() => { if (!document.hidden) void loadSummary(); }, 5000);
    };
    const openStream = () => {
      if (source || mode.current === 'missing') return;
      source = new EventSource(`${HOST}${SUMMARY_STREAM}`);
      source.addEventListener('bot-summary', event => {
        try {
          const parsed = parseSidebarSummary(JSON.parse((event as MessageEvent).data));
          if (!parsed || !alive.current) return;
          mode.current = 'live';
          summaryRef.current = parsed;
          setSummary(parsed);
          noteSidebarSummary(true);
          stopPoll();
        } catch { /* A bad frame leaves the last good summary on screen. */ }
      });
      source.addEventListener('error', () => { if (alive.current && mode.current !== 'missing') startPoll(); });
    };
    void refresh().then(() => { if (alive.current && mode.current !== 'missing') openStream(); });
    const catalogTimer = window.setInterval(() => {
      if (document.hidden) return;
      void loadCatalog();
      if (mode.current !== 'live') void loadSummary().then(ok => { if (ok && alive.current) openStream(); });
    }, 5000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    const stopRead = onSidebarRead((kind, id) => {
      markLocalChats(kind, id);
      setSummary(current => {
        if (!current) return current;
        const next = clearSummaryUnread(current, kind, id);
        const same = kind === 'bot'
          ? current.bots.every((bot, index) => bot.unreadCount === next.bots[index]?.unreadCount)
          : current.rooms.every((room, index) => room.unreadCount === next.rooms[index]?.unreadCount);
        if (same) return current;
        summaryRef.current = next;
        return next;
      });
    });
    return () => {
      alive.current = false;
      stopRead();
      stopPoll();
      source?.close();
      window.clearInterval(catalogTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadCatalog, loadSummary, refresh]);
  const roster = useMemo(() => {
    const derived = sidebarRoster({ bots, teams, runs, sessions, activeSession });
    const live = summary ? applySidebarSummary(derived, summary, { bots, teams }) : derived;
    return openedSidebarRead(live, sidebarReadTarget(location.route, location.param, location.query));
  }, [bots, teams, runs, sessions, activeSession, summary, location.route, location.param, location.query]);
  const items = useMemo<SidebarCatalogItem[]>(() => [
    ...roster.bots.map(bot => ({ kind: 'bot' as const, id: bot.id, name: bot.name, updatedAt: bot.updatedAt })),
    ...roster.rooms.map(room => ({ kind: 'room' as const, id: room.id, name: room.name, updatedAt: room.updatedAt })),
  ], [roster.bots, roster.rooms]);
  return { ...roster, items, loading, error, refresh: () => void refresh() };
}
