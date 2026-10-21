import { useState } from 'react';
import { api } from '../lib/client';
import { pickWorkspace } from '../lib/store';
import { botComputerLabel, type Bot, type BotHostFolder } from '../lib/bots';
import { Btn, ErrorNotice, Select } from './ui';

/** A separate explicit grant; editing a profile or opening this form grants nothing. */
export function BotHostFolderSettings({ bot, onSaved }: { bot: Bot; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(!!bot.hostFolder);
  const [path, setPath] = useState(bot.hostFolder?.path ?? '');
  const [access, setAccess] = useState<BotHostFolder['access']>(bot.hostFolder?.access ?? 'read');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  async function save() {
    setBusy(true); setError(''); setSaved(false);
    try {
      await api.put(`/api/bots/${bot.id}/host-folder`, { expectedUpdatedAt: bot.updatedAt, hostFolder: enabled ? { path: path.trim(), access } : null });
      setSaved(true); onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="form-stack" aria-label="Shared host folder settings">
    <label className="row small"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => { setEnabled(event.target.checked); setSaved(false); }}/>Share a host folder</label>
    <p className="xs muted">Choose one folder on {botComputerLabel(bot.execution)}. The isolated bot can list and read text files through dedicated tools. Commands and browser tools stay inside its computer.</p>
    {enabled ? <>
      <label className="input-field"><span>Host folder path</span><div className="row"><input className="st-input" aria-label="Shared host folder path" value={path} disabled={busy} autoCapitalize="none" autoCorrect="off" placeholder="/full/path/to/project" onChange={event => { setPath(event.target.value); setSaved(false); }}/>{bot.execution.kind === 'local' ? <Btn icon="folder" disabled={busy} onClick={() => void pickWorkspace().then(value => { if (value) { setPath(value); setSaved(false); } }).catch(cause => setError(String(cause)))}>Choose folder</Btn> : null}</div></label>
      <div className="input-field"><span>Access</span><Select ariaLabel="Shared host folder access" value={access} disabled={busy} options={[{ value: 'read', label: 'Read only' }, { value: 'read-write', label: 'Read and write' }]} onChange={value => { setAccess(value); setSaved(false); }}/></div>
      <p className="xs muted">{access === 'read-write' ? 'Allows text file changes inside this folder. The bot’s approval mode still applies.' : 'The bot cannot change files through this share.'} Teams sharing this bot’s isolated computer inherit its folder access.</p>
    </> : null}
    <p className="xs muted">Changes apply to new chats and team runs. Removing or changing access also revokes it from older chats. Saving starts no computer or model.</p>
    <Btn disabled={busy || enabled && !path.trim().startsWith('/')} onClick={() => void save()}>{busy ? 'Saving…' : enabled ? 'Save folder access' : 'Remove folder access'}</Btn>
    {saved ? <p className="small" role="status">Folder access saved.</p> : null}
    {error ? <ErrorNotice message={error} action="Dismiss" onRetry={() => setError('')}/> : null}
  </div>;
}
