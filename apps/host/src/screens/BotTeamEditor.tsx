import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/client';
import { postWithFolderFallback } from '../lib/folder-pick';
import { botTeamDraftError, botTeamRunActive, CONTINUOUS_BOT_TEAM_LIMITS, DEFAULT_BOT_TEAM_LIMITS, TEAM_MEMBER_CAP, type Bot, type BotTeam, type BotTeamBriefing, type BotTeamComputer, type BotTeamExecution, type BotTeamLimits, type BotTeamMemberBriefing, type BotTeamsSnapshot } from '../lib/bots';
import { CuaBotAvatar } from '../components/CuaBotAvatar';
import { Btn, Dialog, ErrorNotice, Icon, Select } from '../components/ui';
import './BotTeamSettings.css';

export type TeamEditorSection = 'general' | 'members' | 'computer';
export function BotTeamEditor({ bots, team, computers = [], settingsSupported = false, instructionsSupported = false, unrestrictedSupported = false, continuousSupported = false, activeWork = false, initialSection = 'general', onReload, onClose, onSaved }: {
  bots: Bot[]; team?: BotTeam; computers?: BotTeamComputer[]; settingsSupported?: boolean; instructionsSupported?: boolean; unrestrictedSupported?: boolean; continuousSupported?: boolean; activeWork?: boolean; initialSection?: TeamEditorSection;
  onReload?: () => Promise<void>; onClose: () => void; onSaved: (team: BotTeam) => Promise<void>;
}) {
  const [base, setBase] = useState(team), [name, setName] = useState(team?.name ?? '');
  const [memberIds, setMemberIds] = useState(team?.memberIds ?? []), [coordinatorId, setCoordinatorId] = useState(team?.coordinatorId ?? '');
  const [enabled, setEnabled] = useState(team?.enabled ?? true), [limits, setLimits] = useState<BotTeamLimits>({ ...(team?.limits ?? DEFAULT_BOT_TEAM_LIMITS) });
  const limitsAreContinuous = (value: BotTeamLimits) => Object.values(value).every(item => item === 0);
  const [untilStopped, setUntilStopped] = useState(() => continuousSupported && !!team && limitsAreContinuous(team.limits));
  const [execution, setExecution] = useState<BotTeamExecution>(team?.execution ?? { mode: 'individual' });
  const [briefing, setBriefing] = useState<BotTeamBriefing>(team?.briefing ?? { instructions: '', members: [] });
  const [talkativeness, setTalkativeness] = useState<Record<string, number>>(team?.talkativeness ?? {});
  const [bidding, setBidding] = useState(team?.bidding === true);
  const [selectorBotId, setSelectorBotId] = useState(team?.selectorBotId ?? '');
  const [busy, setBusy] = useState<'save' | 'folder' | 'reload' | null>(null), [error, setError] = useState(''), [conflict, setConflict] = useState(false);
  const [refreshedComputers, setRefreshedComputers] = useState<BotTeamComputer[] | null>(null), [refreshedSupport, setRefreshedSupport] = useState<boolean | null>(null);
  const [refreshedInstructionsSupport, setRefreshedInstructionsSupport] = useState<boolean | null>(null);
  const [refreshedUnrestrictedSupport, setRefreshedUnrestrictedSupport] = useState<boolean | null>(null);
  const mounted = useRef(true), folderRevision = useRef(0), membersRef = useRef<HTMLElement>(null), computerRef = useRef<HTMLElement>(null);
  const choices = refreshedComputers ?? computers, supported = refreshedSupport ?? settingsSupported;
  const supportsInstructions = refreshedInstructionsSupport ?? instructionsSupported;
  const unrestricted = refreshedUnrestrictedSupport ?? unrestrictedSupported;
  const [refreshedContinuousSupport, setRefreshedContinuousSupport] = useState<boolean | null>(null);
  const continuous = refreshedContinuousSupport ?? continuousSupported;
  const target = execution.mode === 'shared' ? choices.find(item => item.id === execution.computerId) : undefined;
  const localFolder = !!target && target.computerMode === 'host' && target.id === 'host:local';
  const sharedAnchor = target?.computerMode === 'cua' ? target.memberId : undefined;
  const locked = !!busy || activeWork;
  const revisionUnavailable = !!base && supported && !(Number.isSafeInteger(base.revision) && base.revision! > 0);
  const targetUnavailable = execution.mode === 'shared' && (!target || !target.available);
  const added = memberIds.filter(id => !base?.memberIds.includes(id)), removed = (base?.memberIds ?? []).filter(id => !memberIds.includes(id));
  const missing = (base?.memberIds ?? []).filter(id => !bots.some(bot => bot.id === id));
  const memberChoices = [...bots.map(bot => ({ id: bot.id, name: bot.name, avatarConfig: bot.avatarConfig, paused: bot.paused, missing: false })), ...missing.map(id => ({ id, name: 'Unavailable bot', avatarConfig: undefined, paused: false, missing: true }))];
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; folderRevision.current++; }; }, []);
  useEffect(() => { const frame = requestAnimationFrame(() => { if (initialSection === 'members') membersRef.current?.scrollIntoView({ block: 'start' }); if (initialSection === 'computer') computerRef.current?.scrollIntoView({ block: 'start' }); }); return () => cancelAnimationFrame(frame); }, [initialSection]);
  useEffect(() => { setRefreshedComputers(null); }, [computers]);
  function changeExecution(value: BotTeamExecution) { folderRevision.current++; setExecution(value); setError(''); }
  function changeMemberBriefing(botId: string, changes: Partial<Pick<BotTeamMemberBriefing, 'role' | 'instructions'>>) {
    setBriefing(value => ({ ...value, members: [...value.members.filter(member => member.botId !== botId), { botId, role: '', instructions: '', ...value.members.find(member => member.botId === botId), ...changes }] }));
  }
  function toggleMember(id: string) {
    if (execution.mode === 'shared' && sharedAnchor === id && memberIds.includes(id)) return;
    const next = memberIds.includes(id) ? memberIds.filter(value => value !== id) : [...memberIds, id];
    setMemberIds(next); setError(''); if (!next.includes(coordinatorId)) setCoordinatorId(next[0] ?? '');
  }
  async function chooseFolder() {
    if (!localFolder || locked || execution.mode !== 'shared') return;
    const selected = ++folderRevision.current; setBusy('folder'); setError('');
    try {
      const result = await postWithFolderFallback<{ path?: string; cancelled?: boolean }>('/api/workspaces/pick');
      if (mounted.current && selected === folderRevision.current && 'path' in result && result.path) setExecution(value => value.mode === 'shared' ? { ...value, workspace: result.path! } : value);
    } catch (cause) { if (mounted.current && selected === folderRevision.current) setError(message(cause)); }
    finally { if (mounted.current) setBusy(null); }
  }
  async function save() {
    if (locked || conflict || revisionUnavailable || targetUnavailable) return;
    const selectedExecution: BotTeamExecution = execution.mode === 'shared' ? { ...execution, workspace: execution.workspace.trim() } : { mode: 'individual' };
    const selectedBriefing = { instructions: briefing.instructions.trim(), members: briefing.members.filter(member => memberIds.includes(member.botId) && (member.role.trim() || member.instructions.trim())).map(member => ({ ...member, role: member.role.trim(), instructions: member.instructions.trim() })) };
    const continuousChoice = continuous && untilStopped;
    const selectedVoice = Object.fromEntries(memberIds.filter(id => Number.isInteger(talkativeness[id]) && talkativeness[id] !== 50).map(id => [id, talkativeness[id]]));
    const draft = { name: name.trim(), memberIds, coordinatorId, enabled, limits: continuousChoice ? { ...CONTINUOUS_BOT_TEAM_LIMITS } : { ...limits, ...(unrestricted ? { maxParallel: 0 } : {}) }, ...(supported ? { execution: selectedExecution } : {}), ...(supportsInstructions ? { briefing: selectedBriefing } : {}), talkativeness: selectedVoice, bidding, selectorBotId: selectorBotId && memberIds.includes(selectorBotId) ? selectorBotId : null };
    const validation = botTeamDraftError(draft, bots, choices, unrestricted && !continuousChoice, continuousChoice); if (validation) { setError(validation); return; }
    setBusy('save'); setError('');
    try {
      const body = { ...draft, ...(base && supported ? { expectedRevision: base.revision } : {}) };
      const result = base ? await api.patch<{ team: BotTeam }>(`/api/bots/teams/${encodeURIComponent(base.id)}`, body) : await api.post<{ team: BotTeam }>('/api/bots/teams', body);
      if (mounted.current) await onSaved(result.team);
    } catch (cause) {
      if (mounted.current) { setError(message(cause)); if (cause instanceof ApiError && cause.status === 409) setConflict(true); }
    } finally { if (mounted.current) setBusy(null); }
  }
  async function reload() {
    if (!base || busy) return; setBusy('reload'); setError('');
    try {
      const snapshot = await api.get<BotTeamsSnapshot>('/api/bots/teams');
      if (!mounted.current) return;
      const latest = snapshot.teams.find(item => item.id === base.id); if (!latest) throw new Error('This team is no longer available. Close settings and refresh your teams.');
      if (snapshot.runs.some(run => run.teamId === latest.id && botTeamRunActive(run.state))) throw new Error('This team is still working. Finish or stop its active work before editing settings.');
      folderRevision.current++; setBase(latest); setName(latest.name); setMemberIds(latest.memberIds); setCoordinatorId(latest.coordinatorId); setEnabled(latest.enabled); setLimits({ ...latest.limits }); setExecution(latest.execution ?? { mode: 'individual' });
      setBriefing(latest.briefing ?? { instructions: '', members: [] }); setTalkativeness(latest.talkativeness ?? {}); setBidding(latest.bidding === true); setSelectorBotId(latest.selectorBotId && latest.memberIds.includes(latest.selectorBotId) ? latest.selectorBotId : ''); setRefreshedInstructionsSupport(snapshot.teamInstructionsSupported === true);
      setRefreshedUnrestrictedSupport(snapshot.teamUnrestrictedSupported === true);
      setRefreshedContinuousSupport(snapshot.teamContinuousSupported === true); setUntilStopped(snapshot.teamContinuousSupported === true && Object.values(latest.limits).every(item => item === 0));
      setRefreshedComputers(snapshot.teamComputers ?? []); setRefreshedSupport(snapshot.teamSettingsSupported === true); setConflict(false); await onReload?.();
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { if (mounted.current) setBusy(null); }
  }
  return <Dialog open title={base ? `${base.name} settings` : 'New team'} className="bots-workspace-dialog bot-team-settings" onClose={() => { if (!busy) onClose(); }} actions={<><Btn disabled={!!busy} onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={locked || conflict || revisionUnavailable || targetUnavailable || !name.trim() || memberIds.length < 2 || !coordinatorId} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : base ? 'Save team' : 'Create team'}</Btn></>}>
    <div className="form-stack">
      {activeWork ? <p className="bot-team-settings-notice" role="status"><Icon name="activity" size={18}/><span>Your team is working. Finish or stop its active work before changing these settings.</span></p> : null}
      <section className="bot-team-settings-section"><label className="input-field"><span>Team name</span><input className="st-input" aria-label="Team name" maxLength={80} value={name} disabled={locked} onChange={event => setName(event.target.value)}/></label><label className="row small"><input type="checkbox" checked={enabled} disabled={locked} onChange={event => setEnabled(event.target.checked)}/>Allow members to collaborate</label></section>
      {supportsInstructions ? <section className="bot-team-settings-section"><div className="bot-team-settings-heading"><Icon name="experts" size={20}/><div><h3>Team instructions</h3><p>Shared with every teammate. Your coordinator can keep this team’s instructions and roles up to date.</p></div></div><label className="input-field"><span>Shared instructions</span><textarea className="st-input" aria-label="Team instructions" rows={5} maxLength={8000} value={briefing.instructions} disabled={locked} onChange={event => setBriefing(value => ({ ...value, instructions: event.target.value }))} placeholder="What are you working on, and how should the team collaborate?"/></label><p className="xs muted">These instructions apply in this team. Each bot’s private profile, tools and permissions are managed separately.</p></section> : null}
      <section ref={membersRef} className="bot-team-settings-section"><div className="bot-team-settings-heading"><Icon name="experts" size={20}/><div><h3>Team members</h3><p>Choose 2 to 12 bots. Each keeps its own model and permissions.</p></div></div>
        {memberIds.length > TEAM_MEMBER_CAP ? <p className="bot-team-cap-note" role="status">Uncheck members until {TEAM_MEMBER_CAP} or fewer remain, then save.</p> : null}
        <fieldset className="bots-member-picker bot-team-member-grid"><legend>Members · {memberIds.length}/{TEAM_MEMBER_CAP}</legend>{memberChoices.map(bot => { const anchor = execution.mode === 'shared' && sharedAnchor === bot.id; return <label key={bot.id} data-selected={memberIds.includes(bot.id) || undefined}><input type="checkbox" aria-label={bot.name} disabled={locked || anchor || memberIds.length >= TEAM_MEMBER_CAP && !memberIds.includes(bot.id)} checked={memberIds.includes(bot.id)} onChange={() => toggleMember(bot.id)}/><CuaBotAvatar name={bot.name} config={bot.avatarConfig} size={34}/><span>{bot.name}{anchor ? <small>Hosts the shared computer</small> : bot.missing ? <small>Remove to update this team</small> : bot.paused ? <small>Paused</small> : null}</span></label>; })}</fieldset>
        <div className="input-field"><span>Coordinator</span><Select ariaLabel="Team coordinator" disabled={locked || !memberIds.length} value={coordinatorId} options={[...(!coordinatorId ? [{ value: '', label: 'Choose a coordinator', disabled: true }] : []), ...memberIds.map(id => ({ value: id, label: bots.find(bot => bot.id === id)?.name ?? 'Unavailable bot' }))]} onChange={setCoordinatorId}/></div>
        <div className="input-field"><span>Who picks the next speaker</span><Select ariaLabel="Who picks the next speaker" disabled={locked || !memberIds.length} value={memberIds.includes(selectorBotId) ? selectorBotId : ''} options={[{ value: '', label: 'Coordinator’s model' }, ...memberIds.map(id => ({ value: id, label: bots.find(bot => bot.id === id)?.name ?? 'Unavailable bot' }))]} onChange={setSelectorBotId}/></div>
        <div className="bots-limit-grid">{memberIds.map(id => { const bot = bots.find(item => item.id === id), value = talkativeness[id] ?? 50; return <label className="input-field" key={id}><span>{bot?.name ?? 'Teammate'} talkativeness</span><input className="st-input" type="number" min={0} max={100} aria-label={`${bot?.name ?? 'Teammate'} talkativeness`} disabled={locked} value={value} onChange={event => { const next = Number(event.target.value); if (Number.isInteger(next)) setTalkativeness(current => ({ ...current, [id]: Math.min(100, Math.max(0, next)) })); }}/></label>; })}</div>
        <p className="xs muted">0 speaks only when mentioned. 50 is a normal share of the room. 100 is eager to join.</p>
        <label className="row small"><input type="checkbox" checked={bidding} disabled={locked} onChange={event => setBidding(event.target.checked)}/>Let each bot bid to speak</label>
        {supportsInstructions ? <div className="bot-team-member-briefings">{memberIds.map(id => { const bot = bots.find(item => item.id === id), member = briefing.members.find(item => item.botId === id); return <details className="bot-team-member-briefing" key={id}><summary><CuaBotAvatar name={bot?.name ?? 'Unavailable bot'} config={bot?.avatarConfig} size={28}/><span>{bot?.name ?? 'Unavailable bot'}<small>{member?.role || (id === coordinatorId ? 'Coordinator' : 'Add a role & instructions')}</small></span></summary><label className="input-field"><span>Role in this team</span><input className="st-input" aria-label={`${bot?.name ?? 'Unavailable bot'} team role`} maxLength={120} value={member?.role ?? ''} disabled={locked} placeholder="e.g. Developer, reviewer, researcher" onChange={event => changeMemberBriefing(id, { role: event.target.value })}/></label><label className="input-field"><span>Instructions for this teammate</span><textarea className="st-input" aria-label={`${bot?.name ?? 'Unavailable bot'} team instructions`} rows={3} maxLength={4000} value={member?.instructions ?? ''} disabled={locked} onChange={event => changeMemberBriefing(id, { instructions: event.target.value })}/></label></details>; })}</div> : null}
        {base && (added.length || removed.length) ? <p className="bot-team-change-summary" role="status">{added.length ? `${added.length} ${added.length === 1 ? 'bot' : 'bots'} joining. ` : ''}{removed.length ? `${removed.length} ${removed.length === 1 ? 'bot' : 'bots'} leaving. ` : ''}Earlier messages and completed work stay in this team.</p> : null}
      </section>
      <section ref={computerRef} className="bot-team-settings-section"><div className="bot-team-settings-heading"><Icon name="computer" size={20}/><div><h3>Computer & working folder</h3><p>Choose where your team works together.</p></div></div>
        <div className="input-field"><span>Execution</span><Select ariaLabel="Team execution" disabled={locked || !supported} value={execution.mode} options={[{ value: 'individual', label: 'Each bot’s computer' }, { value: 'shared', label: 'Shared team computer' }]} onChange={mode => changeExecution(mode === 'shared' ? { mode: 'shared', computerId: '', workspace: '' } : { mode: 'individual' })}/></div>
        {!supported ? <p className="xs muted">Update Strata on this Mac to choose a shared team computer. Each bot’s saved computer is kept.</p> : execution.mode === 'shared' ? <>
          <div className="input-field"><span>Computer</span><Select ariaLabel="Shared team computer" value={execution.computerId} disabled={locked} options={[{ value: '', label: 'Choose a computer', disabled: true }, ...(execution.computerId && !choices.some(item => item.id === execution.computerId && (item.computerMode === 'host' || !!item.memberId && memberIds.includes(item.memberId))) ? [{ value: execution.computerId, label: 'Saved shared computer is unavailable', disabled: true }] : []), ...choices.filter(item => item.computerMode === 'host' || !!item.memberId && memberIds.includes(item.memberId)).map(item => ({ value: item.id, label: item.name, disabled: !item.available }))]} onChange={id => { const computer = choices.find(item => item.id === id); if (computer) changeExecution({ mode: 'shared', computerId: id, workspace: computer.workspace }); }}/></div>
          {target ? <div className="bot-team-computer-note"><Icon name="computer" size={16}/><p><strong>{target.computerMode === 'cua' ? 'Shared isolated CUA computer' : target.label}</strong><span>{target.computerMode === 'cua' ? 'Everyone uses this teammate’s existing browser and desktop.' : 'Everyone works on this host using their own model and permissions.'}</span>{!target.available && target.detail ? <span>{target.detail}</span> : null}</p></div> : null}
          <label className="input-field"><span>Working folder</span><div className="bot-team-folder-row"><input className="st-input" aria-label="Team working folder" value={execution.workspace} maxLength={4096} disabled={locked || !target} spellCheck={false} autoCapitalize="none" autoCorrect="off" placeholder={target?.computerMode === 'cua' ? '/workspace/project' : '/full/path/to/project'} onChange={event => changeExecution({ ...execution, workspace: event.target.value })}/>{localFolder ? <Btn icon="folder" disabled={locked} onClick={() => void chooseFolder()}>{busy === 'folder' ? 'Choosing…' : 'Choose folder'}</Btn> : null}</div><small className="muted">{target?.computerMode === 'cua' ? 'Use the full folder path inside the shared CUA computer.' : localFolder ? 'Choose an existing folder on this Mac.' : 'Enter the full folder path on the selected SSH computer. A Mac folder picker cannot browse that host.'}</small></label>
          {target?.computerMode === 'cua' ? <p className="xs muted">Use /workspace or a folder inside it. The teammate hosting this CUA computer stays in the team; choose another computer before removing that teammate.</p> : null}
        </> : <p className="xs muted">Each teammate uses its saved computer and working folder. Choose a shared team computer when everyone should work in the same place.</p>}
      </section>
      {unrestricted ? <p className="bot-team-settings-notice" role="status"><Icon name="experts" size={18}/><span>All available teammates can work at once. Teammates sharing one desktop take turns controlling it.</span></p> : null}
      {continuous ? <label className="row small"><input type="checkbox" checked={untilStopped} disabled={locked} onChange={event => { const on = event.target.checked; setUntilStopped(on); if (!on && Object.values(limits).every(item => item === 0)) setLimits({ ...DEFAULT_BOT_TEAM_LIMITS, ...(unrestricted ? { maxParallel: 0 } : {}) }); }}/>Until finished or stopped</label> : null}
      {untilStopped ? <p className="bot-team-settings-notice" role="status"><Icon name="activity" size={18}/><span>Until finished or stopped. Team work has no automatic turn, time, depth or message-hop cutoff. Use Stop whenever you need to end it.</span></p> : <details className="bots-advanced" open><summary>Work limits</summary><div className="bots-limit-grid">{(unrestricted ? [{ key: 'maxTurns', label: 'Work turns', min: 1, max: 100 }] as const : [{ key: 'maxParallel', label: 'Parallel tasks', min: 1, max: 8 }, { key: 'maxTurns', label: 'Total turns', min: 1, max: 100 }] as const).map(field => <label className="input-field" key={field.key}><span>{field.label}</span><input className="st-input" type="number" min={field.min} max={field.max} disabled={locked} value={limits[field.key]} onChange={event => setLimits(value => ({ ...value, [field.key]: Number(event.target.value) }))}/></label>)}<label className="input-field"><span>Time limit · minutes</span><input className="st-input" type="number" min={1} max={60} disabled={locked} value={limits.maxDurationMs / 60000} onChange={event => setLimits(value => ({ ...value, maxDurationMs: Number(event.target.value) * 60000 }))}/></label><label className="input-field"><span>Maximum depth</span><input className="st-input" type="number" min={1} max={4} disabled={locked} value={limits.maxDepth} onChange={event => setLimits(value => ({ ...value, maxDepth: Number(event.target.value) }))}/></label><label className="input-field"><span>Message hops</span><input className="st-input" type="number" min={1} max={32} disabled={locked} value={limits.maxHops} onChange={event => setLimits(value => ({ ...value, maxHops: Number(event.target.value) }))}/></label></div></details>}
      <p className="xs muted">Saving team settings starts no work. Earlier conversations and completed tasks keep their original settings.</p>
      {revisionUnavailable ? <ErrorNotice message="Refresh this team before changing its settings."/> : null}
      {error ? <ErrorNotice message={error}/> : null}
      {conflict || revisionUnavailable ? <div className="bot-team-settings-conflict"><p>Your draft is kept here. Reloading replaces it with the latest saved team so you can review the changes.</p><Btn icon="refresh" disabled={!!busy} onClick={() => void reload()}>{busy === 'reload' ? 'Reloading…' : 'Reload latest'}</Btn></div> : null}
    </div>
  </Dialog>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
