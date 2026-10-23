// Embedded CUA Bots adaptation. FSL-1.1-MIT; see /cua-bots-LICENSE.txt and /cua-bots-NOTICE.txt.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../lib/client';
import { navigate, useLocation } from '../lib/router';
import { coucouPaneStyle, useCoucouTracked } from '../lib/use-coucou-tracked';
import { adoptSharedConversation, adoptSharedConversations, selectSession, useStore } from '../lib/store';
import { markSidebarRead, sidebarReadTarget } from '../lib/sidebar-reads';
import { sessionTitle } from '../lib/session-title';
import { relTime } from '../lib/format';
import { blankBot, botComputerSelection, botConversationContext, botConversations, botPersonalConversations, botDraftError, botPolicyLabel, botAvatarActivity, botReplySignal, botConversationRoster, botProviderName, botSetupStepError, teamRosterLabel, type BotPolicy, type Bot, type BotDraft, type BotExecution, type BotsSnapshot, type BotTeamsSnapshot } from '../lib/bots';
import { botReadiness, type BotComputerReadiness } from '../lib/bot-readiness';
import type { Session } from '../lib/types';
import { CuaBotAvatar, CuaBotAvatarPicker, defaultCuaBotAvatar } from '../components/CuaBotAvatar';
import { BotComputer } from '../components/BotComputer';
import { BotHostFolderSettings } from '../components/BotHostFolderSettings';
import { Screen } from '../components/layout';
import { Btn, Dialog, ErrorNotice, Icon, IconBtn, Select } from '../components/ui';
import { ConversationRosterCopy, ConversationRosterFace, ConversationRosterResize } from './ConversationRoster';
import { CONVERSATION_ROSTER_WIDTH_KEY, readConversationRosterWidth } from '../lib/conversation-roster-width';
import { ChatScreen } from './Chat';
import { ComputerPicker, CuaBotsConfig, BotPermissionPicker } from './CuaBotsConfig';
import { BotMemoryDialog, BotOutputDialog, BotRoutineDialog, BotRulesDialog, BotsWorkView, EMPTY_BOT_WORK, routineScheduleLabel, useBotsWork, type BotRoutine, type BotWorkOutput, type BotsWorkTab } from './CuaBotsWork';
import { BotTeamActivityView, BotTeamEditor, BotTeamPanel, TeamMark, useBotsResource } from './BotsWorkspace';
import { BotConnectionsPanel, BotCreatedToolsPanel, BotSkillsPanel } from './BotsCapabilities';
import './Bots.css';
import { openNotifications } from '../lib/notifications';

const SETUP_STEPS = ['Name', 'Look', 'Model', 'Computer', 'Permissions'];
const WORK_TABS: { id: BotsWorkTab; label: string; icon: 'clock' | 'shield' | 'file' }[] = [{ id: 'scheduled', label: 'Scheduled', icon: 'clock' }, { id: 'approvals', label: 'Approvals', icon: 'shield' }, { id: 'outputs', label: 'Outputs', icon: 'file' }];
const BOT_PLACES = [{ id: 'activity', label: 'Activity', icon: 'activity' }, { id: 'skills', label: 'Skills', icon: 'skills' }, { id: 'tools', label: 'Tools', icon: 'tool' }, { id: 'connections', label: 'Connectors', icon: 'link' }] as const;
type ConversationMetadata = { id: string; updatedAt: string; botId?: string; teamId?: string; teamRunId?: string; parentChatId?: string; preferences?: Session['preferences'] };
function personalConversationMetadata(rows: ConversationMetadata[], botId: string) {
  if (!Array.isArray(rows)) throw new Error('Shared conversations could not be checked. Refresh Bots and try again.');
  const normalized = rows.map(row => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(row.id) || typeof row.updatedAt !== 'string') throw new Error('Shared conversations returned an invalid identity. Refresh Bots and try again.');
    const preferences = { ...row.preferences };
    for (const key of ['botId', 'teamId', 'teamRunId', 'parentChatId'] as const) if (row[key] !== undefined) {
      if (typeof row[key] !== 'string' || preferences[key] !== undefined && preferences[key] !== row[key]) throw new Error('Shared conversations returned conflicting ownership. Refresh Bots and try again.');
      preferences[key] = row[key];
    }
    return { id: row.id, updatedAt: row.updatedAt, preferences };
  });
  return botPersonalConversations(normalized, botId);
}

export function BotsScreen() {
  const location = useLocation(), sessions = useStore(state => state.sessions);
  const workspace = useStore(state => state.workspaces.find(item => item.id === state.activeWorkspace)?.path ?? state.workspacePath);
  const [snapshot, setSnapshot] = useState<BotsSnapshot | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [pending, setPending] = useState('');
  const [selectedChats, setSelectedChats] = useState<Record<string, string>>({}), [showProfile, setShowProfile] = useState(false), [showComputer, setShowComputer] = useState(false);
  const [step, setStep] = useState(0), [newDraft, setNewDraft] = useState<BotDraft>(() => newBotDraft(workspace)), [customLook, setCustomLook] = useState(false);
  const [editing, setEditing] = useState<{ bot: Bot; draft: BotDraft } | null>(null), [editorError, setEditorError] = useState(''), [configBusy, setConfigBusy] = useState(false);
  const [opening, setOpening] = useState<{ bot: Bot; execution: BotExecution; workspace: string; modelId: string; policy: BotPolicy } | null>(null), [chatError, setChatError] = useState(''), [computerBusy, setComputerBusy] = useState(false), [personalChatError, setPersonalChatError] = useState('');
  const [removing, setRemoving] = useState<Bot | null>(null), [memoryFor, setMemoryFor] = useState<Bot | null>(null), [rulesFor, setRulesFor] = useState<Bot | null>(null);
  const [routineFor, setRoutineFor] = useState<{ bot?: Bot; routine?: BotRoutine } | null>(null), [outputFor, setOutputFor] = useState<{ bot: Bot; output: BotWorkOutput } | null>(null);
  const [readinessRevision, setReadinessRevision] = useState(0);
  const [newTeam, setNewTeam] = useState(false);
  const [rosterQuery, setRosterQuery] = useState(''), [rosterFilter, setRosterFilter] = useState('all'), [rosterWidth, setRosterWidth] = useState(() => readConversationRosterWidth(typeof localStorage === 'undefined' ? null : localStorage));
  const [showRosterFilters, setShowRosterFilters] = useState(false), [showChatHistory, setShowChatHistory] = useState(false);
  const teams = useBotsResource<BotTeamsSnapshot>('/api/bots/teams');
  const [computerReadiness, setComputerReadiness] = useState<{ key: string; computer?: BotComputerReadiness; error?: string; checking?: boolean } | null>(null);
  const generation = useRef(0), navigationRevision = useRef(0), alive = useRef(true), personalChatRequest = useRef<symbol | null>(null), snapshotSignature = useRef(''), reading = useRef(false), readPost = useRef('');
  const profileMotion = useCoucouTracked(showProfile);
  const bots = snapshot?.bots ?? [];
  const selected = bots.find(bot => bot.id === location.param) ?? (!location.param ? bots[0] : undefined);
  const workTab = WORK_TABS.find(tab => tab.id === location.param)?.id;
  const workspaceRoute = ['teams', 'activity', 'skills', 'tools', 'connections'].includes(location.param ?? '') ? location.param : null;
  const destination = workTab || workspaceRoute === 'activity' ? 'activity' : workspaceRoute === 'skills' ? 'skills' : workspaceRoute === 'tools' ? 'tools' : workspaceRoute === 'connections' ? 'connections' : 'team';
  const route = workTab ?? workspaceRoute ?? (location.param === 'new' || !selected ? 'new' : 'bot');
  const { work, error: workError, refresh: refreshWork } = useBotsWork(workTab === 'scheduled' || workTab === 'outputs' ? bots : route === 'bot' && selected ? [selected] : []);
  const chats = selected ? botConversations(sessions, selected.id) : [], chatId = selected ? selectedChats[selected.id] ?? botPersonalConversations(chats, selected.id)[0]?.id : undefined;
  const chat = chats.find(item => item.id === chatId);
  const context = selected ? botConversationContext(selected, chat ?? (chatId ? { id: chatId, preferences: { botId: selected.id } } : undefined), snapshot?.models) : null;
  const hasComputer = context?.computerMode === 'cua', selectedWork = selected ? work[selected.id] ?? EMPTY_BOT_WORK : EMPTY_BOT_WORK;
  const computerKey = selected && hasComputer ? `${selected.id}:${context?.chatId ?? 'profile'}:${context?.chatId ? '' : selected.updatedAt}` : '';
  const approvals = sessions.filter(session => bots.some(bot => bot.id === session.preferences?.botId)).flatMap(session => session.messages.flatMap(row => (row.tools ?? []).filter(tool => tool.live && tool.state === 'proposed'))).length;

  async function refresh(includeChats = false, force = true) {
    if (reading.current && !force) return;
    const request = ++generation.current;
    reading.current = true;
    try {
      const result = await api.get<BotsSnapshot>('/api/bots');
      if (!alive.current || request !== generation.current) return;
      const signature = JSON.stringify(result);
      if (snapshotSignature.current !== signature) { snapshotSignature.current = signature; setSnapshot(result); }
      setError('');
      if (includeChats) {
        const catalog = await api.get<{ conversations: Session[] }>('/api/companion/conversations');
        if (!alive.current || request !== generation.current) return;
        adoptSharedConversations(catalog.conversations ?? []);
      }
    } catch (cause) { if (alive.current && request === generation.current) setError(message(cause)); }
    finally { if (alive.current && request === generation.current) { setLoading(false); reading.current = false; } }
  }
  useEffect(() => {
    alive.current = true; void refresh(true);
    const navigated = () => { navigationRevision.current++; };
    window.addEventListener('hashchange', navigated);
    const timer = setInterval(() => { if (!document.hidden) void refresh(false, false); }, 3000);
    return () => { alive.current = false; generation.current++; navigationRevision.current++; clearInterval(timer); window.removeEventListener('hashchange', navigated); };
  }, []);
  useEffect(() => { setEditing(null); setOpening(null); setEditorError(''); setNewTeam(location.route === 'bots' && location.param === 'teams' && location.query.get('new') === 'room'); setShowChatHistory(false); }, [location.route, location.param, location.query.toString()]);
  useEffect(() => {
    const target = sidebarReadTarget(location.route, location.param, location.query);
    if (!target) return;
    const key = `${target.kind}:${target.id}`;
    const post = readPost.current !== key;
    if (post) readPost.current = key;
    void markSidebarRead(target.kind, target.id, { post });
  }, [location.route, location.param, location.query, sessions]);
  useEffect(() => {
    if (route === 'bot' && selected && chat) {
      setSelectedChats(previous => previous[selected.id] ? previous : { ...previous, [selected.id]: chat.id });
      selectSession(chat.id);
    }
  }, [route, selected?.id, chat?.id]);
  useEffect(() => { setShowComputer(false); }, [selected?.id]);
  useEffect(() => {
    if (!computerKey || !selected || showComputer) return;
    let current = true, reading = false;
    const path = `/api/bots/${encodeURIComponent(selected.id)}/computer${context?.chatId ? `?chatId=${encodeURIComponent(context.chatId)}` : ''}`;
    async function check() {
      if (!current || reading || document.hidden) return;
      reading = true; setComputerReadiness(previous => previous?.key === computerKey ? { ...previous, checking: true } : { key: computerKey, checking: true });
      try { const computer = await api.get<BotComputerReadiness>(path); if (current) setComputerReadiness({ key: computerKey, computer }); }
      catch (cause) { if (current) setComputerReadiness({ key: computerKey, error: message(cause) }); }
      finally { reading = false; }
    }
    void check(); const timer = setInterval(() => void check(), 30000);
    return () => { current = false; clearInterval(timer); };
  }, [computerKey, showComputer, readinessRevision]);
  async function action(id: string, operation: () => Promise<void>) { setPending(id); setError(''); try { await operation(); } catch (cause) { setError(message(cause)); } finally { setPending(''); } }
  function startNew() { navigationRevision.current++; setStep(0); setNewDraft(newBotDraft(workspace)); setCustomLook(false); setEditorError(''); navigate('bots', 'new'); }
  function edit(bot: Bot) { setEditorError(''); setEditing({ bot, draft: draftFor(bot) }); }
  function openChat(bot: Bot, conversation: Session) { navigationRevision.current++; adoptSharedConversation(conversation); setSelectedChats(previous => ({ ...previous, [bot.id]: conversation.id })); selectSession(conversation.id); navigate('bots', bot.id); }
  async function openPersonalChat(bot: Bot) {
    if (personalChatRequest.current || pending || loading) return;
    const request = Symbol(bot.id), revision = navigationRevision.current, hash = window.location.hash;
    personalChatRequest.current = request; setPending(`open:${bot.id}`); setPersonalChatError('');
    const current = () => alive.current && personalChatRequest.current === request && navigationRevision.current === revision && window.location.hash === hash;
    try {
      // Another device may have created this bot's personal chat since the roster
      // loaded. Read the shared history before making a new empty conversation.
      const catalog = await api.get<{ available?: boolean; conversations: ConversationMetadata[] }>('/api/companion/conversations?summary=1');
      if (!current()) return;
      if (catalog.available === false) throw new Error('Shared conversations are temporarily unavailable. Refresh Bots and try again.');
      const selected = personalConversationMetadata(catalog.conversations, bot.id)[0];
      let conversation: Session;
      if (selected) {
        // These allowlisted host IDs contain no URL delimiters. Encoding ':'
        // would make older host route matchers reject a valid existing chat.
        // URL dot segments cannot address a detail route; inspect the exact
        // retained full row instead, without creating a replacement chat.
        const detail = ['.', '..'].includes(selected.id)
          ? { conversation: (await api.get<{ conversations: Session[] }>('/api/companion/conversations')).conversations.find(row => row.id === selected.id)! }
          : await api.get<{ conversation: Session }>(`/api/companion/conversations/${selected.id}`);
        if (!current()) return;
        conversation = detail.conversation;
        if (!conversation || conversation.id !== selected.id || !botPersonalConversations([conversation], bot.id).length) throw new Error('Strata returned a different conversation. Refresh Bots and try again.');
      } else {
        if (bot.paused) throw new Error('This bot is paused. Resume it before starting a new chat.');
        // Defaults are frozen by the host. Creating an empty chat sends no prompt
        // and does not start or prepare a computer, provider, or model service.
        const created = await api.post<{ conversation: Session }>(`/api/bots/${encodeURIComponent(bot.id)}/conversations`, {});
        conversation = created.conversation;
        if (!conversation || typeof conversation.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(conversation.id) || !botPersonalConversations([conversation], bot.id).length) throw new Error('Strata returned a different conversation. Refresh Bots and try again.');
      }
      if (current()) openChat(bot, conversation);
    } catch (cause) { if (current()) setPersonalChatError(message(cause)); }
    finally { if (personalChatRequest.current === request) { personalChatRequest.current = null; if (alive.current) setPending(''); } }
  }
  function chooseChat(bot: Bot) { setChatError(''); setOpening({ bot, execution: { ...bot.execution }, workspace: bot.workspace, modelId: '', policy: bot.policy }); }
  async function openSharedConversation(id: string, conversation?: Session) {
    const revision = navigationRevision.current, hash = window.location.hash;
    const known = conversation ?? sessions.find(item => item.id === id);
    if (known) {
      adoptSharedConversation(known); selectSession(id);
      const bot = bots.find(item => item.id === known.preferences?.botId);
      if (bot) openChat(bot, known); else navigate('chat', id);
      return;
    }
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) throw new Error('This conversation is no longer available. Refresh the shared history.');
    const detail = ['.', '..'].includes(id)
      ? { conversation: (await api.get<{ conversations: Session[] }>('/api/companion/conversations')).conversations.find(row => row.id === id)! }
      : await api.get<{ conversation: Session }>(`/api/companion/conversations/${id}`);
    if (!alive.current || revision !== navigationRevision.current || hash !== window.location.hash) return;
    const found = detail.conversation;
    if (!found || found.id !== id) throw new Error('This conversation is no longer available. Refresh the shared history.');
    await openSharedConversation(id, found);
  }
  async function save(draft: BotDraft, bot?: Bot) {
    const shape = draft.avatarConfig?.shape;
    if (shape && shape !== 'classic' && !snapshot?.avatarShapes?.includes(shape)) { setEditorError('This Strata host does not support this character. Choose an animal to save your changes.'); return; }
    const validation = botDraftError(draft); if (validation) { setEditorError(validation); return; }
    const revision = navigationRevision.current, hash = window.location.hash;
    const current = () => alive.current && revision === navigationRevision.current && hash === window.location.hash;
    setPending('save'); setEditorError('');
    try {
      const avatarConfig = draft.avatarConfig?.shape === 'classic' && !snapshot?.avatarShapes?.length ? (({ shape: _, ...face }) => face)(draft.avatarConfig) : draft.avatarConfig;
      const body = { ...draft, ...(avatarConfig ? { avatarConfig } : {}), name: draft.name.trim(), model: draft.model.trim(), workspace: draft.workspace.trim() };
      const result = bot ? await api.patch<{ bot: Bot }>(`/api/bots/${encodeURIComponent(bot.id)}`, body) : await api.post<{ bot: Bot }>('/api/bots', body);
      if (alive.current) await refresh();
      if (current()) { setEditing(null); setNewDraft(newBotDraft(workspace)); setStep(0); navigate('bots', result.bot.id); }
    } catch (cause) { if (current()) setEditorError(message(cause)); } finally { if (alive.current) setPending(''); }
  }
  async function newChat() {
    if (!opening || !snapshot) return;
    const selectionError = botSetupStepError(3, { ...opening.bot, workspace: opening.workspace, execution: opening.execution });
    if (selectionError) { setChatError(selectionError); return; }
    const revision = navigationRevision.current, hash = window.location.hash;
    const current = () => alive.current && revision === navigationRevision.current && hash === window.location.hash;
    setPending('chat'); setChatError('');
    try {
      const target = botComputerSelection(opening.execution, snapshot.computers);
      const body = { ...(target === 'local' || !['custom-ssh', 'sandbox'].includes(target) ? { computerId: target } : { execution: opening.execution }), workspace: opening.workspace.trim(), policy: opening.policy, ...(opening.modelId ? { modelId: opening.modelId } : {}) };
      const result = await api.post<{ conversation: Session }>(`/api/bots/${encodeURIComponent(opening.bot.id)}/conversations`, body);
      adoptSharedConversation(result.conversation);
      if (current()) { openChat(opening.bot, result.conversation); setOpening(null); }
    } catch (cause) { if (current()) setChatError(message(cause)); } finally { if (alive.current) setPending(''); }
  }
  function pause(bot: Bot) { void action('pause', async () => { await api.post(`/api/bots/${encodeURIComponent(bot.id)}/pause`, { paused: !bot.paused }); await refresh(); }); }
  function removeProfile(bot: Bot) {
    const revision = navigationRevision.current, hash = window.location.hash;
    void action('remove', async () => {
      await api.del(`/api/bots/${encodeURIComponent(bot.id)}`);
      if (alive.current) await refresh();
      if (alive.current && revision === navigationRevision.current && hash === window.location.hash) { setRemoving(null); navigate('bots'); }
    });
  }
  function toggleComputer() { setShowComputer(previous => { if (!previous) setShowProfile(false); return !previous; }); }
  function updateNew(patch: Partial<BotDraft>) { setEditorError(''); setNewDraft(current => ({ ...current, ...patch })); }
  function resizeRoster(next: number) {
    setRosterWidth(next);
    try { localStorage.setItem(CONVERSATION_ROSTER_WIDTH_KEY, String(next)); } catch { /* This visit keeps the width. */ }
  }
  function advanceNew() { const error = botSetupStepError(step, newDraft); if (error) setEditorError(error); else { setEditorError(''); setStep(value => value + 1); } }
  const mood = (bot: Bot) => botAvatarActivity(bot, sessions);
  const rosterDetail = (bot: Bot, preview?: {text:string}) => bot.paused ? 'Paused' : mood(bot) === 'needsApproval' ? 'Needs approval' : ['thinking', 'working'].includes(mood(bot)) ? 'Working' : mood(bot) === 'error' ? 'Needs attention' : preview?.text ?? snapshot?.providers.find(provider => provider.id === bot.provider)?.name ?? (bot.provider === 'configured' ? 'Models connection' : bot.provider);
  const roster = botConversationRoster(bots, teams.data, sessions);
  const listedRoster = roster.filter(row => row.name.toLowerCase().includes(rosterQuery.trim().toLowerCase()) && (rosterFilter === 'all' || row.state === rosterFilter));
  const frozenPolicy = chat ? chat.preferences?.mode === 'plan' ? 'plan' : chat.preferences?.mode === 'bypass' ? 'bypass' : 'manual' : !chatId ? selected?.policy : undefined;
  const checkedComputer = computerReadiness?.key === computerKey ? computerReadiness : null;
  const readiness = selected ? botReadiness(selected, { computerMode: context?.computerMode, conversation: !!chatId, unavailableConversation: !!chatId && !chat, active: chats.some(session => session.active), needsApproval: mood(selected) === 'needsApproval', computer: checkedComputer?.computer, computerError: checkedComputer?.error, checking: !checkedComputer || checkedComputer.checking }) : null;

  return <Screen title="Bots" titleDetail={route === 'new' ? 'New bot' : undefined} bare actions={<><Btn size="sm" icon="activity" onClick={() => openNotifications()}>Notifications</Btn><IconBtn name="refresh" title="Refresh bots and shared work" disabled={loading || !!pending} onClick={() => { void refresh(true); void refreshWork(); void teams.refresh(); setReadinessRevision(value => value + 1); }}/></>}>
    <div className="bots-workspace">
    <div className="cua-bots-shell" data-list style={{ '--cua-roster-width': `${rosterWidth}px` } as CSSProperties}>
      <aside className="cua-bots-sidebar" aria-label="Bots navigation"><nav id="conversation-roster">
        <button className="cua-sidebar-item cua-sidebar-new" data-selected={route === 'new' || undefined} onClick={startNew} aria-label="New bot"><Icon name="plus" size={16}/><span>New bot</span></button>
        <button className="cua-sidebar-item cua-roster-compact" data-active={!!rosterQuery || rosterFilter !== 'all' || undefined} aria-label="Search and filter bots" aria-haspopup="dialog" aria-expanded={showRosterFilters} onClick={() => setShowRosterFilters(true)}><Icon name="search" size={17}/></button>
        <div className="cua-roster-search"><Icon name="search" size={14}/><input type="search" aria-label="Search bots" placeholder="Search conversations…" value={rosterQuery} onChange={event => setRosterQuery(event.target.value)}/></div><div className="cua-roster-filter"><Select ariaLabel="Filter bots" value={rosterFilter} options={[{value:"all",label:"All conversations"},{value:"attention",label:"Needs attention"},{value:"working",label:"Working"}]} onChange={setRosterFilter}/></div>
        <h2>Conversations <span>{listedRoster.length}{listedRoster.length !== roster.length ? `/${roster.length}` : ""}</span></h2>
        <div className="cua-bot-list">{listedRoster.map(row => {
          if (row.kind === 'team') {
            const team = teams.data?.teams.find(item => item.id === row.id); if (!team) return null;
            const preview = row.preview ?? (team.enabled ? teamRosterLabel(team.memberIds.length) : 'Collaboration off');
            const teamStatus = row.state === 'working' ? 'working' : row.state === 'attention' ? 'attention' : 'idle';
            return <button className="cua-sidebar-item cua-roster-bot cua-roster-team" key={`team:${team.id}`} aria-label={`Open team ${team.name}`} title={team.name} data-selected={route === 'teams' && location.query.get('team') === team.id || undefined} data-state={row.state} onClick={() => navigate('bots','teams',{team:team.id})}>
              <ConversationRosterFace status={teamStatus}><TeamMark team={team} bots={bots} size={16}/></ConversationRosterFace>
              <ConversationRosterCopy name={team.name} timeLabel={Number.isFinite(Date.parse(row.updatedAt)) ? relTime(row.updatedAt) : undefined} timeStamp={row.updatedAt} preview={preview} shimmer={row.state === 'working'}/>
            </button>;
          }
          const bot = bots.find(item => item.id === row.id); if (!bot) return null;
          const detail = pending === `open:${bot.id}` ? 'Opening conversation…' : rosterDetail(bot, row.preview ? { text: row.preview } : undefined);
          const dot = bot.paused || mood(bot) === 'paused' ? 'paused' : mood(bot) === 'needsApproval' || mood(bot) === 'error' ? 'attention' : mood(bot) === 'thinking' || mood(bot) === 'working' ? 'working' : 'idle';
          return <button key={`bot:${bot.id}`} className="cua-sidebar-item cua-roster-bot" aria-label={`Open ${bot.name}`} title={bot.name} data-selected={selected?.id === bot.id && route === 'bot' || undefined} data-state={mood(bot)} disabled={loading || !!pending} onClick={() => void openPersonalChat(bot)}>
            <ConversationRosterFace status={dot}><CuaBotAvatar config={bot.avatarConfig} name={bot.name} size={32} mood={mood(bot)} messageSignal={botReplySignal(bot.id, sessions)}/></ConversationRosterFace>
            <ConversationRosterCopy name={bot.name} timeLabel={Number.isFinite(Date.parse(row.updatedAt)) ? relTime(row.updatedAt) : undefined} timeStamp={row.updatedAt} preview={detail} shimmer={dot === 'working'} extra={bot.paused ? <Icon name="pause" size={12}/> : null}/>
          </button>;
        })}{!listedRoster.length ? <p className="cua-roster-empty">{rosterQuery ? 'No conversations match this search.' : rosterFilter === 'working' ? 'No conversations are active.' : rosterFilter === 'attention' ? 'No conversations need attention.' : 'Create your first bot.'}</p> : null}</div>
        <div className="cua-roster-team-actions"><button className="cua-sidebar-item" data-selected={route==='teams'&&!location.query.get('team')||undefined} onClick={()=>navigate('bots','teams')} aria-label="All teams"><Icon name="experts" size={17}/><span>All teams</span></button><button className="cua-sidebar-item cua-sidebar-new" disabled={bots.length<2} title={bots.length<2?'Add a second bot to create a team':undefined} onClick={()=>setNewTeam(true)} aria-label="New team"><Icon name="plus" size={16}/><span>New team</span></button></div>
      </nav>
      <nav className="cua-roster-places" aria-label="Bots workspace">{BOT_PLACES.map(tab => <button key={tab.id} className="cua-sidebar-item" aria-current={destination === tab.id ? 'page' : undefined} onClick={() => tab.id === 'connections' ? navigate('connectors') : navigate('bots', tab.id)}><Icon name={tab.icon} size={16}/><span>{tab.label}</span>{tab.id === 'activity' && approvals ? <b>{approvals}</b> : null}</button>)}</nav>
      </aside>
      <ConversationRosterResize width={rosterWidth} onChange={resizeRoster}/>
      <section className="cua-bots-main">
        {personalChatError ? <div className="cua-inline-error"><ErrorNotice message={personalChatError} action="Dismiss" onRetry={() => setPersonalChatError('')}/></div> : null}
        {error ? <div className="cua-inline-error"><ErrorNotice message={error} action="Refresh" onRetry={() => void refresh(true)}/></div> : null}
        {workError ? <div className="cua-inline-error"><ErrorNotice message={workError} action="Refresh work" onRetry={() => void refreshWork()}/></div> : null}
        {destination==='activity'?<nav className="bots-activity-tabs" aria-label="Activity sections"><button aria-current={!workTab?'page':undefined} onClick={()=>navigate('bots','activity')}>Team work</button>{WORK_TABS.map(tab=><button key={tab.id} aria-current={workTab===tab.id?'page':undefined} onClick={()=>navigate('bots',tab.id)}>{tab.label}{tab.id==='approvals'&&approvals?` (${approvals})`:''}</button>)}</nav>:null}
        {route==='teams'?<BotTeamPanel bots={bots} resource={teams} teamId={location.query.get('team')??undefined} onSelect={id=>navigate('bots','teams',{team:id})} onNewTeam={()=>setNewTeam(true)} onNewBot={startNew} onOpenConversation={openSharedConversation}/>:null}
        {route==='activity'?<BotTeamActivityView bots={bots} onOpenConversation={openSharedConversation}/>:null}
        {route==='skills'?<BotSkillsPanel bots={bots}/>:null}
        {route==='tools'?<BotCreatedToolsPanel bots={bots} teams={teams.data?.teams}/>:null}
        {route==='connections'?<BotConnectionsPanel bots={bots} teams={teams.data?.teams} initialScope={location.query.get('bot')?'bot:'+location.query.get('bot'):location.query.get('team')?'team:'+location.query.get('team'):'all'}/>:null}
        {route === 'new' ? <div className="cua-new-bot"><div className="cua-new-bot-body"><div className={step < 2 ? "cua-new-identity" : "cua-new-setup"}>
          {step < 2 ? <div className="cua-companion-intro"><p className="cua-companion-kicker">{step === 0 ? 'A new little teammate' : 'A face to call your own'}</p><div className="cua-companion-stage"><span className="cua-companion-spark" aria-hidden="true"/><span className="cua-companion-dot" aria-hidden="true"/><CuaBotAvatar config={newDraft.avatarConfig} name={newDraft.name} size={144} mood="idle" messageSignal={step === 1 ? JSON.stringify(newDraft.avatarConfig) : undefined}/></div></div> : <CuaBotAvatar config={newDraft.avatarConfig} name={newDraft.name} size={56} mood="idle"/>}
          {step === 0 ? <div className="cua-meet"><h2>Meet your bot</h2><p>A bot works on its own computer, remembers what matters to you, and checks in when something needs your approval. Strata keeps its work and routines running while the Mac app is open.</p><input className="st-input" aria-label="Bot name" placeholder="What should we call it?" maxLength={120} value={newDraft.name} onChange={event => updateNew({ name: event.target.value, ...(!customLook ? { avatarConfig: defaultCuaBotAvatar(event.target.value) } : {}) })} onKeyDown={event => { if (event.key === 'Enter' && newDraft.name.trim()) setStep(1); }}/></div> : step === 1 ? <div className="cua-look"><h2>Make {newDraft.name.trim() || 'your bot'} yours</h2><CuaBotAvatarPicker value={newDraft.avatarConfig ?? defaultCuaBotAvatar(newDraft.name)} name={newDraft.name} shapes={snapshot?.avatarShapes} onChange={avatarConfig => { setCustomLook(true); updateNew({ avatarConfig }); }}/></div> : snapshot ? <div className="cua-new-config"><h2>{step === 2 ? "Choose its role and model" : step === 3 ? "Choose its computer" : "Set its permissions"}</h2><CuaBotsConfig section={step === 2 ? "model" : step === 3 ? "computer" : "permissions"} draft={newDraft} snapshot={snapshot} busy={!!pending} onBusyChange={setConfigBusy} onChange={updateNew}/></div> : <p role="status">Connecting to Strata…</p>}
          {editorError ? <ErrorNotice message={editorError} action="Dismiss" onRetry={() => setEditorError('')}/> : null}</div></div><footer className="cua-new-footer"><Btn disabled={!!pending || configBusy || step === 0} onClick={() => setStep(value => value - 1)}>Back</Btn><div className="cua-step-dots" aria-label={`Step ${step + 1} of ${SETUP_STEPS.length}: ${SETUP_STEPS[step]}`}>{SETUP_STEPS.map((label, value) => <i key={value} title={label} data-current={step === value || undefined}/>)}</div>{step < SETUP_STEPS.length - 1 ? <Btn variant="primary" disabled={!!pending || configBusy || step === 0 && !newDraft.name.trim()} onClick={advanceNew}>Continue</Btn> : <Btn variant="primary" disabled={!snapshot || !!pending || configBusy} onClick={() => void save(newDraft)}>{pending === 'save' ? 'Creating…' : `Create ${newDraft.name.trim() || 'bot'}`}</Btn>}</footer></div> : null}
        {workTab ? <BotsWorkView tab={workTab} bots={bots} sessions={sessions} work={work} onOpenChat={openChat} onRoutine={(bot, routine) => setRoutineFor({ bot, routine })} onOutput={(bot, output) => setOutputFor({ bot, output })} onRefresh={refreshWork}/> : null}
        {route === 'bot' && selected && context ? <>
          <header className="cua-bot-toolbar"><div className="cua-conversation-control">{chats.length > 1 || (chatId && !chat) ? <Select value={chatId ?? ''} ariaLabel="Bot conversation" options={[...(chatId && !chat ? [{ value: chatId, label: 'Conversation unavailable', disabled: true }] : []), ...chats.map(session => ({ value: session.id, label: sessionTitle(session) }))]} onChange={id => { const conversation = chats.find(item => item.id === id); if (conversation) openChat(selected, conversation); }}/> : !chatId ? <span className="cua-toolbar-status" data-tone={readiness?.tone}>{readiness?.label}</span> : null}<IconBtn name="new-chat" title="New shared conversation" disabled={!!pending} onClick={() => chooseChat(selected)}/></div><span className="spacer"/><div className="cua-toolbar-controls" role="group" aria-label="Bot controls"><IconBtn name="computer" title={showComputer ? 'Hide computer' : 'Open computer'} disabled={!hasComputer} onClick={toggleComputer}/><IconBtn name={selected.paused ? 'play' : 'pause'} title={selected.paused ? 'Resume bot' : 'Pause bot'} disabled={!!pending} onClick={() => pause(selected)}/><IconBtn name="panel" title={showProfile ? 'Hide profile' : 'Show profile'} onClick={() => setShowProfile(value => !value)}/></div></header>
          <div className="cua-bot-detail" data-computer={showComputer && hasComputer || undefined}>
            <div className="cua-bot-chat">{chat ? <ChatScreen key={chat.id} embedded sessionId={chat.id} onComputer={hasComputer ? toggleComputer : undefined}/> : <div className="cua-chat-welcome"><div className="cua-welcome-avatar"><CuaBotAvatar config={selected.avatarConfig} name={selected.name} size={112} mood={mood(selected)} messageSignal={botReplySignal(selected.id, sessions)}/></div><h2>{selected.name}</h2><span className="cua-readiness" data-tone={readiness?.tone}>{readiness?.label}</span><p className="small muted">{readiness?.detail}</p><div className="cua-welcome-actions">{readiness?.action === 'settings' ? <Btn variant="primary" icon="settings" disabled={!!pending} onClick={() => edit(selected)}>Review setup</Btn> : readiness?.action === 'computer' && hasComputer ? <Btn variant="primary" icon="computer" onClick={toggleComputer}>Open computer</Btn> : null}<Btn variant={readiness?.action ? 'secondary' : 'primary'} icon="chat" disabled={loading || !!pending || selected.paused} onClick={() => void openPersonalChat(selected)}>{pending === `open:${selected.id}` ? 'Opening…' : 'New conversation'}</Btn></div><p className="cua-welcome-note">Conversations, thinking and approvals stay shared with your iPhone.</p></div>}</div>
            {showComputer && hasComputer ? <aside className="cua-bot-computer" aria-label="Bot computer"><BotComputer key={selected.id + ':' + (chat?.id ?? 'profile')} embedded bot={selected} chatId={chat?.id} onClose={() => setShowComputer(false)}/></aside> : null}
            <aside className="cua-bot-profile spring-pane" data-open={showProfile || undefined} data-coucou-spring={profileMotion.driving || undefined} style={profileMotion.driving ? coucouPaneStyle(profileMotion.value) : undefined} inert={showProfile ? undefined : true} aria-hidden={showProfile ? undefined : true} aria-label={`${selected.name} profile`}>
              <div className="cua-profile-menu"><span>Bot details</span><details><summary aria-label="Bot actions"><Icon name="ellipsis" size={19}/></summary><div><button disabled={!!pending || chats.some(item => item.active)} onClick={() => setRemoving(selected)}>Remove bot profile…</button></div></details></div>
              <div className="cua-profile-identity"><button className="cua-edit-avatar" onClick={() => edit(selected)} aria-label={`Edit ${selected.name}’s look`}><CuaBotAvatar config={selected.avatarConfig} name={selected.name} size={96} mood={mood(selected)} messageSignal={botReplySignal(selected.id, sessions)}/><Icon name="pencil" size={23}/></button><h2>{selected.name}</h2><span className="cua-readiness" data-tone={readiness?.tone}>{readiness?.label}</span><p className="cua-profile-hint">{readiness?.detail}</p><Btn size="sm" icon="settings" onClick={() => edit(selected)}>Bot settings</Btn></div>
              <ProfileSection title="Profile defaults"><button className="cua-profile-row cua-profile-setting" onClick={() => edit(selected)}><strong>Provider</strong><span>{botProviderName(selected.provider)}</span><Icon name="chevron" size={12}/></button><button className="cua-profile-row cua-profile-setting" onClick={() => edit(selected)}><strong>Model</strong><span>{botConversationContext(selected, undefined, snapshot?.models).model}</span><Icon name="chevron" size={12}/></button><button className="cua-profile-row cua-profile-setting" onClick={() => edit(selected)}><strong>Effort</strong><span>{selected.effort || 'Provider default'}</span><Icon name="chevron" size={12}/></button><button className="cua-profile-row cua-profile-setting" onClick={() => edit(selected)}><strong>Approval mode</strong><span>{botPolicyLabel(selected.policy)}</span><Icon name="chevron" size={12}/></button><p className="cua-profile-note">Defaults for new conversations.</p></ProfileSection>
              <ProfileSection title="Shared work"><button className="cua-profile-row" onClick={() => setShowChatHistory(true)}><Icon name="clock" size={18}/><div><strong>Chat history</strong><small>{chats.length} shared {chats.length === 1 ? 'conversation' : 'conversations'}</small></div><Icon name="chevron" size={12}/></button><button className="cua-profile-row" onClick={() => navigate('bots', 'scheduled')}><Icon name="clock" size={18}/><div><strong>Routines</strong><small>Schedule work and review runs</small></div><Icon name="chevron" size={12}/></button></ProfileSection>
              <ProfileSection title="Connectors"><Btn icon="link" onClick={()=>navigate('connectors',undefined,{bot:selected.id})}>Manage connectors</Btn><p className="xs muted">Choose service accounts and tools for this bot.</p></ProfileSection><ProfileSection title="Computers"><button className="cua-profile-row" disabled={!hasComputer} onClick={toggleComputer}><Icon name="computer" size={18}/><div><strong>{hasComputer ? 'Isolated desktop' : 'Computer'}</strong><small>{hasComputer ? 'Isolated CUA desktop' : context.computerMode === 'host' ? 'Host tools' : 'Conversation settings unavailable'}</small></div><Icon name="chevron" size={13}/></button><div className="cua-profile-row"><Icon name="cpu" size={18}/><div><strong>Execution computer</strong><small>{context.computer}</small></div><button className="cua-link" onClick={() => edit(selected)}>Settings</button></div><div className="cua-profile-row"><Icon name="folder" size={18}/><div><strong>Workspace</strong><small>{context.workspace || 'Unavailable'}</small></div></div></ProfileSection>
              {selected.computerMode === 'cua' && snapshot?.hostFolderSupported ? <ProfileSection title="Shared host folder"><BotHostFolderSettings key={selected.id + ":" + selected.updatedAt} bot={selected} onSaved={() => void refresh()}/></ProfileSection> : null}
              <ProfileSection title="Activity">{selectedWork.routines.length ? selectedWork.routines.slice(0, 4).map(routine => <button className="cua-profile-row" key={routine.id} onClick={() => setRoutineFor({ bot: selected, routine })}><Icon name="clock" size={16}/><div><strong>{routine.title}</strong><small>{routineScheduleLabel(routine)}</small></div></button>) : <p className="cua-profile-note">Nothing yet. Ask {selected.name} for something, or schedule a routine.</p>}<button className="cua-profile-row cua-link" onClick={() => setRoutineFor({ bot: selected })}><Icon name="plus" size={15}/>Add routine</button></ProfileSection>
              <ProfileSection title="Outputs">{selectedWork.outputs.length ? selectedWork.outputs.slice(0, 6).map(output => <button key={output.path} className="cua-profile-row" onClick={() => setOutputFor({ bot: selected, output })}><Icon name="file" size={16}/><div><strong>{output.name}</strong><small>{relTime(output.modified)}</small></div><Icon name="chevron" size={12}/></button>) : <p className="cua-profile-note">Finished files land in this bot’s private outputs/ folder.</p>}</ProfileSection>
              <ProfileSection title="Customize"><button className="cua-profile-row" onClick={() => setMemoryFor(selected)}><Icon name="memory" size={18}/><strong>Memory</strong><span className="spacer"/><Icon name="chevron" size={12}/></button><button className="cua-profile-row" onClick={() => setRulesFor(selected)}><Icon name="shield" size={18}/><strong>Custom rules</strong><small>{selectedWork.rules.length} rules</small><Icon name="chevron" size={12}/></button><button className="cua-profile-row" disabled={!hasComputer} onClick={toggleComputer}><Icon name="link" size={18}/><div><strong>Website sign-in</strong><small>Take over the computer</small></div><Icon name="chevron" size={12}/></button><div className="cua-profile-row"><Icon name="models" size={18}/><div><strong>Model</strong><small>{context.model}</small></div></div><div className="cua-profile-row"><Icon name="shield" size={18}/><div><strong>Permissions</strong><small>{frozenPolicy ? botPolicyLabel(frozenPolicy) : 'Conversation permissions unavailable'}</small></div></div></ProfileSection>
            </aside>
          </div>
        </> : null}
      </section>
    </div>
    </div>
    <Dialog open={showChatHistory && !!selected} title="Chat history" className="cua-history-dialog" onClose={() => setShowChatHistory(false)} actions={<Btn onClick={() => setShowChatHistory(false)}>Done</Btn>}>
      <div className="cua-chat-history">{selected && chats.length ? chats.map(conversation => <button key={conversation.id} aria-label={`Open conversation ${sessionTitle(conversation)}`} onClick={() => { setShowChatHistory(false); openChat(selected, conversation); }}><Icon name="chat" size={19}/><span><strong>{sessionTitle(conversation)}</strong><small>{conversation.active ? 'Working' : Number.isFinite(Date.parse(conversation.updatedAt)) ? relTime(conversation.updatedAt) : 'Shared conversation'}</small></span><Icon name="chevron" size={13}/></button>) : <p className="small muted">New conversations with this bot will appear here.</p>}</div>
    </Dialog>
    <Dialog open={showRosterFilters} title="Find a conversation" compact onClose={() => setShowRosterFilters(false)} actions={<><Btn disabled={!rosterQuery && rosterFilter === 'all'} onClick={() => { setRosterQuery(''); setRosterFilter('all'); }}>Clear filters</Btn><Btn variant="primary" onClick={() => setShowRosterFilters(false)}>Done</Btn></>}><div className="form-stack"><label className="input-field"><span>Search bots</span><input className="st-input" type="search" aria-label="Search bots" placeholder="Search bots…" value={rosterQuery} onChange={event => setRosterQuery(event.target.value)}/></label><div className="input-field"><span>Activity</span><Select ariaLabel="Filter bots" value={rosterFilter} options={[{value:'all',label:'All conversations'},{value:'attention',label:'Needs attention'},{value:'working',label:'Working'}]} onChange={setRosterFilter}/></div><p className="small muted" role="status">{listedRoster.length} of {roster.length} conversations</p></div></Dialog>
    {newTeam?<BotTeamEditor bots={bots} computers={teams.data?.teamComputers} settingsSupported={teams.data?.teamSettingsSupported} instructionsSupported={teams.data?.teamInstructionsSupported} unrestrictedSupported={teams.data?.teamUnrestrictedSupported} continuousSupported={teams.data?.teamContinuousSupported} onClose={()=>{setNewTeam(false); if(location.query.get('new')==='room') navigate('bots','teams');}} onSaved={async team=>{const revision=navigationRevision.current,hash=window.location.hash;await teams.refresh();if(alive.current&&revision===navigationRevision.current&&hash===window.location.hash){setNewTeam(false);navigate('bots','teams',{team:team.id});}}}/>:null}
    <Dialog open={!!editing} title={editing ? `${editing.bot.name}’s settings` : 'Bot settings'} className="cua-settings-dialog" onClose={() => { if (!pending && !configBusy) setEditing(null); }} actions={<><Btn disabled={!!pending || configBusy} onClick={() => setEditing(null)}>Cancel</Btn><Btn variant="primary" disabled={!!pending || configBusy} onClick={() => { if (editing) void save(editing.draft, editing.bot); }}>{pending === 'save' ? 'Saving…' : 'Save settings'}</Btn></>}>
      {editing && snapshot ? <div className="form-stack"><label className="input-field"><span>Name</span><input className="st-input" maxLength={120} value={editing.draft.name} onChange={event => setEditing({ ...editing, draft: { ...editing.draft, name: event.target.value } })}/></label><details className="cua-edit-look"><summary><CuaBotAvatar config={editing.draft.avatarConfig} name={editing.draft.name} size={40}/>Edit look</summary><CuaBotAvatarPicker value={editing.draft.avatarConfig ?? defaultCuaBotAvatar(editing.draft.name)} name={editing.draft.name} shapes={snapshot?.avatarShapes} onChange={avatarConfig => setEditing({ ...editing, draft: { ...editing.draft, avatarConfig } })}/></details><CuaBotsConfig draft={editing.draft} snapshot={snapshot} apiKeySet={editing.bot.providerSettings?.apiKeySet} busy={!!pending} onBusyChange={setConfigBusy} onChange={patch => setEditing(current => current ? { ...current, draft: { ...current.draft, ...patch } } : null)}/><p className="xs muted">Profile changes apply to new conversations. Existing conversations keep their original settings.</p>{editorError ? <ErrorNotice message={editorError} action="Dismiss" onRetry={() => setEditorError('')}/> : null}</div> : null}
    </Dialog>
    <Dialog open={!!opening} title="New shared conversation" className="cua-settings-dialog" onClose={() => { if (!pending && !computerBusy) setOpening(null); }} actions={<><Btn disabled={!!pending || computerBusy} onClick={() => setOpening(null)}>Cancel</Btn><Btn variant="primary" disabled={!!pending || computerBusy || !opening?.workspace.trim()} onClick={() => void newChat()}>{pending === 'chat' ? 'Opening…' : 'Create conversation'}</Btn></>}>
      {opening && snapshot ? <div className="form-stack"><div className="cua-dialog-identity"><CuaBotAvatar config={opening.bot.avatarConfig} name={opening.bot.name} size={52}/><div><h3>{opening.bot.name}</h3><p className="small muted">Choose where this conversation works.</p></div></div><ComputerPicker execution={opening.execution} computers={snapshot.computers} disabled={!!pending} label="Conversation computer" onBusyChange={setComputerBusy} onChange={execution => setOpening(current => current ? { ...current, execution } : null)}/><p className="xs muted">{opening.bot.computerMode === 'cua' ? 'Tools work inside the selected host’s isolated CUA desktop.' : 'Tools work on the selected host.'}</p><label className="input-field"><span>Workspace</span><input className="st-input" disabled={opening.bot.computerMode === 'cua'} value={opening.workspace} onChange={event => setOpening({ ...opening, workspace: event.target.value })}/></label><div className="input-field"><span>Model for this conversation</span><Select value={opening.modelId} ariaLabel="Conversation model" options={[{ value: '', label: `Profile · ${botConversationContext(opening.bot, undefined, snapshot.models).model}` }, ...(snapshot.models ?? []).map(model => ({ value: model.id, label: `${model.connectionName} · ${model.name || model.model}`, disabled: !model.available }))]} onChange={modelId => setOpening({ ...opening, modelId })}/><small className="muted">Each saved model connection stays separate. This conversation keeps its selected model and computer.</small></div><BotPermissionPicker value={opening.policy} disabled={!!pending} onChange={policy => setOpening({ ...opening, policy })}/><p className="xs muted">This mode applies only to the new conversation. Existing chats keep their saved permissions.</p><p className="xs muted">Creating a conversation sends no prompt and starts no computer.</p>{chatError ? <ErrorNotice message={chatError} action="Dismiss" onRetry={() => setChatError('')}/> : null}</div> : null}
    </Dialog>
    <Dialog open={!!removing} title="Remove bot profile?" compact onClose={() => { if (!pending) setRemoving(null); }} actions={<><Btn disabled={!!pending} onClick={() => setRemoving(null)}>Keep bot</Btn><Btn variant="danger" disabled={!!pending} onClick={() => { if (removing) removeProfile(removing); }}>Remove profile</Btn></>}><p>Remove {removing?.name} from Bots?</p><p className="small muted">Shared conversations, memory and outputs stay on Strata. This does not delete the computer.</p></Dialog>
    {memoryFor ? <BotMemoryDialog key={memoryFor.id} bot={memoryFor} onClose={() => setMemoryFor(null)} onSaved={refreshWork}/> : null}
    {rulesFor ? <BotRulesDialog key={rulesFor.id} bot={rulesFor} onClose={() => setRulesFor(null)} onSaved={refreshWork}/> : null}
    {routineFor ? <BotRoutineDialog bots={bots} bot={routineFor.bot} routine={routineFor.routine} onClose={() => setRoutineFor(null)} onSaved={refreshWork}/> : null}
    {outputFor ? <BotOutputDialog bot={outputFor.bot} output={outputFor.output} onClose={() => setOutputFor(null)}/> : null}
  </Screen>;
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) { return <section className="cua-profile-section" aria-label={title}><h3>{title}</h3><div>{children}</div></section>; }
function newBotDraft(workspace: string): BotDraft { return { ...blankBot(workspace), computerMode: 'cua', workspace: '/workspace', avatarConfig: defaultCuaBotAvatar('') }; }
function draftFor(bot: Bot): BotDraft { return { name: bot.name, avatar: bot.avatar, avatarConfig: bot.avatarConfig ? { ...bot.avatarConfig } : defaultCuaBotAvatar(bot.name), computerMode: bot.computerMode ?? 'host', instructions: bot.instructions, provider: bot.provider, model: bot.model, effort: bot.effort, modelSource: bot.modelSource ? { ...bot.modelSource } : undefined, capabilities: bot.capabilities, policy: bot.policy, workspace: bot.workspace, execution: { ...bot.execution }, ...(bot.providerSettings?.baseURL ? { providerSettings: { baseURL: bot.providerSettings.baseURL } } : {}) }; }
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
