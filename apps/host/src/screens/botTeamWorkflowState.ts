import type { Bot, BotTaskEvidence, BotTeam, BotTeamWorkflow, BotTeamWorkflowsSnapshot } from '../lib/bots';

export const workflowPhases = ['planning', 'building', 'evaluating', 'repairing', 'awaiting_review', 'completed', 'blocked', 'interrupted', 'stopping', 'stopped'] as const;
export const workflowStagePhases = ['planning', 'building', 'evaluating', 'repairing'] as const;
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const uuid = (prefix: string, value: unknown): value is string => typeof value === 'string' && new RegExp(`^${prefix}_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(value);
function wellFormed(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
const text = (value: unknown, max: number, required = false): value is string => typeof value === 'string' && value.length <= max && wellFormed(value) && !value.includes('\0') && (!required || !!value.trim());
const optionalText = (value: unknown, max: number) => value === undefined || text(value, max);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown) => typeof value === 'string' && value.length <= 80 && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const unique = (values: unknown[]) => new Set(values).size === values.length;
const evidence = (value: unknown): value is BotTaskEvidence => {
  if (!object(value) || !['file', 'test', 'link', 'note'].includes(String(value.kind)) || !text(value.label, 160, true) || !text(value.detail, 1000, true)) return false;
  if (value.kind === 'link') { try { const url = new URL(value.detail); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }
  return true;
};

/** Validate before enabling an action or trusting a linked conversation identity. */
export function validTeamWorkflow(value: unknown, teamId: string): value is BotTeamWorkflow {
  if (!object(value) || !uuid('wf', value.id) || value.teamId !== teamId || !safeId(teamId) ||
      !text(value.goal, 16000, true) || !safeId(value.plannerId) || !safeId(value.builderId) || !safeId(value.evaluatorId) || value.builderId === value.evaluatorId ||
      !workflowPhases.includes(value.phase as never) || !integer(value.revision) || value.revision < 1 || !text(value.proof, 64) || !/^[a-f0-9]{64}$/.test(value.proof) ||
      !integer(value.round) || !time(value.createdAt) || !time(value.updatedAt) || !optionalText(value.summary, 8000) || !optionalText(value.blockedReason, 2500) || typeof value.canResume !== 'boolean' || value.canResume && !['blocked', 'interrupted', 'stopped'].includes(String(value.phase))) return false;
  if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 16 || value.criteria.some(row => !object(row) || !uuid('wc', row.id) || !text(row.text, 1000, true)) || !unique(value.criteria.map(row => row.id))) return false;
  const ids = new Set(value.criteria.map(row => row.id));
  if (!Array.isArray(value.checks) || value.checks.length > 16 || value.checks.some(row => !object(row) || !ids.has(row.criterionId) || typeof row.passed !== 'boolean' || !text(row.detail, 2000, true)) || !unique(value.checks.map(row => row.criterionId))) return false;
  if (!Array.isArray(value.steps) || value.steps.length > 12 || value.steps.some(row => !object(row) || !uuid('ws', row.id) || !workflowStagePhases.includes(row.phase as never) || !safeId(row.botId) ||
      !['pending', 'running', 'completed', 'blocked', 'interrupted', 'stopped'].includes(String(row.state)) || row.chatId !== undefined && !safeId(row.chatId) || row.runId !== undefined && !safeId(row.runId) ||
      row.botId !== (row.phase === 'planning' ? value.plannerId : row.phase === 'evaluating' ? value.evaluatorId : value.builderId) ||
      !optionalText(row.summary, 1000) || row.startedAt !== undefined && !time(row.startedAt) || row.completedAt !== undefined && !time(row.completedAt) ||
      row.evidence !== undefined && (!Array.isArray(row.evidence) || row.evidence.length > 4 || row.evidence.some(item => !evidence(item)))) || !unique(value.steps.map(row => row.id))) return false;
  if (!integer(value.totalSteps) || value.totalSteps < value.steps.length || typeof value.stepsTruncated !== 'boolean' || value.stepsTruncated !== (value.totalSteps > value.steps.length)) return false;
  if (['awaiting_review', 'completed'].includes(String(value.phase)) && (value.checks.length !== value.criteria.length || value.checks.some(row => !row.passed) || value.steps.at(-1)?.phase !== 'evaluating' || value.steps.at(-1)?.state !== 'completed')) return false;
  return value.plan === undefined || object(value.plan) && text(value.plan.summary, 2000, true) && Array.isArray(value.plan.items) && value.plan.items.length >= 1 && value.plan.items.length <= 16 && value.plan.items.every(item => text(item, 1000, true));
}
export function validateTeamWorkflows(value: unknown, teamId: string, previous?: BotTeamWorkflowsSnapshot): BotTeamWorkflowsSnapshot {
  if (!object(value) || value.teamWorkflowsSupported !== true || typeof value.available !== 'boolean' || !Array.isArray(value.workflows) || value.workflows.length > 20 ||
      value.workflows.some(row => !validTeamWorkflow(row, teamId)) || !unique(value.workflows.map(row => row.id)) || typeof value.hasMore !== 'boolean' || value.error !== undefined && !text(value.error, 2500, true) || new TextEncoder().encode(JSON.stringify(value.workflows)).byteLength > 256 * 1024) throw Error('The workflow response could not be verified for this team. Refresh before continuing.');
  const accepted = value as unknown as BotTeamWorkflowsSnapshot;
  for (const row of accepted.workflows) {
    const old = previous?.workflows.find(item => item.id === row.id);
    if (old && (row.revision < old.revision || row.revision === old.revision && row.proof !== old.proof || row.revision > old.revision && row.proof === old.proof)) throw Error('Strata returned an older or inconsistent workflow checkpoint. Refresh before continuing.');
  }
  return accepted;
}
export const workflowActive = (phase: BotTeamWorkflow['phase']) => workflowStagePhases.includes(phase as never) || phase === 'stopping';
export const workflowLabel = (phase: BotTeamWorkflow['phase']) => ({ planning: 'Planning', building: 'Building', evaluating: 'Independent review', repairing: 'Making changes', awaiting_review: 'Needs your review', completed: 'Accepted by you', blocked: 'Blocked', interrupted: 'Interrupted', stopping: 'Stopping', stopped: 'Stopped' })[phase];
export function workflowMutationMatches(before: BotTeamWorkflow, after: unknown, action: 'resume'|'stop'|'accept'|'changes_requested'): after is BotTeamWorkflow {
  if (!validTeamWorkflow(after, before.teamId) || after.id !== before.id || after.revision <= before.revision || after.proof === before.proof ||
      after.goal !== before.goal || after.plannerId !== before.plannerId || after.builderId !== before.builderId || after.evaluatorId !== before.evaluatorId || JSON.stringify(after.criteria) !== JSON.stringify(before.criteria)) return false;
  return action === 'accept' ? after.phase === 'completed' : action === 'stop' ? ['stopping', 'stopped'].includes(after.phase) : after.phase !== 'completed';
}
export function workflowMembers(team: BotTeam, bots: Bot[]) { return team.memberIds.map(id => bots.find(bot => bot.id === id)).filter((bot): bot is Bot => !!bot); }
export function workflowMemberAvailable(bot: Bot) { return !bot.paused && bot.available !== false; }
export function defaultWorkflowRoles(team: BotTeam, bots: Bot[]) {
  const members = workflowMembers(team, bots).filter(workflowMemberAvailable), plannerId = members.find(bot => bot.id === team.coordinatorId)?.id ?? members[0]?.id ?? '';
  const workers = members.filter(bot => bot.policy !== 'plan'), builderId = workers.find(bot => bot.id !== plannerId)?.id ?? workers[0]?.id ?? '';
  return { plannerId, builderId, evaluatorId: workers.find(bot => bot.id !== builderId)?.id ?? '' };
}
export function workflowFormError(team: BotTeam, bots: Bot[], goal: string, criteria: string[], roles: {plannerId: string; builderId: string; evaluatorId: string}) {
  const eligible = workflowMembers(team, bots).filter(workflowMemberAvailable).map(bot => bot.id);
  if (eligible.length < 2) return 'Choose a team with at least two available bots. The reviewer must be different from the builder.';
  if (bots.filter(bot => eligible.includes(bot.id) && bot.policy !== 'plan').length < 2) return 'Choose at least two bots that can do work for the builder and independent reviewer. A bot in Plan mode can still be the planner.';
  if (Object.values(roles).some(id => !eligible.includes(id))) return 'Choose available team members for all three roles.';
  if ([roles.builderId, roles.evaluatorId].some(id => bots.find(bot => bot.id === id)?.policy === 'plan')) return 'Choose a builder and reviewer who can do work. A bot in Plan mode can still be the planner.';
  if (!text(goal, 16000, true)) return 'Describe the goal in up to 16,000 characters.';
  if (!criteria.length || criteria.length > 16 || criteria.some(row => !text(row, 1000, true))) return 'Add between one and 16 success criteria, up to 1,000 characters each.';
  if (roles.builderId === roles.evaluatorId) return 'Choose a reviewer who is different from the builder.';
  return '';
}
