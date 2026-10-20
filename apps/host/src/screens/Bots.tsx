import { useEffect, useRef, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import { href, navigate, useLocation } from '../lib/router';
import { adoptSharedConversation, pickWorkspace, selectSession, useStore } from '../lib/store';
import { sessionTitle } from '../lib/session-title';
import { relTime } from '../lib/format';
import { BOT_AVATARS, BOT_PROVIDERS, blankBot, botAvatar, botCapabilityLabel, botComputerLabel, botComputerSelection, botConversations, botDraftError, botPolicyLabel, botProviderName, configuredModel, configuredModelLabel, type Bot, type BotComputer as BotExecutionComputer, type BotComputerCheck, type BotDraft, type BotExecution, type BotProviderId, type BotsSnapshot } from '../lib/bots';
import type { Session } from '../lib/types';
import { BotComputer } from '../components/BotComputer';
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
  const [opening, setOpening] = useState<{ bot: Bot; execution: BotExecution; workspace: string; modelId: string } | null>(null);
  const [chatError, setChatError] = useState('');
  const [nativeDesktop, setNativeDesktop] = useState(false), [webSettings, setWebSettings] = useState(false);
  const [viewing, setViewing] = useState<Bot | null>(null);
  const [preparingCUA, setPreparingCUA] = useState(false);
  const [cuaSetup, setCuaSetup] = useState('');
  const [computerBusy, setComputerBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    try { setSnapshot(await api.get<BotsSnapshot>('/api/bots')); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); void api.get<{ available: boolean }>('/api/bots/desktop').then(value => { if (value.available) { setNativeDesktop(true); void api.post('/api/bots/desktop/open').catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); } }).catch(() => {}); }, []);

  async function action(id: string, operation: () => Promise<void>) {
    setPending(id); setError('');
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  }
  function edit(bot?: Bot) {
    setEditorError('');
    setEditing(bot ? { id: bot.id, apiKeySet: bot.providerSettings?.apiKeySet, draft: {
      name: bot.name, avatar: botAvatar(bot.avatar), computerMode: bot.computerMode ?? 'host', instructions: bot.instructions, provider: bot.provider, model: bot.model, modelSource: bot.modelSource ? { ...bot.modelSource } : undefined, capabilities: bot.capabilities,
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
  function chooseChat(bot: Bot) {
    setChatError(''); setComputerBusy(false);
    setOpening({ bot, execution: { ...bot.execution }, workspace: bot.workspace, modelId: '' });
  }
  async function newChat() {
    if (!opening) return;
    if (!opening.workspace.trim()) { setChatError('Choose a workspace on the execution computer.'); return; }
    if (opening.execution.kind === 'ssh' && !opening.execution.host?.trim()) { setChatError('Enter the SSH host or alias.'); return; }
    setPending('chat'); setChatError('');
    try {
      const target = botComputerSelection(opening.execution, snapshot?.computers ?? []);
      const body = { ...(target === 'local' || !['custom-ssh', 'sandbox'].includes(target) ? { computerId: target } : { execution: opening.execution }),
        workspace: opening.workspace.trim(), ...(opening.modelId ? { modelId: opening.modelId } : {}) };
      const result = await api.post<{ conversation: Session }>(`/api/bots/${encodeURIComponent(opening.bot.id)}/conversations`, body);
      adoptSharedConversation(result.conversation); selectSession(result.conversation.id); setOpening(null); navigate('chat', result.conversation.id);
    } catch (cause) { setChatError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  }
  const bots = (snapshot?.bots ?? []).filter(bot => (!query.trim() || `${bot.name} ${bot.instructions} ${botProviderName(bot.provider)}`.toLowerCase().includes(query.trim().toLowerCase())) && (filter === 'all' || bot.capabilities === filter || bot.capabilities === 'both'));
  const draft = editing?.draft;
  const selectedProvider = snapshot?.providers.find(provider => provider.id === draft?.provider);
  const models = snapshot?.models ?? [];
  const draftModel = configuredModel(draft?.modelSource, models);
  const openingModel = models.find(model => model.id === opening?.modelId);

  if (nativeDesktop && !webSettings) return <Screen title="Bots" titleDetail="Your bots, with their own computers" width="wide"><Empty icon="experts" title="Strata Bots" body="The native Bots window uses the CUA Bots Mac interface, connected to your Strata chats, providers and computers." action={<Btn variant="primary" icon="experts" onClick={() => void action('native', async () => { await api.post('/api/bots/desktop/open'); })}>Open Bots</Btn>}/>{error ? <ErrorNotice message={error} action="Dismiss" onRetry={() => setError('')}/> : null}<Btn onClick={() => setWebSettings(true)}>Advanced bot settings</Btn></Screen>;
  return <Screen title={tr('Bots')} titleDetail={tr('Code, create and work across computers')} width="wide" actions={<><IconBtn name="refresh" title={tr('Refresh bots and providers')} disabled={loading || !!pending} onClick={() => void refresh()}/><Btn icon="plus" variant="primary" disabled={!snapshot || !!pending} onClick={() => edit()}>{tr('New bot')}</Btn></>}>
    <div className="bots-page">
      {error ? <ErrorNotice message={error} action={tr('Refresh')} onRetry={() => void refresh()}/> : null}
      <section className="bots-intro" aria-label={tr('Bots overview')}>
        <span className="bots-intro__icon"><Icon name="experts" size={26}/></span><div><h2 className="h3">{tr('Your team, on your computers')}</h2><p className="small muted">{tr('Give each bot a provider, a workspace and permission to code, use a computer, or both. Continue the same conversation on your Mac and paired iPhone.')}</p></div>
      </section>
      <details className="bots-providers" open={!snapshot?.bots.length || undefined}>
        <summary><span>{tr('Providers')}</span><span className="xs muted">{snapshot ? tr('{0} of 5 available', [snapshot.providers.filter(provider => provider.id !== 'configured' && provider.available).length]) : tr('Checking…')}</span><Icon name="chevron" size={15}/></summary>
        <div className="bots-provider-grid">{BOT_PROVIDERS.map(definition => {
          const provider = snapshot?.providers.find(item => item.id === definition.id);
          return <article className="bots-provider" key={definition.id}><div className="row"><strong>{definition.name}</strong><span className="spacer"/><Pill badge tone={provider?.available ? 'accent' : 'plain'}>{tr(provider?.available ? 'Available' : loading ? 'Checking' : 'Setup needed')}</Pill></div><p className="xs muted">{provider?.detail ?? tr(loading ? 'Checking the provider on this Mac…' : 'Refresh to check this provider.')}</p></article>;
        })}</div>
        <p className="xs muted bots-provider-note">{tr('Native provider accounts stay on their execution computer. Models connections are selected separately, including Maya.')}</p>
      </details>
      <div className="bots-toolbar"><Seg value={filter} options={[{ value: 'all', label: 'All bots' }, { value: 'code', label: 'Coding', icon: 'tool' }, { value: 'computer', label: 'Computer', icon: 'computer' }]} onChange={setFilter} ariaLabel={tr('Filter bots')}/><label className="bots-search"><Icon name="search" size={16}/><input className="st-input st-input--bare" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={tr('Search bots…')} aria-label={tr('Search bots')}/></label></div>
      {loading && !snapshot ? <p className="small muted" role="status">{tr('Loading bots…')}</p> : null}
      {snapshot && !bots.length ? <Empty icon="experts" title={tr(snapshot.bots.length ? 'No matching bots' : 'Build your first bot')} body={snapshot.bots.length ? tr('Try another search or filter.') : tr('Choose a provider and the computer it works on. Saving a bot starts no work.')} action={<Btn icon={snapshot.bots.length ? 'search' : 'plus'} onClick={() => snapshot.bots.length ? (setQuery(''), setFilter('all')) : edit()}>{tr(snapshot.bots.length ? 'Clear filters' : 'Create a bot')}</Btn>}/> : null}
      <div className="bots-grid">{bots.map(bot => {
        const chats = botConversations(sessions, bot.id);
        const active = chats.some(chat => chat.active);
        const provider = snapshot?.providers.find(item => item.id === bot.provider);
        const connectedModel = configuredModel(bot.modelSource, models);
        const executionComputer = snapshot?.computers.find(computer => computer.id === botComputerSelection(bot.execution, snapshot.computers));
        const executionAvailable = bot.execution.kind === 'local' || executionComputer?.available === true;
        const providerAvailable = bot.provider === 'configured' ? connectedModel?.available : bot.execution.kind === 'local' ? provider?.available : false;
        const available = bot.available ?? (executionAvailable && providerAvailable);
        const expanded = location.param === bot.id;
        return <article className="bot-card" key={bot.id} data-selected={expanded || undefined}>
          <header className="bot-card__head"><span className="bot-card__avatar" role="img" aria-label={tr('Bot avatar')}>{botAvatar(bot.avatar)}</span><div className="bot-card__identity"><h2 className="h3">{bot.name}</h2><span className="small muted">{bot.provider === 'configured' ? connectedModel?.connectionName ?? tr('Saved Models connection') : botProviderName(bot.provider)}{bot.model ? ` · ${bot.model}` : ''}</span></div><IconBtn name="pencil" title={tr('Edit {0}', [bot.name])} disabled={!!pending} onClick={() => edit(bot)}/></header>
          <div className="bot-card__tags"><Pill badge>{tr(botCapabilityLabel(bot.capabilities))}</Pill><Pill badge dot tone={active ? 'accent' : available ? 'plain' : 'warn'}>{tr(active ? 'Working' : available ? 'Available' : 'Setup needed')}</Pill></div>
          <p className="bot-card__instructions small muted">{bot.instructions.trim() || tr('Add instructions to give this bot its own focus and working style.')}</p>
          <dl className="bot-card__facts"><div><dt><Icon name="computer" size={15}/>{tr('Computer')}</dt><dd title={botComputerLabel(bot.execution)}>{botComputerLabel(bot.execution)}</dd></div><div><dt><Icon name="folder" size={15}/>{tr('Workspace')}</dt><dd title={bot.workspace}>{bot.workspace}</dd></div><div><dt><Icon name="shield" size={15}/>{tr('Permissions')}</dt><dd>{tr(botPolicyLabel(bot.policy))}</dd></div></dl>
          {!available && !active ? <p className="xs muted bot-card__availability">{bot.detail ?? (bot.execution.kind === 'local' ? bot.provider === 'configured' ? connectedModel?.detail : provider?.detail : executionComputer?.detail) ?? tr('Check and prepare this execution computer before starting work.')}</p> : null}
          <footer className="bot-card__actions">{bot.computerMode === 'cua' ? <Btn icon="computer" disabled={!!pending} onClick={() => setViewing(bot)}>Computer</Btn> : null}{chats.length ? <Btn icon="chat" variant="primary" disabled={!!pending} onClick={() => { selectSession(chats[0].id); navigate('chat', chats[0].id); }}>{tr(active ? 'Open conversation' : 'Continue')}</Btn> : null}<Btn icon="new-chat" variant={chats.length ? 'secondary' : 'primary'} disabled={!!pending} onClick={() => chooseChat(bot)}>{tr(pending === bot.id ? 'Opening…' : 'New chat')}</Btn><span className="spacer"/><IconBtn name="trash" title={tr('Remove {0}', [bot.name])} disabled={!!pending || active} onClick={() => setRemoving(bot)}/></footer>
          {chats.length ? <div className="bot-card__history"><button type="button" className="bot-card__history-toggle" aria-expanded={expanded} aria-controls={`bot-history-${bot.id}`} onClick={() => navigate('bots', expanded ? undefined : bot.id)}><Icon name="clock" size={14}/>{tr(chats.length === 1 ? '1 conversation' : '{0} conversations', [chats.length])}<span className="spacer"/><Icon name="chevron" size={13}/></button>{expanded ? <div id={`bot-history-${bot.id}`}>{chats.slice(0, 8).map(chat => <a key={chat.id} href={href('chat', chat.id)} onClick={() => selectSession(chat.id)}><span>{sessionTitle(chat)}</span><span className="xs muted">{chat.active ? tr('Working') : relTime(chat.updatedAt)}</span></a>)}</div> : null}</div> : null}
        </article>;
      })}</div>
    </div>
    <Dialog open={!!editing} title={tr(editing?.id ? 'Edit bot' : 'New bot')} className="bot-editor" onClose={closeEditor} actions={<><Btn disabled={!!pending} onClick={closeEditor}>{tr('Cancel')}</Btn><Btn icon="check" variant="primary" disabled={!!pending || !draft?.name.trim() || !draft.workspace.trim()} onClick={() => void save()}>{tr(pending === 'save' ? 'Saving…' : 'Save bot')}</Btn></>}>
      {draft ? <div className="bot-editor__fields">
        <label className="input-field"><span>{tr('Name')}</span><input className="st-input" maxLength={120} value={draft.name} placeholder={tr('My coding partner')} onChange={event => update({ name: event.target.value })}/></label>
        <AvatarPicker value={botAvatar(draft.avatar)} onChange={avatar => update({ avatar })}/>
        <div className="input-field"><span>{tr('Capabilities')}</span><Seg value={draft.capabilities} options={[{ value: 'code', label: 'Coding', icon: 'tool' }, { value: 'computer', label: 'Computer', icon: 'computer' }, { value: 'both', label: 'Both', icon: 'experts' }]} onChange={capabilities => update({ capabilities })} ariaLabel={tr('Bot capabilities')}/></div>
        <div className="input-field"><span>{tr('Model source')}</span><Select value={draft.provider} ariaLabel={tr('Bot provider')} options={[...BOT_PROVIDERS.map(provider => ({ value: provider.id as BotProviderId, label: provider.name })), { value: 'configured', label: 'Choose from Models' }]} onChange={provider => update({ provider, model: '', modelSource: undefined, providerSettings: undefined })}/></div>
        {draft.provider === 'configured' ? <div className="input-field"><span>{tr('Configured model')}</span><Select value={draftModel?.id ?? ''} ariaLabel={tr('Configured bot model')} options={[{ value: '', label: draft.modelSource ? 'Saved model is no longer listed' : models.length ? 'Choose a saved model' : 'No models configured', disabled: true }, ...models.map(model => ({ value: model.id, label: configuredModelLabel(model), disabled: !model.available }))]} onChange={id => { const model = models.find(item => item.id === id); if (model) update({ model: model.model, modelSource: { connectionId: model.connectionId, model: model.model } }); }}/><small className="muted">{draftModel?.detail ?? tr('Uses only the selected connection from Models. This does not change the model serving on Strata or Maya.')}</small><a className="bot-models-link small" href={href('models')}>{tr('Manage Models connections')}</a></div> : <label className="input-field"><span>{tr('Provider model')}</span><input className="st-input" list="bot-provider-models" maxLength={240} value={draft.model} placeholder={tr('Provider default')} onChange={event => update({ model: event.target.value })}/><datalist id="bot-provider-models">{selectedProvider?.models?.map(model => <option key={model} value={model}/>)}</datalist><small className="muted">{selectedProvider?.detail ?? tr('Uses the selected native provider account on the execution computer.')}</small></label>}
        {draft.provider === 'ollama' ? <details className="bot-editor__advanced"><summary>{tr('Ollama Cloud connection')}</summary><div className="form-stack"><label className="input-field"><span>{tr('API address')}</span><input className="st-input" type="url" value={draft.providerSettings?.baseURL ?? ''} placeholder="https://ollama.com/v1" autoCapitalize="none" autoCorrect="off" onChange={event => update({ providerSettings: { ...draft.providerSettings, baseURL: event.target.value } })}/></label><label className="input-field"><span>{tr(editing?.apiKeySet ? 'Replace API key' : 'API key')}</span><input className="st-input" type="password" autoComplete="new-password" value={draft.providerSettings?.apiKey ?? ''} placeholder={tr(editing?.apiKeySet ? 'Saved on this Mac' : 'Use the configured account when left empty')} onChange={event => update({ providerSettings: { ...draft.providerSettings, apiKey: event.target.value, clearKey: false } })}/></label>{editing?.apiKeySet ? <label className="row small"><input type="checkbox" checked={draft.providerSettings?.clearKey === true} onChange={event => update({ providerSettings: { ...draft.providerSettings, apiKey: '', clearKey: event.target.checked } })}/>{tr('Remove saved API key')}</label> : null}</div></details> : null}
        <ComputerPicker execution={draft.execution} computers={snapshot?.computers ?? []} disabled={!!pending} onChange={execution => update({ execution })}/>
        <div className="input-field"><span>Computer environment</span><Select value={draft.computerMode ?? 'host'} ariaLabel="Computer environment" options={[{ value: 'host', label: 'Work on this computer' }, { value: 'cua', label: 'Isolated CUA computer' }]} onChange={computerMode => { update({ computerMode, workspace: computerMode === 'cua' ? '/workspace' : workspace }); setCuaSetup(''); }}/><small className="muted">CUA gives this bot its own persistent desktop. Its tools run inside that isolated computer.</small></div>
        {draft.computerMode === 'cua' ? <div><Btn icon="download" disabled={!!pending || preparingCUA || computerBusy} onClick={() => { setPreparingCUA(true); setCuaSetup(''); void api.post<{detail?:string}>('/api/bots/computers/prepare-cua', { execution: draft.execution }).then(value => setCuaSetup(value.detail || 'CUA prepared. Start the computer from its bot card.')).catch(cause => setCuaSetup(cause instanceof Error ? cause.message : String(cause))).finally(() => setPreparingCUA(false)); }}>{preparingCUA ? 'Preparing CUA…' : 'Prepare CUA on this computer'}</Btn><p className="xs muted">Installs CUA’s private SDK and runtime. Starting the desktop is a separate action.</p>{cuaSetup ? <p className="small" role="status">{cuaSetup}</p> : null}</div> : null}
        <label className="input-field"><span>{tr(draft.computerMode === 'cua' ? 'Workspace inside the CUA computer' : 'Workspace on this computer')}</span><div className="row"><input className="st-input" value={draft.workspace} autoCapitalize="none" autoCorrect="off" placeholder="/path/to/project" onChange={event => update({ workspace: event.target.value })}/>{draft.execution.kind === 'local' && draft.computerMode !== 'cua' ? <Btn icon="folder" disabled={!!pending} onClick={() => { void action('folder', async () => { const path = await pickWorkspace(); if (path) update({ workspace: path }); }); }}>{tr('Choose')}</Btn> : null}</div></label>
        <div className="input-field"><span>{tr('Permissions')}</span><Select value={draft.policy} ariaLabel={tr('Bot permission policy')} options={[{ value: 'manual', label: 'Ask before changes' }, { value: 'plan', label: 'Plan first' }, { value: 'bypass', label: 'Automatic' }]} onChange={policy => update({ policy })}/><small className="muted">{tr(draft.policy === 'bypass' ? 'Tools run without approval prompts within the bot’s configured capabilities.' : draft.policy === 'plan' ? 'Work starts with a plan. Changes still follow the runtime’s permission rules.' : 'Review requests before the bot makes changes or controls a computer.')}</small></div>
        <label className="input-field"><span>{tr('Instructions')}</span><textarea className="st-input bot-editor__instructions" rows={5} maxLength={32000} placeholder={tr('What should this bot focus on? How should it work with you?')} value={draft.instructions} onChange={event => update({ instructions: event.target.value })}/></label>
        <p className="xs muted">{tr('Saving creates a profile. Start work by opening a conversation and sending a message. Chat history, supported thinking and tool activity are shared with your paired iPhone.')}</p>
        <p className="xs muted">{tr('Profile changes apply to new conversations. Existing conversations keep their original settings.')}</p>
        {editorError ? <ErrorNotice message={editorError} action={tr('Dismiss')} onRetry={() => setEditorError('')}/> : null}
      </div> : null}
    </Dialog>
    <Dialog open={!!opening} title={tr('New bot conversation')} className="bot-editor" onClose={() => { if (!pending && !computerBusy) setOpening(null); }} actions={<><Btn disabled={!!pending || computerBusy} onClick={() => setOpening(null)}>{tr('Cancel')}</Btn><Btn icon="chat" variant="primary" disabled={!!pending || computerBusy || !opening?.workspace.trim()} onClick={() => void newChat()}>{tr(pending === 'chat' ? 'Opening…' : 'Open conversation')}</Btn></>}>
      {opening ? <div className="bot-editor__fields">
        <div className="bot-conversation-heading"><span className="bot-card__avatar" role="img" aria-label={tr('Bot avatar')}>{botAvatar(opening.bot.avatar)}</span><div><h3 className="h3">{opening.bot.name}</h3><p className="small muted">{tr('Choose where this conversation works.')}</p></div></div>
        <ComputerPicker execution={opening.execution} computers={snapshot?.computers ?? []} disabled={!!pending} label="Conversation computer" onBusyChange={setComputerBusy} onChange={execution => setOpening(current => current ? { ...current, execution } : null)}/>
        <p className="small muted">{opening.bot.computerMode === 'cua' ? 'Tools work inside this bot’s isolated CUA computer.' : 'Tools work on the selected host computer.'}</p>
        <label className="input-field"><span>{tr(opening.bot.computerMode === 'cua' ? 'Workspace inside the CUA computer' : 'Workspace on this computer')}</span><input className="st-input" value={opening.workspace} autoCapitalize="none" autoCorrect="off" placeholder="/path/to/project" onChange={event => setOpening({ ...opening, workspace: event.target.value })}/></label>
        <div className="input-field"><span>{tr('Model for this conversation')}</span><Select value={opening.modelId} ariaLabel={tr('Conversation model')} options={[{ value: '', label: `Bot profile · ${opening.bot.provider === 'configured' ? configuredModel(opening.bot.modelSource, models)?.connectionName ?? 'Saved Models connection' : botProviderName(opening.bot.provider)}${opening.bot.model ? ` · ${opening.bot.model}` : ''}` }, ...models.map(model => ({ value: model.id, label: configuredModelLabel(model), disabled: !model.available }))]} onChange={modelId => setOpening({ ...opening, modelId })}/><small className="muted">{openingModel?.detail ?? tr('Models connections use the saved API on the Mac. Tools run on the computer chosen above. Maya and other serving connections stay separate.')}</small></div>
        <p className="xs muted">{tr('Opening creates a shared chat. Work starts only after you send a message. This conversation keeps its selected computer and model.')}</p>
        {chatError ? <ErrorNotice message={chatError} action={tr('Dismiss')} onRetry={() => setChatError('')}/> : null}
      </div> : null}
    </Dialog>
    {viewing ? <BotComputer key={viewing.id} bot={viewing} onClose={() => setViewing(null)}/> : null}
    <Dialog open={!!removing} title={tr('Remove bot profile?')} compact onClose={() => { if (!pending) setRemoving(null); }} actions={<><Btn disabled={!!pending} onClick={() => setRemoving(null)}>{tr('Keep bot')}</Btn><Btn variant="danger" disabled={!!pending} onClick={() => { if (removing) void action('delete', async () => { await api.del(`/api/bots/${encodeURIComponent(removing.id)}`); setRemoving(null); await refresh(); }); }}>{tr(pending === 'delete' ? 'Removing…' : 'Remove bot')}</Btn></>}><p>{tr('Remove {0} from Bots?', [removing?.name ?? ''])}</p><p className="small muted">{tr('Existing conversations stay in your chat history.')}</p></Dialog>
  </Screen>;
}

function AvatarPicker({ value, onChange }: { value: string; onChange: (avatar: string) => void }) {
  return <div className="input-field"><span>{tr('Avatar')}</span><div className="bot-avatar-picker" role="radiogroup" aria-label={tr('Bot avatar')}>
    {BOT_AVATARS.map((avatar, index) => <button key={avatar.value} type="button" role="radio" aria-label={tr(avatar.label)} aria-checked={value === avatar.value} title={tr(avatar.label)} tabIndex={value === avatar.value ? 0 : -1} onClick={() => onChange(avatar.value)} onKeyDown={event => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? BOT_AVATARS.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + BOT_AVATARS.length) % BOT_AVATARS.length;
      onChange(BOT_AVATARS[next].value); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
    }}><span aria-hidden="true">{avatar.value}</span></button>)}
  </div></div>;
}

function ComputerPicker({ execution, computers, disabled, onChange, label = 'Bot execution computer', onBusyChange }: {
  execution: BotExecution; computers: BotExecutionComputer[]; disabled: boolean; onChange: (execution: BotExecution) => void;
  label?: string; onBusyChange?: (busy: boolean) => void;
}) {
  const [check, setCheck] = useState<BotComputerCheck | null>(null);
  const [busy, setBusy] = useState<'check' | 'prepare' | null>(null);
  const [error, setError] = useState('');
  const request = useRef(0);
  const targetKey = JSON.stringify([execution.kind, execution.host, execution.user, execution.port]);
  useEffect(() => { request.current++; setCheck(null); setError(''); }, [targetKey]);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { onBusyChange?.(!!busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const selected = botComputerSelection(execution, computers);
  const choices = computers.filter(computer => computer.kind === 'ssh' && computer.execution?.host);
  const selectedComputer = computers.find(computer => computer.id === selected);
  async function inspect(operation: 'check' | 'prepare') {
    const current = ++request.current;
    setBusy(operation); setError('');
    try {
      const result = await api.post<BotComputerCheck>(`/api/bots/computers/${operation}`, { execution });
      if (request.current === current) setCheck(result);
    } catch (cause) { if (request.current === current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request.current === current) setBusy(null); }
  }
  const locked = disabled || !!busy;
  return <div className="bot-computer-picker">
    <div className="input-field"><span>{tr('Execution computer')}</span><Select value={selected} ariaLabel={tr(label)} disabled={locked} options={[{ value: 'local', label: 'This Mac' }, ...choices.map(computer => ({ value: computer.id, label: `${computer.name} · ${botComputerLabel(computer.execution!)}` })), { value: 'custom-ssh', label: 'Another SSH computer…' }, { value: 'sandbox', label: 'Sandbox · setup required' }]} onChange={id => {
      if (id === 'local') onChange({ kind: 'local' });
      else if (id === 'custom-ssh') onChange({ kind: 'ssh' });
      else if (id === 'sandbox') onChange({ kind: 'sandbox' });
      else { const computer = choices.find(item => item.id === id); if (computer?.execution) onChange({ ...computer.execution }); }
    }}/></div>
    {execution.kind === 'ssh' ? <div className="bot-computer-picker__remote">
      <label className="input-field"><span>{tr('SSH host or alias')}</span><input className="st-input" disabled={locked} autoCapitalize="none" autoCorrect="off" value={execution.host ?? ''} placeholder="my-workstation" onChange={event => onChange({ ...execution, name: undefined, host: event.target.value })}/></label>
      <div className="bot-editor__grid"><label className="input-field"><span>{tr('SSH user')}</span><input className="st-input" disabled={locked} autoCapitalize="none" autoCorrect="off" value={execution.user ?? ''} placeholder={tr('From SSH configuration')} onChange={event => onChange({ ...execution, name: undefined, user: event.target.value })}/></label><label className="input-field"><span>{tr('SSH port')}</span><input className="st-input" disabled={locked} type="number" min={1} max={65535} value={execution.port ?? ''} placeholder="22" onChange={event => onChange({ ...execution, name: undefined, port: event.target.value ? Number(event.target.value) : undefined })}/></label></div>
      <p className="xs muted">{tr('Uses your Mac’s SSH keys and configuration. The selected computer runs the bot tools; a model API alone does not provide computer access.')}</p>
      <div className="bot-computer-picker__actions"><Btn icon="refresh" size="sm" disabled={locked || !execution.host?.trim()} onClick={() => void inspect('check')}>{tr(busy === 'check' ? 'Checking…' : 'Check SSH computer')}</Btn><Btn icon="download" size="sm" disabled={locked || !execution.host?.trim()} onClick={() => void inspect('prepare')}>{tr(busy === 'prepare' ? 'Preparing…' : 'Prepare SSH computer')}</Btn></div>
      <p className="xs muted">{tr('Prepare installs the private Strata bot helper over SSH. Existing model services stay separate.')}</p>
    </div> : execution.kind === 'sandbox' ? <><label className="input-field"><span>{tr('Sandbox address')}</span><input className="st-input" disabled={locked} autoCapitalize="none" autoCorrect="off" value={execution.host ?? ''} placeholder="https://sandbox.example" onChange={event => onChange({ ...execution, host: event.target.value })}/></label><p className="xs muted">{tr('A sandbox execution adapter must be configured before this target can run.')}</p></> : <p className="xs muted">{tr('Coding tools use the selected folder on this Mac. Computer control uses this Mac’s browser and desktop permissions.')}</p>}
    {selectedComputer?.detail && execution.kind === 'ssh' && !check ? <p className="xs muted">{selectedComputer.detail}</p> : null}
    {check ? <div className="bot-computer-check" data-available={check.available || undefined} role="status"><Icon name={check.available ? 'check' : 'info'} size={16}/><span>{check.detail}</span></div> : null}
    {error ? <ErrorNotice message={error} action={tr('Dismiss')} onRetry={() => setError('')}/> : null}
  </div>;
}
