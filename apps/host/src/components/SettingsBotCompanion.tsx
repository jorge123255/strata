import { useEffect, useId, useRef, useState } from 'react';
import { tr } from '../lib/i18n';
import { Btn, ErrorNotice, Field, Icon, Select } from './ui';
import './SettingsBotCompanion.css';

interface CompanionSettings { enabled: boolean; screen: string }
type CompanionStatus = { available: false; detail?: string } | {
  available: true; settings: CompanionSettings; screens: { id: string; name: string }[];
  visible: boolean; expanded: boolean; detail?: string;
};
const displayId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function statusFrom(value: unknown): CompanionStatus {
  if (!record(value) || typeof value.available !== 'boolean' || value.detail !== undefined && (typeof value.detail !== 'string' || value.detail.length > 1000)) throw new Error('The Mac companion settings were incomplete. Refresh to check them again.');
  if (!value.available) return { available: false, ...(typeof value.detail === 'string' ? { detail: value.detail } : {}) };
  if (!record(value.settings) || typeof value.settings.enabled !== 'boolean' || !(value.settings.screen === 'main' || displayId(value.settings.screen)) || typeof value.visible !== 'boolean' || typeof value.expanded !== 'boolean' || !Array.isArray(value.screens) || value.screens.length > 64 || value.screens.some(screen => !record(screen) || !displayId(screen.id) || typeof screen.name !== 'string' || !screen.name.trim() || screen.name.length > 300) || new Set(value.screens.map(screen => (screen as { id: string }).id.toLowerCase())).size !== value.screens.length) throw new Error('The Mac companion settings were incomplete. Refresh to check them again.');
  return value as CompanionStatus;
}

/** Native preferences are canonical. This component never saves a local shadow or starts bot work. */
export function SettingsBotCompanion() {
  const [status, setStatus] = useState<CompanionStatus | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState<'read' | 'write' | null>('read'), [confirmed, setConfirmed] = useState(false), [uncertainWrite, setUncertainWrite] = useState(false);
  const mounted = useRef(false), generation = useRef(0), request = useRef<{ controller: AbortController; kind: 'read' | 'write' } | null>(null);
  const titleId = useId(), hintId = useId();
  const base = (globalThis as { __STRATA_HOST__?: string }).__STRATA_HOST__ ?? '';

  async function refresh(patch?: Partial<CompanionSettings>) {
    if (!mounted.current || request.current?.kind === 'write' || document.hidden) return;
    request.current?.controller.abort();
    const controller = new AbortController(), kind = patch ? 'write' : 'read', selected = ++generation.current;
    request.current = { controller, kind }; setBusy(kind); setError(''); setUncertainWrite(false);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const current = () => mounted.current && selected === generation.current && !controller.signal.aborted;
    try {
      const response = await Promise.race([
        (async () => {
          const result = await fetch(`${base}/api/bots/companion${patch ? '/settings' : ''}`, { method: patch ? 'POST' : 'GET', ...(patch ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) } : {}), signal: controller.signal, redirect: 'error' });
          // Older hosts do not have this optional native surface.
          if (!patch && result.status === 404) return { available: false, detail: 'The bot companion is available in the updated Strata Mac app.' };
          const body: unknown = await result.json();
          if (!result.ok) throw new Error(record(body) && typeof body.error === 'string' ? body.error.slice(0, 1000) : 'The Mac companion settings could not be updated. Refresh and try again.');
          return body;
        })(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => { reject(new Error('The Mac did not answer in time. Refresh to check the current companion settings.')); controller.abort(); }, 10000); }),
      ]);
      if (!current()) return;
      setStatus(statusFrom(response)); setConfirmed(true);
    } catch (cause) {
      // Aborts caused by replacement/unmount are not failures. A timeout still
      // belongs to this generation, and an uncertain write needs a fresh read.
      if (mounted.current && selected === generation.current) { setError(cause instanceof Error ? cause.message : 'The Mac companion settings could not be checked.'); setConfirmed(false); setUncertainWrite(kind === 'write'); }
    } finally {
      clearTimeout(timeout);
      if (mounted.current && selected === generation.current) { request.current = null; setBusy(null); }
    }
  }

  useEffect(() => {
    mounted.current = true; void refresh();
    const shown = () => {
      if (document.hidden) {
        if (request.current?.kind === 'read') { request.current.controller.abort(); request.current = null; generation.current++; setBusy(null); }
      } else void refresh();
    };
    const timer = setInterval(() => { if (!document.hidden && !request.current) void refresh(); }, 15000);
    document.addEventListener('visibilitychange', shown); window.addEventListener('focus', shown);
    return () => { mounted.current = false; generation.current++; request.current?.controller.abort(); request.current = null; clearInterval(timer); document.removeEventListener('visibilitychange', shown); window.removeEventListener('focus', shown); };
  }, []);

  const native = status?.available === true ? status : null, available = !!native, settings = native?.settings;
  const missing = !!settings && settings.screen !== 'main' && !native!.screens.some(screen => screen.id === settings.screen);
  const disabled = !available || !confirmed || busy !== null;
  const options = [{ value: 'main', label: 'Main display' }, ...(native ? native.screens.map(screen => ({ value: screen.id, label: screen.name })) : []), ...(missing ? [{ value: settings!.screen, label: 'Unavailable display · using Main display', disabled: true }] : [])];
  return <section className="settings-bot-companion" aria-labelledby={titleId} aria-busy={busy !== null}>
    <div className="settings-bot-companion__heading"><span className="settings-bot-companion__mark"><Icon name="activity" size={21}/></span><div><h2 className="h3" id={titleId}>{tr('Bot companion')}</h2><p className="small muted">{tr('A little company while your bots work. Keep their activity in a compact panel on your desktop.')}</p></div></div>
    <div className="st-card st-card--flush">
      <Field label={tr('Show bot companion')} hint={tr('Keep your bots visible while Strata is open or minimized.')}><button type="button" className="st-toggle" role="switch" aria-label={tr('Show bot companion')} aria-checked={settings?.enabled ?? false} aria-describedby={hintId} disabled={disabled} onClick={() => { if (settings) void refresh({ enabled: !settings.enabled }); }}/></Field>
      {available ? <Field label={tr('Display')} hint={tr(missing ? 'Your chosen display is disconnected. The companion uses Main display until it returns; your choice is remembered.' : 'Choose where the companion lives. Main display follows your macOS display settings.')}><Select ariaLabel={tr('Bot companion display')} value={settings!.screen} options={options} disabled={disabled} onChange={screen => void refresh({ screen })}/></Field> : null}
    </div>
    <p className="xs muted settings-bot-companion__detail" id={hintId} role="status">{tr(busy === 'write' ? 'Updating the Mac companion…' : busy === 'read' && !status ? 'Checking Mac companion settings…' : !confirmed && status ? 'Last known settings. Refresh to check the current companion.' : status?.detail || (native ? settings!.enabled ? native.visible ? 'Your companion is on the desktop.' : 'Enabled. The companion appears when this desktop is available.' : 'Off until you turn it on.' : 'The bot companion is available in the Strata Mac app.'))}</p>
    <p className="xs muted settings-bot-companion__note">{tr('Open a conversation from the companion to review thinking, tools or approvals. Closing Strata’s main window still quits the app.')}</p>
    <div className="settings-bot-companion__actions"><Btn size="sm" icon="refresh" disabled={busy !== null} onClick={() => void refresh()}>{tr('Refresh companion settings')}</Btn></div>
    {error ? <ErrorNotice message={tr(error)} next={tr(uncertainWrite ? 'A change may already have reached the Mac. Refresh to check before changing it again.' : 'Refresh to check the current Mac companion settings.')} action={tr('Refresh settings')} onRetry={() => void refresh()}/> : null}
  </section>;
}
