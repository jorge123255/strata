// CUA Bots configuration, using the existing Strata profiles and execution helpers.
import { useEffect, useRef, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import { href } from '../lib/router';
import { pickWorkspace } from '../lib/store';
import { BOT_PROVIDERS, botComputerLabel, botComputerSelection, configuredModel, configuredModelLabel, type BotComputer as BotExecutionComputer, type BotComputerCheck, type BotDraft, type BotExecution, type BotProviderId, type BotsSnapshot, type BotProviderModels } from '../lib/bots';
import { Btn, ErrorNotice, Icon, Select, Seg } from '../components/ui';

export function CuaBotsConfig({ draft, snapshot, onChange, busy, apiKeySet, onBusyChange }: { draft: BotDraft; snapshot: BotsSnapshot; onChange: (patch: Partial<BotDraft>) => void; busy: boolean; apiKeySet?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const models = snapshot.models ?? [], model = configuredModel(draft.modelSource, models), provider = snapshot.providers.find(row => row.id === draft.provider);
  const [preparing, setPreparing] = useState(false), [detail, setDetail] = useState(''), [error, setError] = useState('');
  const [modelCatalog,setModelCatalog] = useState<BotProviderModels|null>(null), [modelError,setModelError] = useState('');
  useEffect(()=>{let current=true;setModelCatalog(null);setModelError('');if(draft.provider==='configured'||draft.provider==='ollama')return;void api.get<BotProviderModels>(`/api/bots/provider-models?provider=${encodeURIComponent(draft.provider)}`).then(catalog=>{if(current)setModelCatalog(catalog);}).catch(()=>{if(current)setModelError('Supported effort could not be verified. Use Provider default.');});return()=>{current=false;};},[draft.provider]);
  const providerModel = modelCatalog?.models.find(row=>row.id===draft.model);
  const efforts = providerModel?.efforts ?? [];
  const revision = useRef(0), target = JSON.stringify(draft.execution);
  useEffect(() => { revision.current++; setDetail(''); setError(''); }, [target]);
  useEffect(() => () => { revision.current++; }, []);
  useEffect(() => { onBusyChange?.(preparing); return () => onBusyChange?.(false); }, [preparing, onBusyChange]);
  async function prepare() {
    const request = ++revision.current; setPreparing(true); setError('');
    try { const result = await api.post<{detail?:string}>('/api/bots/computers/prepare-cua', { execution: draft.execution }); if (request === revision.current) setDetail(result.detail || 'CUA prepared. Start the desktop from the bot’s Computer pane.'); }
    catch (cause) { if (request === revision.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPreparing(false); }
  }
  return <div className="cua-config">
    <section><h3>Computer</h3><ComputerPicker execution={draft.execution} computers={snapshot.computers} disabled={busy || preparing} onBusyChange={onBusyChange} onChange={execution => onChange({ execution })}/>
      <div className="input-field"><span>Tools operate on</span><Select value={draft.computerMode ?? 'host'} ariaLabel="Computer environment" disabled={busy || preparing} options={[{ value: 'cua', label: 'Isolated CUA computer' }, { value: 'host', label: 'Selected host' }]} onChange={computerMode => onChange({ computerMode, workspace: computerMode === 'cua' ? '/workspace' : draft.workspace })}/></div>
      {draft.computerMode === 'cua' ? <><p className="xs muted">An owned Ubuntu computer with 2 CPUs and 4 GB RAM. Files, browser and commands stay inside /workspace.</p><Btn size="sm" icon="download" disabled={busy || preparing || draft.execution.kind === 'ssh' && !draft.execution.host?.trim()} onClick={() => void prepare()}>{preparing ? 'Preparing CUA…' : 'Prepare CUA on this computer'}</Btn><p className="xs muted">Installs the private SDK and runtime. Starting the desktop is a separate action.</p></> : null}
      <label className="input-field"><span>{draft.computerMode === 'cua' ? 'Workspace inside the CUA computer' : 'Workspace on selected host'}</span><div className="row"><input className="st-input" disabled={draft.computerMode === 'cua' || busy} value={draft.workspace} autoCapitalize="none" autoCorrect="off" onChange={event => onChange({ workspace: event.target.value })}/>{draft.execution.kind === 'local' && draft.computerMode !== 'cua' ? <Btn icon="folder" disabled={busy} onClick={() => void pickWorkspace().then(path => { if (path) onChange({ workspace: path }); }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))}>Choose</Btn> : null}</div></label>
      <div className="input-field"><span>Capabilities</span><Seg value={draft.capabilities} options={[{ value: 'code', label: 'Coding', icon: 'tool' }, { value: 'computer', label: 'Computer', icon: 'computer' }, { value: 'both', label: 'Both', icon: 'experts' }]} onChange={capabilities => onChange({ capabilities })} ariaLabel="Bot capabilities"/></div>
      {detail ? <p className="small" role="status">{detail}</p> : null}
    </section>
    <section><h3>Model</h3><div className="input-field"><span>Provider</span><Select value={draft.provider} ariaLabel="Bot provider" disabled={busy} options={[...BOT_PROVIDERS.map(row => ({ value: row.id as BotProviderId, label: row.name })), { value: 'configured', label: 'Models connection' }]} onChange={value => onChange({ provider: value, model: '', effort: '', modelSource: undefined, providerSettings: undefined })}/></div>
      {draft.provider === 'configured' ? <div className="input-field"><span>Saved Models connection</span><Select value={model?.id ?? ''} ariaLabel="Configured bot model" disabled={busy} options={[{ value: '', label: draft.modelSource ? 'Saved model is no longer listed' : 'Choose a saved model', disabled: true }, ...models.map(row => ({ value: row.id, label: configuredModelLabel(row), disabled: !row.available }))]} onChange={id => { const row = models.find(item => item.id === id); if (row) onChange({ model: row.model, effort: '', modelSource: { connectionId: row.connectionId, model: row.model } }); }}/><small className="muted">Maya and every Strata connection stay separate. This does not switch a server’s active model.</small><a className="bot-models-link small" href={href('models')}>Manage Models connections</a></div> : <label className="input-field"><span>Provider model</span><input className="st-input" aria-label="Provider model" list="cua-provider-models" disabled={busy} value={draft.model} maxLength={240} placeholder="Provider default" onChange={event => onChange({ model: event.target.value, effort: '' })}/><datalist id="cua-provider-models">{(modelCatalog?.models.length ? modelCatalog.models.map(row=>row.id) : provider?.models ?? []).map(name => <option key={name} value={name}/>)}</datalist><small className="muted">{draft.execution.kind === 'local' ? provider?.detail : 'Uses the provider account on the selected SSH computer.'}</small></label>}
      <div className="input-field"><span>Effort</span><Select ariaLabel="Bot reasoning effort" disabled={busy || !efforts.length && !draft.effort} value={draft.effort ?? ''} options={[{value:'',label:'Provider default'}, ...(draft.effort && !efforts.includes(draft.effort) ? [{value:draft.effort,label:`${draft.effort} · unavailable`,disabled:true}] : []), ...efforts.map(value=>({value,label:value.charAt(0).toUpperCase()+value.slice(1)}))]} onChange={effort=>onChange({effort})}/><small className="muted">{modelError || (efforts.length ? 'Uses the effort levels reported for this model. Applies to new conversations.' : 'Only Provider default is verified for this model.')}</small></div>
      {draft.provider === 'ollama' ? <details><summary>Ollama Cloud connection</summary><div className="form-stack"><label className="input-field"><span>API address</span><input className="st-input" type="url" value={draft.providerSettings?.baseURL ?? ''} placeholder="https://ollama.com/v1" autoCapitalize="none" autoCorrect="off" onChange={event => onChange({ providerSettings: { ...draft.providerSettings, baseURL: event.target.value } })}/></label><label className="input-field"><span>{apiKeySet ? 'Replace API key' : 'API key'}</span><input className="st-input" type="password" autoComplete="new-password" value={draft.providerSettings?.apiKey ?? ''} placeholder={apiKeySet ? 'Saved on this Mac' : 'Use the configured account when empty'} onChange={event => onChange({ providerSettings: { ...draft.providerSettings, apiKey: event.target.value, clearKey: false } })}/></label>{apiKeySet ? <label className="row small"><input type="checkbox" checked={draft.providerSettings?.clearKey === true} onChange={event => onChange({ providerSettings: { ...draft.providerSettings, apiKey: '', clearKey: event.target.checked } })}/>Remove saved API key</label> : null}</div></details> : null}
      <div className="input-field"><span>Permissions</span><Select value={draft.policy} ariaLabel="Bot permission policy" disabled={busy} options={[{ value: 'manual', label: 'Ask before changes' }, { value: 'plan', label: 'Plan: inspect only' }, { value: 'bypass', label: 'Automatic' }]} onChange={policy => onChange({ policy })}/><small className="muted">{draft.policy === 'bypass' ? 'Tools run without approval prompts within configured capabilities.' : draft.policy === 'plan' ? 'The bot can inspect but cannot change files or control the computer.' : 'Review requests before the bot makes changes or controls a computer.'}</small></div>
      <label className="input-field"><span>Standing instructions</span><textarea className="st-input" rows={4} maxLength={32000} value={draft.instructions} onChange={event => onChange({ instructions: event.target.value })}/></label>
    </section>
    {error ? <ErrorNotice message={error} action="Dismiss" onRetry={() => setError('')}/> : null}
  </div>;
}

export function ComputerPicker({ execution, computers, disabled, onChange, label = 'Bot execution computer', onBusyChange }: {
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
    </div> : execution.kind === 'sandbox' ? <><label className="input-field"><span>{tr('Sandbox address')}</span><input className="st-input" disabled={locked} autoCapitalize="none" autoCorrect="off" value={execution.host ?? ''} placeholder="https://sandbox.example" onChange={event => onChange({ ...execution, host: event.target.value })}/></label><p className="xs muted">{tr('A sandbox execution adapter must be configured before this target can run.')}</p></> : <p className="xs muted">{tr('Uses provider accounts and runtime preparation on this Mac. The computer environment below determines where the tools work.')}</p>}
    {selectedComputer?.detail && execution.kind === 'ssh' && !check ? <p className="xs muted">{selectedComputer.detail}</p> : null}
    {check ? <div className="bot-computer-check" data-available={check.available || undefined} role="status"><Icon name={check.available ? 'check' : 'info'} size={16}/><span>{check.detail}</span></div> : null}
    {error ? <ErrorNotice message={error} action={tr('Dismiss')} onRetry={() => setError('')}/> : null}
  </div>;
}
