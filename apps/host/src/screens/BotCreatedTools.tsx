import { useState } from 'react';
import { api, ApiError } from '../lib/client';
import type { Bot, BotCreatedTool, BotCreatedToolDraft, BotCreatedToolsSnapshot, BotTeam } from '../lib/bots';
import { Btn, Dialog, Empty, ErrorNotice, Icon, Select } from '../components/ui';
import { errorMessage, ResourceNotice, useBotsResource } from './BotsWorkspace';

const emptySchema = { type: 'object', properties: {}, required: [], additionalProperties: false };
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));

export function BotCreatedToolsPanel({ bots, teams = [] }: { bots: Bot[]; teams?: BotTeam[] }) {
  const resource = useBotsResource<BotCreatedToolsSnapshot>('/api/bots/tools', 10000);
  const [query, setQuery] = useState(''), [scope, setScope] = useState('all');
  const [review, setReview] = useState<BotCreatedTool | null>(null), [editing, setEditing] = useState<BotCreatedTool | 'new' | null>(null);
  const tools = (resource.data?.tools ?? []).filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()) && (scope === 'all' || tool.status === scope));
  const ready = resource.data?.createdToolsSupported === true && !resource.error && !resource.loading && !resource.data.reason;
  return <section className="bots-workspace-page" aria-label="Bot tools">
    <div className="bots-page-heading"><div><h2>Tools</h2><p>Useful commands your bots can build, share and use again.</p></div><div className="row"><Btn size="sm" icon="refresh" onClick={() => void resource.refresh()}>Refresh tools</Btn><Btn icon="plus" disabled={!ready} onClick={() => setEditing('new')}>New tool</Btn></div></div>
    <div className="bots-tool-intro"><Icon name="tool" size={22}/><div><strong>Give your team a growing toolbox</strong><p>Ask a bot in Work mode to draft and test a tool it needs. Review its command and the actual test in its conversation, enable that version, then choose the bots and teams that can reuse it.</p></div></div>
    <div className="bots-filter-row"><Select ariaLabel="Tool status" value={scope} options={[{value:'all',label:'All tools'},{value:'draft',label:'Drafts'},{value:'enabled',label:'Enabled'}]} onChange={setScope}/><input className="st-input" type="search" aria-label="Search bot tools" placeholder="Search tools…" value={query} onChange={event => setQuery(event.target.value)}/></div>
    <ResourceNotice {...resource} onRefresh={() => void resource.refresh()}>
      {resource.data?.reason ? <p className="small muted">{resource.data.reason}</p> : resource.data && resource.data.createdToolsSupported !== true ? <p className="small muted">Update Strata on this Mac to use the shared tools library.</p> : tools.length ? <div className="bots-created-tools-list">{tools.map(tool => <article className="bots-created-tool-card" key={tool.id}>
        <div className="bots-created-tool-heading"><span className="bots-capability-icon"><Icon name="tool" size={20}/></span><div><h3>{tool.name}</h3><span className="bots-state" data-state={tool.status === 'enabled' ? 'completed' : undefined}>{tool.status === 'enabled' ? 'Enabled' : 'Draft'}</span></div><Btn size="sm" onClick={() => setReview(tool)}>Review tool</Btn></div>
        <p>{tool.description}</p><code className="bots-created-tool-preview">{tool.command}</code><div className="bots-created-tool-meta"><span>Revision {tool.revision}</span><span>{tool.provenance ? `Built by ${bots.find(bot => bot.id === tool.provenance?.botId)?.name ?? 'a bot'}` : 'Created in Strata'}</span><span>{tool.botIds.length} bots · {tool.teamIds.length} teams</span></div>
      </article>)}</div> : !resource.error ? <Empty icon="tool" title={query || scope !== 'all' ? 'No matching tools' : 'A toolbox that grows with your bots'} body={query || scope !== 'all' ? 'Try another search or status.' : 'Ask a bot to draft a reusable command, or create your first draft here.'} action={!query && scope === 'all' ? <Btn disabled={!ready} onClick={() => setEditing('new')}>Create draft tool</Btn> : undefined}/> : null}
    </ResourceNotice>
    <p className="xs muted">Saving, enabling and assigning never runs a command. Tools run on the bot’s selected computer and working folder, using its approval policy. To try a tool, ask an assigned bot in Work mode.</p>
    {review ? <BotCreatedToolReview key={review.id} reviewed={review} current={resource.data?.tools.find(tool => tool.id === review.id)} bots={bots} teams={teams} currentState={ready} onRefresh={resource.refresh} onClose={() => setReview(null)} onReview={setReview} onEdit={tool => { setReview(null); setEditing(tool); }} onDeleted={async () => { setReview(null); await resource.refresh(); }} onChanged={async tool => { setReview(tool); await resource.refresh(); }}/> : null}
    {editing ? <BotCreatedToolEditor tool={editing === 'new' ? undefined : editing} readinessSupported={resource.data?.createdToolReadinessSupported === true} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await resource.refresh(); }}/>: null}
  </section>;
}

function BotCreatedToolReview({ reviewed, current, bots, teams, currentState, onClose, onReview, onEdit, onChanged, onDeleted, onRefresh }: { reviewed: BotCreatedTool; current?: BotCreatedTool; bots: Bot[]; teams: BotTeam[]; currentState: boolean; onClose: () => void; onReview: (tool: BotCreatedTool) => void; onEdit: (tool: BotCreatedTool) => void; onChanged: (tool: BotCreatedTool) => Promise<void>; onDeleted: () => Promise<void>; onRefresh: () => Promise<void> }) {
  const [botIds, setBotIds] = useState(reviewed.botIds), [teamIds, setTeamIds] = useState(reviewed.teamIds), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [removing, setRemoving] = useState(false);
  const unchanged = current?.revision === reviewed.revision && current.digest === reviewed.digest;
  const ready = currentState && unchanged && !conflict && !busy;
  const accessChanged = !sameIds(botIds, reviewed.botIds) || !sameIds(teamIds, reviewed.teamIds);
  const addingAccess = botIds.some(id => !reviewed.botIds.includes(id)) || teamIds.some(id => !reviewed.teamIds.includes(id));
  function accept(tool: BotCreatedTool) { setBotIds(tool.botIds); setTeamIds(tool.teamIds); setError(''); setConflict(false); setRemoving(false); onReview(tool); }
  async function save(patch: { status?: 'draft'|'enabled'; botIds?: string[]; teamIds?: string[] }) {
    if (!ready) return;
    setBusy(true); setError('');
    try { const result = await api.patch<{tool: BotCreatedTool}>(`/api/bots/tools/${encodeURIComponent(reviewed.id)}`, { ...patch, expectedRevision: reviewed.revision, expectedDigest: reviewed.digest }); accept(result.tool); await onChanged(result.tool); }
    catch (cause) { setError(errorMessage(cause)); if (cause instanceof ApiError && cause.status === 409) { setConflict(true); await onRefresh(); } }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!ready || !removing) return;
    setBusy(true); setError('');
    try { await api.del(`/api/bots/tools/${encodeURIComponent(reviewed.id)}`, {expectedRevision: reviewed.revision, expectedDigest: reviewed.digest}); await onDeleted(); }
    catch (cause) { setError(errorMessage(cause)); if (cause instanceof ApiError && cause.status === 409) { setConflict(true); await onRefresh(); } }
    finally { setBusy(false); }
  }
  const toggle = (ids: string[], id: string, checked: boolean) => checked ? [...ids.filter(value => value !== id), id] : ids.filter(value => value !== id);
  return <Dialog open title={reviewed.name} className="bots-workspace-dialog bots-created-tool-dialog" onClose={() => { if (!busy) onClose(); }} actions={<><Btn disabled={busy} onClick={onClose}>Done</Btn><Btn disabled={!ready} onClick={() => onEdit(reviewed)}>Edit draft</Btn><Btn variant={reviewed.status === 'enabled' ? 'danger' : 'primary'} disabled={!ready} onClick={() => void save({status: reviewed.status === 'enabled' ? 'draft' : 'enabled'})}>{reviewed.status === 'enabled' ? 'Revoke tool' : 'Enable reviewed tool'}</Btn></>}>
    {!unchanged || conflict ? <div className="bots-tool-review-warning"><p>This tool changed. Reload and review its current version before saving.</p><Btn size="sm" disabled={!current || busy} onClick={() => { if (current) accept(current); }}>Review latest version</Btn></div> : null}
    {!currentState ? <p className="small muted">Current tool state could not be verified. Refresh the library before making changes.</p> : null}
    <p className="small">{reviewed.description}</p><div className="bots-created-tool-meta"><span>{reviewed.status === 'enabled' ? 'Enabled' : 'Draft · unavailable for reuse'}</span><span>Revision {reviewed.revision}</span><span>{reviewed.timeoutSeconds} second timeout</span><span>{reviewed.provenance ? `Built by ${bots.find(bot => bot.id === reviewed.provenance?.botId)?.name ?? 'a bot'}` : 'Created in Strata'}</span></div>
    <section className="bots-tool-code-section"><h3>Command to review</h3><pre>{reviewed.command}</pre><p className="xs muted">The command runs in the selected computer’s workspace. Inputs arrive as JSON in the STRATA_TOOL_INPUT environment variable.</p></section>
    <section className="bots-tool-code-section"><h3>Inputs</h3><pre>{JSON.stringify(reviewed.inputSchema, null, 2)}</pre></section>
    <section className="bots-tool-code-section"><h3>Computer requirements</h3>{reviewed.requirements ? <><p>Platforms: {reviewed.requirements.platforms?.join(', ') || 'Any supported platform'}</p><p>Programs: {reviewed.requirements.executables?.join(', ') || 'None declared'}</p><p>Workspace files: {reviewed.requirements.workspaceFiles?.join(', ') || 'None declared'}</p></> : <p>No requirements declared.</p>}<p className="xs muted">Ask the bot to check this exact tool on its selected computer. Checks use the normal command permission and install nothing. Declared requirements are checked again before the command runs.</p></section>
    <fieldset className="bots-member-picker"><legend>Assigned bots</legend>{bots.length ? bots.map(bot => <label key={bot.id}><input type="checkbox" checked={botIds.includes(bot.id)} disabled={!ready || reviewed.status !== 'enabled' && !reviewed.botIds.includes(bot.id)} onChange={event => setBotIds(toggle(botIds, bot.id, event.target.checked))}/>{bot.name}</label>) : <p className="xs muted">Create a bot to share this tool.</p>}</fieldset>
    <fieldset className="bots-member-picker"><legend>Assigned teams</legend>{teams.length ? teams.map(team => <label key={team.id}><input type="checkbox" checked={teamIds.includes(team.id)} disabled={!ready || reviewed.status !== 'enabled' && !reviewed.teamIds.includes(team.id)} onChange={event => setTeamIds(toggle(teamIds, team.id, event.target.checked))}/>{team.name}</label>) : <p className="xs muted">Create a team to share this tool.</p>}</fieldset>
    <div className="bots-tool-access-footer"><p className="xs muted">Enable a reviewed version to share it. New conversations receive assigned tools; revoking access blocks further calls. Editing returns the tool to draft.</p><Btn disabled={!ready || !accessChanged || reviewed.status !== 'enabled' && addingAccess} onClick={() => void save({botIds, teamIds})}>Save tool access</Btn></div>
    <p className="xs muted">A bot can test its own exact draft with test_created_tool in Work mode. Enabled tools are reused by assigned bots with run_created_tool. Commands, approvals and actual results appear in their shared conversations. Enabling alone does not prove a tool works.</p>
    <div className="bots-delete-row">{removing ? <><span>Delete this tool and remove its access? Conversation history is retained.</span><Btn size="sm" disabled={busy} onClick={() => setRemoving(false)}>Keep tool</Btn><Btn size="sm" variant="danger" disabled={!ready} onClick={() => void remove()}>Delete tool</Btn></> : <Btn size="sm" variant="danger" disabled={!ready} onClick={() => setRemoving(true)}>Delete tool…</Btn>}</div>{error ? <ErrorNotice message={error}/> : null}
  </Dialog>;
}

function BotCreatedToolEditor({ tool, readinessSupported, onClose, onSaved }: { tool?: BotCreatedTool; readinessSupported: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(tool?.name ?? ''), [description, setDescription] = useState(tool?.description ?? ''), [command, setCommand] = useState(tool?.command ?? '');
  const [schema, setSchema] = useState(JSON.stringify(tool?.inputSchema ?? emptySchema, null, 2)), [timeout, setTimeout] = useState(String(tool?.timeoutSeconds ?? 30)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false);
  const [platforms, setPlatforms] = useState(tool?.requirements?.platforms ?? []), [executables, setExecutables] = useState(tool?.requirements?.executables?.join('\n') ?? ''), [workspaceFiles, setWorkspaceFiles] = useState(tool?.requirements?.workspaceFiles?.join('\n') ?? '');
  async function save() {
    if (busy || conflict) return;
    let inputSchema: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(schema); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>).type !== 'object') throw new Error(); inputSchema = parsed as Record<string, unknown>; }
    catch { setError('Enter a JSON object schema with type "object".'); return; }
    const seconds = Number(timeout); if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) { setError('Choose a timeout from 1 to 120 seconds.'); return; }
    const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
    const draft: BotCreatedToolDraft = {name: name.trim(), description: description.trim(), command, inputSchema, timeoutSeconds: seconds, ...(readinessSupported ? { requirements: { platforms, executables: lines(executables), workspaceFiles: lines(workspaceFiles) } } : {})};
    setBusy(true); setError('');
    try { if (tool) await api.patch(`/api/bots/tools/${encodeURIComponent(tool.id)}`, {...draft, status: 'draft', expectedRevision: tool.revision, expectedDigest: tool.digest}); else await api.post('/api/bots/tools', draft); await onSaved(); }
    catch (cause) { setError(errorMessage(cause)); if (cause instanceof ApiError && cause.status === 409) setConflict(true); }
    finally { setBusy(false); }
  }
  return <Dialog open title={tool ? 'Edit tool draft' : 'New tool draft'} className="bots-workspace-dialog bots-created-tool-dialog" onClose={() => { if (!busy) onClose(); }} actions={<><Btn disabled={busy} onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={busy || conflict || !name.trim() || !description.trim() || !command.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save draft'}</Btn></>}>
    <div className="form-stack"><label className="input-field"><span>Name</span><input className="st-input" maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)}/></label><label className="input-field"><span>Purpose</span><textarea className="st-input" rows={2} maxLength={2000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)}/></label>
      <label className="input-field"><span>Command</span><textarea className="st-input bots-skill-body" rows={6} maxLength={32000} value={command} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => setCommand(event.target.value)}/></label><p className="xs muted">Read JSON inputs from the STRATA_TOOL_INPUT environment variable. Inputs are data; Strata does not insert them into the command source. Commands use the bot’s selected local, SSH or isolated computer and workspace.</p>
      <label className="input-field"><span>Input schema · JSON</span><textarea className="st-input bots-skill-body" rows={8} maxLength={16000} value={schema} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => setSchema(event.target.value)}/></label><p className="xs muted">Use a flat object with string, number, integer or boolean properties, and additionalProperties set to false. Use an empty properties object for a tool without inputs.</p>
      {readinessSupported ? <fieldset className="form-stack"><legend>Computer requirements · optional</legend><div className="row">{(['darwin','linux','win32'] as const).map(platform => <label key={platform}><input type="checkbox" checked={platforms.includes(platform)} disabled={busy} onChange={event => setPlatforms(event.target.checked ? [...platforms,platform] : platforms.filter(value => value !== platform))}/>{platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux'}</label>)}</div><p className="xs muted">Leave all platforms unchecked to allow any supported platform.</p><label className="input-field"><span>Required programs · one name per line</span><textarea className="st-input" rows={3} maxLength={1100} placeholder={'python3\ngit'} value={executables} disabled={busy} onChange={event => setExecutables(event.target.value)}/></label><label className="input-field"><span>Required workspace files · one relative path per line</span><textarea className="st-input" rows={3} maxLength={3900} placeholder="scripts/check_project.py" value={workspaceFiles} disabled={busy} onChange={event => setWorkspaceFiles(event.target.value)}/></label><p className="xs muted">Up to 16 programs and 16 files. Changes require review again. Checks run on the selected computer and install nothing.</p></fieldset> : <p className="xs muted">Update the host to declare computer requirements.</p>}
      <label className="input-field"><span>Timeout · seconds</span><input className="st-input" type="number" min={1} max={120} step={1} value={timeout} disabled={busy} onChange={event => setTimeout(event.target.value)}/></label><p className="xs muted">Saving creates a draft and executes nothing. Review and enable it separately, then choose access. Changes to an existing command require a new review.</p>{conflict ? <p className="small muted">Close this draft and reopen the latest tool before editing again. Your changes have not overwritten it.</p> : null}{error ? <ErrorNotice message={error}/> : null}
    </div>
  </Dialog>;
}
