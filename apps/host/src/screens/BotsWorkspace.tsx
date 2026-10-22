import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/client';
import { navigate } from '../lib/router';
import { relTime } from '../lib/format';
import { botActivityLabel, botTaskWorkLabel, botTeamRunActive, botTeamWorkLabel, botTeamWorkplace, type Bot, type BotTeam, type BotTeamActivity, type BotTeamActivitySnapshot, type BotTeamRun, type BotTeamsSnapshot } from '../lib/bots';
import type { Session } from '../lib/types';
import { CuaBotAvatar } from '../components/CuaBotAvatar';
import { BotComputer } from '../components/BotComputer';
import { BotTeamChannel } from './BotTeamChannel';
import { Btn, Dialog, Empty, ErrorNotice, Icon, IconBtn } from '../components/ui';
import { BotTeamEditor, type TeamEditorSection } from './BotTeamEditor';
import { BotSupervision, type BotSupervisionSnapshot } from '../components/BotSupervision';
import { BotHarnessActions } from './BotHarnessActions';
import { BotTaskReview } from './BotTaskReview';
import { BotTeamWorkOverview, TeamWorkCounts } from './BotTeamWorkOverview';
import { teamWorkGroups } from './botTeamWorkSelectors';
import { BotTeamWorkflow, useTeamWorkflows } from './BotTeamWorkflow';
import { teamWorkflowCounts, workflowActive } from './botTeamWorkflowState';
import { BotTeamPlans, useTeamPlans } from './BotTeamPlans';
import { planActive } from './botTeamPlanState';
export { BotTeamEditor } from './BotTeamEditor';

/** Old data stays visible after a failed poll and is explicitly marked stale. */
export function useBotsResource<T>(path: string | null, interval = 5000, resetKey?: string) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const generation = useRef(0), alive = useRef(true), inFlight = useRef(false), checkedAt = useRef<string | undefined>(undefined), signature = useRef('');
  const refresh = useCallback(async (force = true) => {
    if (!path || inFlight.current && !force) return;
    const request = ++generation.current; inFlight.current = true;
    try { const result = await api.get<T>(path); if (alive.current && request === generation.current) { const next = JSON.stringify(result); if (signature.current !== next) { signature.current = next; setData(result); } setError(''); checkedAt.current = new Date().toISOString(); } }
    catch (cause) { if (alive.current && request === generation.current) setError(errorMessage(cause)); }
    finally { if (alive.current && request === generation.current) { setLoading(false); inFlight.current = false; } }
  }, [path, resetKey]);
  useEffect(() => {
    alive.current = true; generation.current++; inFlight.current = false; signature.current = ''; checkedAt.current = undefined; setData(null); setError(''); setLoading(!!path);
    void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(false); }, interval);
    return () => { alive.current = false; generation.current++; inFlight.current = false; clearInterval(timer); };
  }, [refresh, interval]);
  return { data, error, loading, checkedAt: checkedAt.current, refresh };
}
export function ResourceNotice({ error, loading, checkedAt, onRefresh, children }: { error: string; loading: boolean; checkedAt?: string; onRefresh: () => void; children?: ReactNode }) {
  return <>{error ? <ErrorNotice message={error} next={checkedAt ? `Showing the last successful check from ${new Date(checkedAt).toLocaleTimeString()}. Work may still be running.` : 'Current state could not be verified.'} action="Retry" onRetry={onRefresh}/> : null}{loading ? <p role="status" className="small muted">Loading current state…</p> : children}</>;
}
export function TeamMark({ team, bots, size = 28 }: { team: Pick<BotTeam, 'memberIds'>; bots: Bot[]; size?: number }) {
  return <span className="bot-team-mark" aria-hidden="true">{team.memberIds.slice(0, 3).map(id => { const bot = bots.find(item => item.id === id); return <CuaBotAvatar key={id} name={bot?.name ?? 'Bot'} config={bot?.avatarConfig} size={size}/>; })}</span>;
}

export function BotTeamPanel({ bots, resource, teamId, onSelect, onOpenConversation, onNewTeam, onNewBot }: { bots: Bot[]; resource: ReturnType<typeof useBotsResource<BotTeamsSnapshot>>; teamId?: string; onSelect: (id: string) => void; onOpenConversation: (chatId: string, conversation?: Session) => Promise<void>; onNewTeam: () => void; onNewBot: () => void }) {
  const team = resource.data?.teams.find(item => item.id === teamId), runs = (resource.data?.runs ?? []).filter(run => run.teamId === teamId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [editing, setEditing] = useState(false), [editorSection, setEditorSection] = useState<TeamEditorSection>('general'), [details, setDetails] = useState(false), [channelSupported, setChannelSupported] = useState(true), [tab, setTab] = useState<'channel'|'work'>('channel'), [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const requestId = useRef<string | null>(null), revision = useRef(0), mounted = useRef(true);
  useEffect(() => { revision.current++; setPrompt(''); requestId.current = null; setError(''); setEditing(false); setDetails(false); setChannelSupported(true); setTab('channel'); }, [teamId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  const active = runs.find(run => botTeamRunActive(run.state)), current = !resource.error && !resource.loading;
  const tasks = useBotsResource<BotTeamActivitySnapshot>(team && resource.data?.teamWorkReviewSupported === true ? '/api/bots/activity' : null, 5000, team?.id);
  const taskGroups = teamWorkGroups(tasks.data?.activity ?? [], team?.id ?? '');
  const workflowsSupported = !!team && channelSupported && resource.data?.teamWorkflowsSupported === true;
  const workflows = useTeamWorkflows(team?.id, workflowsSupported);
  const workflowRows = workflows.snapshot?.workflows.filter(row => row.teamId === team?.id) ?? [];
  const observeWorkflow = workflowsSupported && workflowRows.some(row => workflowActive(row.phase) && row.steps.at(-1)?.chatId);
  const workflowActivity = useBotsResource<BotSupervisionSnapshot>(observeWorkflow ? '/api/bots/supervision' : null, 5000, team?.id);
  const workflowSessions = Array.isArray(workflowActivity.data?.sessions) ? workflowActivity.data.sessions.filter(row => row.teamId === team?.id && typeof row.id === 'string' && typeof row.botId === 'string' && ['approval','error','working','thinking','completed'].includes(row.state) && Number.isSafeInteger(row.approvalCount) && row.approvalCount >= 0 && (row.toolName === undefined || typeof row.toolName === 'string')) : [];
  const workflowStale = workflowsSupported && (workflows.stale || observeWorkflow && (!!workflowActivity.error || workflowActivity.loading));
  const plansSupported = !!team && resource.data?.teamWorkPlansSupported === true;
  const plans = useTeamPlans(team?.id, plansSupported);
  const planRows = plans.snapshot?.plans ?? [];
  const planCounts = { needsYou: planRows.filter(row => ['awaiting_review','blocked','interrupted'].includes(row.phase) || row.counts.blocked > 0).length, working: planRows.filter(row => planActive(row.phase) && !['awaiting_review','blocked','interrupted'].includes(row.phase) && !row.counts.blocked).length };
  const oldWorkflowCounts = workflowsSupported ? { ...teamWorkflowCounts(workflowRows, workflowSessions), partial: workflows.snapshot?.hasMore === true, unknown: workflows.scope !== team?.id || workflows.unsupported || !workflows.snapshot?.available || !!workflows.error } : undefined;
  const workflowCounts = plansSupported ? { needsYou: (oldWorkflowCounts?.needsYou ?? 0) + planCounts.needsYou, working: (oldWorkflowCounts?.working ?? 0) + planCounts.working, partial: !!oldWorkflowCounts?.partial || !!plans.snapshot?.hasMore, unknown: !!oldWorkflowCounts?.unknown || plans.stale || !plans.snapshot, statusLabel: 'Work plan status unavailable' } : oldWorkflowCounts;
  const workplace = team ? botTeamWorkplace(team, resource.data?.teamComputers, bots) : null;
  const execution = team?.execution;
  const sharedComputer = execution?.mode === 'shared' ? resource.data?.teamComputers?.find(item => item.id === execution.computerId) : undefined;
  const computerOwner = sharedComputer?.computerMode === 'cua' ? bots.find(bot => bot.id === sharedComputer.memberId) : undefined;
  const [computerOpen, setComputerOpen] = useState(false);
  useEffect(() => { setComputerOpen(false); }, [teamId, sharedComputer?.id]);
  function editSettings(section: TeamEditorSection) { setDetails(false); setEditorSection(section); setEditing(true); }
  async function start() {
    if (!team || busy || !prompt.trim() || !team.enabled || active || !current) return;
    const selected = revision.current; requestId.current ??= crypto.randomUUID(); setBusy('start'); setError('');
    try { const result = await api.post<{run: BotTeamRun; conversation: Session}>(`/api/bots/teams/${encodeURIComponent(team.id)}/runs`, { message: prompt.trim(), requestId: requestId.current }); await resource.refresh(); if (mounted.current && selected === revision.current) { setPrompt(''); requestId.current = null; await onOpenConversation(result.run.rootChatId, result.conversation); } }
    catch (cause) { if (mounted.current && selected === revision.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setBusy(''); }
  }
  async function stop(run: BotTeamRun) {
    if (busy) return; const selected = revision.current; setBusy(run.id); setError('');
    try { await api.post(`/api/bots/teams/${encodeURIComponent(run.teamId)}/runs/${encodeURIComponent(run.id)}/stop`, {}); await resource.refresh(); }
    catch (cause) { if (mounted.current && selected === revision.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setBusy(''); }
  }
  return <section className={`bots-workspace-page${team && channelSupported ? ' bots-team-room-page' : ''}`} aria-label="Team workspace">
    <ResourceNotice {...resource} onRefresh={() => void resource.refresh()}>
      {!team ? <><div className="bots-page-heading"><div><h2>Your team</h2><p>Give each bot a role. Work together in shared conversations.</p></div><Btn icon="plus" disabled={bots.length<2} onClick={onNewTeam}>New team</Btn></div><div className="bots-team-grid">{(resource.data?.teams ?? []).map(item => <button className="bots-team-card" key={item.id} onClick={() => onSelect(item.id)}><TeamMark team={item} bots={bots} size={38}/><strong>{item.name}</strong><span>{item.memberIds.length} members · {bots.find(bot => bot.id === item.coordinatorId)?.name ?? 'Unavailable coordinator'} coordinates</span><small>{item.enabled ? 'Collaboration enabled' : 'Collaboration off'}</small></button>)}</div>{!resource.data?.teams.length ? <Empty icon="experts" title="A place for your bots to work together" body={bots.length<2?'Add a second bot, then choose a coordinator and the work limits. Creating a team starts no task.':'Choose existing bots, pick a coordinator, and set the limits. Creating a team starts no task.'} action={<Btn icon="plus" onClick={bots.length<2?onNewBot:onNewTeam}>{bots.length<2?'Add a teammate':'Create your first team'}</Btn>}/> : null}</> : <>
        <div className="bots-page-heading bot-group-header"><div className="bot-group-identity"><TeamMark team={team} bots={bots} size={28}/><div><h2>{team.name}</h2><p>{team.memberIds.length} teammates · {bots.find(bot => bot.id === team.coordinatorId)?.name ?? 'Unavailable coordinator'} coordinates</p></div></div><IconBtn name="ellipsis" title="Team details" onClick={() => setDetails(true)}/></div>
        {channelSupported ? <div className="bot-room-tabs" role="tablist" aria-label="Team views"><button type="button" role="tab" id="team-channel-tab" aria-controls="team-channel-panel" aria-selected={tab === 'channel'} onClick={() => setTab('channel')} onKeyDown={event => { if (event.key === 'ArrowRight') { setTab('work'); document.getElementById('team-work-tab')?.focus(); } }}>Channel</button><button type="button" role="tab" id="team-work-tab" aria-controls="team-work-panel" aria-selected={tab === 'work'} onClick={() => setTab('work')} onKeyDown={event => { if (event.key === 'ArrowLeft') { setTab('channel'); document.getElementById('team-channel-tab')?.focus(); } }}>Work{tasks.data ? <TeamWorkCounts groups={taskGroups} stale={!!tasks.error || !!resource.error || workflowStale} workflows={workflowCounts}/> : tasks.error ? <span className="bot-work-counts">Unavailable</span> : active ? <span className="bot-room-tab-dot" aria-label="Active work"/> : null}</button></div> : <p className="small muted">This host supports coordinator work. Update it to use the shared team channel.</p>}
        <div className={`bot-team-view${tab === 'work' ? ' bot-team-view--work' : ''}`}>{workflowsSupported && team ? <BotTeamWorkflow key={team.id} team={team} bots={bots} visible={true} current={current} resource={workflows} view={tab} sessions={workflowSessions} activityStale={!!workflowActivity.error || workflowActivity.loading} onOpenConversation={onOpenConversation} onChanged={resource.refresh}/> : null}
        {channelSupported ? <div id="team-channel-panel" role="tabpanel" aria-labelledby="team-channel-tab" className="bot-room-panel" hidden={tab !== 'channel'}><BotTeamChannel key={team.id} team={team} bots={bots} visible={tab === 'channel'} current={current} continuousSupported={resource.data?.teamContinuousSupported} coordinatorWorkToolsSupported={resource.data?.teamCoordinatorWorkToolsSupported === true} workPlansSupported={plansSupported} onUnsupported={() => setChannelSupported(false)} onOpenConversation={onOpenConversation} onStateChange={resource.refresh} onDetails={() => setDetails(true)} onShowWork={() => setTab('work')}/></div> : null}
        <div id="team-work-panel" role={channelSupported ? 'tabpanel' : undefined} aria-labelledby={channelSupported ? 'team-work-tab' : undefined} className="bot-room-work" hidden={channelSupported && tab !== 'work'}>

        {plansSupported ? <BotTeamPlans key={team.id} team={team} bots={bots} visible={tab === 'work'} current={current} resource={plans} onOpenConversation={onOpenConversation} onChanged={resource.refresh}/> : null}
        {!channelSupported ? <div className="bots-request-card"><label className="input-field"><span>What should the team do?</span><textarea className="st-input" aria-label="Team request" rows={4} maxLength={16000} value={prompt} disabled={!!busy} onChange={event => { setPrompt(event.target.value); requestId.current = null; }} placeholder="Ask your coordinator to work with the team…"/></label><div className="bots-request-footer"><p>{team.enabled ? botTeamWorkLabel(team.limits, resource.data?.teamContinuousSupported, resource.data?.teamUnrestrictedSupported) : 'Turn on collaboration in Team settings before sending a request.'}</p><Btn icon="send" variant="primary" disabled={!!busy || !!active || !team.enabled || !prompt.trim() || !current} onClick={() => void start()}>{busy === 'start' ? 'Starting…' : active ? 'Team is working' : 'Send to team'}</Btn></div><p className="xs muted">Uses each member’s saved model and execution computer. </p></div> : null}
        {error ? <ErrorNotice message={error} action="Dismiss" onRetry={() => setError('')}/> : null}
        {resource.data?.teamWorkReviewSupported === true ? <ResourceNotice {...tasks} onRefresh={() => void tasks.refresh()}>
          {tasks.data ? <BotTeamWorkOverview key={team.id} groups={taskGroups} bots={bots} stale={!!tasks.error || !!resource.error || workflowStale} workflows={workflowCounts} disabled={!current || !!tasks.error}
            onChanged={async () => { await tasks.refresh(); await resource.refresh(); }}
            onOpenConversation={id => void onOpenConversation(id).catch(cause => setError(errorMessage(cause)))}/> : null}
        </ResourceNotice> : null}
        <details className="bot-work-disclosure" key={`members-${team.id}`}><summary>Team members <span>{team.memberIds.length}</span></summary>
        <div className="bots-team-members">{team.memberIds.map(id => { const bot = bots.find(item => item.id === id); return <div key={id}><CuaBotAvatar name={bot?.name ?? 'Unavailable bot'} config={bot?.avatarConfig} size={34}/><span><strong>{bot?.name ?? 'Unavailable bot'}</strong><small>{team.briefing?.members.find(member => member.botId === id)?.role ? `${team.briefing.members.find(member => member.botId === id)!.role}${id === team.coordinatorId ? ' · Coordinator' : ''}` : id === team.coordinatorId ? 'Coordinator' : 'Teammate'}{bot?.paused ? ' · Paused' : ''}</small></span></div>; })}</div>
        </details>
        {runs.some(run => botTeamRunActive(run.state)) ? <section aria-label="Requests in progress"><div className="bots-section-heading"><h3>Requests in progress</h3></div><div className="bots-activity-list">{runs.filter(run => botTeamRunActive(run.state)).map(run => <article key={run.id} className="bots-activity-card"><div><Icon name="experts" size={20}/><div><strong>{botActivityLabel(run.state)}</strong><p>{run.consumedTurns} turns · {relTime(run.createdAt)}</p></div><span className="spacer"/><Btn size="sm" onClick={() => void onOpenConversation(run.rootChatId).catch(cause => setError(errorMessage(cause)))}>Open conversation</Btn><Btn size="sm" variant="danger" disabled={!current || !!busy || run.state === 'stopping'} onClick={() => void stop(run)}>{busy === run.id ? 'Stopping…' : run.state === 'cleanup_pending' ? 'Retry Stop' : 'Stop team'}</Btn></div>{run.detail ? <p>{run.detail}</p> : null}{run.state === 'cleanup_pending' ? <p>Some work has not confirmed it stopped. Check the conversation before starting another request.</p> : null}</article>)}</div></section> : null}
        <details className="bot-work-disclosure" key={`requests-${team.id}`}><summary><h3>Team requests</h3><span>{runs.filter(run => !botTeamRunActive(run.state)).length} earlier requests</span></summary>
          {!runs.length ? <p className="small muted">No team work yet. Conversations stay in Channel; assigned work and its details appear here.</p> : <div className="bots-activity-list">{runs.filter(run => !botTeamRunActive(run.state)).map(run => <article key={run.id} className="bots-activity-card"><div><Icon name="experts" size={20}/><div><strong>{resource.data?.teamWorkReviewSupported === true && run.state === 'completed' ? 'Turn finished' : botActivityLabel(run.state)}</strong><p>{run.consumedTurns} turns · {relTime(run.createdAt)}</p></div><span className="spacer"/><Btn size="sm" onClick={() => void onOpenConversation(run.rootChatId).catch(cause => setError(errorMessage(cause)))}>Open conversation</Btn></div>{run.detail ? <p>{run.detail}</p> : null}</article>)}</div>}
        </details>
        </div>
        </div>
      </>}
    </ResourceNotice>
    {details && team && workplace ? <Dialog open title={team.name} compact className="bot-group-details" onClose={() => setDetails(false)} actions={<Btn onClick={() => setDetails(false)}>Done</Btn>}>
      <section className="bot-team-details-section"><div className="bot-team-details-heading"><h3>Members · {team.memberIds.length}</h3><Btn size="sm" disabled={!!busy || !current} onClick={() => editSettings('members')}>Edit members</Btn></div><div className="bot-group-detail-members">{team.memberIds.map(id => { const bot = bots.find(row => row.id === id); return <div key={id}><CuaBotAvatar name={bot?.name ?? 'Unavailable bot'} config={bot?.avatarConfig} size={42}/><span><strong>{bot?.name ?? 'Unavailable bot'}</strong><small>{team.briefing?.members.find(member => member.botId === id)?.role ? `${team.briefing.members.find(member => member.botId === id)!.role}${id === team.coordinatorId ? ' · Coordinator' : ''}` : id === team.coordinatorId ? 'Coordinator' : 'Teammate'}{bot?.paused ? ' · Paused' : ''}</small>{team.briefing?.members.find(member => member.botId === id)?.instructions ? <p className="bot-team-member-note">{team.briefing.members.find(member => member.botId === id)!.instructions}</p> : null}</span></div>; })}</div></section>
      {team.briefing?.instructions ? <section className="bot-team-details-section"><div className="bot-team-details-heading"><h3>Team instructions</h3><Btn size="sm" disabled={!!busy || !current} onClick={() => editSettings('general')}>Edit instructions</Btn></div><p className="bot-team-public-instructions">{team.briefing.instructions}</p></section> : null}
      <section className="bot-team-details-section" aria-label="Team computer and working folder"><div className="bot-team-details-heading"><h3>Computer & working folder</h3><Btn size="sm" disabled={!!busy || !current} onClick={() => editSettings('computer')}>Change</Btn></div><div className="bot-team-details-place"><Icon name="computer" size={19}/><div><strong>{workplace.name}</strong><span>{workplace.label}</span><code>{workplace.workspace}</code></div></div><p className="bot-group-detail-note">{workplace.shared ? 'Everyone shares this computer and folder. Each teammate keeps its own model and permissions.' : 'Each teammate uses its saved computer and working folder.'}</p>{computerOwner ? <Btn icon="computer" disabled={!!busy || !current} onClick={() => { setDetails(false); setComputerOpen(true); }}>Open team computer</Btn> : null}</section>
      {active ? <p className="bot-group-detail-note">The team is working. Settings can be reviewed now and changed after active work finishes or stops.</p> : null}
      <div className="bot-group-detail-actions"><Btn icon="link" onClick={()=>navigate('connectors',undefined,{team:team.id})}>Team connectors</Btn><Btn icon="activity" onClick={() => { setDetails(false); setTab('work'); }}>View team work</Btn><Btn icon="settings" disabled={!!busy || !current} onClick={() => editSettings('general')}>Team settings</Btn></div><p className="bot-group-detail-note">{botTeamWorkLabel(team.limits, resource.data?.teamContinuousSupported, resource.data?.teamUnrestrictedSupported)}{team.enabled ? '' : ' · Collaboration off'}. Earlier messages and completed work are retained.</p>
    </Dialog> : null}
    {editing && team ? <BotTeamEditor key={team.id} bots={bots} team={team} computers={resource.data?.teamComputers} settingsSupported={resource.data?.teamSettingsSupported} instructionsSupported={resource.data?.teamInstructionsSupported} unrestrictedSupported={resource.data?.teamUnrestrictedSupported} continuousSupported={resource.data?.teamContinuousSupported} activeWork={!!active} initialSection={editorSection} onReload={resource.refresh} onClose={() => setEditing(false)} onSaved={async item => { const selected=revision.current;await resource.refresh();if(mounted.current&&selected===revision.current){setEditing(false);onSelect(item.id);} }}/>: null}
    {computerOpen && computerOwner && team ? <BotComputer key={`${team.id}:${computerOwner.id}`} bot={computerOwner} teamName={team.name} onClose={() => setComputerOpen(false)}/> : null}
  </section>;
}

export function BotTeamActivityView({ bots, onOpenConversation }: { bots: Bot[]; onOpenConversation: (id: string) => Promise<void> }) {
  const resource = useBotsResource<BotTeamActivitySnapshot>('/api/bots/activity'), [error, setError] = useState(''), [stopping,setStopping] = useState('');
  const supervision = useBotsResource<BotSupervisionSnapshot>('/api/bots/supervision', 3000);
  const rows = (resource.data?.activity ?? []).slice().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const name = (id?: string) => bots.find(bot=>bot.id===id)?.name ?? 'Bot';
  async function stop(row:BotTeamActivity) { if(stopping)return;setStopping(row.runId);setError('');try{await api.post(`/api/bots/teams/${encodeURIComponent(row.teamId)}/runs/${encodeURIComponent(row.runId)}/stop`,{});await resource.refresh();}catch(cause){setError(errorMessage(cause));}finally{setStopping('');} }
  return <section className="bots-workspace-page" aria-label="Team activity"><ResourceNotice {...supervision} onRefresh={() => void supervision.refresh()}>{supervision.data ? <BotSupervision snapshot={supervision.data} bots={bots} stale={!!supervision.error} onOpen={id => void onOpenConversation(id).catch(cause => setError(errorMessage(cause)))}/> : null}</ResourceNotice><BotHarnessActions onOpen={onOpenConversation}/><div className="bots-page-heading"><div><h2>Activity</h2><p>Team requests, handoffs and subagents, from the same host as your iPhone.</p></div><Btn size="sm" icon="refresh" disabled={resource.loading} onClick={()=>void resource.refresh()}>Refresh activity</Btn></div><ResourceNotice {...resource} onRefresh={()=>void resource.refresh()}>{rows.length ? <div className="bots-activity-list">{rows.map(row=><article className="bots-activity-card" key={row.id}><div><Icon name={row.type==='subagent'?'experts':row.type==='delivery'?'send':'activity'} size={20}/><div><strong>{row.title}</strong><p>{row.type==='delivery'?(row.fromBotId?`${name(row.fromBotId)} → ${name(row.toBotId)}`:`${name(row.botId)} · Assigned task`):row.type==='subagent'?`Subagent · ${name(row.botId)}`:'Team request'} · {relTime(row.updatedAt)}</p></div><span className="bots-state" data-active={botTeamRunActive(row.state)||undefined} data-state={!resource.error ? row.state : undefined}>{resource.error?'Last known: ':''}{resource.data?.teamWorkReviewSupported === true && row.work ? botTaskWorkLabel(row.work.status) : botActivityLabel(row.state)}</span>{resource.data?.teamWorkReviewSupported === true && row.work ? <BotTaskReview row={row} disabled={!!resource.error || resource.loading} onChanged={resource.refresh}/> : null}{row.chatId?<Btn size="sm" onClick={()=>void onOpenConversation(row.chatId!).catch(cause=>setError(errorMessage(cause)))}>Open conversation</Btn>:null}{row.type==='run'&&botTeamRunActive(row.state)?<Btn size="sm" variant="danger" disabled={!!stopping||row.state==='stopping'} onClick={()=>void stop(row)}>{stopping===row.runId?'Stopping…':row.state==='cleanup_pending'?'Retry Stop':'Stop team'}</Btn>:null}</div>{row.detail?<p>{row.detail}</p>:null}</article>)}</div>:!resource.error?<Empty icon="activity" title="No team activity yet" body="Requests and handoffs appear here when you send work to a team."/>:null}</ResourceNotice>{error?<ErrorNotice message={error} action="Dismiss" onRetry={()=>setError('')}/>:null}</section>;
}
export function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
