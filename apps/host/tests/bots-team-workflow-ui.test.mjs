/** Workflow presentation proofs; no host accounts, APIs or model prompts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../src/screens/botTeamWorkflowState.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, write: false, format: 'esm', platform: 'node' });
const state = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const uuid = (kind, n) => `${kind}_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-22T08:00:00.000Z';
const workflow = patch => ({ id: uuid('wf', 1), teamId: 'team_fixture', goal: 'Deliver a checked change', plannerId: 'bot_planner', builderId: 'bot_builder', evaluatorId: 'bot_planner', criteria: [{ id: uuid('wc', 1), text: 'Requested behavior works' }], phase: 'awaiting_review', revision: 4, proof: 'a'.repeat(64), round: 1, createdAt: at, updatedAt: at, steps: [{ id: uuid('ws', 1), phase: 'building', botId: 'bot_builder', chatId: 's_exact_builder', state: 'completed', summary: 'Reported work', evidence: [{ kind: 'note', label: 'Claim', detail: 'All tests passed' }] }, { id: uuid('ws', 2), phase: 'evaluating', botId: 'bot_planner', chatId: 's_exact_evaluator', state: 'completed', summary: 'Independent reviewer report' }], checks: [{ criterionId: uuid('wc', 1), passed: true, detail: 'Reviewer report' }], canResume: false, totalSteps: 2, stepsTruncated: false, ...patch });

test('workflow validation binds exact team, roles, criteria and linked conversation identities', () => {
  const row = workflow(); assert.equal(state.validTeamWorkflow(row, 'team_fixture'), true);
  for (const patch of [{ teamId: 'team_other' }, { builderId: 'bot_planner' }, { proof: 'old' }, { revision: 0 }, { phase: 'verified' }, { round: Infinity }, { criteria: [] }, { totalSteps: 0 }, { stepsTruncated: true }, { checks: [{ criterionId: uuid('wc', 2), passed: true, detail: '' }] }, { steps: [{ ...row.steps[0], chatId: '../private' }] }, { steps: [{ ...row.steps[0], evidence: [{ kind: 'shell', label: 'Claim', detail: 'Execute' }] }] }]) assert.equal(state.validTeamWorkflow(workflow(patch), 'team_fixture'), false, JSON.stringify(patch));
  assert.equal(state.validateTeamWorkflows({ teamWorkflowsSupported: true, available: false, workflows: [row], hasMore: false, error: 'One record unavailable' }, 'team_fixture').available, false);
  assert.throws(() => state.validateTeamWorkflows({ teamWorkflowsSupported: true, available: true, workflows: [row, row], hasMore: false }, 'team_fixture'), /could not be verified/);
});

test('owner mutation acknowledgements require newer exact authority and truthful target state', () => {
  const before = workflow(), after = { ...before, phase: 'completed', revision: 7, proof: 'b'.repeat(64) };
  assert.equal(state.workflowMutationMatches(before, after, 'accept'), true, 'Async updates may advance more than one revision.');
  for (const patch of [{ id: uuid('wf', 2) }, { teamId: 'team_other' }, { proof: before.proof }, { revision: before.revision }, { phase: 'awaiting_review' }, { goal: 'Other work' }, { criteria: [{ id: uuid('wc', 1), text: 'Changed acceptance' }] }, { evaluatorId: before.builderId }]) assert.equal(state.workflowMutationMatches(before, { ...after, ...patch }, 'accept'), false, JSON.stringify(patch));
  assert.equal(state.workflowMutationMatches(before, after, 'changes_requested'), false);
  assert.equal(state.workflowMutationMatches(before, { ...after, phase: 'repairing' }, 'changes_requested'), true);
  assert.equal(state.workflowMutationMatches(before, { ...after, phase: 'stopping' }, 'stop'), true);
  assert.equal(state.workflowMutationMatches(before, { ...after, phase: 'evaluating' }, 'stop'), false);
});

test('saved role defaults require a separate available evaluator and preserve provider settings', () => {
  const team = { memberIds: ['bot_planner', 'bot_builder', 'bot_paused'], coordinatorId: 'bot_planner' }, bots = [{ id: 'bot_planner' }, { id: 'bot_builder' }, { id: 'bot_paused', paused: true }], before = structuredClone(bots);
  const roles = state.defaultWorkflowRoles(team, bots);
  assert.deepEqual(roles, { plannerId: 'bot_planner', builderId: 'bot_builder', evaluatorId: 'bot_planner' });
  assert.equal(state.workflowFormError(team, bots, 'Goal', ['One criterion'], roles), '');
  assert.match(state.workflowFormError(team, bots, 'Goal', ['One criterion'], { ...roles, evaluatorId: roles.builderId }), /different from the builder/);
  assert.match(state.workflowFormError(team, bots, 'Goal', ['One criterion'], { ...roles, builderId: 'bot_paused' }), /available team members/);
  assert.match(state.workflowFormError(team, bots, 'Goal', Array(17).fill('Check'), roles), /one and 16/);
  assert.deepEqual(bots, before);
});

test('model-reported passes remain needs-review and interrupted workflows remain explicit continuations', () => {
  assert.equal(state.workflowLabel(workflow().phase), 'Needs your review');
  assert.equal(state.workflowLabel('completed'), 'Accepted by you');
  assert.equal(state.workflowActive('interrupted'), false);
  assert.equal(state.workflowActive('repairing'), true);
});

test('positive claims cannot bypass complete independent evaluation, public bounds or Unicode checks', () => {
  const row = workflow();
  const bad = [
    { checks: [] }, { checks: [{ ...row.checks[0], passed: false }] }, { checks: [row.checks[0], row.checks[0]] },
    { steps: [row.steps[0]], totalSteps: 1 },
    { steps: [row.steps[0], { ...row.steps[1], botId: row.builderId }] },
    { steps: [row.steps[0], { ...row.steps[1], state: 'running' }] },
    { canResume: true }, { goal: '\ud800' }, { goal: '\udc00' },
    { steps: [{ ...row.steps[0], summary: 'x'.repeat(1001) }, row.steps[1]] },
    { steps: [{ ...row.steps[0], evidence: Array(5).fill(row.steps[0].evidence[0]) }, row.steps[1]] },
    { steps: [{ ...row.steps[0], evidence: [{ kind: 'link', label: 'Unsafe URL', detail: 'https://user:password@example.invalid/' }] }, row.steps[1]] },
  ];
  for (const phase of ['awaiting_review', 'completed']) for (const patch of bad) assert.equal(state.validTeamWorkflow(workflow({ phase, ...patch }), 'team_fixture'), false, JSON.stringify({ phase, ...patch }));
  assert.equal(state.validTeamWorkflow(workflow({ phase: 'stopped', canResume: true }), 'team_fixture'), true);
  assert.equal(state.validTeamWorkflow(workflow({ goal: 'A well-formed character 🦊' }), 'team_fixture'), true);
  assert.equal(state.validTeamWorkflow(workflow({ phase: 'stopping', canResume: true }), 'team_fixture'), false);
});

test('reads cannot roll back committed checkpoints; Plan policy is limited to the planner role', () => {
  const snapshot = row => ({ teamWorkflowsSupported: true, available: true, workflows: [row], hasMore: false });
  const current = snapshot(workflow());
  for (const patch of [{ revision: 3 }, { proof: 'b'.repeat(64) }, { revision: 5 }]) assert.throws(() => state.validateTeamWorkflows(snapshot(workflow(patch)), 'team_fixture', current), /older or inconsistent/);
  assert.equal(state.validateTeamWorkflows(snapshot(workflow({ canResume: false })), 'team_fixture', current).available, true);
  const team = { memberIds: ['planner', 'builder', 'reviewer'], coordinatorId: 'planner' }, bots = [{ id: 'planner', policy: 'plan' }, { id: 'builder', policy: 'manual' }, { id: 'reviewer', policy: 'bypass' }], roles = state.defaultWorkflowRoles(team, bots);
  assert.deepEqual(roles, { plannerId: 'planner', builderId: 'builder', evaluatorId: 'reviewer' }); assert.equal(state.workflowFormError(team, bots, 'Goal', ['Criterion'], roles), '');
  assert.match(state.workflowFormError(team, bots, 'Goal', ['Criterion'], { ...roles, builderId: 'planner' }), /builder and reviewer who can do work/);
});

test('workflow counts include current work and owner review without counting finished or stopped stages', () => {
  const phases = ['planning','building','evaluating','repairing','stopping','awaiting_review','blocked','interrupted','stopped','completed'];
  const rows = phases.map((phase, index) => workflow({ id: uuid('wf',index+1), phase }));
  assert.deepEqual(state.teamWorkflowCounts(rows), {working:5,needsYou:3});
  const cleanup = workflow({phase:'stopping',blockedReason:'Cleanup needs inspection'}); assert.deepEqual(state.teamWorkflowCounts([cleanup]),{working:0,needsYou:1});
});
test('only the exact current stage observation can label an approval or error as needing the owner', () => {
  const row = workflow({phase:'building',steps:[{id:uuid('ws',3),phase:'building',botId:'bot_builder',chatId:'s_current',state:'running'}],totalSteps:1,checks:[]});
  const pending={id:'s_current',botId:'bot_builder',teamId:row.teamId,state:'approval',approvalCount:1,toolName:'write_file'};
  assert.deepEqual(state.teamWorkflowCounts([row],[pending]),{working:0,needsYou:1});
  for(const patch of [{id:'s_other'},{botId:'bot_planner'},{teamId:'team_other'},{approvalCount:0}]) assert.deepEqual(state.teamWorkflowCounts([row],[{...pending,...patch}]),{working:1,needsYou:0});
  assert.equal(state.workflowObservedActivity({...row,phase:'awaiting_review'},[pending]),undefined);
  assert.equal(state.workflowObservedActivity({...row,steps:[{...row.steps[0],state:'completed'}]},[pending]),undefined);
});

test('three available roles prefer three distinct bots while two bots remain supported',()=>{
 const team={memberIds:['planner','builder','reviewer'],coordinatorId:'planner'},bots=team.memberIds.map(id=>({id,policy:'manual'}));assert.deepEqual(state.defaultWorkflowRoles(team,bots),{plannerId:'planner',builderId:'builder',evaluatorId:'reviewer'});assert.deepEqual(state.defaultWorkflowRoles({...team,memberIds:['planner','builder']},bots),{plannerId:'planner',builderId:'builder',evaluatorId:'planner'});
});
