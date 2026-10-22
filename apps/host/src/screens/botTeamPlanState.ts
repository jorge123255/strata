import type { BotTeamChannelMessage, BotTeamChannelSnapshot, BotTeamPlan, BotTeamPlansSnapshot, BotTeamRun } from '../lib/bots';

export const planActive = (phase: string) => ['planning','running','summarizing','stopping'].includes(phase);
export const planLabel = (phase: string) => ({planning:'Planning the work',running:'Team working',summarizing:'Coordinator summarizing',awaiting_review:'Ready for your review',completed:'Accepted by you',blocked:'Needs attention',interrupted:'Interrupted',stopping:'Stopping',stopped:'Stopped'} as Record<string,string>)[phase] ?? 'Unknown';
export const planTaskLabel = (state: string) => ({pending:'Waiting for prerequisites',queued:'Queued for its computer',running:'Working',working:'Continuing from checkpoint',ready_for_review:'Result reported',blocked:'Blocked',interrupted:'Interrupted',stopped:'Stopped'} as Record<string,string>)[state] ?? 'Unknown';
const uuid = (prefix: string, value: unknown) => typeof value === 'string' && new RegExp(`^${prefix}_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(value);
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
export function validTeamPlan(row: BotTeamPlan, teamId: string): boolean {
  if (!row || !uuid('tp',row.id) || row.teamId !== teamId || typeof row.goal !== 'string' || !row.goal.trim() || !Array.isArray(row.memberIds) || !row.memberIds.includes(row.coordinatorId) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !/^[a-f0-9]{64}$/.test(row.proof) || !['planning','running','summarizing','awaiting_review','completed','blocked','interrupted','stopping','stopped'].includes(row.phase) || typeof row.canResume !== 'boolean' || !Array.isArray(row.tasks) || row.tasks.length > 64 || !integer(row.totalTasks) || !integer(row.tasksOffset) || row.tasksOffset + row.tasks.length > row.totalTasks || row.tasksTruncated !== (row.tasksOffset > 0 || row.tasks.length < row.totalTasks)) return false;
  const states = ['pending','queued','running','working','ready_for_review','blocked','interrupted','stopped'] as const;
  if (!row.counts || states.some(state=>!integer(row.counts[state])) || states.reduce((sum,state)=>sum+row.counts[state],0)!==row.totalTasks) return false;
  if (row.tasksOffset + row.tasks.length < row.totalTasks ? row.nextTaskOffset !== row.tasksOffset + row.tasks.length || !row.tasks.length : row.nextTaskOffset !== null) return false;
  if (new Set(row.tasks.map(task=>task.id)).size !== row.tasks.length || new Set(row.tasks.map(task=>task.key)).size !== row.tasks.length) return false;
  if (!row.tasks.every(task=>uuid('tpt',task.id) && row.memberIds.includes(task.ownerId) && states.includes(task.state) && ['work','review'].includes(task.kind) && typeof task.title==='string' && typeof task.instructions==='string' && Array.isArray(task.dependsOn) && !task.dependsOn.includes(task.key) && Array.isArray(task.collaboratorIds) && task.collaboratorIds.every(id=>row.memberIds.includes(id)&&id!==task.ownerId) && Array.isArray(task.criteria) && task.criteria.length>0 && task.criteria.length<=16 && task.criteria.every(criterion=>uuid('tpc',criterion.id)&&typeof criterion.text==='string') && (task.kind!=='review'||task.state!=='ready_for_review'||task.checks?.length===task.criteria.length&&task.checks.every(check=>check.passed&&task.criteria.some(criterion=>criterion.id===check.criterionId))))) return false;
  if (!Array.isArray(row.participation) || row.participation.length && (row.participation.length !== row.memberIds.length || new Set(row.participation.map(member=>member.botId)).size!==row.memberIds.length || row.participation.some(member=>!row.memberIds.includes(member.botId)||typeof member.reason!=='string'||typeof member.role!=='string'))) return false;
  if (!Array.isArray(row.attempts) || row.attempts.length>12 || !integer(row.totalAttempts) || row.totalAttempts<row.attempts.length || row.attemptsTruncated!==(row.totalAttempts>row.attempts.length) || row.attempts.some(attempt=>!uuid('tpa',attempt.id)||!row.memberIds.includes(attempt.botId))) return false;
  if (['awaiting_review','completed'].includes(row.phase) && (!row.totalTasks || row.counts.ready_for_review!==row.totalTasks || row.attempts.at(-1)?.kind!=='synthesis' || row.attempts.at(-1)?.state!=='completed')) return false;
  return true;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const reportCuts = [80, 200, 500, 1000];
/** Only known server clip boundaries can explain a changed public excerpt. */
function samePreview(left: string | undefined, right: string | undefined, cuts = reportCuts) {
  if (left === right) return true;
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  if (!longer.startsWith(shorter)) return false;
  if (cuts.includes(shorter.length)) return true;
  // UTF-16 clipping drops the high surrogate when a cut splits an emoji.
  return cuts.includes(shorter.length + 1) && /[\uD800-\uDBFF]/.test(longer[shorter.length] ?? '') && /[\uDC00-\uDFFF]/.test(longer[shorter.length + 1] ?? '');
}
function sameInstructions(left: BotTeamPlan['tasks'][number], right: BotTeamPlan['tasks'][number]) {
  const leftCut = left.instructionsTruncated === true, rightCut = right.instructionsTruncated === true;
  if (left.instructions === right.instructions) return leftCut === rightCut;
  if (!leftCut && !rightCut || !samePreview(left.instructions, right.instructions)) return false;
  // A known complete definition cannot be shorter than its claimed excerpt.
  return (leftCut || left.instructions.length > right.instructions.length) && (rightCut || right.instructions.length > left.instructions.length);
}
function samePreviewRows<T extends object>(left: T[] | undefined, right: T[] | undefined, field: keyof T, cuts = reportCuts) {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((row,index) => {
    const other = right[index];
    return samePreview(row[field] as string | undefined, other[field] as string | undefined, cuts) && same({...row,[field]:other[field]},other);
  });
}
function sameEvidence(left: BotTeamPlan['tasks'][number]['evidence'], right: BotTeamPlan['tasks'][number]['evidence']) {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((row,index) => {
    const other = right[index];
    return row.kind === other.kind && row.label === other.label && (row.kind === 'link' ? row.detail === other.detail : samePreview(row.detail,other.detail));
  });
}
export function teamPlanCheckpointMatches(next:BotTeamPlan,previous:BotTeamPlan) {
  if (next.id!==previous.id||next.teamId!==previous.teamId||next.goal!==previous.goal||next.parentRunId!==previous.parentRunId||next.sourceMessageId!==previous.sourceMessageId||next.coordinatorId!==previous.coordinatorId||next.createdAt!==previous.createdAt||!same(next.memberIds,previous.memberIds)||next.totalTasks<previous.totalTasks||next.revision<previous.revision||next.revision===previous.revision&&next.proof!==previous.proof||next.revision>previous.revision&&next.proof===previous.proof) return false;
  for(const task of next.tasks){const prior=previous.tasks.find(row=>row.id===task.id||row.key===task.key);if(!prior)continue;
    if(['id','key','title','ownerId','collaboratorIds','workspaceKey','dependsOn','kind','criteria'].some(name=>!same(task[name as keyof typeof task],prior[name as keyof typeof prior]))||!sameInstructions(task,prior))return false;
    if(next.revision===previous.revision){
      if(['state','attemptId','chatId','jobId'].some(name=>!same(task[name as keyof typeof task],prior[name as keyof typeof prior])))return false;
      if(!samePreview(task.summary,prior.summary)||!samePreview(task.nextStep,prior.nextStep)||!samePreviewRows(task.checks,prior.checks,'detail',[80,200,500])||!sameEvidence(task.evidence,prior.evidence))return false;
    }
  }
  if(next.revision===previous.revision){
    if(['phase','summary','updatedAt','counts','totalTasks','totalAttempts','attemptsTruncated'].some(name=>!same(next[name as keyof BotTeamPlan],previous[name as keyof BotTeamPlan])))return false;
    if(!samePreviewRows(next.participation,previous.participation,'reason')||!samePreviewRows(next.attempts,previous.attempts,'summary'))return false;
  }
  return true;
}
export function validateTeamPlans(value: BotTeamPlansSnapshot, teamId: string, previous?: BotTeamPlansSnapshot|null) {
  if (!value || value.teamWorkPlansSupported!==true || typeof value.available!=='boolean' || typeof value.hasMore!=='boolean' || !Array.isArray(value.plans) || value.plans.length>20 || value.plans.some(row=>!validTeamPlan(row,teamId)) || new Set(value.plans.map(row=>row.id)).size!==value.plans.length || value.hasMore&&!value.plans.length) throw Error('Strata returned incomplete work-plan progress. Refresh before taking an action.');
  if (value.plans.some(row=>{const old=previous?.plans.find(item=>item.id===row.id);return old&&!teamPlanCheckpointMatches(row,old);})) throw Error('Strata returned an older or different work-plan checkpoint. Refresh its saved progress.');
  return value;
}
export function durableTeamIntakeMatches(value: {channel:BotTeamChannelSnapshot;run?:BotTeamRun;planId?:string;sourceMessageId?:string;sourceMessage?:BotTeamChannelMessage}, teamId:string, body:{message:string;replyToId?:string;recipientIds?:string[]}) {
  const source=value.sourceMessage??value.channel?.messages.find(row=>row.id===value.sourceMessageId);
  return !!value.run&&value.run.teamId===teamId&&uuid('tp',value.planId)&&value.run.planId===value.planId&&!!source&&source.id===value.sourceMessageId&&source.teamId===teamId&&source.author.type==='user'&&source.content===body.message.trim()&&source.workMode==='work'&&source.planId===value.planId&&source.runId===value.run.id&&(source.replyToId??null)===(body.replyToId??null)&&JSON.stringify([...(source.recipientIds??[])].sort())===JSON.stringify([...(body.recipientIds??[])].sort());
}
