/** Paired-device boundary for opt-in, durable team workflows. No execution here. */
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const workflowId = value => typeof value === 'string' && /^wf_[a-f0-9-]{36}$/.test(value);
const proof = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const phases = new Set(['planning', 'building', 'evaluating', 'repairing', 'awaiting_review', 'completed', 'blocked', 'interrupted', 'stopping', 'stopped']);
const stages = new Set(['planning', 'building', 'evaluating', 'repairing']);
const stepStates = new Set(['pending', 'running', 'completed', 'blocked', 'interrupted', 'stopped']);
const text = (value, maximum, status = 502, empty = false) => {
  if (typeof value !== 'string' || value.length > maximum || !value.isWellFormed() || value.includes('\0') || !empty && !value.trim()) fail(status, 'Review the current workflow text.');
  return value;
};
const keys = (value, allowed, status) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(status, 'Use only the displayed workflow settings.');
};
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(502, 'Strata returned an unreadable workflow time.');
  return value;
};
export function teamWorkflowRoute(path) {
  const found = /^\/api\/bots\/teams\/(team_[a-f0-9-]+)\/workflows(?:\/(wf_[a-f0-9-]{36})(?:\/(resume|stop|review))?)?$/.exec(path);
  return found ? { kind: 'workflow', teamId: found[1], ...(found[2] ? { workflowId: found[2] } : {}), ...(found[3] ? { action: found[3] } : {}) } : null;
}
export function workflowRequest(route, method, body, status = 400, validateBody = true) {
  route.method = method;
  const allowed = route.action ? ['POST'] : route.workflowId ? ['GET'] : ['GET', 'POST'];
  if (!allowed.includes(method)) fail(status, 'This workflow action is unavailable.');
  if (!validateBody) return route;
  if (method === 'GET') {
    if (body !== undefined) fail(status, 'Workflow reads take no settings.');
    return route;
  }
  if (!route.workflowId) {
    keys(body, ['requestId', 'goal', 'plannerId', 'builderId', 'evaluatorId', 'criteria'], status);
    text(body.requestId, 160, status); text(body.goal, 16000, status);
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(body.requestId) || !['plannerId', 'builderId', 'evaluatorId'].every(key => identifier(body[key])) || body.builderId === body.evaluatorId) fail(status, 'Choose saved teammates and a reviewer different from the builder.');
    if (!Array.isArray(body.criteria) || body.criteria.length < 1 || body.criteria.length > 16) fail(status, 'Enter one to sixteen success criteria.');
    for (const row of body.criteria) text(row, 1000, status);
    return route;
  }
  keys(body, ['expectedRevision', 'expectedProof', ...(route.action === 'resume' ? ['requestId', 'inspected'] : route.action === 'review' ? ['decision', 'note'] : [])], status);
  if (!positive(body.expectedRevision) || !proof(body.expectedProof)) fail(status, 'Refresh and inspect this exact workflow checkpoint.');
  if (route.action === 'resume') {
    text(body.requestId, 160, status);
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(body.requestId) || body.inspected !== true) fail(status, 'Inspect existing progress before continuing this task.');
  }
  if (route.action === 'review') {
    if (!['accept', 'changes_requested'].includes(body.decision)) fail(status, 'Choose a workflow review decision.');
    if (body.note !== undefined) text(body.note, 2500, status, true);
  }
  return route;
}
function evidence(row) {
  if (!object(row) || !['file', 'test', 'link', 'note'].includes(row.kind)) fail(502, 'Strata returned unreadable workflow evidence.');
  const value = { kind: row.kind, label: text(row.label, 160), detail: text(row.detail, 1000) };
  if (row.kind === 'link') {
    let url; try { url = new URL(row.detail); } catch {}
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail(502, 'Strata returned an unsupported workflow evidence link.');
  }
  return value;
}
export function publicTeamWorkflow(value, teamId, expectedId) {
  if (!object(value) || !workflowId(value.id) || value.teamId !== teamId || expectedId && value.id !== expectedId || !['plannerId', 'builderId', 'evaluatorId'].every(key => identifier(value[key])) || value.builderId === value.evaluatorId || !phases.has(value.phase) || !positive(value.revision) || !proof(value.proof) || !nonnegative(value.round) || typeof value.canResume !== 'boolean') fail(502, 'Strata returned an unreadable workflow checkpoint.');
  if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 16 || !Array.isArray(value.steps) || value.steps.length > 12 || !nonnegative(value.totalSteps) || value.totalSteps < value.steps.length || value.stepsTruncated !== (value.totalSteps > value.steps.length) || !Array.isArray(value.checks) || value.checks.length > 16) fail(502, 'Strata returned incomplete workflow progress.');
  const criterionIds = new Set();
  const criteria = value.criteria.map(row => {
    if (!object(row) || !/^wc_[a-f0-9-]{36}$/.test(row.id) || criterionIds.has(row.id)) fail(502, 'Strata returned inconsistent workflow criteria.');
    criterionIds.add(row.id); return { id: row.id, text: text(row.text, 1000) };
  });
  const seenSteps = new Set();
  const steps = value.steps.map(row => {
    const expectedBot = row?.phase === 'planning' ? value.plannerId : row?.phase === 'evaluating' ? value.evaluatorId : value.builderId;
    if (!object(row) || !/^ws_[a-f0-9-]{36}$/.test(row.id) || seenSteps.has(row.id) || !stages.has(row.phase) || row.botId !== expectedBot || !stepStates.has(row.state)) fail(502, 'Strata returned inconsistent workflow stages.');
    seenSteps.add(row.id);
    const result = { id: row.id, phase: row.phase, botId: row.botId, state: row.state };
    for (const key of ['chatId', 'runId']) if (row[key] !== undefined) { if (!identifier(row[key])) fail(502, 'Strata returned an invalid workflow conversation.'); result[key] = row[key]; }
    for (const key of ['startedAt', 'completedAt']) if (row[key] !== undefined) result[key] = timestamp(row[key]);
    if (row.summary !== undefined) result.summary = text(row.summary, 1000, 502, true);
    if (row.evidence !== undefined) { if (!Array.isArray(row.evidence) || row.evidence.length > 4) fail(502, 'Strata returned unbounded workflow evidence.'); result.evidence = row.evidence.map(evidence); }
    return result;
  });
  const seenChecks = new Set();
  const checks = value.checks.map(row => {
    if (!object(row) || !criterionIds.has(row.criterionId) || seenChecks.has(row.criterionId) || typeof row.passed !== 'boolean') fail(502, 'Strata returned inconsistent workflow checks.');
    seenChecks.add(row.criterionId); return { criterionId: row.criterionId, passed: row.passed, detail: text(row.detail, 2000) };
  });
  if (['awaiting_review', 'completed'].includes(value.phase) && (checks.length !== criteria.length || checks.some(row => !row.passed) || steps.at(-1)?.phase !== 'evaluating' || steps.at(-1)?.state !== 'completed')) fail(502, 'The workflow does not have a complete independent evaluation.');
  if (value.canResume && !['blocked', 'interrupted', 'stopped'].includes(value.phase)) fail(502, 'Strata returned an inconsistent continuation checkpoint.');
  const result = { id: value.id, teamId, goal: text(value.goal, 16000), plannerId: value.plannerId, builderId: value.builderId, evaluatorId: value.evaluatorId, criteria, phase: value.phase, revision: value.revision, proof: value.proof, round: value.round, steps, checks, totalSteps: value.totalSteps, stepsTruncated: value.stepsTruncated, canResume: value.canResume, createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt) };
  for (const key of ['summary', 'blockedReason']) if (value[key] !== undefined) result[key] = text(value[key], key === 'summary' ? 8000 : 2500, 502, true);
  if (value.plan !== undefined) {
    if (!object(value.plan) || !Array.isArray(value.plan.items) || value.plan.items.length < 1 || value.plan.items.length > 16) fail(502, 'Strata returned an unreadable workflow plan.');
    result.plan = { summary: text(value.plan.summary, 2000), items: value.plan.items.map(row => text(row, 1000)) };
  }
  return result;
}
export function publicWorkflowResponse(body, route) {
  if (!object(body)) fail(502, 'Strata returned unreadable workflows.');
  if (route.method === 'GET' && !route.workflowId && body.workflow !== undefined) fail(502, 'Strata returned a task instead of its workflow list.');
  if (body.workflow !== undefined) return { workflow: publicTeamWorkflow(body.workflow, route.teamId, route.workflowId) };
  if (route.workflowId || route.method === 'POST' || body.teamWorkflowsSupported !== true || typeof body.available !== 'boolean' || typeof body.hasMore !== 'boolean' || !Array.isArray(body.workflows) || body.workflows.length > 20) fail(502, 'Strata returned an unreadable workflow list.');
  const seen = new Set();
  const workflows = body.workflows.map(value => {
    const safe = publicTeamWorkflow(value, route.teamId);
    if (seen.has(safe.id)) fail(502, 'Strata returned repeated workflow identities.');
    seen.add(safe.id); return safe;
  });
  if (Buffer.byteLength(JSON.stringify(workflows)) > 256 * 1024) fail(502, 'Strata returned an unbounded workflow list.');
  return { teamWorkflowsSupported: true, available: body.available, workflows, hasMore: body.hasMore, ...(body.error !== undefined ? { error: text(body.error, 2500) } : {}) };
}
export function confirmWorkflowMutation(result, route, body, before) {
  const value = publicWorkflowResponse(result, route).workflow;
  if (!value) fail(502, 'Strata did not confirm this workflow action.');
  if (!route.workflowId) {
    if (value.goal !== body.goal.trim() || ['plannerId', 'builderId', 'evaluatorId'].some(key => value[key] !== body[key]) || value.criteria.length !== body.criteria.length || value.criteria.some((row, index) => row.text !== body.criteria[index].trim())) fail(502, 'Strata did not confirm the selected workflow.');
  } else {
    if (value.revision <= body.expectedRevision || value.proof === body.expectedProof) fail(502, 'Strata did not confirm a new workflow checkpoint.');
    if (before && (['goal', 'plannerId', 'builderId', 'evaluatorId', 'createdAt'].some(key => value[key] !== before[key]) || JSON.stringify(value.criteria) !== JSON.stringify(before.criteria))) fail(502, 'Strata returned different workflow scope. Refresh before continuing.');
    if (route.action === 'review' && body.decision === 'accept' && value.phase !== 'completed') fail(502, 'Strata did not confirm your final acceptance.');
    if ((route.action === 'resume' || route.action === 'review' && body.decision === 'changes_requested') && value.phase === 'completed') fail(502, 'Strata reported acceptance for an action that did not accept the result. Refresh its saved state.');
    if (route.action === 'stop' && !['stopped', 'stopping'].includes(value.phase)) fail(502, 'Strata did not confirm this workflow stopped.');
  }
  return value;
}
