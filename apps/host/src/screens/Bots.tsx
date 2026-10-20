import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import { href, navigate, useLocation } from '../lib/router';
import { adoptSharedConversation, pickWorkspace, selectSession, useStore } from '../lib/store';
import { sessionTitle } from '../lib/session-title';
import { relTime } from '../lib/format';
import { BOT_PROVIDERS, blankBot, botCapabilityLabel, botComputerLabel, botConversations, botDraftError, botPolicyLabel, botProviderName, type Bot, type BotDraft, type BotsSnapshot } from '../lib/bots';
import type { Session } from '../lib/types';
import { Screen } from '../components/layout';
import { Btn, Dialog, Empty, ErrorNotice, Icon, IconBtn, Pill, Select, Seg } from '../components/ui';
import './Bots.css';

export function BotsScreen() {
  const location = useLocation();
  const sessions = useStore(state => state.sessions);
  const workspace = useStore(state => state.workspaces.find(item => item.id === state.activeWorkspace)?.path ?? state.workspacePath);
  const [snapshot, setSnapshot] = useState<BotsSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'code' | 'computer'>('all');
  const [editing, setEditing] = useState<{ id?: string; draft: BotDraft; apiKeySet?: boolean } | null>(null);
  const [editorError, setEditorError] = useState('');
  const [removing, setRemoving] = useState<Bot | null>(null);

  async function refresh() {
    setLoading(true);
    try { setSnapshot(await api.get<BotsSnapshot>('/api/bots')); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function action(id: string, operation: () => Promise<void>) {
    setPending(id); setError('');
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  }
  function edit(bot?: Bot) {
    setEditorError('');
    setEditing(bot ? { id: bot.id, apiKeySet: bot.providerSettings?.apiKeySet, draft: {
      name: bot.name, instructions: bot.instructions, provider: bot.provider, model: bot.model, capabilities: bot.capabilities,
      policy: bot.policy, workspace: bot.workspace, execution: { ...bot.execution },
      ...(bot.providerSettings?.baseURL ? { providerSettings: { baseURL: bot.providerSettings.baseURL } } : {}),
    } } : { draft: blankBot(workspace) });
  }
  function update(patch: Partial<BotDraft>) { setEditing(current => current ? { ...current, draft: { ...current.draft, ...patch } } : current); }
  function closeEditor() { if (!pending) { setEditing(null); setEditorError(''); } }
  async function save() {
    if (!editing) return;
    const validation = botDraftError(editing.draft);
    if (validation) { setEditorError(validation); return; }
    setPending('save'); setEditorError('');
    try {
      const body = { ...editing.draft, name: editing.draft.name.trim(), workspace: editing.draft.workspace.trim(), model: editing.draft.model.trim() };
      const result = editing.id ? await api.patch<{ bot: Bot }>(`/api/bots/${encodeURIComponent(editing.id)}`, body) : await api.post<{ bot: Bot }>('/api/bots', body);
      setSnapshot(current => current ? { ...current, bots: [result.bot, ...current.bots.filter(bot => bot.id !== result.bot.id)] } : current);
      setEditing(null); await refresh(); navigate('bots', result.bot.id);
    } catch (cause) { setEditorError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  }
  async function newChat(bot: Bot) {
    const result = await api.post<{ conversation: Session }>(`/api/bots/${encodeURIComponent(bot.id)}/conversations`);
    adoptSharedConversation(result.conversation); selectSession(result.conversation.id); navigate('chat', result.conversation.id);
  }
  const bots = (snapshot?.bots ?? []).filter(bot => (!query.trim() || `${bot.name} ${bot.instructions} ${botProviderName(bot.provider)}`.toLowerCase().includes(query.trim().toLowerCase())) && (filter === 'all' || bot.capabilities === filter || bot.capabilities === 'both'));
  const draft = editing?.draft;
  const selectedProvider = snapshot?.providers.find(provider => provider.id === draft?.provider);

  return <Screen title={tr('Bots')} titleDetail={tr('Code, create and work across computers')} width="wide" actions={<><IconBtn name="refresh" title={tr('Refresh bots and providers')} disabled={loading || !!pending} onClick={() => void refresh()}/><Btn icon="plus" variant="primary" disabled={!snapshot || !!pending} onClick={() => edit()}>{tr('New bot')}</Btn></>}>
    <div className="bots-page">
      {error ? <ErrorNotice message={error} action={tr('Refresh')} onRetry={() => void refresh()}/> : null}
      <section className="bots-intro" aria-label={tr('Bots overview')}>
        <span className="bots-intro__icon"><Icon name="experts" size={26}/></span><div><h2 className="h3">{tr('Your team, on your computers')}</h2><p className="small muted">{tr('Give each bot a provider, a workspace and permission to code, use a computer, or both. Continue the same conversation on your Mac and paired iPhone.')}</p></div>
      </section>
      <details className="bots-providers" open={!snapshot?.bots.length || undefined}>
        <summary><span>{tr('Providers')}</span><span className="xs muted">{snapshot ? tr('{0} of 5 available', [snapshot.providers.filter(provider => provider.available).length]) : tr('Checking…')}</span><Icon name="chevron" size={15}/></summary>
        <div className="bots-provider-grid">{BOT_PROVIDERS.map(definition => {
          const provider = snapshot?.providers.find(item => item.id === definition.id);
          return <article className="bots-provider" key={definition.id}><div className="row"><strong>{definition.name}</strong><span className="spacer"/><Pill badge tone={provider?.available ? 'accent' : 'plain'}>{tr(provider?.available ? 'Available' : loading ? 'Checking' : 'Setup needed')}</Pill></div><p className="xs muted">{provider?.detail ?? tr(loading ? 'Checking the provider on this Mac…' : 'Refresh to check this provider.')}</p></article>;
        })}</div>
        <p className="xs muted bots-provider-note">{tr('Provider accounts stay on the Mac. Your saved Strata and Maya model connections remain separate.')}</p>
      </details>
      <div className="bots-toolbar"><Seg value={filter} options={[{ value: 'all', label: 'All bots' }, { value: 'code', label: 'Coding', icon: 'tool' }, { value: 'computer', label: 'Computer', icon: 'computer' }]} onChange={setFilter} ariaLabel={tr('Filter bots')}/><label className="bots-search"><Icon name="search" size={16}/><input className="st-input st-input--bare" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={tr('Search bots…')} aria-label={tr('Search bots')}/></label></div>
      {loading && !snapshot ? <p className="small muted" role="status">{tr('Loading bots…')}</p> : null}
      {snapshot && !bots.length ? <Empty icon="experts" title={tr(snapshot.bots.length ? 'No matching bots' : 'Build your first bot')} body={snapshot.bots.length ? tr('Try another search or filter.') : tr('Choose a provider and the computer it works on. Saving a bot starts no work.')} action={<Btn icon={snapshot.bots.length ? 'search' : 'plus'} onClick={() => snapshot.bots.length ? (setQuery(''), setFilter('all')) : edit()}>{tr(snapshot.bots.length ? 'Clear filters' : 'Create a bot')}</Btn>}/> : null}
      <div className="bots-grid">{bots.map(bot => {
        const chats = botConversations(sessions, bot.id);
        const active = chats.some(chat => chat.active);
        const provider = snapshot?.providers.find(item => item.id === bot.provider);
        const available = bot.available ?? (bot.execution.kind === 'local' ? provider?.available : false);
        const expanded = location.param === bot.id;
        return <article className="bot-card" key={bot.id} data-selected={expanded || undefined}>
          <header className="bot-card__head"><span className="bot-card__avatar"><Icon name={bot.capabilities === 'computer' ? 'computer' : bot.capabilities === 'code' ? 'tool' : 'experts'} size={24}/></span><div className="bot-card__identity"><h2 className="h3">{bot.name}</h2><span className="small muted">{botProviderName(bot.provider)}{bot.model ? ` · ${bot.model}` : ''}</span></div><IconBtn name="pencil" title={tr('Edit {0}', [bot.name])} disabled={!!pending} onClick={() => edit(bot)}/></header>
          <div className="bot-card__tags"><Pill badge>{tr(botCapabilityLabel(bot.capabilities))}</Pill><Pill badge dot tone={active ? 'accent' : available ? 'plain' : 'warn'}>{tr(active ? 'Working' : available ? 'Available' : 'Setup needed')}</Pill></div>
          <p className="bot-card__instructions small muted">{bot.instructions.trim() || tr('Add instructions to give this bot its own focus and working style.')}</p>
          <dl className="bot-card__facts"><div><dt><Icon name="computer" size={15}/>{tr('Computer')}</dt><dd title={botComputerLabel(bot.execution)}>{botComputerLabel(bot.execution)}</dd></div><div><dt><Icon name="folder" size={15}/>{tr('Workspace')}</dt><dd title={bot.workspace}>{bot.workspace}</dd></div><div><dt><Icon name="shield" size={15}/>{tr('Permissions')}</dt><dd>{tr(botPolicyLabel(bot.policy))}</dd></div></dl>
          {!available && !active ? <p className="xs muted bot-card__availability">{bot.detail ?? (bot.execution.kind === 'local' ? provider?.detail : snapshot?.computers.find(computer => computer.kind === bot.execution.kind)?.detail) ?? tr('This execution computer needs setup before a bot can run.')}</p> : null}
          <footer className="bot-card__actions">{chats.length ? <Btn icon="chat" variant="primary" disabled={!!pending} onClick={() => { selectSession(chats[0].id); navigate('chat', chats[0].id); }}>{tr(active ? 'Open conversation' : 'Continue')}</Btn> : null}<Btn icon="new-chat" variant={chats.length ? 'secondary' : 'primary'} disabled={!!pending} onClick={() => void action(bot.id, () => newChat(bot))}>{tr(pending === bot.id ? 'Opening…' : 'New chat')}</Btn><span className="spacer"/><IconBtn name="trash" title={tr('Remove {0}', [bot.name])} disabled={!!pending || active} onClick={() => setRemoving(bot)}/></footer>
          {chats.length ? <div className="bot-card__history"><button type="button" className="bot-card__history-toggle" aria-expanded={expanded} aria-controls={`bot-history-${bot.id}`} onClick={() => navigate('bots', expanded ? undefined : bot.id)}><Icon name="clock" size={14}/>{tr(chats.length === 1 ? '1 conversation' : '{0} conversations', [chats.length])}<span className="spacer"/><Icon name="chevron" size={13}/></button>{expanded ? <div id={`bot-history-${bot.id}`}>{chats.slice(0, 8).map(chat => <a key={chat.id} href={href('chat', chat.id)} onClick={() => selectSession(chat.id)}><span>{sessionTitle(chat)}</span><span className="xs muted">{chat.active ? tr('Working') : relTime(chat.updatedAt)}</span></a>)}</div> : null}</div> : null}
        </article>;
      })}</div>
    </div>
    <Dialog open={!!editing} title={tr(editing?.id ? 'Edit bot' : 'New bot')} className="bot-editor" onClose={closeEditor} actions={<><Btn disabled={!!pending} onClick={closeEditor}>{tr('Cancel')}</Btn><Btn icon="check" variant="primary" disabled={!!pending || !draft?.name.trim() || !draft.workspace.trim()} onClick={() => void save()}>{tr(pending === 'save' ? 'Saving…' : 'Save bot')}</Btn></>}>
      {draft ? <div className="bot-editor__fields">
        <label className="input-field"><span>{tr('Name')}</span><input className="st-input" maxLength={120} value={draft.name} placeholder={tr('My coding partner')} onChange={event => update({ name: event.target.value })}/></label>
        <div className="input-field"><span>{tr('Capabilities')}</span><Seg value={draft.capabilities} options={[{ value: 'code', label: 'Coding', icon: 'tool' }, { value: 'computer', label: 'Computer', icon: 'computer' }, { value: 'both', label: 'Both', icon: 'experts' }]} onChange={capabilities => update({ capabilities })} ariaLabel={tr('Bot capabilities')}/></div>
        <div className="bot-editor__grid"><div className="input-field"><span>{tr('Provider')}</span><Select value={draft.provider} ariaLabel={tr('Bot provider')} options={BOT_PROVIDERS.map(provider => ({ value: provider.id, label: provider.name }))} onChange={provider => update({ provider, model: '', providerSettings: undefined })}/></div><label className="input-field"><span>{tr('Model')}</span><input className="st-input" list="bot-provider-models" maxLength={240} value={draft.model} placeholder={tr('Provider default')} onChange={event => update({ model: event.target.value })}/><datalist id="bot-provider-models">{selectedProvider?.models?.map(model => <option key={model} value={model}/>)}</datalist></label></div>
        <p className="xs muted bot-editor__hint">{selectedProvider?.detail ?? tr('The provider runs on the execution computer using its configured account.')}</p>
        {draft.provider === 'ollama' ? <details className="bot-editor__advanced"><summary>{tr('Ollama Cloud connection')}</summary><div className="form-stack"><label className="input-field"><span>{tr('API address')}</span><input className="st-input" type="url" value={draft.providerSettings?.baseURL ?? ''} placeholder="https://ollama.com/v1" autoCapitalize="none" autoCorrect="off" onChange={event => update({ providerSettings: { ...draft.providerSettings, baseURL: event.target.value } })}/></label><label className="input-field"><span>{tr(editing?.apiKeySet ? 'Replace API key' : 'API key')}</span><input className="st-input" type="password" autoComplete="new-password" value={draft.providerSettings?.apiKey ?? ''} placeholder={tr(editing?.apiKeySet ? 'Saved on this Mac' : 'Use the configured account when left empty')} onChange={event => update({ providerSettings: { ...draft.providerSettings, apiKey: event.target.value, clearKey: false } })}/></label>{editing?.apiKeySet ? <label className="row small"><input type="checkbox" checked={draft.providerSettings?.clearKey === true} onChange={event => update({ providerSettings: { ...draft.providerSettings, apiKey: '', clearKey: event.target.checked } })}/>{tr('Remove saved API key')}</label> : null}</div></details> : null}
        <div className="input-field"><span>{tr('Execution computer')}</span><Select value={draft.execution.kind} ariaLabel={tr('Bot execution computer')} options={[{ value: 'local', label: 'This Mac' }, { value: 'ssh', label: 'SSH computer' }, { value: 'sandbox', label: 'Sandbox' }]} onChange={kind => update({ execution: { kind } })}/></div>
        {draft.execution.kind !== 'local' ? <><label className="input-field"><span>{tr(draft.execution.kind === 'ssh' ? 'SSH host or alias' : 'Sandbox address')}</span><input className="st-input" autoCapitalize="none" autoCorrect="off" value={draft.execution.host ?? ''} placeholder={draft.execution.kind === 'ssh' ? 'my-workstation' : 'https://sandbox.example'} onChange={event => update({ execution: { ...draft.execution, host: event.target.value } })}/></label>{draft.execution.kind === 'ssh' ? <div className="bot-editor__grid"><label className="input-field"><span>{tr('SSH user')}</span><input className="st-input" autoCapitalize="none" autoCorrect="off" value={draft.execution.user ?? ''} placeholder={tr('From SSH configuration')} onChange={event => update({ execution: { ...draft.execution, user: event.target.value } })}/></label><label className="input-field"><span>{tr('SSH port')}</span><input className="st-input" type="number" min={1} max={65535} value={draft.execution.port ?? ''} placeholder="22" onChange={event => update({ execution: { ...draft.execution, port: event.target.value ? Number(event.target.value) : undefined } })}/></label></div> : null}<p className="xs muted">{snapshot?.computers.find(computer => computer.kind === draft.execution.kind)?.detail ?? tr('The execution computer must have a supported bot runtime. Saving this profile does not connect to it.')}</p></> : null}
        <label className="input-field"><span>{tr('Workspace on this computer')}</span><div className="row"><input className="st-input" value={draft.workspace} autoCapitalize="none" autoCorrect="off" placeholder="/path/to/project" onChange={event => update({ workspace: event.target.value })}/>{draft.execution.kind === 'local' ? <Btn icon="folder" disabled={!!pending} onClick={() => { void action('folder', async () => { const path = await pickWorkspace(); if (path) update({ workspace: path }); }); }}>{tr('Choose')}</Btn> : null}</div></label>
        <div className="input-field"><span>{tr('Permissions')}</span><Select value={draft.policy} ariaLabel={tr('Bot permission policy')} options={[{ value: 'manual', label: 'Ask before changes' }, { value: 'plan', label: 'Plan first' }, { value: 'bypass', label: 'Automatic' }]} onChange={policy => update({ policy })}/><small className="muted">{tr(draft.policy === 'bypass' ? 'Tools run without approval prompts within the bot’s configured capabilities.' : draft.policy === 'plan' ? 'Work starts with a plan. Changes still follow the runtime’s permission rules.' : 'Review requests before the bot makes changes or controls a computer.')}</small></div>
        <label className="input-field"><span>{tr('Instructions')}</span><textarea className="st-input bot-editor__instructions" rows={5} maxLength={32000} placeholder={tr('What should this bot focus on? How should it work with you?')} value={draft.instructions} onChange={event => update({ instructions: event.target.value })}/></label>
        <p className="xs muted">{tr('Saving creates a profile. Start work by opening a conversation and sending a message. Chat history, supported thinking and tool activity are shared with your paired iPhone.')}</p>
        <p className="xs muted">{tr('Profile changes apply to new conversations. Existing conversations keep their original settings.')}</p>
        {editorError ? <ErrorNotice message={editorError} action={tr('Dismiss')} onRetry={() => setEditorError('')}/> : null}
      </div> : null}
    </Dialog>
    <Dialog open={!!removing} title={tr('Remove bot profile?')} compact onClose={() => { if (!pending) setRemoving(null); }} actions={<><Btn disabled={!!pending} onClick={() => setRemoving(null)}>{tr('Keep bot')}</Btn><Btn variant="danger" disabled={!!pending} onClick={() => { if (removing) void action('delete', async () => { await api.del(`/api/bots/${encodeURIComponent(removing.id)}`); setRemoving(null); await refresh(); }); }}>{tr(pending === 'delete' ? 'Removing…' : 'Remove bot')}</Btn></>}><p>{tr('Remove {0} from Bots?', [removing?.name ?? ''])}</p><p className="small muted">{tr('Existing conversations stay in your chat history.')}</p></Dialog>
  </Screen>;
}
