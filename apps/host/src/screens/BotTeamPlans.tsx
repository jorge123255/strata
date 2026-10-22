import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/client';
import type { Bot, BotTeam, BotTeamPlan, BotTeamPlansSnapshot } from '../lib/bots';
import { CuaBotAvatar } from '../components/CuaBotAvatar';
import { Btn, Dialog, ErrorNotice } from '../components/ui';
import { planActive, planLabel, planTaskLabel, teamPlanCheckpointMatches, validTeamPlan, validateTeamPlans } from './botTeamPlanState';
import './BotTeamPlans.css';

const pathFor = (teamId: string) => `/api/bots/teams/${encodeURIComponent(teamId)}/plans`;
const failure = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export function useTeamPlans(teamId: string | undefined, enabled: boolean) {
  const [snapshot,setSnapshot]=useState<BotTeamPlansSnapshot|null>(null), [error,setError]=useState(''), [loading,setLoading]=useState(false);
  const epoch=useRef(0), pending=useRef(false), alive=useRef(false), signature=useRef(''), cached=useRef<BotTeamPlansSnapshot|null>(null);
  const refresh=useCallback(async () => {
    if(!teamId||!enabled||!alive.current||pending.current||document.hidden)return;
    const token=epoch.current;pending.current=true;setLoading(true);
    try{const raw=await api.get<BotTeamPlansSnapshot>(pathFor(teamId));if(!alive.current||token!==epoch.current)return;const value=validateTeamPlans(raw,teamId,cached.current);const next=JSON.stringify(value);cached.current=value;if(next!==signature.current){signature.current=next;setSnapshot(value);}setError(value.error||(!value.available?'Work-plan storage is unavailable. Existing progress is retained.':''));}
    catch(cause){if(alive.current&&token===epoch.current)setError(failure(cause));}
    finally{if(alive.current&&token===epoch.current){pending.current=false;setLoading(false);}}
  },[teamId,enabled]);
  useEffect(()=>{alive.current=true;epoch.current++;pending.current=false;signature.current='';cached.current=null;setSnapshot(null);setError('');setLoading(!!teamId&&enabled);void refresh();const timer=setInterval(()=>void refresh(),10000);return()=>{alive.current=false;epoch.current++;clearInterval(timer);};},[refresh]);
  function acceptPlan(plan:BotTeamPlan){if(!teamId||!alive.current||!validTeamPlan(plan,teamId))return;epoch.current++;pending.current=false;const old=cached.current;if(!old)return false;const prior=old.plans.find(row=>row.id===plan.id);if(prior&&!teamPlanCheckpointMatches(plan,prior))return false;const next={...old,plans:old.plans.map(row=>row.id===plan.id?plan:row)};cached.current=next;signature.current=JSON.stringify(next);setSnapshot(next);setLoading(false);return true;}
  return {snapshot,error,loading,refresh,acceptPlan,stale:!!error||!snapshot?.available};
}

type Action = {kind:'resume'|'stop'|'accept'|'changes_requested'; plan:BotTeamPlan; requestId:string; taskId?:string};
export function BotTeamPlans({team,bots,visible,current,resource,onOpenConversation,onChanged}:{team:BotTeam;bots:Bot[];visible:boolean;current:boolean;resource:ReturnType<typeof useTeamPlans>;onOpenConversation:(id:string)=>Promise<void>;onChanged:()=>Promise<void>}) {
  const [selected,setSelected]=useState<BotTeamPlan|null>(null), [action,setAction]=useState<Action|null>(null), [note,setNote]=useState(''), [inspected,setInspected]=useState(false), [busy,setBusy]=useState(false), [error,setError]=useState(''), [older,setOlder]=useState<BotTeamPlan[]>([]), [more,setMore]=useState(false);
  const generation=useRef(0), live=useRef({teamId:team.id,visible});live.current={teamId:team.id,visible};
  useEffect(()=>{generation.current++;setSelected(null);setAction(null);setError('');setOlder([]);setMore(false);setBusy(false);},[team.id,visible]);
  useEffect(()=>()=>{generation.current++;},[]);
  const rows=[...(resource.snapshot?.plans??[]),...older].filter((row,index,all)=>all.findIndex(item=>item.id===row.id)===index);
  const known=resource.snapshot?.plans.find(row=>row.id===selected?.id);
  const checkpointCurrent=!selected||!known||known.revision<=selected.revision;
  const ready=current&&!resource.stale&&!busy&&checkpointCurrent;
  useEffect(()=>{
    if(!selected||!known||action||busy||resource.stale||!visible)return;
    if(!teamPlanCheckpointMatches(known,selected))return;
    if(selected.tasksOffset===0&&JSON.stringify(known)!==JSON.stringify(selected))setSelected(known);
    else if(selected.tasksOffset>0&&known.revision>selected.revision)void inspect(selected,selected.tasksOffset);
  },[resource.snapshot,resource.stale,visible,selected,action,busy]);
  async function inspect(plan:BotTeamPlan,offset=0){
    const token=++generation.current;setBusy(true);setError('');
    try{const value=await api.get<{plan:BotTeamPlan}>(`${pathFor(team.id)}/${plan.id}?taskOffset=${offset}`);if(token!==generation.current||!live.current.visible||live.current.teamId!==team.id)return;if(!validTeamPlan(value.plan,team.id)||value.plan.id!==plan.id||!teamPlanCheckpointMatches(value.plan,plan)||value.plan.tasksOffset!==offset)throw Error('This work-plan page did not match the selected task.');setSelected(value.plan);setAction(null);}
    catch(cause){if(token===generation.current)setError(failure(cause));}
    finally{if(token===generation.current)setBusy(false);}
  }
  async function earlier(){
    const last=rows.at(-1);if(!last)return;const token=++generation.current;setBusy(true);setError('');
    try{const value=validateTeamPlans(await api.get<BotTeamPlansSnapshot>(`${pathFor(team.id)}?beforePlanId=${last.id}`),team.id);if(token!==generation.current)return;setOlder(previous=>[...previous,...value.plans]);setMore(value.hasMore);}
    catch(cause){if(token===generation.current)setError(failure(cause));}
    finally{if(token===generation.current)setBusy(false);}
  }
  function choose(kind:Action['kind'],taskId?:string){if(!selected)return;setAction({kind,plan:selected,requestId:crypto.randomUUID(),...(taskId?{taskId}:{})});setNote('');setInspected(false);setError('');}
  async function perform(){
    if(!action||!ready||action.plan.id!==selected?.id||action.plan.proof!==selected.proof||action.kind==='resume'&&!inspected||action.kind==='changes_requested'&&!note.trim())return;
    const choice=action, token=++generation.current;setBusy(true);setError('');
    const suffix=choice.kind==='accept'||choice.kind==='changes_requested'?'review':choice.kind;
    const body={expectedRevision:choice.plan.revision,expectedProof:choice.plan.proof,...(suffix==='review'?{decision:choice.kind,...(note.trim()?{note:note.trim()}:{})}:{}),...(choice.kind==='resume'?{requestId:choice.requestId,inspected:true,...(choice.taskId?{taskId:choice.taskId}:{})}:{})};
    try{const result=await api.post<{plan:BotTeamPlan}>(`${pathFor(team.id)}/${choice.plan.id}/${suffix}`,body);if(token!==generation.current||!live.current.visible||live.current.teamId!==team.id)return;if(!validTeamPlan(result.plan,team.id)||result.plan.id!==choice.plan.id||!teamPlanCheckpointMatches(result.plan,choice.plan)||choice.kind==='resume'&&['completed','stopped','stopping'].includes(result.plan.phase)||choice.kind==='changes_requested'&&result.plan.phase==='completed'||result.plan.goal!==choice.plan.goal||result.plan.parentRunId!==choice.plan.parentRunId||result.plan.revision<=choice.plan.revision||result.plan.proof===choice.plan.proof||choice.kind==='accept'&&result.plan.phase!=='completed'||choice.kind==='stop'&&!['stopped','stopping'].includes(result.plan.phase))throw Error('Strata did not confirm this plan action. Refresh its current progress before trying again.');if(!resource.acceptPlan(result.plan))throw Error('Newer plan progress is already available. Refresh before taking another action.');setSelected(result.plan);setAction(null);await Promise.allSettled([resource.refresh(),onChanged()]);}
    catch(cause){if(token===generation.current){setError(`${failure(cause)} No action will be automatically resent. Refresh the plan to check its saved state.`);setAction(null);}}
    finally{if(token===generation.current)setBusy(false);}
  }
  const title=(id:string)=>bots.find(bot=>bot.id===id)?.name??'Unavailable teammate';
  return <section className="bot-team-plans" aria-label="Durable team work plans">
    <div className="bots-section-heading"><h3>Work plans</h3><Btn size="sm" disabled={busy} onClick={()=>void resource.refresh()}>Refresh plans</Btn></div>
    {resource.error?<ErrorNotice message={resource.error} next="Showing the last known plan. Refresh before changing work." action="Refresh" onRetry={()=>void resource.refresh()}/>:null}
    {resource.loading&&!resource.snapshot?<p role="status">Loading work plans…</p>:null}
    {!rows.length&&!resource.error&&!resource.loading?<p className="small muted">Send a Work request in Channel. Your coordinator will plan the tasks and choose the right teammates before execution starts.</p>:null}
    <div className="bot-work-task-list">{rows.map(plan=><article className="bot-work-task" key={plan.id} data-plan-id={plan.id}><div className="bot-work-task-heading"><CuaBotAvatar name={title(plan.coordinatorId)} config={bots.find(bot=>bot.id===plan.coordinatorId)?.avatarConfig} size={32}/><div><h4>{plan.goal.slice(0,160)}</h4><p>{plan.counts.ready_for_review} of {plan.totalTasks} task results reported · {title(plan.coordinatorId)} coordinates</p></div><span className="bots-state">{resource.stale?'Last known: ':''}{planLabel(plan.phase)}</span></div>{plan.summary?<p className="bot-work-task-summary">{plan.summary}</p>:null}{plan.blockedReason?<p className="bot-work-task-reason">{plan.blockedReason}</p>:null}<Btn size="sm" disabled={busy} onClick={()=>void inspect(plan)}>Inspect plan</Btn></article>)}</div>
    {(older.length?more:resource.snapshot?.hasMore)?<Btn size="sm" disabled={busy} onClick={()=>void earlier()}>Earlier plans</Btn>:null}
    {error&&!selected?<ErrorNotice message={error} action="Dismiss" onRetry={()=>setError('')}/>:null}
    {selected?<Dialog open title="Team work plan" onClose={()=>{if(!busy){generation.current++;setSelected(null);setAction(null);}}} actions={<Btn disabled={busy} onClick={()=>{setSelected(null);setAction(null);}}>Done</Btn>}>
      {error?<ErrorNotice message={error} action="Dismiss" onRetry={()=>setError('')}/>:null}<p className="bot-plan-goal">{selected.goal}</p>{!checkpointCurrent?<p role="status">This plan changed while you were inspecting it. Refresh the current plan before confirming an action.</p>:null}{resource.error?<ErrorNotice message={resource.error} next="Showing the last known progress." action="Refresh" onRetry={()=>void resource.refresh()}/>:null}<p><strong>{resource.stale?'Last known: ':''}{planLabel(selected.phase)}</strong> · {selected.counts.ready_for_review} of {selected.totalTasks} task results reported</p>
      {selected.summary?<p>{selected.summary}</p>:null}{selected.blockedReason?<p role="status">{selected.blockedReason}</p>:null}
      <details><summary>Team roles and participation</summary><div className="bot-plan-members">{selected.participation.map(member=><div key={member.botId}><CuaBotAvatar name={title(member.botId)} config={bots.find(bot=>bot.id===member.botId)?.avatarConfig} size={28}/><div><strong>{title(member.botId)} · {member.role}</strong><p>{member.reason}</p></div></div>)}</div></details>
      <div className="bot-plan-tasks">{selected.tasks.map(task=>{const attempt=selected.attempts.find(row=>row.id===task.attemptId);return <article key={task.id} className="bot-work-task"><div className="bot-work-task-heading"><CuaBotAvatar name={title(task.ownerId)} config={bots.find(bot=>bot.id===task.ownerId)?.avatarConfig} size={28}/><div><h4>{task.title}</h4><p>{title(task.ownerId)} · {task.kind==='review'?'Independent review':'Task owner'}{task.collaboratorIds.length?` · Contributors: ${task.collaboratorIds.map(title).join(', ')}`:''}</p></div><span className="bots-state">{planTaskLabel(task.state)}</span></div>{task.dependsOn.length?<p className="small muted">After: {task.dependsOn.join(', ')}</p>:null}<p>{task.summary??task.instructions}</p>{task.instructionsTruncated?<p className="small muted">Instructions are excerpted; the assigned bot receives the full task.</p>:null}{task.nextStep?<p>Next: {task.nextStep}</p>:null}<details><summary>Acceptance criteria and reported evidence</summary><ul>{task.criteria.map(criterion=><li key={criterion.id}>{criterion.text}{task.checks?.find(check=>check.criterionId===criterion.id)?<p>{task.checks.find(check=>check.criterionId===criterion.id)!.detail}</p>:null}</li>)}</ul>{task.evidence?.map((item,index)=><p key={index}><strong>{item.label}</strong> · {item.detail}</p>)}</details>{(task.chatId??attempt?.chatId)?<Btn size="sm" onClick={()=>void onOpenConversation((task.chatId??attempt?.chatId)!).catch(cause=>setError(failure(cause)))}>Open task conversation</Btn>:null}{selected.canResume&&['blocked','interrupted','stopped'].includes(task.state)?<Btn size="sm" disabled={!ready} onClick={()=>choose('resume',task.id)}>Inspect and continue this task</Btn>:null}</article>;})}</div>
      {selected.totalTasks?<p className="small muted">Tasks {selected.tasksOffset+1}–{selected.tasksOffset+selected.tasks.length} of {selected.totalTasks}</p>:null}
      <div className="bot-work-task-actions">{selected.tasksOffset>0?<Btn size="sm" disabled={busy} onClick={()=>void inspect(selected,Math.max(0,selected.tasksOffset-64))}>Previous tasks</Btn>:null}{selected.nextTaskOffset!==null?<Btn size="sm" disabled={busy} onClick={()=>void inspect(selected,selected.nextTaskOffset!)}>Next tasks</Btn>:null}</div>
      <p className="small muted">Reported results and independent checks remain separate from your acceptance. Continuing starts a fresh scoped turn and retains completed tasks.</p>
      <div className="bot-work-task-actions"><Btn disabled={busy} onClick={()=>void inspect(selected,selected.tasksOffset)}>Refresh current plan</Btn>{selected.canResume?<Btn disabled={!ready} onClick={()=>choose('resume')}>Inspect and continue</Btn>:null}{planActive(selected.phase)?<Btn variant="danger" disabled={!ready} onClick={()=>choose('stop')}>Stop plan</Btn>:null}{selected.phase==='awaiting_review'?<><Btn disabled={!ready} onClick={()=>choose('accept')}>Accept result</Btn><Btn disabled={!ready} onClick={()=>choose('changes_requested')}>Request changes</Btn></>:null}</div>
      {action?<div className="bot-plan-action"><h4>{action.kind==='resume'?'Continue unfinished work':action.kind==='stop'?'Stop this plan':action.kind==='accept'?'Accept this result':'Request changes'}</h4>{action.kind==='resume'?<label><input type="checkbox" checked={inspected} onChange={event=>setInspected(event.target.checked)}/>I inspected existing progress and unresolved tool receipts.</label>:null}{action.kind==='changes_requested'?<label>Requested changes<textarea className="st-input" value={note} maxLength={4000} onChange={event=>setNote(event.target.value)}/></label>:null}<div><Btn disabled={!ready||action.kind==='resume'&&!inspected||action.kind==='changes_requested'&&!note.trim()} onClick={()=>void perform()}>Confirm {action.kind==='accept'?'acceptance':action.kind==='changes_requested'?'changes':action.kind==='stop'?'Stop':'continuation'}</Btn><Btn disabled={busy} onClick={()=>setAction(null)}>Cancel</Btn></div></div>:null}
    </Dialog>:null}
  </section>;
}
