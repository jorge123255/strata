import { useState } from 'react';
import type { Bot } from '../lib/bots';
import { relTime } from '../lib/format';
import { CuaBotAvatar } from './CuaBotAvatar';
import { Btn, Empty, Icon } from './ui';
import './BotSupervision.css';

export interface BotSupervisionSession {
  id: string; botId: string; name: string; title: string; state: 'approval'|'error'|'working'|'thinking'|'completed';
  approvalCount: number; toolName?: string; computerName?: string; teamId?: string; parentChatId?: string; updatedAt?: string;
}
export interface BotSupervisionSnapshot {
  supported: boolean; sessions: BotSupervisionSession[]; counts: { waiting: number; working: number; completed: number; errors: number }; hasMore: boolean;
}
type Filter = 'all'|'attention'|'working'|'completed';
export function supervisionLabel(row: BotSupervisionSession) {
  return row.state === 'approval' ? `${row.approvalCount} approval${row.approvalCount === 1 ? '' : 's'} waiting` : row.state === 'error' ? 'Needs attention' : row.state === 'working' ? 'Using a tool' : row.state === 'thinking' ? 'Thinking' : 'Finished';
}
export function BotSupervision({ snapshot, bots, stale, onOpen }: { snapshot: BotSupervisionSnapshot; bots: Bot[]; stale: boolean; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all'), [limit, setLimit] = useState(12);
  if (!snapshot.supported) return <p className="small muted">Update the Strata host to see live bot supervision.</p>;
  const rows = snapshot.sessions.filter(row => filter === 'all' || filter === 'attention' && ['approval', 'error'].includes(row.state) || filter === 'working' && ['working', 'thinking'].includes(row.state) || filter === 'completed' && row.state === 'completed');
  const { waiting, working, completed, errors } = snapshot.counts;
  return <section className="bot-supervision" aria-label="Live bot supervision" data-stale={stale || undefined}>
    <div className="bot-supervision-heading"><div><p className="bot-supervision-eyebrow">{stale ? 'Last known activity' : 'Your bots, at a glance'}</p><h3>{waiting ? `${waiting} conversation${waiting === 1 ? '' : 's'} waiting for you` : working ? `${working} conversation${working === 1 ? '' : 's'} in motion` : errors ? 'A bot needs your attention' : 'Your conversations, together.'}</h3><p>Approvals first. Follow the exact conversation to review tools, thinking and results.</p></div><Icon name="activity" size={25}/></div>
    <div className="bot-supervision-filters" role="group" aria-label="Filter live bot activity">
      {([{id:'all', label:'All', count:waiting+working+completed+errors}, {id:'attention', label:'Needs you', count:waiting+errors}, {id:'working', label:'Working', count:working}, {id:'completed', label:'Recently finished', count:completed}] as const).map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setLimit(12); }}><span>{item.label}</span><b>{item.count}</b></button>)}
    </div>
    {rows.length ? <div className="bot-supervision-grid">{rows.slice(0, limit).map(row => {
      const bot = bots.find(bot => bot.id === row.botId);
      return <article key={row.id} className="bot-supervision-card" data-state={row.state} aria-label={`${row.name}: ${row.title}`}>
        <div className="bot-supervision-identity"><CuaBotAvatar name={row.name} config={bot?.avatarConfig} size={42} mood={stale ? 'idle' : row.state === 'approval' ? 'needsApproval' : row.state === 'error' ? 'error' : row.state === 'completed' ? 'idle' : row.state}/><div><strong>{row.name}</strong><span>{row.parentChatId ? 'Subagent' : row.teamId ? 'Team conversation' : 'Personal conversation'}{row.computerName ? ` · ${row.computerName}` : ''}</span></div></div>
        <h4>{row.title}</h4><p className="bot-supervision-state">{stale ? 'Last known: ' : ''}{supervisionLabel(row)}</p>
        {row.state === 'working' && row.toolName ? <p className="bot-supervision-tool">{row.toolName.replaceAll('_', ' ')}</p> : null}
        <div className="bot-supervision-footer">{row.updatedAt ? <time dateTime={row.updatedAt}>{relTime(row.updatedAt)}</time> : <span/>}<Btn size="sm" onClick={() => onOpen(row.id)}>{row.state === 'approval' ? 'Review approval' : 'Open conversation'}</Btn></div>
      </article>;
    })}</div> : <Empty icon="activity" title={filter === 'attention' ? 'Nothing waiting on you' : filter === 'working' ? 'No bots are working right now' : filter === 'completed' ? 'No finished conversations today' : 'Your next idea starts a new story'} body="Your bots’ live conversations and results from the past 24 hours appear here."/>}
    {rows.length > limit ? <Btn onClick={() => setLimit(value => value + 12)}>Show more conversations</Btn> : null}
    {snapshot.hasMore ? <p className="small muted">Showing the 200 most urgent or recent conversations. Open a bot to browse its full history.</p> : null}
  </section>;
}
