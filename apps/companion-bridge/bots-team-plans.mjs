/** Paired-device projection of durable team plans. Never executes or retries work. */
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const uuid = (prefix, value) => typeof value === 'string' && new RegExp(`^${prefix}_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const key = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const states = ['pending','queued','running','working','ready_for_review','blocked','interrupted','stopped'];
const phases = ['planning','running','summarizing','awaiting_review','completed','blocked','interrupted','stopping','stopped'];
const text = (value, max, empty = false) => {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || value.includes('\0') || !empty && !value.trim()) fail(502, 'Strata returned unreadable work-plan text.');
  return value;
};
const date = value => { text(value, 40); if (!Number.isFinite(Date.parse(value))) fail(502, 'Strata returned an unreadable work-plan time.'); return value; };
const fields = (value, names, status) => { if (!object(value) || Object.keys(value).some(name => !names.includes(name))) fail(status, 'Use only the displayed work-plan action.'); };
const unique = (values, valid, maximum = Infinity) => Array.isArray(values) && values.length <= maximum && values.every(valid) && new Set(values).size === values.length;

export function teamPlanRoute(path) {
  const url = new URL(path, 'http://loopback.invalid');
  const match = /^\/api\/bots\/teams\/(team_[a-f0-9-]+)\/plans(?:\/(tp_[a-f0-9-]{36})(?:\/(resume|stop|review))?)?$/.exec(url.pathname);
  if (!match) return null;
  const [, teamId, planId, action] = match;
  const allowed = !planId ? ['beforePlanId'] : !action ? ['taskOffset'] : [];
  const query = [...url.searchParams];
  if (url.hash || query.some(([name]) => !allowed.includes(name)) || new Set(query.map(([name]) => name)).size !== query.length) fail(400, 'Choose a supported work-plan page.');
  const before = url.searchParams.get('beforePlanId'), offset = url.searchParams.get('taskOffset');
  if (planId && !uuid('tp', planId) || before !== null && !uuid('tp', before) || offset !== null && (!/^(0|[1-9]\d*)$/.test(offset) || !integer(Number(offset)))) fail(400, 'Choose a valid work-plan page.');
  return { kind: 'teamPlan', teamId, ...(planId ? { planId } : {}), ...(action ? { action } : {}), ...(offset !== null ? { taskOffset: Number(offset) } : {}), ...(before !== null ? { beforePlanId: before } : {}) };
}

export function teamPlanRequest(route, method, body, status = 400, validateBody = true) {
  if (route.action ? method !== 'POST' : method !== 'GET') fail(status, 'Start a work plan with a Work message in the team channel.');
  if (!validateBody || method === 'GET') return { ...route, method };
  const allowed = route.action === 'resume' ? ['requestId','expectedRevision','expectedProof','inspected','taskId','note'] : route.action === 'review' ? ['expectedRevision','expectedProof','decision','note'] : ['expectedRevision','expectedProof'];
  fields(body, allowed, status);
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || !/^[a-f0-9]{64}$/.test(body.expectedProof ?? '')) fail(status, 'Refresh and inspect this exact work-plan checkpoint.');
  if (route.action === 'resume' && (body.inspected !== true || !identifier(body.requestId) || body.taskId !== undefined && !uuid('tpt', body.taskId))) fail(status, 'Inspect existing progress before continuing this work plan.');
  if (body.note !== undefined && (typeof body.note !== 'string' || !body.note.isWellFormed() || body.note.includes('\0') || body.note.length > 4000)) fail(status, 'Keep work-plan notes within 4,000 characters.');
  if (route.action === 'review' && (!['accept','changes_requested'].includes(body.decision) || body.decision === 'changes_requested' && !body.note?.trim())) fail(status, 'Choose an owner review decision and describe requested changes.');
  return { ...route, method };
}

function evidence(value) {
  if (!Array.isArray(value) || value.length > 32) fail(502, 'Strata returned unbounded work-plan evidence.');
  return value.map(row => {
    if (!object(row) || !['file','test','link','note'].includes(row.kind)) fail(502, 'Strata returned unreadable work-plan evidence.');
    const result = { kind: row.kind, label: text(row.label,160), detail: text(row.detail,4000) };
    if (row.kind === 'link') { let url; try { url = new URL(result.detail); } catch {} if (!url || !['https:','http:'].includes(url.protocol) || url.username || url.password) fail(502, 'Strata returned an unsupported evidence link.'); }
    return result;
  });
}

export function publicTeamPlan(value, teamId, expectedId) {
  if (!object(value) || !uuid('tp',value.id) || value.teamId !== teamId || expectedId && value.id !== expectedId || !identifier(value.parentRunId) || !identifier(value.coordinatorId) || !unique(value.memberIds,identifier) || !value.memberIds.includes(value.coordinatorId) || !phases.includes(value.phase) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !/^[a-f0-9]{64}$/.test(value.proof ?? '') || typeof value.canResume !== 'boolean') fail(502, 'Strata returned an unreadable work plan.');
  if (!Array.isArray(value.tasks) || value.tasks.length > 64 || !integer(value.totalTasks) || !integer(value.tasksOffset) || value.tasksOffset + value.tasks.length > value.totalTasks || typeof value.tasksTruncated !== 'boolean' || value.tasksTruncated !== (value.tasksOffset > 0 || value.tasks.length < value.totalTasks) || !(value.nextTaskOffset === null || integer(value.nextTaskOffset) && value.nextTaskOffset === value.tasksOffset + value.tasks.length && value.nextTaskOffset < value.totalTasks)) fail(502, 'Strata returned incomplete work-plan pagination.');
  if (value.tasksOffset + value.tasks.length < value.totalTasks && value.nextTaskOffset === null || value.totalTasks > 0 && !value.tasks.length) fail(502, 'Strata omitted a work-plan page.');
  if (!object(value.counts) || states.some(state => !integer(value.counts[state])) || states.reduce((sum,state) => sum + value.counts[state],0) !== value.totalTasks) fail(502, 'Strata returned inconsistent work-plan counts.');
  const members = new Set(value.memberIds), seen = new Set(), taskKeys = new Set();
  const tasks = value.tasks.map(row => {
    if (!object(row) || !uuid('tpt',row.id) || seen.has(row.id) || !key(row.key) || taskKeys.has(row.key) || !members.has(row.ownerId) || !unique(row.collaboratorIds,id => members.has(id) && id !== row.ownerId) || !unique(row.dependsOn,id => key(id) && id !== row.key) || !['work','review'].includes(row.kind) || !states.includes(row.state) || !Array.isArray(row.criteria) || !row.criteria.length || row.criteria.length > 16) fail(502, 'Strata returned inconsistent work-plan tasks.');
    seen.add(row.id); taskKeys.add(row.key);
    const criteria = row.criteria.map(criterion => { if (!object(criterion) || !uuid('tpc',criterion.id)) fail(502, 'Strata returned unreadable plan criteria.'); return { id: criterion.id, text: text(criterion.text,1000) }; });
    if (new Set(criteria.map(c=>c.id)).size !== criteria.length) fail(502, 'Strata returned repeated plan criteria.');
    const result = { id:row.id,key:row.key,title:text(row.title,160),instructions:text(row.instructions,8000),ownerId:row.ownerId,collaboratorIds:[...row.collaboratorIds],dependsOn:[...row.dependsOn],kind:row.kind,criteria,state:row.state };
    if (row.instructionsTruncated !== undefined) { if (typeof row.instructionsTruncated !== 'boolean') fail(502,'Strata returned unreadable plan instructions.'); result.instructionsTruncated=row.instructionsTruncated; }
    for (const [name,max] of [['summary',8000],['nextStep',4000],['workspaceKey',160]]) if (row[name] !== undefined) result[name]=text(row[name],max);
    if (row.attemptId !== undefined) { if (!uuid('tpa',row.attemptId)) fail(502,'Strata returned an invalid plan attempt.'); result.attemptId=row.attemptId; }
    for(const name of ['chatId','jobId'])if(row[name]!==undefined){if(!identifier(row[name]))fail(502,'Strata returned an invalid task conversation.');result[name]=row[name];}
    if (row.evidence !== undefined) result.evidence=evidence(row.evidence);
    if (row.checks !== undefined) {
      if (!Array.isArray(row.checks) || row.checks.length > 16 || !unique(row.checks.map(check=>check.criterionId),id=>criteria.some(c=>c.id===id))) fail(502,'Strata returned inconsistent plan checks.');
      result.checks=row.checks.map(check=>{if(typeof check.passed!=='boolean')fail(502,'Strata returned an unreadable plan check.');return {criterionId:check.criterionId,passed:check.passed,detail:text(check.detail,2000)};});
    }
    if (row.kind === 'review' && row.state === 'ready_for_review' && (result.checks?.length !== criteria.length || result.checks.some(check=>!check.passed))) fail(502,'This review has no complete criterion assessment.');
    return result;
  });
  if (!Array.isArray(value.participation) || value.participation.length && (value.participation.length !== members.size || !unique(value.participation.map(row=>row.botId),id=>members.has(id)))) fail(502,'Strata returned incomplete member participation.');
  const participation=value.participation.map(row=>({botId:row.botId,role:text(row.role,120),reason:text(row.reason,1000)}));
  if (!Array.isArray(value.attempts) || value.attempts.length > 12 || !integer(value.totalAttempts) || value.totalAttempts < value.attempts.length || value.attemptsTruncated !== (value.totalAttempts > value.attempts.length)) fail(502,'Strata returned incomplete plan attempts.');
  const attempts=value.attempts.map(row=>{
    if (!object(row) || !uuid('tpa',row.id) || !members.has(row.botId) || !['planning','task','synthesis'].includes(row.kind) || !['pending','running','completed','blocked','interrupted','stopped'].includes(row.state) || row.taskId !== undefined && !uuid('tpt',row.taskId)) fail(502,'Strata returned an unreadable plan attempt.');
    const result={id:row.id,kind:row.kind,botId:row.botId,state:row.state};
    if(row.taskId!==undefined)result.taskId=row.taskId;
    for(const name of ['chatId','jobId'])if(row[name]!==undefined){if(!identifier(row[name]))fail(502,'Strata returned an invalid plan conversation.');result[name]=row[name];}
    if(row.summary!==undefined)result.summary=text(row.summary,8000);
    for(const name of ['startedAt','completedAt'])if(row[name]!==undefined)result[name]=date(row[name]);
    return result;
  });
  if(new Set(attempts.map(row=>row.id)).size!==attempts.length)fail(502,'Strata returned repeated plan attempts.');
  const result={id:value.id,teamId,parentRunId:value.parentRunId,goal:text(value.goal,16000),coordinatorId:value.coordinatorId,memberIds:[...value.memberIds],phase:value.phase,revision:value.revision,proof:value.proof,createdAt:date(value.createdAt),updatedAt:date(value.updatedAt),participation,tasks,counts:Object.fromEntries(states.map(state=>[state,value.counts[state]])),totalTasks:value.totalTasks,tasksOffset:value.tasksOffset,nextTaskOffset:value.nextTaskOffset,tasksTruncated:value.tasksTruncated,attempts,totalAttempts:value.totalAttempts,attemptsTruncated:value.attemptsTruncated,canResume:value.canResume};
  if(value.sourceMessageId!==undefined){if(!identifier(value.sourceMessageId))fail(502,'Strata returned an invalid source message.');result.sourceMessageId=value.sourceMessageId;}
  for(const name of ['summary','blockedReason'])if(value[name]!==undefined)result[name]=text(value[name],8000);
  if(['awaiting_review','completed'].includes(value.phase)&&(value.counts.ready_for_review!==value.totalTasks||!value.totalTasks||attempts.at(-1)?.kind!=='synthesis'||attempts.at(-1)?.state!=='completed'))fail(502,'This plan has no completed task graph and synthesis.');
  if(Buffer.byteLength(JSON.stringify(result))>256*1024)fail(502,'Strata returned an unbounded work-plan page.');
  return result;
}

export function publicTeamPlanResponse(body,route) {
  if(!object(body))fail(502,'Strata returned unreadable work plans.');
  if(body.plan!==undefined)return {plan:publicTeamPlan(body.plan,route.teamId,route.planId)};
  if(route.planId||body.teamWorkPlansSupported!==true||typeof body.available!=='boolean'||typeof body.hasMore!=='boolean'||!Array.isArray(body.plans)||body.plans.length>20)fail(502,'Strata returned an unreadable work-plan list.');
  const plans=body.plans.map(row=>publicTeamPlan(row,route.teamId));
  if(new Set(plans.map(row=>row.id)).size!==plans.length)fail(502,'Strata returned repeated work plans.');
  const next=body.nextBeforePlanId??(body.hasMore?plans.at(-1)?.id:null);
  if(body.hasMore&&(!plans.length||!uuid('tp',next)||next!==plans.at(-1).id)||!body.hasMore&&next!==null)fail(502,'Strata returned an invalid work-plan cursor.');
  const result={teamWorkPlansSupported:true,available:body.available,plans,hasMore:body.hasMore,nextBeforePlanId:next,...(body.error!==undefined?{error:text(body.error,2500)}:{})};
  if(Buffer.byteLength(JSON.stringify(result))>256*1024)fail(502,'Strata returned an unbounded work-plan list.');
  return result;
}

export function confirmTeamPlanMutation(result,route,body,before) {
  const plan=publicTeamPlanResponse(result,route).plan;
  if(!plan||plan.revision<=body.expectedRevision||plan.proof===body.expectedProof||before&&(plan.goal!==before.goal||plan.parentRunId!==before.parentRunId||plan.sourceMessageId!==before.sourceMessageId))fail(502,'Strata did not confirm this exact work-plan action. Refresh before acting again.');
  if(before&&(plan.coordinatorId!==before.coordinatorId||plan.createdAt!==before.createdAt||JSON.stringify(plan.memberIds)!==JSON.stringify(before.memberIds)))fail(502,'Strata returned a different work-plan team.');
  if(before)for(const task of plan.tasks){const prior=before.tasks.find(row=>row.id===task.id);if(prior&&['key','title','ownerId','collaboratorIds','dependsOn','kind','criteria'].some(name=>JSON.stringify(task[name])!==JSON.stringify(prior[name])))fail(502,'Strata changed an existing task assignment while confirming this action.');}
  if(route.action==='stop'&&!['stopped','stopping'].includes(plan.phase)||route.action==='review'&&body.decision==='accept'&&plan.phase!=='completed')fail(502,'Strata did not confirm the selected work-plan result.');
  if(route.action==='resume'&&['completed','stopped','stopping'].includes(plan.phase)||route.action==='review'&&body.decision==='changes_requested'&&plan.phase==='completed')fail(502,'Strata did not confirm the requested unfinished work.');
  return plan;
}
