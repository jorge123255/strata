import { relTime } from '../lib/format';
import { botTeamRunActive, type Bot, type BotTeamActivity } from '../lib/bots';
import { CuaBotAvatar } from '../components/CuaBotAvatar';
import { Btn } from '../components/ui';
import { BotTaskReview } from './BotTaskReview';
import { teamTaskEvidence, teamTaskLabel, type TeamWorkGroups } from './botTeamWorkSelectors';
import './BotTeamWorkOverview.css';

export function TeamWorkCounts({ groups, stale = false }: { groups: TeamWorkGroups; stale?: boolean }) {
  return <span className="bot-work-counts" aria-label={`${stale ? 'Last known: ' : ''}${groups.needsYou.length} need you, ${groups.working.length} working`}>
    {stale ? <span>Last known:</span> : null}
    <span data-attention={!!groups.needsYou.length || undefined}>{groups.needsYou.length} need you</span>
    <span>{groups.working.length} working</span>
  </span>;
}

export function BotTeamWorkOverview({ groups, bots, stale, disabled, onChanged, onOpenConversation }: {
  groups: TeamWorkGroups; bots: Bot[]; stale: boolean; disabled: boolean;
  onChanged: () => Promise<void>; onOpenConversation: (id: string) => void;
}) {
  function task(row: BotTeamActivity) {
    const owner = bots.find(bot => bot.id === row.botId), work = row.work!;
    const active = botTeamRunActive(row.state), legacy = work.legacy === true && !active && work.status !== 'ready_for_review' && work.status !== 'working';
    const review = work.reviewHistory.at(-1), requestedChange = review?.decision === 'reject' ? review.note : undefined;
    const evidence = teamTaskEvidence(row), timestamp = new Date(row.updatedAt), hasTime = Number.isFinite(timestamp.getTime());
    return <article className="bot-work-task" key={row.id} data-task-id={row.id} aria-label={row.title}>
      <div className="bot-work-task-heading">
        <CuaBotAvatar name={owner?.name ?? 'Original task owner'} config={owner?.avatarConfig} size={32}/>
        <div><h4>{row.title}</h4><p>{owner?.name ?? 'Original task owner'}{hasTime ? <> · <time dateTime={row.updatedAt} title={timestamp.toLocaleString()}>{relTime(row.updatedAt)}</time></> : null}</p></div>
        <span className="bots-state" data-state={stale ? undefined : active ? row.state : work.status}>{stale ? 'Last known: ' : ''}{teamTaskLabel(row)}</span>
      </div>
      {legacy ? <p className="bot-work-task-summary">No structured result was recorded for this earlier turn. Its conversation is retained.</p> : <>
        {requestedChange ? <div className="bot-work-task-reason"><strong>Requested changes</strong><p>{requestedChange}</p></div> : null}
        {work.summary ? <p className="bot-work-task-summary">{work.summary}</p> : null}
        {evidence ? <p className="bot-work-task-evidence">{work.status === 'verified' ? 'Reviewed evidence' : 'Reported evidence'} · {evidence}</p> : null}
      </>}
      {work.sourceJobId ? <p className="bot-work-task-context">Continues an earlier task. Previous results remain available.</p> : null}
      {work.recoveryJobId ? <p className="bot-work-task-context">A continuation was created. This earlier result remains available.</p> : null}
      <div className="bot-work-task-actions">
        <BotTaskReview row={row} disabled={disabled} onChanged={onChanged}/>
        {row.chatId ? <Btn size="sm" onClick={() => onOpenConversation(row.chatId!)}>Open conversation</Btn> : null}
      </div>
    </article>;
  }
  function section(title: string, rows: BotTeamActivity[], name: string) {
    return rows.length ? <section className="bot-work-group" aria-label={name}>
      <div className="bots-section-heading"><h4>{title}</h4><span>{rows.length}</span></div>
      <div className="bot-work-task-list">{rows.map(task)}</div>
    </section> : null;
  }
  return <section className="bot-team-work-overview" aria-label="Current team work">
    <div className="bots-section-heading"><h3>Current work</h3><TeamWorkCounts groups={groups} stale={stale}/></div>
    {!groups.needsYou.length && !groups.working.length ? <p className="small muted">{stale ? 'No tasks needed your attention at the last check.' : 'Nothing needs your attention right now.'}</p> : null}
    {section('Needs you', groups.needsYou, 'Tasks needing you')}
    {section('Working', groups.working, 'Tasks in progress')}
    {section('Earlier results with a continuation', groups.continuing, 'Results with a continuation')}
    {groups.history.length ? <details className="bot-work-history"><summary>Earlier work <span>{groups.history.length}</span></summary>
      <p className="small muted">Verified results and earlier turns stay available here.</p>
      <div className="bot-work-task-list">{groups.history.map(task)}</div>
    </details> : null}
    <p className="small muted">Reported results become verified after your review. Opening a result or recovery plan starts no work.</p>
  </section>;
}
