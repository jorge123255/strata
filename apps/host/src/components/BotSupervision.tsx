import { useState } from 'react';
import type { Bot } from '../lib/bots';
import { relTime } from '../lib/format';
import { CuaBotAvatar, type CuaBotMood } from './CuaBotAvatar';
import { Btn, Empty, Icon } from './ui';
import './BotSupervision.css';

export interface BotSupervisionSession {
  id: string; botId: string; name: string; title: string; state: 'approval'|'error'|'working'|'thinking'|'completed';
  approvalCount: number; toolName?: string; computerName?: string; teamId?: string; parentChatId?: string; updatedAt?: string;
  harness?: BotHarnessDiagnostics;
}
export interface BotHarnessDiagnostics {
  phase: 'starting'|'model'|'approval'|'tool'|'cleanup'|'completed'|'interrupted'|'error'; elapsedMs: number; firstOutputMs?: number;
  timings: { startingMs: number; modelMs: number; approvalMs: number; toolMs: number; cleanupMs: number };
  toolCalls: number; toolErrors: number; contextCompactions: number;
}
const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
export function BotHarnessDetails({ value }: { value: BotHarnessDiagnostics }) {
  const label = { starting: 'Preparing run', model: 'Waiting for provider', approval: 'Waiting for approval', tool: 'Using tools', cleanup: 'Finishing cleanup', completed: 'Run finished', interrupted: 'Run interrupted', error: 'Run needs attention' }[value.phase];
  return <details className="bot-harness-details"><summary>{label} · {seconds(value.elapsedMs)}</summary><dl>
    {value.firstOutputMs !== undefined ? <><dt>First response</dt><dd>{seconds(value.firstOutputMs)}</dd></> : null}
    {Object.entries({ 'Preparation': value.timings.startingMs, 'Provider wait': value.timings.modelMs, 'Approval wait': value.timings.approvalMs, 'Tools': value.timings.toolMs, 'Cleanup': value.timings.cleanupMs }).map(([name, ms]) => <div key={name}><dt>{name}</dt><dd>{seconds(ms)}</dd></div>)}
    <dt>Tool calls / errors</dt><dd>{value.toolCalls} / {value.toolErrors}</dd><dt>Context compactions</dt><dd>{value.contextCompactions}</dd>
  </dl><p>Observed for this host session. Provider wait includes connection and startup time. Timings do not verify the task’s result.</p></details>;
}
export interface BotSupervisionSnapshot {
  supported: boolean; sessions: BotSupervisionSession[]; counts: { waiting: number; working: number; completed: number; errors: number }; hasMore: boolean;
}
const avatarMood = (row: BotSupervisionSession | undefined, stale: boolean): CuaBotMood => stale || !row ? 'idle' : row.state === 'approval' ? 'needsApproval' : row.state === 'completed' ? 'done' : row.state;
/** Chip numbers follow the cards that can render, not a separate profile total. */
export function supervisionRowCounts(sessions: BotSupervisionSession[]) {
  const counts = { waiting: 0, working: 0, completed: 0, errors: 0 };
  for (const row of sessions) {
    if (row.state === 'approval') counts.waiting += 1;
    else if (row.state === 'error') counts.errors += 1;
    else if (row.state === 'working' || row.state === 'thinking') counts.working += 1;
    else counts.completed += 1;
  }
  return counts;
}
type Filter = 'all'|'attention'|'working'|'completed';
export function supervisionLabel(row: BotSupervisionSession) {
  return row.state === 'approval' ? `${row.approvalCount} approval${row.approvalCount === 1 ? '' : 's'} waiting` : row.state === 'error' ? 'Needs attention' : row.state === 'working' ? 'Using a tool' : row.state === 'thinking' ? 'Thinking' : 'Finished';
}
export function BotSupervision({ snapshot, bots, stale, onOpen }: { snapshot: BotSupervisionSnapshot; bots: Bot[]; stale: boolean; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all'), [limit, setLimit] = useState(12);
  if (!snapshot.supported) return <p className="small muted">Update the Strata host to see live bot supervision.</p>;
  const rows = snapshot.sessions.filter(row => filter === 'all' || filter === 'attention' && ['approval', 'error'].includes(row.state) || filter === 'working' && ['working', 'thinking'].includes(row.state) || filter === 'completed' && row.state === 'completed');
  const { waiting, working, completed, errors } = supervisionRowCounts(snapshot.sessions);
  const lead = (['approval', 'error', 'working', 'thinking', 'completed'] as const).map(state => snapshot.sessions.find(row => row.state === state)).find(Boolean);
  const companion = lead ? bots.find(bot => bot.id === lead.botId) : bots[0];
  return <section className="bot-supervision" aria-label="Live bot supervision" data-stale={stale || undefined}>
    <div className="bot-supervision-heading"><div><p className="bot-supervision-eyebrow">{stale ? 'Last known activity' : 'Your bots, at a glance'}</p><h3>{waiting ? `${waiting} conversation${waiting === 1 ? '' : 's'} waiting for you` : working ? `${working} conversation${working === 1 ? '' : 's'} in motion` : errors ? 'A bot needs your attention' : 'Your conversations, together.'}</h3><p>Approvals first. Follow the exact conversation to review tools, thinking and results.</p></div>{companion || lead ? <div className="bot-supervision-companion" data-state={stale ? 'stale' : lead?.state ?? 'idle'} aria-hidden="true"><div className="bot-supervision-companion-stage"><span className="bot-supervision-companion-spark"/><CuaBotAvatar name={lead?.name ?? companion?.name} config={companion?.avatarConfig} size={88} mood={avatarMood(lead, stale)}/><span className="bot-supervision-companion-dot"/></div><span>{lead?.name ?? companion?.name}</span></div> : <Icon name="activity" size={25}/>}</div>
    <div className="bot-supervision-filters" role="group" aria-label="Filter live bot activity">
      {([{id:'all', label:'All', count:waiting+working+completed+errors}, {id:'attention', label:'Needs you', count:waiting+errors}, {id:'working', label:'Working', count:working}, {id:'completed', label:'Recently finished', count:completed}] as const).map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setLimit(12); }}><span>{item.label}</span><b>{item.count}</b></button>)}
    </div>
    {rows.length ? <div className="bot-supervision-grid">{rows.slice(0, limit).map(row => {
      const bot = bots.find(bot => bot.id === row.botId);
      return <article key={row.id} className="bot-supervision-card" data-state={row.state} aria-label={`${row.name}: ${row.title}`}>
        <div className="bot-supervision-identity"><CuaBotAvatar name={row.name} config={bot?.avatarConfig} size={42} mood={avatarMood(row, stale)}/><div><strong>{row.name}</strong><span>{row.parentChatId ? 'Subagent' : row.teamId ? 'Team conversation' : 'Personal conversation'}{row.computerName ? ` · ${row.computerName}` : ''}</span></div></div>
        <h4>{row.title}</h4><p className="bot-supervision-state">{stale ? 'Last known: ' : ''}{supervisionLabel(row)}</p>
        {row.state === 'working' && row.toolName ? <p className="bot-supervision-tool">{row.toolName.replaceAll('_', ' ')}</p> : null}
        {row.harness ? <BotHarnessDetails value={row.harness}/> : null}
        <div className="bot-supervision-footer">{row.updatedAt ? <time dateTime={row.updatedAt}>{relTime(row.updatedAt)}</time> : <span/>}<Btn size="sm" onClick={() => onOpen(row.id)}>{row.state === 'approval' ? 'Review approval' : 'Open conversation'}</Btn></div>
      </article>;
    })}</div> : <Empty icon="activity" title={filter === 'attention' ? 'Nothing waiting on you' : filter === 'working' ? 'No bots are working right now' : filter === 'completed' ? 'No finished conversations today' : 'Your next idea starts a new story'} body="Your bots’ live conversations and results from the past 24 hours appear here."/>}
    {rows.length > limit ? <Btn onClick={() => setLimit(value => value + 12)}>Show more conversations</Btn> : null}
    {snapshot.hasMore ? <p className="small muted">Showing the 200 most urgent or recent conversations. Open a bot to browse its full history.</p> : null}
  </section>;
}
