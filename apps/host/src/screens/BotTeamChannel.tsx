import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/client';
import { botActivityLabel, botTeamRunActive, mergeBotTeamChannelMessages, type Bot, type BotTeam, type BotTeamChannelMessage, type BotTeamChannelSnapshot, type BotTeamPresence, type BotTeamRun } from '../lib/bots';
import { useStore } from '../lib/store';
import type { Session } from '../lib/types';
import { CuaBotAvatar } from '../components/CuaBotAvatar';
import { Markdown } from '../components/Markdown';
import { Btn, Dialog, ErrorNotice, Icon } from '../components/ui';
import './BotTeamChannel.css';
import { NotificationMuteButton } from '../components/BotNotifications';
import { useNotificationDestination } from '../lib/notifications';
import { currentLanguage } from '../lib/i18n';
import { durableTeamIntakeMatches } from './botTeamPlanState';

const messageError = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const roomPath = (teamId: string) => `/api/bots/teams/${encodeURIComponent(teamId)}`;
// Draft keystrokes and unchanged status checks do not reparse saved reports.
// Language is an explicit key below so translated Markdown controls stay fresh.
const ChannelMarkdown = memo(Markdown);

/** A room's polling never creates a chat, resumes a bot or executes a tool. */
function useTeamChannel(teamId: string, visible: boolean, onUnsupported: () => void, live = false) {
  const [messages, setMessages] = useState<BotTeamChannelMessage[]>([]), [activeRuns, setActiveRuns] = useState<BotTeamRun[]>([]), [presence, setPresence] = useState<BotTeamPresence[]>([]);
  const [loading, setLoading] = useState(true), [loadingEarlier, setLoadingEarlier] = useState(false), [error, setError] = useState(''), [hasEarlier, setHasEarlier] = useState(false);
  const cached = useRef<BotTeamChannelMessage[]>([]);
  const alive = useRef(false), generation = useRef(0), pending = useRef(false), earlierPending = useRef(false), cursor = useRef<number | null>(null), first = useRef(0), unsupported = useRef(onUnsupported);
  unsupported.current = onUnsupported;
  const accept = useCallback((snapshot: BotTeamChannelSnapshot, older = false) => {
    if (snapshot.teamId !== teamId || snapshot.supported !== true || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.activeRuns) || !Number.isSafeInteger(snapshot.nextSequence) || snapshot.nextSequence < 0 || snapshot.messages.some(row => row.teamId !== teamId || !Number.isSafeInteger(row.sequence) || row.sequence < 1)) throw new Error('The team channel response did not match this team.');
    if (snapshot.messages.some((row, index) => index > 0 && row.sequence <= snapshot.messages[index - 1].sequence) || snapshot.messages.length && snapshot.nextSequence !== snapshot.messages.at(-1)!.sequence) throw new Error('The team channel returned an invalid message order. Refresh before sending.');
    const merged = snapshot.messages.length ? mergeBotTeamChannelMessages(cached.current, snapshot.messages, teamId) : cached.current;
    const highest = Math.max(0, ...snapshot.messages.map(row => row.teamId === teamId ? row.sequence : 0));
    cursor.current = Math.max(cursor.current ?? 0, highest, older ? 0 : snapshot.nextSequence);
    const lowest = Math.min(...snapshot.messages.filter(row => row.teamId === teamId).map(row => row.sequence));
    if (Number.isFinite(lowest)) first.current = first.current ? Math.min(first.current, lowest) : lowest;
    cached.current = merged; setMessages(merged);
    if (!older) setActiveRuns(previous => JSON.stringify(previous) === JSON.stringify(snapshot.activeRuns) ? previous : snapshot.activeRuns);
    if (!older && Array.isArray(snapshot.presence)) setPresence(snapshot.presence.filter(row => !!row && typeof row.botId === 'string' && (row.state === 'working' || row.state === 'queued') && typeof row.runId === 'string' && typeof row.jobId === 'string'));
    if (older || first.current === lowest) setHasEarlier(!!snapshot.hasMoreBefore);
    setError(''); setLoading(false);
  }, [teamId]);
  const refresh = useCallback(async () => {
    if (!alive.current || pending.current) return;
    const selected = generation.current; pending.current = true;
    try {
      // A newly opened room starts at its latest page. Subsequent polls drain forward.
      for (let page = 0; page < 10; page++) {
        const previousCursor = cursor.current;
        const snapshot = await api.get<BotTeamChannelSnapshot>(`${roomPath(teamId)}/channel${previousCursor === null ? '' : `?after=${previousCursor}`}`);
        if (!alive.current || selected !== generation.current) return;
        if (snapshot.supported === false) { unsupported.current(); return; }
        accept(snapshot);
        if (!snapshot.hasMore || cursor.current === previousCursor) break;
      }
    } catch (cause) {
      if (alive.current && selected === generation.current) {
        if (cursor.current === null && cause instanceof ApiError && [404, 405, 501].includes(cause.status)) unsupported.current();
        else { setError(messageError(cause)); setLoading(false); }
      }
    } finally { if (alive.current && selected === generation.current) pending.current = false; }
  }, [teamId, accept]);
  const loadEarlier = useCallback(async () => {
    if (!alive.current || earlierPending.current || !first.current) return;
    const selected = generation.current; earlierPending.current = true; setLoadingEarlier(true);
    try {
      const snapshot = await api.get<BotTeamChannelSnapshot>(`${roomPath(teamId)}/channel?before=${first.current}`);
      if (alive.current && selected === generation.current) { accept(snapshot, true); return true; }
    } catch (cause) { if (alive.current && selected === generation.current) setError(messageError(cause)); return false; }
    finally { if (alive.current && selected === generation.current) { earlierPending.current = false; setLoadingEarlier(false); } }
  }, [teamId, accept]);
  useEffect(() => {
    alive.current = true; generation.current++;
    return () => { alive.current = false; generation.current++; };
  }, [teamId]);
  useEffect(() => {
    if (!visible) return;
    const check = () => { if (!document.hidden) void refresh(); };
    check(); const timer = setInterval(check, live ? 15000 : 2500);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [visible, refresh, live]);
  const acceptPosted = useCallback((snapshot: BotTeamChannelSnapshot) => {
    generation.current++; pending.current = false; earlierPending.current = false; setLoadingEarlier(false);
    const previousCursor = cursor.current; accept(snapshot);
    // A POST returns the latest page; drain a missed interval before advancing past it.
    if (previousCursor !== null && snapshot.messages[0]?.sequence > previousCursor + 1) cursor.current = previousCursor;
  }, [accept]);
  return { messages, activeRuns, presence, loading, error, hasEarlier, loadingEarlier, accept: acceptPosted, refresh, loadEarlier };
}

type RoomDraft = { messageId: string; botId: string; seq: number; text: string };

/** Live reply text for this room. A saved message with the same id replaces the draft. */
function useRoomDrafts(teamId: string) {
  const [drafts, setDrafts] = useState<RoomDraft[]>([]);
  useEffect(() => { setDrafts([]); }, [teamId]);
  useEffect(() => {
    const onPartial = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!detail || detail.teamId !== teamId) return;
      const { messageId, botId, seq, text, done } = detail;
      if (typeof messageId !== 'string' || typeof botId !== 'string' || typeof seq !== 'number' || typeof text !== 'string') return;
      setDrafts(current => {
        if (done === true && text === '') return current.filter(row => row.messageId !== messageId);
        const previous = current.find(row => row.messageId === messageId);
        if (previous && previous.seq >= seq) return current;
        return [...current.filter(row => row.messageId !== messageId), { messageId, botId, seq, text }];
      });
    };
    window.addEventListener('strata:message-partial', onPartial);
    return () => window.removeEventListener('strata:message-partial', onPartial);
  }, [teamId]);
  return drafts;
}

export function BotTeamChannel({ team, bots, visible, current, coordinatorWorkToolsSupported = false, workPlansSupported = false, onUnsupported, onOpenConversation, onStateChange, onDetails, onShowWork }: {
  team: BotTeam; bots: Bot[]; visible: boolean; current: boolean; continuousSupported?: boolean; coordinatorWorkToolsSupported?: boolean; workPlansSupported?: boolean; onUnsupported: () => void;
  onOpenConversation: (chatId: string, conversation?: Session) => Promise<void>; onStateChange: () => Promise<void>; onDetails: () => void; onShowWork: () => void;
}) {
  const connection = useStore(state => state.connection);
  const channel = useTeamChannel(team.id, visible, onUnsupported, connection === 'live');
  const drafts = useRoomDrafts(team.id);
  const liveDrafts = drafts.filter(row => row.text && !channel.messages.some(message => message.id === row.messageId));
  useEffect(() => {
    const onRoom = (event: Event) => {
      const detail = (event as CustomEvent<{ teamId?: string }>).detail;
      if (detail?.teamId === team.id) void channel.refresh();
    };
    window.addEventListener('strata:team-channel', onRoom);
    return () => window.removeEventListener('strata:team-channel', onRoom);
  }, [team.id, channel.refresh]);
  useNotificationDestination({ type: 'team', id: team.id }, visible);
  const [workMode, setWorkMode] = useState<'chat' | 'work'>('chat');
  const [prompt, setPrompt] = useState(''), [recipients, setRecipients] = useState<string[]>([]), [picker, setPicker] = useState(false), [replyTo, setReplyTo] = useState<BotTeamChannelMessage | null>(null);
  const [actions, setActions] = useState(false), [sending, setSending] = useState(false), [stopping, setStopping] = useState(''), [error, setError] = useState(''), [unread, setUnread] = useState(0), [away, setAway] = useState(false);
  const requestId = useRef<string | null>(null), mounted = useRef(true), sendingRef = useRef(false), feed = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null), follow = useRef(true), previousLast = useRef(0), olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const members = team.memberIds.map(id => bots.find(bot => bot.id === id)).filter((bot): bot is Bot => !!bot);
  const active = channel.activeRuns.filter(run => botTeamRunActive(run.state));
  const ready = current && !channel.error && !channel.loading;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!visible) { setPicker(false); setActions(false); } }, [visible]);
  useEffect(() => {
    if (!visible || !team.enabled) return undefined;
    const typing = prompt.trim().length > 0 && !sending;
    const handle = setTimeout(() => { void api.post(`${roomPath(team.id)}/typing`, { typing }).catch(() => {}); }, 250);
    return () => clearTimeout(handle);
  }, [prompt, sending, visible, team.id, team.enabled]);
  useEffect(() => { if (!coordinatorWorkToolsSupported) { setWorkMode('chat'); requestId.current = null; } }, [coordinatorWorkToolsSupported]);
  useLayoutEffect(() => { const element = composer.current; if (element) { element.style.height = 'auto'; element.style.height = `${Math.min(160, element.scrollHeight)}px`; } }, [prompt]);
  useEffect(() => {
    const element = feed.current; if (!element || !visible) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) element.scrollTop = element.scrollHeight;
      setAway(element.scrollHeight - element.scrollTop - element.clientHeight >= 80);
    });
    observer.observe(element); return () => observer.disconnect();
  }, [visible]);
  useLayoutEffect(() => {
    const element = feed.current; if (!element || !visible) return;
    if (olderAnchor.current) { const anchor = olderAnchor.current; element.scrollTop = anchor.top + element.scrollHeight - anchor.height; olderAnchor.current = null; }
    else if (follow.current) { element.scrollTop = element.scrollHeight; setUnread(0); }
    else {
      const arrived = channel.messages.filter(row => row.sequence > previousLast.current).length;
      if (arrived && previousLast.current) setUnread(value => value + arrived);
    }
    previousLast.current = channel.messages.at(-1)?.sequence ?? previousLast.current;
  }, [channel.messages, visible]);
  function jumpToLatest() { follow.current = true; setAway(false); setUnread(0); if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }
  function changeRecipients(next: string[]) { setRecipients(next); requestId.current = null; }
  function reply(message: BotTeamChannelMessage) {
    setReplyTo(message); requestId.current = null;
    changeRecipients(message.author.botId && team.memberIds.includes(message.author.botId) ? [message.author.botId] : []);
    composer.current?.focus();
  }
  async function send() {
    if (sendingRef.current || !ready || !team.enabled || !prompt.trim()) return;
    sendingRef.current = true; setSending(true); setError(''); requestId.current ??= crypto.randomUUID();
    const addressedEveryone = recipients.length > 0 && recipients.length === team.memberIds.length && team.memberIds.every(id => recipients.includes(id));
    const body = { message: prompt.trim(), requestId: requestId.current, ...(recipients.length ? { recipientIds: recipients } : {}), ...(addressedEveryone ? { everyone: true } : {}), ...(replyTo ? { replyToId: replyTo.id } : {}), ...(coordinatorWorkToolsSupported ? { workMode } : {}), ...(workMode === 'work' && coordinatorWorkToolsSupported && workPlansSupported ? { durablePlan: true } : {}) };
    try {
      const result = await api.post<{ channel: BotTeamChannelSnapshot; run?: BotTeamRun; planId?: string; sourceMessageId?: string; sourceMessage?: BotTeamChannelMessage }>(`${roomPath(team.id)}/messages`, body);
      if (!mounted.current) return;
      if (body.durablePlan && !durableTeamIntakeMatches(result,team.id,body)) throw Error('Strata did not confirm this exact Work plan. Your draft is retained. Refresh the room to inspect its saved state before trying again.');
      olderAnchor.current = null; follow.current = true; channel.accept(result.channel); setPrompt(''); setWorkMode('chat'); setReplyTo(null); setRecipients([]); requestId.current = null; setPicker(false); setUnread(0);
      // Execution remains in the shared room. Work details open only on an explicit click.
      await Promise.allSettled([channel.refresh(), onStateChange()]);
    } catch (cause) { if (mounted.current) setError(messageError(cause)); }
    finally { sendingRef.current = false; if (mounted.current) setSending(false); }
  }
  async function stop(run: BotTeamRun) {
    if (stopping) return; setStopping(run.id); setError('');
    try { await api.post(`${roomPath(team.id)}/runs/${encodeURIComponent(run.id)}/stop`, {}); if (mounted.current) await Promise.allSettled([channel.refresh(), onStateChange()]); }
    catch (cause) { if (mounted.current) setError(messageError(cause)); }
    finally { if (mounted.current) setStopping(''); }
  }
  const recipientLabel = recipients.length === team.memberIds.length ? 'Everyone' : recipients.length ? recipients.map(id => bots.find(bot => bot.id === id)?.name ?? 'Unavailable teammate').join(', ') : 'Team';
  return <div className="bot-room" hidden={!visible} aria-label={`${team.name} channel`}>
    {channel.error ? <ErrorNotice message={channel.error} next="Showing saved messages. Refresh to verify current team work before sending." action="Refresh channel" onRetry={() => void channel.refresh()}/> : null}
    <div className="bot-room-feed" ref={feed} role="region" aria-label="Team conversation" tabIndex={0} onScroll={() => { const element = feed.current; if (element) { follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; setAway(!follow.current); if (follow.current) setUnread(0); } }}>
      {channel.loading ? <p role="status" className="bot-room-loading">Opening the team channel…</p> : null}
      {channel.hasEarlier ? <div className="bot-room-earlier"><Btn size="sm" disabled={channel.loadingEarlier} onClick={() => { if (feed.current) olderAnchor.current = { height: feed.current.scrollHeight, top: feed.current.scrollTop }; void channel.loadEarlier().then(ok => { if (!ok) olderAnchor.current = null; }); }}>{channel.loadingEarlier ? 'Loading earlier…' : 'Load earlier messages'}</Btn></div> : null}
      {!channel.loading && !channel.messages.length && !channel.error ? <div className="bot-room-welcome"><div className="bot-room-welcome-faces">{members.slice(0, 4).map(bot => <CuaBotAvatar key={bot.id} name={bot.name} config={bot.avatarConfig} size={56}/>)}</div><h3>Your team, together</h3><p>Say hello, share an idea, or give the team something to work on. Everyone can join the conversation; {bots.find(bot => bot.id === team.coordinatorId)?.name ?? 'your coordinator'} organizes the work.</p><div><button type="button" disabled={!ready || !team.enabled} onClick={() => { setWorkMode('chat'); setPrompt('Hi everyone!'); changeRecipients([...team.memberIds]); composer.current?.focus(); }}>Say hi to everyone</button><button type="button" disabled={!ready || !team.enabled} onClick={() => { setPrompt('Who wants to help with '); changeRecipients([]); composer.current?.focus(); }}>Find the right teammate</button></div></div> : null}
      {channel.messages.map(message => <TeamChannelMessage key={message.id} message={message} team={team} bots={bots} messages={channel.messages} disabled={sending} onReply={() => reply(message)} onOpenConversation={chatId => void onOpenConversation(chatId).catch(cause => { if (mounted.current) setError(messageError(cause)); })}/>)}
      {liveDrafts.map(draft => {
        const bot = bots.find(item => item.id === draft.botId), name = bot?.name ?? 'A teammate';
        return <article key={draft.messageId} className="bot-room-message bot-room-draft" data-author="bot" aria-live="polite" aria-busy="true" aria-label={`${name} is replying`}>
          <div className="bot-room-message-face">{bot ? <CuaBotAvatar name={name} config={bot.avatarConfig} size={38}/> : <span className="bot-room-person" aria-hidden="true"><Icon name="experts" size={17}/></span>}</div>
          <div className="bot-room-message-main"><header><strong>{name}</strong></header><div className="bot-room-message-bubble"><div className="bot-room-message-body">{draft.text}</div></div></div>
        </article>;
      })}
      {channel.presence.filter(row => row.state === 'working' && !liveDrafts.some(draft => draft.botId === row.botId)).map(row => <div className="bot-room-working" key={row.jobId}><span className="bot-room-working-dot" aria-hidden="true"/><span>{bots.find(bot => bot.id === row.botId)?.name ?? 'A teammate'} is working…</span></div>)}
      {active.map(run => { const limited = !Object.values(run.limits).every(value => value === 0); return <div className="bot-room-working" key={run.id}><span className="bot-room-working-dot" aria-hidden="true"/><span><strong>{botActivityLabel(run.state)}</strong><small>{limited ? 'Working with the team' : 'Until finished or stopped'}</small></span><Btn size="sm" variant="danger" disabled={!!stopping || run.state === 'stopping'} onClick={() => void stop(run)}>{stopping === run.id ? 'Stopping…' : run.state === 'cleanup_pending' ? 'Retry Stop' : 'Stop team'}</Btn></div>; })}
    </div>
    {unread || away ? <div className="bot-room-new"><button type="button" onClick={jumpToLatest}>{unread ? `${unread} new ${unread === 1 ? 'message' : 'messages'} · ` : ''}Latest <Icon name="chevron" size={14}/></button></div> : null}
    {error ? <ErrorNotice message={error} action="Dismiss" onRetry={() => setError('')}/> : null}
    <form className="bot-room-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      {replyTo ? <div className="bot-room-replying"><Icon name="chat" size={14}/><span>Replying to <strong>{replyTo.author.name}</strong><small>{replyTo.content.slice(0, 150)}</small></span><Btn size="sm" variant="ghost" aria-label="Cancel reply" disabled={sending} onClick={() => { setReplyTo(null); requestId.current = null; }}>Cancel</Btn></div> : null}
      <div className="bot-room-composer-top"><button className="bot-room-to" type="button" aria-expanded={picker} aria-controls={`team-recipients-${team.id}`} disabled={sending} onClick={() => setPicker(value => !value)}><Icon name="experts" size={14}/><span>To: <strong>{recipientLabel}</strong></span><Icon name="chevron" size={12}/></button><span className="bot-room-device-note">Shared on Mac and iPhone</span></div>
      {coordinatorWorkToolsSupported ? <div className="bot-room-work-mode"><div role="group" aria-label="Team message mode">{(['chat', 'work'] as const).map(mode => <button key={mode} type="button" aria-pressed={workMode === mode} disabled={sending} onClick={() => { setWorkMode(mode); requestId.current = null; }}>{mode === 'chat' ? 'Chat' : 'Work'}</button>)}</div><p>{workMode === 'work' ? (workPlansSupported ? 'Your coordinator plans tasks, chooses teammates and follows their saved checkpoints through review.' : 'Coordinator and teammates can use their saved tools, approvals and selected team computer/folder.') : 'Talk with the team. Your coordinator can bring in teammates.'}</p></div> : null}
      {picker ? <fieldset className="bot-room-recipient-picker" disabled={sending} id={`team-recipients-${team.id}`}><legend>Who should respond?</legend><div><button type="button" aria-pressed={!recipients.length} onClick={() => changeRecipients([])}>Let the team decide</button><button type="button" aria-pressed={recipients.length === team.memberIds.length} onClick={() => changeRecipients([...team.memberIds])}>@everyone</button></div>{members.map(bot => <label key={bot.id}><input type="checkbox" checked={recipients.includes(bot.id)} onChange={() => changeRecipients(recipients.includes(bot.id) ? recipients.filter(id => id !== bot.id) : [...recipients, bot.id])}/><CuaBotAvatar name={bot.name} config={bot.avatarConfig} size={24}/><span>{bot.name}{bot.paused ? ' · Paused' : ''}</span></label>)}</fieldset> : null}
      <div className="bot-room-composer-row"><button type="button" className="bot-room-add" aria-label="Team actions" aria-haspopup="dialog" disabled={sending} onClick={() => setActions(true)}><Icon name="plus" size={22}/></button><div className="bot-room-input-pill"><label className="bot-room-input"><span className="sr-only">Message team</span><textarea ref={composer} rows={1} maxLength={16000} aria-label="Message team" value={prompt} disabled={sending} onChange={event => { setPrompt(event.target.value); requestId.current = null; }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void send(); } }} placeholder={team.enabled ? `Message ${team.name}…` : 'Collaboration is turned off'}/></label><button className="bot-room-send" type="submit" aria-label={sending ? 'Sending…' : 'Send'} disabled={sending || !team.enabled || !prompt.trim() || !ready}><Icon name="send" size={19}/></button></div></div>
      <div className="bot-room-composer-bottom"><p>{!team.enabled ? 'Turn on collaboration in Team settings to send.' : active.length ? 'Your team is working. You can keep the conversation going.' : recipients.length ? 'Selected teammates respond using their own models and permissions.' : 'Your coordinator brings in the right teammates.'}</p></div>
    </form>
    {actions ? <Dialog open title="Team actions" compact className="bot-room-actions-dialog" onClose={() => setActions(false)} actions={<Btn onClick={() => setActions(false)}>Done</Btn>}><div className="bot-room-action-list"><NotificationMuteButton destination={{ type: 'team', id: team.id }}/><Btn icon="experts" onClick={() => { setActions(false); setPicker(true); }}>Choose teammates</Btn><Btn icon="chat" disabled={!ready || !team.enabled} onClick={() => { setActions(false); setWorkMode('chat'); setPrompt('Hi everyone!'); changeRecipients([...team.memberIds]); }}>Draft a greeting to everyone</Btn><Btn icon="info" onClick={() => { setActions(false); onDetails(); }}>Team details</Btn><Btn icon="activity" onClick={() => { setActions(false); onShowWork(); }}>View team work</Btn></div><p className="small muted">Drafting a message starts no work. Send it when you are ready.</p></Dialog> : null}
  </div>;
}

function TeamChannelMessage({ message, team, bots, messages, disabled, onReply, onOpenConversation }: { message: BotTeamChannelMessage; team: BotTeam; bots: Bot[]; messages: BotTeamChannelMessage[]; disabled: boolean; onReply: () => void; onOpenConversation: (id: string) => void }) {
  const author = message.author, bot = bots.find(item => item.id === author.botId), replying = messages.find(item => item.id === message.replyToId);
  const implicitRootReply = !!message.runId && replying?.author.type === 'user' && replying.runId === message.runId;
  const addressedEveryone = !!team.memberIds.length && message.recipientIds?.length === team.memberIds.length && team.memberIds.every(id => message.recipientIds?.includes(id));
  const kind = author.type === 'user' && message.workMode === 'work' ? 'Work request' : message.kind === 'assignment' ? 'Assignment' : message.kind === 'report' ? 'Report' : message.kind === 'status' ? 'Team update' : '';
  const folded = message.kind === 'assignment' || message.kind === 'report' && message.content.length > 1800;
  const preview = message.content.split('\n').find(line => line.trim())?.slice(0, 140) ?? '';
  const date = new Date(message.createdAt), validDate = Number.isFinite(date.getTime());
  return <article className="bot-room-message" data-kind={message.kind} data-author={author.type} data-message-id={message.id} aria-label={`${author.name}${kind ? ` · ${kind}` : ''}`}>
    <div className="bot-room-message-face">{author.type === 'bot' ? <CuaBotAvatar name={author.name} config={author.avatarConfig ?? bot?.avatarConfig} size={38}/> : <span className="bot-room-person" aria-hidden="true">{author.type === 'user' ? <Icon name="chat" size={17}/> : <Icon name="experts" size={17}/>}</span>}</div>
    <div className="bot-room-message-main"><header><strong>{author.name}</strong>{author.botId === team.coordinatorId ? <span className="bot-room-role">Coordinator</span> : null}{kind ? <span className="bot-room-kind">{kind}</span> : null}{validDate ? <time dateTime={message.createdAt} title={date.toLocaleString()}>{date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time> : null}</header>
      <div className="bot-room-message-bubble">{message.recipientIds?.length && !addressedEveryone ? <p className="bot-room-addressed">To {message.recipientIds.map(id => bots.find(item => item.id === id)?.name ?? 'Former teammate').join(', ')}</p> : null}
      {message.replyToId && !implicitRootReply ? <blockquote className="bot-room-reply-context"><strong>{replying?.author.name ?? 'Earlier message'}</strong><span>Related message</span></blockquote> : null}
      <div className="bot-room-message-body">{folded ? <details className="bot-room-message-disclosure"><summary><strong>{message.kind === 'assignment' ? 'Task assignment' : 'Read full report'}</strong><span>{preview}</span></summary><ChannelMarkdown key={currentLanguage()} text={message.content}/></details> : <ChannelMarkdown key={currentLanguage()} text={message.content}/>}</div>
      <footer><button type="button" disabled={disabled} onClick={onReply}>Reply<span className="sr-only"> to {author.name}</span></button>{message.chatId ? <button type="button" onClick={() => onOpenConversation(message.chatId!)}><Icon name="activity" size={12}/>Thinking & tools</button> : null}{message.state && ['error', 'interrupted', 'cancelled'].includes(message.state) ? <span>{botActivityLabel(message.state)}</span> : null}</footer></div>
    </div>
  </article>;
}
