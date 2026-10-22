import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/client';
import type { Bot, BotTeam, BotTeamWorkflow as Workflow, BotTeamWorkflowsSnapshot } from '../lib/bots';
import { CuaBotAvatar } from '../components/CuaBotAvatar';
import { Btn, Dialog, ErrorNotice, Icon } from '../components/ui';
import type { BotSupervisionSession } from '../components/BotSupervision';
import { defaultWorkflowRoles, validTeamWorkflow, validateTeamWorkflows, workflowActive, workflowFormError, workflowLabel, workflowMemberAvailable, workflowMembers, workflowMutationMatches, workflowObservedActivity, workflowNeedsOwner } from './botTeamWorkflowState';
import './BotTeamWorkflow.css';

const failure = (value: unknown) => value instanceof Error ? value.message : String(value);
const pathFor = (teamId: string) => `/api/bots/teams/${encodeURIComponent(teamId)}/workflows`;
type OwnerAction = { kind: 'resume'|'stop'|'accept'|'changes_requested'; workflow: Workflow; requestId: string };

/** Read-only discovery/polling; no GET can dispatch, resume or review work. */
export function useTeamWorkflows(teamId: string | undefined, visible: boolean) {
  const [snapshot, setSnapshot] = useState<BotTeamWorkflowsSnapshot | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [unsupported, setUnsupported] = useState(false), [busy, setBusy] = useState(false), [stale, setStale] = useState(true);
  const [scope, setScope] = useState<string | null>(null);
  const alive = useRef(false), epoch = useRef(0), pending = useRef(false), mutating = useRef(false), selected = useRef(teamId), shown = useRef(visible), cached = useRef<BotTeamWorkflowsSnapshot | null>(null), unavailable = useRef(false), lastCheck = useRef(0);
  selected.current = teamId; shown.current = visible;
  const live = useCallback((token: number, id: string) => alive.current && token === epoch.current && selected.current === id && shown.current && !document.hidden, []);
  const refresh = useCallback(async (force = false) => {
    if (!teamId || !alive.current || !shown.current || document.hidden || pending.current || mutating.current || unavailable.current && !force || !force && Date.now() - lastCheck.current < 1500) return;
    const token = epoch.current, id = teamId; pending.current = true; lastCheck.current = Date.now(); setLoading(true);
    try {
      const result = await api.get<BotTeamWorkflowsSnapshot>(pathFor(id));
      if (!live(token, id)) return;
      if (result?.teamWorkflowsSupported === false) { unavailable.current = true; setUnsupported(true); setStale(true); setError(''); return; }
      const accepted = validateTeamWorkflows(result, id, cached.current ?? undefined);
      setScope(id);
      if (JSON.stringify(cached.current) !== JSON.stringify(accepted)) { cached.current = accepted; setSnapshot(accepted); }
      const reason = accepted.error || (!accepted.available ? 'Some saved workflows could not be read. Available records remain inspectable.' : '');
      setUnsupported(false); unavailable.current = false; setError(reason); setStale(!accepted.available || !!reason);
    } catch (cause) {
      if (!live(token, id)) return;
      if (cause instanceof ApiError && [404, 405, 501].includes(cause.status)) { unavailable.current = true; setUnsupported(true); setError(''); }
      else setError(failure(cause));
      setStale(true);
    } finally { if (live(token, id)) { pending.current = false; setLoading(false); } }
  }, [teamId, live]);
  useEffect(() => {
    alive.current = true; epoch.current++; pending.current = false; mutating.current = false; unavailable.current = false; cached.current = null; lastCheck.current = 0;
    setSnapshot(null); setScope(null); setError(''); setLoading(false); setUnsupported(false); setBusy(false); setStale(true);
    return () => { alive.current = false; epoch.current++; };
  }, [teamId]);
  useEffect(() => {
    const invalidate = () => { epoch.current++; pending.current = false; mutating.current = false; setLoading(false); setBusy(false); setStale(true); };
    if (!visible) { invalidate(); return; }
    const check = () => {
      if (document.hidden) { invalidate(); return; }
      const interval = cached.current?.workflows.some(row => workflowActive(row.phase)) ? 8000 : 30000;
      if (Date.now() - lastCheck.current >= interval || stale) void refresh();
    };
    void refresh(); const timer = setInterval(check, 8000);
    document.addEventListener('visibilitychange', check); window.addEventListener('focus', check);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); };
  }, [visible, refresh, stale]);
  const write = useCallback(async (suffix: string, body: unknown, validate: (value: unknown) => value is Workflow) => {
    if (!teamId || scope !== teamId || !alive.current || !shown.current || document.hidden || mutating.current || !cached.current?.available || error || stale || unsupported) return false;
    const token = ++epoch.current, id = teamId; pending.current = false; mutating.current = true; setLoading(false); setBusy(true); setError('');
    try {
      const result = await api.post<{workflow: Workflow}>(`${pathFor(id)}${suffix}`, body);
      if (!live(token, id)) return false;
      if (!validate(result?.workflow)) throw Error('Strata did not confirm this exact workflow change. Refresh the saved workflow before continuing.');
      const value = result.workflow, previous = cached.current!;
      const next = { ...previous, workflows: [value, ...previous.workflows.filter(row => row.id !== value.id)].slice(0, 20) };
      cached.current = next; setSnapshot(next); setStale(false); return true;
    } catch (cause) {
      if (live(token, id)) { setError(failure(cause)); setStale(true); }
      return false;
    } finally { if (live(token, id)) { mutating.current = false; setBusy(false); } }
  }, [teamId, scope, error, stale, unsupported, live]);
  return { snapshot, scope, error, loading, unsupported, busy, stale, refresh, write };
}

/** Optional workflow controls live in the existing team channel. */
export function BotTeamWorkflow({ team, bots, visible, current, resource, view = 'channel', sessions = [], activityStale = false, onOpenConversation, onChanged }: {
  team: BotTeam; bots: Bot[]; visible: boolean; current: boolean;
  resource: ReturnType<typeof useTeamWorkflows>; view?: 'channel'|'work'; sessions?: BotSupervisionSession[]; activityStale?: boolean;
  onOpenConversation: (chatId: string) => Promise<void>; onChanged: () => Promise<void>;
}) {
  const [inspecting, setInspecting] = useState(false), [creating, setCreating] = useState(false), [selectedId, setSelectedId] = useState(''), [action, setAction] = useState<OwnerAction | null>(null), [note, setNote] = useState(''), [inspected, setInspected] = useState(false), [navigationError, setNavigationError] = useState('');
  const context = useRef({ teamId: team.id, visible, mounted: true }); context.current.teamId = team.id; context.current.visible = visible;
  useEffect(() => { context.current.mounted = true; return () => { context.current.mounted = false; }; }, []);
  useEffect(() => { setCreating(false); setInspecting(false); setAction(null); setNavigationError(''); }, [team.id, visible]);
  const workflows = resource.snapshot?.workflows.filter(row => row.teamId === team.id) ?? [], selected = workflows.find(row => row.id === selectedId) ?? (!selectedId ? workflows[0] : undefined);
  const prioritized = workflows.slice().sort((a, b) => Number(workflowNeedsOwner(b, sessions)) - Number(workflowNeedsOwner(a, sessions)) || Number(workflowActive(b.phase)) - Number(workflowActive(a.phase)));
  const latest = prioritized[0], currentWorkflows = prioritized.filter(row => workflowActive(row.phase) || workflowNeedsOwner(row, sessions)), earlierWorkflows = prioritized.filter(row => !currentWorkflows.includes(row));
  const ready = visible && current && resource.scope === team.id && resource.snapshot?.available === true && !resource.stale && !resource.error && !resource.busy && !resource.unsupported;
  const canStart = ready && team.enabled;
  const actionCurrent = !!action && workflows.some(row => row.id === action.workflow.id && row.revision === action.workflow.revision && row.proof === action.workflow.proof);
  function open(row?: Workflow) { setSelectedId(row?.id ?? workflows[0]?.id ?? ''); setInspecting(true); setNavigationError(''); }
  function choose(kind: OwnerAction['kind'], workflow: Workflow) { setAction({ kind, workflow: structuredClone(workflow), requestId: crypto.randomUUID() }); setNote(''); setInspected(false); }
  async function openChat(id: string) {
    const scope = team.id;
    try { await onOpenConversation(id); }
    catch (cause) { if (context.current.mounted && context.current.visible && context.current.teamId === scope) setNavigationError(failure(cause)); }
  }
  async function confirm() {
    if (!ready || !action || !actionCurrent || ['resume', 'changes_requested'].includes(action.kind) && !team.enabled || action.kind === 'resume' && !inspected) return;
    const scope = team.id, { workflow, kind } = action;
    const route = kind === 'accept' || kind === 'changes_requested' ? 'review' : kind;
    const body = { expectedRevision: workflow.revision, expectedProof: workflow.proof, ...(kind === 'resume' ? { requestId: action.requestId, inspected: true } : kind === 'accept' || kind === 'changes_requested' ? { decision: kind, ...(note.trim() ? { note: note.trim() } : {}) } : {}) };
    const accepted = await resource.write(`/${encodeURIComponent(workflow.id)}/${route}`, body, (value): value is Workflow => workflowMutationMatches(workflow, value, kind));
    if (accepted && context.current.mounted && context.current.visible && context.current.teamId === scope) { setAction(null); void onChanged().catch(() => {}); void resource.refresh(true); }
  }
  const needsReview = workflows.filter(row => workflowNeedsOwner(row, sessions)).length;
  function workCard(row: Workflow) {
    const observed = workflowObservedActivity(row, sessions), stage = row.steps.at(-1), needsApproval = observed?.state === 'approval' && observed.approvalCount > 0;
    return <article className="bot-workflow-card" key={row.id} aria-label={row.goal}>
      <div className="bot-workflow-card-heading"><span className="bot-workflow-state" data-phase={resource.stale ? undefined : row.phase}>{resource.stale ? 'Last known: ' : ''}{workflowLabel(row.phase)}</span><small>Round {row.round}</small></div>
      <h4 title={row.goal}>{row.goal}</h4><WorkflowCurrentStage workflow={row} bots={bots} sessions={sessions} stale={resource.stale || activityStale}/>
      {row.blockedReason ? <p className="bot-workflow-warning">{row.blockedReason}</p> : null}
      <div className="bot-workflow-card-actions"><Btn size="sm" onClick={() => open(row)}>{row.phase === 'awaiting_review' ? 'Review result' : 'Inspect workflow'}</Btn>{stage?.chatId ? <Btn size="sm" onClick={() => void openChat(stage.chatId!)}>{needsApproval ? 'Review approval' : 'Thinking & tools'}</Btn> : null}</div>
    </article>;
  }
  return <section className="bot-team-workflow" aria-label="Planned team work">
    <div className="bot-workflow-toolbar"><div><Icon name="check" size={18}/><span><strong>Plan, build, review</strong><small>{resource.unsupported ? 'Update Strata on this computer to use planned workflows.' : 'A clear goal. An independent reviewer. Your final say.'}</small></span></div><div>
      <Btn size="sm" disabled={!canStart} onClick={() => setCreating(true)}>Plan &amp; verify</Btn>
      {workflows.length ? <Btn size="sm" onClick={() => open()}>Workflows · {workflows.length}{resource.snapshot?.hasMore ? '+' : ''}{needsReview ? ` · ${needsReview} need you` : ''}</Btn> : null}
      {resource.unsupported ? <Btn size="sm" disabled={resource.loading} onClick={() => void resource.refresh(true)}>Check again</Btn> : null}
    </div></div>
    {resource.error ? <ErrorNotice message={resource.error} next="Saved records may be out of date. Refresh before making changes." action="Refresh workflows" onRetry={() => void resource.refresh(true)}/> : null}
    {latest && view === 'channel' ? <div className="bot-workflow-current"><button className="bot-workflow-latest" type="button" onClick={() => open(latest)}><span className="bot-workflow-state" data-phase={resource.stale ? undefined : latest.phase}>{resource.stale ? 'Last known: ' : ''}{workflowLabel(latest.phase)}</span><span>{latest.goal}</span><Icon name="chevron" size={14}/></button><WorkflowCurrentStage workflow={latest} bots={bots} sessions={sessions} stale={resource.stale || activityStale}/>{workflowObservedActivity(latest, sessions)?.state === 'approval' && latest.steps.at(-1)?.chatId ? <Btn size="sm" onClick={() => void openChat(latest.steps.at(-1)!.chatId!)}>Review approval</Btn> : null}</div> : null}
    {view === 'work' ? <section className="bot-workflow-work" aria-label="Planned workflows"><h3>Planned workflows</h3>{resource.snapshot?.hasMore ? <p className="small muted">Showing available workflow records. Counts are a lower bound; earlier conversations and reports remain in the channel.</p> : null}{!resource.snapshot && !resource.error ? <p role="status" className="small muted">Checking saved workflows…</p> : null}{currentWorkflows.map(workCard)}{earlierWorkflows.length ? <details className="bot-workflow-history"><summary>Earlier workflows · {earlierWorkflows.length}</summary>{earlierWorkflows.map(workCard)}</details> : null}{resource.snapshot?.available && !resource.stale && !workflows.length ? <p className="small muted">No saved workflows yet. Plan &amp; verify starts a goal with a separate reviewer.</p> : null}</section> : null}
    {creating && visible ? <WorkflowCreate team={team} bots={bots} disabled={!canStart} busy={resource.busy} error={resource.error} onRefresh={() => void resource.refresh(true)} onClose={() => { if (!resource.busy) setCreating(false); }} onCreate={async draft => {
      if (!canStart) return false; const scope = team.id;
      const accepted = await resource.write('', draft, (value): value is Workflow => validTeamWorkflow(value, scope) && value.goal === draft.goal && value.plannerId === draft.plannerId && value.builderId === draft.builderId && value.evaluatorId === draft.evaluatorId && JSON.stringify(value.criteria.map(row => row.text)) === JSON.stringify(draft.criteria));
      if (accepted && context.current.mounted && context.current.visible && context.current.teamId === scope) { setCreating(false); setSelectedId(''); setInspecting(true); void onChanged().catch(() => {}); void resource.refresh(true); }
      return accepted;
    }}/> : null}
    {inspecting && visible ? <Dialog open wide className="bot-workflow-dialog" title="Team workflows" onClose={() => { if (!resource.busy) { setInspecting(false); setAction(null); } }} actions={<><Btn disabled={resource.loading || resource.busy} onClick={() => void resource.refresh(true)}>Refresh workflows</Btn><Btn disabled={resource.busy} onClick={() => setInspecting(false)}>Done</Btn></>}>
      {resource.stale ? <p className="bot-workflow-warning" role="status">Showing last known workflow records. Refresh to check their current state before continuing.</p> : null}
      {resource.error ? <ErrorNotice message={resource.error} action="Refresh workflows" onRetry={() => void resource.refresh(true)}/> : null}
      <div className="bot-workflow-inspector"><nav aria-label="Saved workflows">{workflows.map(row => <button type="button" key={row.id} aria-current={selected?.id === row.id ? 'true' : undefined} onClick={() => setSelectedId(row.id)}><span className="bot-workflow-state" data-phase={resource.stale ? undefined : row.phase}>{workflowLabel(row.phase)}</span><strong>{row.goal}</strong><small>{new Date(row.updatedAt).toLocaleString()}</small></button>)}</nav>
        {selected ? <WorkflowDetails workflow={selected} bots={bots} sessions={sessions} activityStale={activityStale || resource.stale} disabled={!ready} startDisabled={!canStart} onAction={kind => choose(kind, selected)} onOpenChat={id => void openChat(id)}/> : <p className="small muted">{selectedId ? 'This workflow is not in the current page. Refresh or select another saved workflow.' : 'No saved workflows are available.'}</p>}
      </div>
      {resource.snapshot?.hasMore ? <p className="small muted">Showing the 20 most recent available workflows. Earlier conversations and team reports remain in the channel.</p> : null}
      {navigationError ? <ErrorNotice message={navigationError} action="Dismiss" onRetry={() => setNavigationError('')}/> : null}
    </Dialog> : null}
    {action && visible ? <Dialog open compact className="bot-workflow-action" title={action.kind === 'accept' ? 'Accept this result?' : action.kind === 'changes_requested' ? 'Request changes' : action.kind === 'resume' ? 'Continue this workflow?' : 'Stop this workflow?'} onClose={() => { if (!resource.busy) setAction(null); }} actions={<><Btn disabled={resource.busy} onClick={() => setAction(null)}>Cancel</Btn><Btn variant={action.kind === 'stop' ? 'danger' : 'primary'} disabled={!ready || !actionCurrent || ['resume', 'changes_requested'].includes(action.kind) && !team.enabled || action.kind === 'resume' && !inspected || action.kind === 'changes_requested' && !note.trim()} onClick={() => void confirm()}>{resource.busy ? 'Saving…' : action.kind === 'accept' ? 'Accept result' : action.kind === 'changes_requested' ? 'Send changes to builder' : action.kind === 'resume' ? 'Continue unfinished work' : 'Stop workflow'}</Btn></>}>
      <p className="bot-workflow-goal">{action.workflow.goal}</p>
      {!actionCurrent ? <p role="alert" className="bot-workflow-warning">This workflow changed. Close this sheet and review its latest checkpoint before continuing.</p> : null}
      <p>{action.kind === 'accept' ? 'Reviewer checks are reported evidence. Accept after inspecting the actual deliverables; this records your review.' : action.kind === 'changes_requested' ? 'Your feedback starts a repair with the saved builder, followed by another independent review, using their existing permissions.' : action.kind === 'resume' ? 'The selected unfinished stage continues in a new conversation after inspecting saved progress. Completed actions are not replayed.' : 'Stop the selected workflow and its active stage. Existing computer cleanup holds remain in force.'}</p>
      {action.kind === 'resume' ? <label className="bot-workflow-checkbox"><input type="checkbox" checked={inspected} onChange={event => setInspected(event.target.checked)} disabled={resource.busy}/><span>I inspected the saved progress and any effects of the interrupted work.</span></label> : null}
      {action.kind === 'accept' || action.kind === 'changes_requested' ? <label className="input-field"><span>{action.kind === 'changes_requested' ? 'What needs to change?' : 'Review note (optional)'}</span><textarea className="st-input" rows={3} maxLength={2500} value={note} disabled={resource.busy} onChange={event => setNote(event.target.value)}/></label> : null}
      {resource.error ? <ErrorNotice message={resource.error} action="Refresh workflows" onRetry={() => void resource.refresh(true)}/> : null}
    </Dialog> : null}
  </section>;
}

type WorkflowDraft = { requestId: string; goal: string; criteria: string[]; plannerId: string; builderId: string; evaluatorId: string };
function WorkflowCreate({ team, bots, disabled, busy, error, onClose, onCreate, onRefresh }: { team: BotTeam; bots: Bot[]; disabled: boolean; busy: boolean; error: string; onClose: () => void; onCreate: (draft: WorkflowDraft) => Promise<boolean>; onRefresh: () => void }) {
  const [goal, setGoal] = useState(''), [criteria, setCriteria] = useState(''), [roles, setRoles] = useState(() => defaultWorkflowRoles(team, bots)), [tried, setTried] = useState(false), requestId = useRef<string | null>(null);
  const members = workflowMembers(team, bots), lines = criteria.split('\n').map(row => row.trim()).filter(Boolean), invalid = workflowFormError(team, bots, goal.trim(), lines, roles);
  function edit() { requestId.current = null; }
  async function submit() { setTried(true); if (disabled || invalid) return; requestId.current ??= crypto.randomUUID(); await onCreate({ requestId: requestId.current, goal: goal.trim(), criteria: lines, ...roles }); }
  return <Dialog open title="Plan & verify" className="bot-workflow-create" onClose={onClose} actions={<><Btn disabled={busy} onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={disabled || !!invalid} onClick={() => void submit()}>{busy ? 'Starting…' : 'Start workflow'}</Btn></>}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } }}>
      <p className="bot-workflow-intro">Give the team an outcome you can check. The planner prepares a plan, the builder does the work, and a different bot reviews each criterion before it reaches you.</p>
      <label className="input-field"><span>Goal</span><textarea autoFocus className="st-input" rows={3} maxLength={16000} value={goal} disabled={busy} onChange={event => { setGoal(event.target.value); edit(); }} placeholder="What should the team deliver?"/></label>
      <label className="input-field"><span>Success criteria</span><textarea aria-label="Success criteria" className="st-input" rows={4} maxLength={16016} value={criteria} disabled={busy} onChange={event => { setCriteria(event.target.value); edit(); }} placeholder={'One check per line, for example:\nThe requested behavior works\nRelevant tests pass\nChanges and remaining limits are explained'}/><small>One per line · up to 16 criteria. These stay with the workflow.</small></label>
      <div className="bot-workflow-roles">{([['plannerId', 'Planner', 'Turns the goal into a concrete plan.'], ['builderId', 'Builder', 'Builds and repairs the result.'], ['evaluatorId', 'Independent reviewer', 'Checks the result against every criterion.']] as const).map(([key, label, description]) => <label className="input-field" key={key}><span>{label}</span><select aria-label={label} className="st-select" value={roles[key]} disabled={busy} onChange={event => { setRoles({ ...roles, [key]: event.target.value }); edit(); }}><option value="">Choose a teammate</option>{members.map(bot => <option key={bot.id} value={bot.id} disabled={!workflowMemberAvailable(bot) || key !== 'plannerId' && bot.policy === 'plan'}>{bot.name}{!workflowMemberAvailable(bot) ? ' · Unavailable' : key !== 'plannerId' && bot.policy === 'plan' ? ' · Plan only' : ''}</option>)}</select><small>{description}</small></label>)}</div>
      {Object.entries(roles).map(([key, id]) => { const bot = members.find(row => row.id === id); return bot ? <p className="bot-workflow-saved-settings" key={key}><CuaBotAvatar name={bot.name} config={bot.avatarConfig} size={24}/><span><strong>{bot.name}</strong> · {bot.model || 'Saved provider default'} · {bot.execution.kind === 'ssh' ? bot.execution.name || bot.execution.host || 'Saved SSH computer' : bot.computerMode === 'cua' ? 'Isolated computer' : 'This Mac'} · {bot.policy === 'bypass' ? 'Bypass approvals' : bot.policy === 'plan' ? 'Plan permissions' : 'Ask for approval'}</span></p> : null; })}
      {invalid && (tried || roles.builderId === roles.evaluatorId || members.filter(workflowMemberAvailable).length < 2) ? <p role="alert" className="bot-workflow-warning">{invalid}</p> : null}
      <p className="small muted">Uses saved bots, models, folders and permissions. Starting a workflow begins real team work. Your final acceptance is separate from a model’s reported checks.</p>
      {error ? <ErrorNotice message={error} action="Refresh workflows" onRetry={onRefresh}/> : null}
    </form>
  </Dialog>;
}

function WorkflowCurrentStage({ workflow, bots, sessions, stale }: { workflow: Workflow; bots: Bot[]; sessions: BotSupervisionSession[]; stale: boolean }) {
  const stage = workflow.steps.at(-1), observed = workflowObservedActivity(workflow, sessions), bot = bots.find(row => row.id === stage?.botId);
  if (workflow.phase === 'awaiting_review') return <p className="bot-workflow-stage"><strong>Waiting for your review</strong><span>{bot?.name ?? 'The reviewer'} completed the reported checks. Inspect the result before accepting.</span></p>;
  if (workflow.phase === 'completed') return <p className="bot-workflow-stage"><strong>Accepted by you</strong><span>The owner review is recorded.</span></p>;
  const activity = observed?.state === 'approval' && observed.approvalCount > 0 ? `Needs your approval${observed.toolName ? ` · ${observed.toolName.replaceAll('_', ' ')}` : ''}` : observed?.state === 'error' ? 'Conversation needs attention' : observed?.state === 'thinking' ? 'Thinking' : observed?.state === 'working' ? `Using ${observed.toolName?.replaceAll('_', ' ') || 'a tool'}` : workflowActive(workflow.phase) && stage?.state === 'pending' ? 'Queued for this stage' : undefined;
  return stage ? <p className="bot-workflow-stage" role={activity?.startsWith('Needs') ? 'status' : undefined}><strong>{bot?.name ?? 'Saved teammate'}</strong> · {workflowLabel(stage.phase)}{activity ? <span>{stale ? 'Last observed: ' : ''}{activity}</span> : null}</p> : <p className="small muted">Preparing the first saved stage.</p>;
}

function WorkflowDetails({ workflow, bots, sessions, activityStale, disabled, startDisabled, onAction, onOpenChat }: { workflow: Workflow; bots: Bot[]; sessions: BotSupervisionSession[]; activityStale: boolean; disabled: boolean; startDisabled: boolean; onAction: (kind: OwnerAction['kind']) => void; onOpenChat: (id: string) => void }) {
  const botName = (id: string) => bots.find(bot => bot.id === id)?.name ?? 'Former teammate';
  const allPassed = workflow.criteria.every(row => workflow.checks.find(check => check.criterionId === row.id)?.passed === true);
  const previousReview = ['planning','building','repairing','evaluating'].includes(workflow.phase) && workflow.checks.length > 0;
  return <article className="bot-workflow-details" aria-label="Workflow details">
    <header><span className="bot-workflow-state" data-phase={workflow.phase}>{workflowLabel(workflow.phase)}</span><h3>{workflow.goal}</h3><p>Round {workflow.round} · Checkpoint {workflow.revision}</p></header>
    <WorkflowCurrentStage workflow={workflow} bots={bots} sessions={sessions} stale={activityStale}/>
    <ol className="bot-workflow-rail" aria-label="Workflow stages">{[['Plan', workflow.plannerId], ['Build & repair', workflow.builderId], ['Independent review', workflow.evaluatorId], ['Your review', '']] .map(([name, id], index) => <li key={name} data-current={(workflow.phase === 'planning' ? 0 : ['building','repairing'].includes(workflow.phase) ? 1 : workflow.phase === 'evaluating' ? 2 : ['awaiting_review','completed'].includes(workflow.phase) ? 3 : -1) === index || undefined}><span>{index + 1}</span><strong>{name}</strong><small>{id ? botName(id) : 'Owner'}</small></li>)}</ol>
    {workflow.summary ? <div>{previousReview ? <p className="small muted">Last saved report</p> : null}<p className="bot-workflow-goal">{workflow.summary}</p></div> : null}
    {workflow.blockedReason ? <p className="bot-workflow-warning">{workflow.blockedReason}</p> : null}
    <section aria-label="Success criteria"><h4>Success criteria</h4><p className="small muted">{previousReview ? 'Previous review — new checks pending. These earlier findings do not verify the current round.' : 'Checks below are reported by the independent reviewer. They do not mark work accepted.'}</p><ul className="bot-workflow-checks">{workflow.criteria.map(row => { const check = workflow.checks.find(item => item.criterionId === row.id); return <li key={row.id}><span className="bot-workflow-check" data-result={previousReview ? 'previous' : check ? check.passed ? 'pass' : 'changes' : 'pending'}>{check ? previousReview ? check.passed ? 'Previously reported pass' : 'Previous changes requested' : check.passed ? 'Reported pass' : 'Needs changes' : 'Not checked yet'}</span><strong>{row.text}</strong>{check?.detail ? <p>{check.detail}</p> : null}</li>; })}</ul></section>
    {workflow.plan ? <details className="bot-workflow-plan"><summary>Saved plan</summary><p>{workflow.plan.summary}</p><ol>{workflow.plan.items.map((item, index) => <li key={index}>{item}</li>)}</ol></details> : null}
    <section aria-label="Saved checkpoints"><h4>Saved checkpoints</h4>{!workflow.steps.length ? <p className="small muted">The first stage is being prepared.</p> : null}<ol className="bot-workflow-checkpoints">{workflow.steps.map((step, index) => <li key={step.id}><div><span>{workflow.totalSteps - workflow.steps.length + index + 1}</span><strong>{workflowLabel(step.phase)}</strong><small>{botName(step.botId)} · {step.state === 'completed' ? 'Stage finished' : step.state}</small></div>{step.summary ? <p>{step.summary}</p> : null}{step.evidence?.length ? <details><summary>Reported evidence · {step.evidence.length}</summary>{step.evidence.map((entry, at) => <div className="bot-workflow-evidence" key={at}><small>{entry.kind}</small><strong>{entry.label}</strong><p>{entry.detail}</p></div>)}</details> : null}{step.chatId ? <Btn size="sm" onClick={() => onOpenChat(step.chatId!)}>Open {workflowLabel(step.phase).toLowerCase()} conversation</Btn> : null}</li>)}</ol>{workflow.stepsTruncated ? <p className="small muted">Showing the latest {workflow.steps.length} of {workflow.totalSteps} checkpoints. Earlier conversations and public reports stay in the team channel.</p> : null}</section>
    <div className="bot-workflow-owner-actions">{workflow.phase === 'awaiting_review' ? <><Btn disabled={startDisabled} onClick={() => onAction('changes_requested')}>Request changes</Btn><Btn variant="primary" disabled={disabled || !allPassed} onClick={() => onAction('accept')}>Review &amp; accept</Btn></> : null}{workflow.canResume && ['blocked','interrupted','stopped'].includes(workflow.phase) ? <Btn disabled={startDisabled} onClick={() => onAction('resume')}>Review continuation</Btn> : null}{workflowActive(workflow.phase) ? <Btn variant="danger" disabled={disabled} onClick={() => onAction('stop')}>{workflow.phase === 'stopping' ? 'Retry stop…' : 'Stop workflow…'}</Btn> : null}</div>
  </article>;
}
