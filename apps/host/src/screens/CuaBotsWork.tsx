// CUA Bots layout adaptation. FSL-1.1-MIT; see apps/bots-macos/LICENSE and UPSTREAM.md.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/client';
import { adoptSharedConversation, answerChatTool } from '../lib/store';
import { sessionTitle } from '../lib/session-title';
import { relTime } from '../lib/format';
import type { Bot } from '../lib/bots';
import type { Session } from '../lib/types';
import { CuaBotAvatar } from '../components/CuaBotAvatar';
import { Btn, Dialog, Empty, ErrorNotice, Icon, Select } from '../components/ui';

export interface BotWorkRule { id: string; action: string; behavior: 'allow' | 'pre-approved' | 'ask' | 'hand-off'; locked?: boolean; isBuiltIn?: boolean; actionClass?: string }
export interface BotWorkOutput { path: string; name: string; size: number; modified: string }
export interface BotRoutine {
  id: string; botId: string; title: string; prompt: string; enabled: boolean; notifyOnCompletion: boolean; state: string;
  schedule: { kind: 'every' | 'daily' | 'weekly'; minutes?: number; hour?: number; minute?: number; weekday?: number };
  timeZone: string; nextRun?: string | null; lastRun?: string | null; chatId?: string; detail?: string;
}
export interface BotWork { memory: string; rules: BotWorkRule[]; routines: BotRoutine[]; outputs: BotWorkOutput[]; files: BotWorkOutput[] }
export const EMPTY_BOT_WORK: BotWork = { memory: '', rules: [], routines: [], outputs: [], files: [] };
export type BotsWorkTab = 'scheduled' | 'approvals' | 'outputs';

export function useBotsWork(bots: Bot[]) {
  const [work, setWork] = useState<Record<string, BotWork>>({}), [error, setError] = useState('');
  const ids = bots.map(bot => bot.id).sort().join('|'), generation = useRef(0), reading = useRef(false);
  const refresh = useCallback(async (force = true) => {
    if (reading.current && !force) return;
    const request = ++generation.current, list = ids ? ids.split('|') : [];
    if (!list.length) { setWork(previous => Object.keys(previous).length ? {} : previous); setError(''); return; }
    reading.current = true;
    const results = await Promise.allSettled(list.map(async id => [id, await api.get<BotWork>(`/api/bots/${encodeURIComponent(id)}/work`)] as const));
    if (request !== generation.current) return;
    reading.current = false;
    setWork(previous => {
      const next: Record<string, BotWork> = {};
      results.forEach((result, index) => { if (result.status === 'fulfilled') next[result.value[0]] = result.value[1]; else if (previous[list[index]]) next[list[index]] = previous[list[index]]; });
      return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
    });
    const failed = results.find(result => result.status === 'rejected');
    setError(failed?.status === 'rejected' ? message(failed.reason) : '');
  }, [ids]);
  useEffect(() => { reading.current = false; void refresh(); if (!ids) return () => { generation.current++; }; const timer = setInterval(() => { if (!document.hidden) void refresh(false); }, 5000); return () => { generation.current++; reading.current = false; clearInterval(timer); }; }, [refresh, ids]);
  return { work, error, refresh };
}

export function BotsWorkView({ tab, bots, sessions, work, onOpenChat, onRoutine, onOutput, onRefresh }: {
  tab: BotsWorkTab; bots: Bot[]; sessions: Session[]; work: Record<string, BotWork>;
  onOpenChat: (bot: Bot, chat: Session) => void; onRoutine: (bot?: Bot, routine?: BotRoutine) => void;
  onOutput: (bot: Bot, output: BotWorkOutput) => void; onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const mounted = useRef(true), navigationRevision = useRef(0);
  useEffect(() => { mounted.current = true; const navigated = () => { navigationRevision.current++; }; window.addEventListener('hashchange', navigated); return () => { mounted.current = false; navigationRevision.current++; window.removeEventListener('hashchange', navigated); }; }, []);
  const approvals = sessions.filter(chat => bots.some(bot => bot.id === chat.preferences?.botId)).flatMap(chat => chat.messages.flatMap(row => (row.tools ?? []).filter(tool => tool.live && tool.state === 'proposed').map(tool => ({ chat, row, tool }))));
  const routines = bots.flatMap(bot => (work[bot.id]?.routines ?? []).map(routine => ({ bot, routine })));
  const outputs = bots.flatMap(bot => (work[bot.id]?.outputs ?? []).map(output => ({ bot, output }))).sort((a, b) => b.output.modified.localeCompare(a.output.modified));
  async function action(id: string, operation: () => Promise<void>) { setBusy(id); setError(''); try { await operation(); await onRefresh(); } catch (cause) { setError(message(cause)); } finally { setBusy(''); } }
  async function run(bot: Bot, routine: BotRoutine) {
    const revision = navigationRevision.current, hash = window.location.hash;
    const result = await api.post<{ conversation: Session }>(`/api/bots/${encodeURIComponent(bot.id)}/routines/${encodeURIComponent(routine.id)}/run`);
    adoptSharedConversation(result.conversation);
    if (mounted.current && revision === navigationRevision.current && hash === window.location.hash) onOpenChat(bot, result.conversation);
  }
  return <section className="cua-work" aria-label={tab === 'scheduled' ? 'Scheduled bot work' : tab === 'approvals' ? 'Bot approvals' : 'Bot outputs'}>
    <header className="cua-content-head"><div><h2 className="cua-visually-hidden">{tab === 'scheduled' ? 'Scheduled' : tab === 'approvals' ? 'Approvals' : 'Outputs'}</h2><p>{tab === 'scheduled' ? 'Routines your bots run while Strata is open.' : tab === 'approvals' ? 'The decisions your bots are waiting for.' : 'Finished files, saved in each bot’s private Volume.'}</p></div>{tab === 'scheduled' ? <Btn icon="plus" disabled={!bots.length} onClick={() => onRoutine()}>New routine</Btn> : null}</header>
    {error ? <ErrorNotice message={error} action="Dismiss" onRetry={() => setError('')}/> : null}
    {tab === 'approvals' ? approvals.length ? <div className="cua-work-list">{approvals.map(({ chat, row, tool }) => {
      const bot = bots.find(item => item.id === chat.preferences?.botId)!;
      return <article className="cua-approval" key={chat.id + ':' + tool.id}><div className="cua-work-identity"><CuaBotAvatar config={bot.avatarConfig} name={bot.name} size={30} mood="needsApproval"/><div><strong>{bot.name}</strong><p>{sessionTitle(chat)}</p></div><Btn size="sm" onClick={() => onOpenChat(bot, chat)}>Open conversation</Btn></div><h3>{tool.name}</h3><pre>{tool.preview || tool.target || tool.effect}</pre><div className="row"><Btn onClick={() => answerChatTool(chat.id, row.id, tool.id, false)}>Deny</Btn><Btn variant="primary" onClick={() => answerChatTool(chat.id, row.id, tool.id, true)}>Approve</Btn></div></article>;
    })}</div> : <Empty icon="shield" title="Nothing needs your approval" body="When a bot needs permission, its request appears here and in the shared conversation."/> : null}
    {tab === 'scheduled' ? routines.length ? <div className="cua-work-list">{routines.map(({ bot, routine }) => <article className="cua-routine" key={routine.id}>
      <div className="cua-work-identity"><CuaBotAvatar config={bot.avatarConfig} name={bot.name} size={30}/><div><strong>{routine.title}</strong><p>{bot.name} · {routineScheduleLabel(routine)}</p></div><span className="cua-work-state">{routine.state === 'running' ? 'Running' : bot.paused ? 'Bot paused' : routine.enabled ? 'Scheduled' : 'Paused'}</span></div>
      <p className="cua-routine-prompt">{routine.prompt}</p><p className="xs muted">{routine.nextRun ? `Next ${new Date(routine.nextRun).toLocaleString()} · ${routine.timeZone}` : 'No scheduled run'}{routine.lastRun ? ` · Last run ${relTime(routine.lastRun)}` : ''}</p>{routine.detail ? <p className="small">{routine.detail}</p> : null}
      <div className="row"><Btn size="sm" disabled={!!busy || routine.state === 'running' || bot.paused} icon="play" onClick={() => void action(routine.id, () => run(bot, routine))}>Run now</Btn><Btn size="sm" disabled={!!busy || routine.state === 'running'} onClick={() => onRoutine(bot, routine)}>Edit</Btn><Btn size="sm" disabled={!!busy || routine.state === 'running'} onClick={() => void action(routine.id, async () => { await api.patch(`/api/bots/${encodeURIComponent(bot.id)}/routines/${encodeURIComponent(routine.id)}`, { enabled: !routine.enabled }); })}>{routine.enabled ? 'Pause schedule' : 'Enable schedule'}</Btn><span className="spacer"/><Btn size="sm" icon="trash" disabled={!!busy || routine.state === 'running'} onClick={() => void action(routine.id, async () => { await api.del(`/api/bots/${encodeURIComponent(bot.id)}/routines/${encodeURIComponent(routine.id)}`); })}>Remove</Btn></div>
    </article>)}</div> : <Empty icon="clock" title="Give your bots a routine" body="Choose what to do and when. Scheduled work uses the bot’s current profile and the same shared chats." action={<Btn icon="plus" disabled={!bots.length} onClick={() => onRoutine()}>New routine</Btn>}/> : null}
    {tab === 'outputs' ? outputs.length ? <div className="cua-output-list">{outputs.map(({ bot, output }) => <button key={bot.id + ':' + output.path} onClick={() => onOutput(bot, output)}><Icon name="file" size={22}/><div><strong>{output.name}</strong><p>{bot.name} · {output.path}</p></div><span>{formatBytes(output.size)} · {relTime(output.modified)}</span><Icon name="chevron" size={14}/></button>)}</div> : <Empty icon="file" title="Nothing here yet" body="Ask a bot to save a finished document or summary in outputs/. It will appear here; the related conversation stays shared."/> : null}
  </section>;
}

export function BotMemoryDialog({ bot, onClose, onSaved }: { bot: Bot; onClose: () => void; onSaved: () => Promise<void> }) {
  const [text, setText] = useState(''), [loaded, setLoaded] = useState(false), [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let alive = true; setLoaded(false); setError(''); void api.get<BotWork>(`/api/bots/${encodeURIComponent(bot.id)}/work`).then(value => { if (alive) { setText(value.memory); setLoaded(true); } }).catch(cause => { if (alive) setError(message(cause)); }); return () => { alive = false; }; }, [bot.id, attempt]);
  async function save() { if (!loaded || busy) return; setBusy(true); try { await api.patch(`/api/bots/${encodeURIComponent(bot.id)}/work`, { memory: text }); await onSaved(); onClose(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }
  return <Dialog open title={`${bot.name}’s memory`} className="cua-memory-dialog" onClose={() => { if (!busy) onClose(); }} actions={<><Btn disabled={busy} onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={busy || !loaded} onClick={() => void save()}>{busy ? 'Saving…' : 'Save memory'}</Btn></>}><p className="small muted">Persistent notes this bot can read in future work. Saved in its private memory/MEMORY.md.</p>{!loaded && !error ? <p role="status">Loading current memory…</p> : null}<textarea className="st-input cua-memory-text" aria-label="Bot memory" disabled={!loaded || busy} maxLength={128000} value={text} onChange={event => setText(event.target.value)}/>{error ? <ErrorNotice message={error} action={loaded ? 'Dismiss' : 'Retry'} onRetry={() => loaded ? setError('') : setAttempt(value => value + 1)}/> : null}</Dialog>;
}

export function BotRulesDialog({ bot, onClose, onSaved }: { bot: Bot; onClose: () => void; onSaved: () => Promise<void> }) {
  const [rules, setRules] = useState<BotWorkRule[]>([]), [loaded, setLoaded] = useState(false), [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let alive = true; setLoaded(false); setError(''); void api.get<BotWork>(`/api/bots/${encodeURIComponent(bot.id)}/work`).then(value => { if (alive) { setRules(value.rules.map(rule => ({ ...rule }))); setLoaded(true); } }).catch(cause => { if (alive) setError(message(cause)); }); return () => { alive = false; }; }, [bot.id, attempt]);
  async function save() { if (!loaded || busy) return; setBusy(true); try { await api.patch(`/api/bots/${encodeURIComponent(bot.id)}/work`, { rules }); await onSaved(); onClose(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }
  return <Dialog open title={`${bot.name}’s custom rules`} className="cua-rules-dialog" onClose={() => { if (!busy) onClose(); }} actions={<><Btn disabled={busy} onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!loaded || busy || rules.some(rule => !rule.action.trim())} onClick={() => void save()}>Save rules</Btn></>}><p className="small muted">Standing preferences for this bot. Strata’s permission mode still decides which actions require approval.</p>{!loaded && !error ? <p role="status">Loading current rules…</p> : null}<div className="cua-rules-list">{rules.map((rule, index) => <div key={rule.id}><input className="st-input" aria-label={`Rule ${index + 1}`} disabled={!loaded || rule.locked || busy} value={rule.action} maxLength={1000} onChange={event => setRules(rows => rows.map((row, i) => i === index ? { ...row, action: event.target.value } : row))}/><Select value={rule.behavior} disabled={!loaded || rule.locked || busy} ariaLabel={`Rule ${index + 1} preference`} options={[{ value: 'ask', label: 'Ask first' }, { value: 'allow', label: 'Allow' }, { value: 'pre-approved', label: 'Pre-approved preference' }, { value: 'hand-off', label: 'Hand off to me' }]} onChange={behavior => setRules(rows => rows.map((row, i) => i === index ? { ...row, behavior } : row))}/><Btn icon="trash" size="sm" disabled={!loaded || rule.locked || busy} onClick={() => setRules(rows => rows.filter((_, i) => i !== index))}>Remove</Btn></div>)}</div><Btn icon="plus" disabled={!loaded || busy || rules.length >= 100} onClick={() => setRules(rows => [...rows, { id: crypto.randomUUID(), action: '', behavior: 'ask' }])}>Add rule</Btn>{error ? <ErrorNotice message={error} action={loaded ? 'Dismiss' : 'Retry'} onRetry={() => loaded ? setError('') : setAttempt(value => value + 1)}/> : null}</Dialog>;
}

export function BotRoutineDialog({ bots, bot, routine, onClose, onSaved }: { bots: Bot[]; bot?: Bot; routine?: BotRoutine; onClose: () => void; onSaved: () => Promise<void> }) {
  const [botId, setBotId] = useState(bot?.id ?? bots[0]?.id ?? ''), [title, setTitle] = useState(routine?.title ?? ''), [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [kind, setKind] = useState(routine?.schedule.kind ?? 'daily'), [minutes, setMinutes] = useState(routine?.schedule.minutes ?? 60), [weekday, setWeekday] = useState(routine?.schedule.weekday ?? 1);
  const [time, setTime] = useState(`${String(routine?.schedule.hour ?? 9).padStart(2, '0')}:${String(routine?.schedule.minute ?? 0).padStart(2, '0')}`), [enabled, setEnabled] = useState(routine?.enabled ?? true), [notify, setNotify] = useState(routine?.notifyOnCompletion ?? true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const timeZone = routine?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  async function save() { setBusy(true); setError(''); try { const [hour, minute] = time.split(':').map(Number); const schedule = kind === 'every' ? { kind, minutes } : { kind, hour, minute, ...(kind === 'weekly' ? { weekday } : {}) }; const body = { title: title.trim(), prompt: prompt.trim(), schedule, timeZone, enabled, notifyOnCompletion: notify }; const path = `/api/bots/${encodeURIComponent(botId)}/routines`; if (routine) await api.patch(`${path}/${encodeURIComponent(routine.id)}`, body); else await api.post(path, body); await onSaved(); onClose(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }
  return <Dialog open title={routine ? 'Edit routine' : 'New routine'} className="cua-routine-dialog" onClose={() => { if (!busy) onClose(); }} actions={<><Btn disabled={busy} onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={busy || !botId || !title.trim() || !prompt.trim() || kind !== 'every' && !/^\d\d:\d\d$/.test(time)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save routine'}</Btn></>}><div className="form-stack"><div className="input-field"><span>Bot</span><Select value={botId} ariaLabel="Routine bot" disabled={!!routine || busy} options={bots.map(item => ({ value: item.id, label: item.name }))} onChange={setBotId}/></div><label className="input-field"><span>Title</span><input className="st-input" value={title} maxLength={120} onChange={event => setTitle(event.target.value)}/></label><label className="input-field"><span>What should it do?</span><textarea className="st-input" rows={5} maxLength={12000} value={prompt} onChange={event => setPrompt(event.target.value)}/></label><div className="input-field"><span>Repeat</span><Select value={kind} ariaLabel="Routine frequency" options={[{ value: 'every', label: 'Every interval' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} onChange={setKind}/></div>{kind === 'every' ? <label className="input-field"><span>Minutes between runs</span><input className="st-input" type="number" min={1} max={10080} value={minutes} onChange={event => setMinutes(Number(event.target.value))}/></label> : <div className="bot-editor__grid">{kind === 'weekly' ? <div className="input-field"><span>Day</span><Select value={String(weekday)} ariaLabel="Routine weekday" options={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((label, value) => ({ value: String(value), label }))} onChange={value => setWeekday(Number(value))}/></div> : null}<label className="input-field"><span>Time · {timeZone}</span><input className="st-input" type="time" value={time} onChange={event => setTime(event.target.value)}/></label></div>}<label className="row small"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/>Run on this schedule while Strata is open</label><label className="row small"><input type="checkbox" checked={notify} onChange={event => setNotify(event.target.checked)}/>Notify when finished</label><p className="xs muted">Each run creates a shared conversation using the bot’s current profile. Permission requests still need your decision. A paused bot does not run routines.</p>{error ? <ErrorNotice message={error} action="Dismiss" onRetry={() => setError('')}/> : null}</div></Dialog>;
}

export function BotOutputDialog({ bot, output, onClose }: { bot: Bot; output: BotWorkOutput; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null), [error, setError] = useState('');
  useEffect(() => { let alive = true; setText(null); void api.get<{ text: string }>(`/api/bots/${encodeURIComponent(bot.id)}/work/file?path=${encodeURIComponent(output.path)}`).then(value => { if (alive) setText(value.text); }).catch(cause => { if (alive) setError(message(cause)); }); return () => { alive = false; }; }, [bot.id, output.path]);
  return <Dialog open title={output.name} className="cua-output-dialog" onClose={onClose} actions={<Btn onClick={onClose}>Done</Btn>}><p className="xs muted">{bot.name} · {output.path}</p>{error ? <ErrorNotice message={error} action="Dismiss" onRetry={() => setError('')}/> : text === null ? <p role="status">Loading output…</p> : <pre className="cua-output-text">{text}</pre>}</Dialog>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
function formatBytes(size: number) { return size < 1024 ? `${size} B` : size < 1048576 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`; }
export function routineScheduleLabel(routine: BotRoutine) { const schedule = routine.schedule; if (schedule.kind === 'every') return `Every ${schedule.minutes} minutes`; const time = `${String(schedule.hour ?? 0).padStart(2, '0')}:${String(schedule.minute ?? 0).padStart(2, '0')}`; return schedule.kind === 'daily' ? `Daily at ${time}` : `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][schedule.weekday ?? 0]} at ${time}`; }
