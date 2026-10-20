import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/client';
import { botAvatar, type Bot } from '../lib/bots';
import { Btn, Dialog, ErrorNotice, Select } from './ui';
import './BotComputer.css';

interface ComputerState {
  available: boolean; detail?: string; computerName?: string; width?: number; height?: number;
  image?: { mimeType: string; data: string }; control?: { active: boolean; owned: boolean; expiresAt?: number };
  leaseToken?: string; expiresAt?: number;
}
export function BotComputer({ bot, chatId, onClose }: { bot: Pick<Bot, 'id' | 'name' | 'avatar'>; chatId?: string; onClose: () => void }) {
  const [state, setState] = useState<ComputerState | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const [text, setText] = useState(''), [key, setKey] = useState('Enter'), [clock, setClock] = useState(Date.now());
  const lease = useRef<{ token: string; expiresAt: number } | null>(null), alive = useRef(true), reading = useRef(false), acting = useRef(false);
  const [, redraw] = useState(0);
  const path = `/api/bots/${encodeURIComponent(bot.id)}/computer`, context = chatId ? { chatId } : {};
  const controls = !!lease.current && lease.current.expiresAt > clock;
  async function refresh() {
    if (!alive.current || reading.current || document.hidden) return;
    reading.current = true;
    try { const value = await api.get<ComputerState>(`${path}${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`); if (alive.current) setState(value); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { reading.current = false; }
  }
  async function release() {
    const held = lease.current; lease.current = null; if (alive.current) redraw(n => n + 1);
    if (held) await api.post(`${path}/release`, { ...context, leaseToken: held.token }).catch(() => {});
  }
  async function operation(name: 'start' | 'stop' | 'takeover' | 'control', input: object = {}) {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError('');
    try {
      const value = await api.post<ComputerState>(`${path}/${name}`, { ...context, ...input });
      if (!alive.current) { if (value.leaseToken) await api.post(`${path}/release`, { ...context, leaseToken: value.leaseToken }).catch(() => {}); return; }
      if (name === 'takeover' && value.leaseToken && value.expiresAt) lease.current = { token: value.leaseToken, expiresAt: value.expiresAt };
      else if (lease.current && value.expiresAt) lease.current.expiresAt = value.expiresAt;
      if (value.image || typeof value.available === 'boolean') setState(value);
      setConfirm(false); setClock(Date.now()); await refresh();
    } catch (cause) { if (alive.current) { setError(cause instanceof Error ? cause.message : String(cause)); if (name === 'control') await release(); } }
    finally { acting.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true; void refresh();
    const poll = setInterval(() => { setClock(Date.now()); void refresh(); }, 1000);
    const hidden = () => { if (document.hidden) void release(); else void refresh(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { alive.current = false; clearInterval(poll); document.removeEventListener('visibilitychange', hidden); void release(); };
    // One viewer instance belongs to an immutable bot/chat selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, chatId]);
  function input(action: string, args: object) {
    if (!lease.current || lease.current.expiresAt <= Date.now() || busy) return;
    void operation('control', { leaseToken: lease.current.token, action, ...args });
  }
  return <Dialog open title={`${botAvatar(bot.avatar)} ${bot.name} · Computer`} className="bot-computer-view" onClose={() => { void release(); onClose(); }} actions={<><Btn disabled={busy} onClick={() => void refresh()}>Refresh</Btn>{controls ? <Btn disabled={busy} onClick={() => void release()}>Release control</Btn> : <Btn variant="primary" disabled={busy || !state?.image} onClick={() => setConfirm(true)}>Take over</Btn>}<Btn disabled={busy} onClick={() => { if (window.confirm('Stop this bot’s isolated computer? Its files remain, and running processes stop.')) { void release().then(() => operation('stop')); } }}>Stop computer</Btn><Btn onClick={() => { void release(); onClose(); }}>Close</Btn></>}>
    <p className="small muted">{state?.computerName || 'Isolated CUA computer'} · {controls ? 'You have control' : state?.control?.active ? 'Another device has control' : 'Viewing'}{controls ? ` · ${Math.max(0, Math.ceil(((lease.current?.expiresAt || 0) - clock) / 1000))}s` : ''}</p>
    {error ? <ErrorNotice message={error} action="Dismiss" onRetry={() => setError('')}/> : null}
    {confirm ? <div className="bot-computer-confirm"><p>Taking over stops this bot’s work on this isolated computer. Control expires after 30 seconds without input. Releasing control leaves the bot stopped.</p><div className="row"><Btn onClick={() => setConfirm(false)}>Cancel</Btn><Btn variant="primary" disabled={busy} onClick={() => void operation('takeover')}>Stop bot and take over</Btn></div></div> : null}
    {state?.image?.mimeType === 'image/png' && state.width && state.height ? <img className="bot-computer-frame" data-controlling={controls || undefined} src={`data:image/png;base64,${state.image.data}`} alt={`${bot.name} computer desktop`} draggable={false} onClick={event => {
      if (!controls || event.currentTarget.naturalWidth !== state.width || event.currentTarget.naturalHeight !== state.height) return;
      const rect = event.currentTarget.getBoundingClientRect();
      input('click', { x: Math.min(state.width! - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * state.width!))), y: Math.min(state.height! - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * state.height!))) });
    }}/> : <div className="bot-computer-offline"><p>{state?.detail || 'Checking this computer…'}</p><Btn variant="primary" disabled={busy} onClick={() => void operation('start')}>{busy ? 'Starting…' : 'Start isolated computer'}</Btn><p className="xs muted">Start creates or resumes this bot’s CUA computer. Prepare CUA for the selected computer in the bot editor first.</p></div>}
    {controls ? <div className="bot-computer-input"><label className="input-field"><span>Text to type</span><input className="st-input" maxLength={4000} value={text} onChange={e => setText(e.target.value)}/></label><Btn disabled={busy || !text} onClick={() => { input('type', { text }); setText(''); }}>Type</Btn><Select value={key} ariaLabel="Computer key" options={['Enter','Escape','Tab','Backspace','Control+l','Control+c'].map(value => ({ value, label: value }))} onChange={setKey}/><Btn disabled={busy} onClick={() => input('key', { key })}>Send key</Btn></div> : <p className="xs muted">Snapshots refresh while this view is open. Take over explicitly to click or type.</p>}
  </Dialog>;
}
