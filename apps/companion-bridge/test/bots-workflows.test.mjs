import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../bridge.mjs';
import { botWorkspaceRequest, publicBotWorkspace } from '../bots-workspace.mjs';
import { confirmWorkflowMutation } from '../bots-workflows.mjs';

const uuid = character => `${character.repeat(8)}-${character.repeat(4)}-${character.repeat(4)}-${character.repeat(4)}-${character.repeat(12)}`;
const teamId = 'team_' + uuid('a'), workflowId = 'wf_' + uuid('b'), criterionId = 'wc_' + uuid('c');
const base = `/api/bots/teams/${teamId}/workflows`, phone = base.replace('/api/', '/v1/');
const create = { requestId: 'test-request', goal: 'Build and test the fixture', plannerId: 'bot_planner', builderId: 'bot_builder', evaluatorId: 'bot_reviewer', criteria: ['The real fixture test passes.'] };
const fixture = (patch = {}) => ({ id: workflowId, teamId, goal: create.goal, plannerId: create.plannerId, builderId: create.builderId, evaluatorId: create.evaluatorId,
  criteria: [{ id: criterionId, text: create.criteria[0] }], phase: 'interrupted', revision: 3, proof: 'd'.repeat(64), round: 1,
  steps: [{ id: 'ws_' + uuid('e'), phase: 'building', botId: create.builderId, state: 'interrupted', chatId: 's_fixture', runId: 'tr_fixture', summary: 'Inspect the partial result.', evidence: [{ kind: 'test', label: 'Fixture', detail: 'Inspect the saved file.', command: 'PRIVATE' }] }],
  totalSteps: 1, stepsTruncated: false, checks: [], canResume: true, createdAt: '2026-10-22T10:00:00.000Z', updatedAt: '2026-10-22T10:01:00.000Z', ...patch });
const exact = { expectedRevision: 3, expectedProof: 'd'.repeat(64) };
const resume = { ...exact, requestId: 'resume-request', inspected: true };
const passed = () => fixture({ phase: 'awaiting_review', canResume: false, checks: [{ criterionId, passed: true, detail: 'Executed the fixture test.' }], steps: [{ id: 'ws_' + uuid('f'), phase: 'evaluating', botId: create.evaluatorId, state: 'completed', chatId: 's_review', summary: 'Fixture test passed.' }] });
function request(bridge, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', part => text += part); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text), text }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test('workflow routes accept exact settings and cannot expose general execution', () => {
  assert.equal(botWorkspaceRequest(base, 'GET').kind, 'workflow');
  assert.equal(botWorkspaceRequest(base, 'POST', create).teamId, teamId);
  for (const action of ['resume', 'stop', 'review']) assert.equal(botWorkspaceRequest(`${base}/${workflowId}/${action}`, 'POST', action === 'resume' ? resume : action === 'review' ? { ...exact, decision: 'accept' } : exact).action, action);
  for (const method of ['PATCH', 'DELETE', 'PUT']) assert.throws(() => botWorkspaceRequest(base, method, {}));
  for (const query of ['?x=1', '?before=1', '?teamId=other']) assert.throws(() => botWorkspaceRequest(base + query, 'GET'));
  assert.throws(() => botWorkspaceRequest(base, 'GET', {}));
  assert.equal(botWorkspaceRequest(`${base}/${workflowId}/execute`, 'POST', {}), null);
  for (const patch of [{ evaluatorId: create.builderId }, { requestId: '' }, { criteria: [] }, { criteria: ['x'.repeat(1001)] }, { goal: '\ud800' }, { command: 'PRIVATE' }, { computer: 'other' }, { criteria: Array(17).fill('x') }]) assert.throws(() => botWorkspaceRequest(base, 'POST', { ...create, ...patch }));
  for (const patch of [{ inspected: false }, { expectedRevision: 0 }, { expectedProof: 'bad' }, { retry: true }, { requestId: 'a/b' }, { expectedRevision: 3.5 }]) assert.throws(() => botWorkspaceRequest(`${base}/${workflowId}/resume`, 'POST', { ...resume, ...patch }));
  assert.throws(() => botWorkspaceRequest(`${base}/${workflowId}/review`, 'POST', { ...exact, decision: 'accept', resume: true }));
});
test('public workflow projection strips execution authority, credentials and private evidence fields', () => {
  const value = fixture({ authority: 'PRIVATE', requestId: 'PRIVATE', nativeSessionId: 'PRIVATE', profile: { apiKey: 'PRIVATE' }, plan: { summary: 'Do the requested work.', items: ['Build', 'Test'], private: 'PRIVATE' } });
  value.criteria[0].private = 'PRIVATE'; value.steps[0].authority = 'PRIVATE';
  const safe = publicBotWorkspace({ workflow: value }, { kind: 'workflow', teamId, workflowId });
  assert.equal(safe.workflow.steps[0].chatId, 's_fixture'); assert.equal(JSON.stringify(safe).includes('PRIVATE'), false);
  assert.equal(publicBotWorkspace({ teamWorkflowsSupported: true, available: true, workflows: [value], hasMore: false, secrets: 'PRIVATE' }, { kind: 'workflow', teamId }).workflows.length, 1);
});
test('evaluator claims require a different assigned author and every exact criterion', () => {
  const route = { kind: 'workflow', teamId, workflowId };
  assert.equal(publicBotWorkspace({ workflow: passed() }, route).workflow.phase, 'awaiting_review');
  assert.equal(publicBotWorkspace({ workflow: fixture({ phase: 'stopped' }) }, route).workflow.canResume, true);
  for (const patch of [{ evaluatorId: create.builderId }, { checks: [] }, { checks: [{ criterionId, passed: false, detail: 'Failed' }] }, { checks: [{ criterionId: 'wc_' + uuid('a'), passed: true, detail: 'Wrong task' }] }, { steps: [{ ...passed().steps[0], botId: create.builderId }] }, { steps: [{ ...passed().steps[0], state: 'running' }] }, { canResume: true }]) assert.throws(() => publicBotWorkspace({ workflow: passedWith(patch) }, route));
  function passedWith(patch) { return { ...passed(), ...patch }; }
});
test('bounded checkpoints retain explicit history truncation and reject malformed identities', () => {
  const route = { kind: 'workflow', teamId, workflowId };
  const value = fixture({ totalSteps: 100, stepsTruncated: true });
  assert.equal(publicBotWorkspace({ workflow: value }, route).workflow.totalSteps, 100);
  for (const patch of [{ teamId: 'team_other' }, { id: 'wf_' + uuid('a') }, { stepsTruncated: false }, { totalSteps: 0 }, { steps: [...value.steps, value.steps[0]] }, { steps: Array(13).fill(value.steps[0]) }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { proof: 'd'.repeat(63) }, { createdAt: 'invalid' }, { plan: { summary: 'Plan', items: [] } }]) assert.throws(() => publicBotWorkspace({ workflow: { ...value, ...patch } }, route));
  assert.throws(() => publicBotWorkspace({ teamWorkflowsSupported: true, available: true, workflows: [value, value], hasMore: false }, { kind: 'workflow', teamId }));
  assert.throws(() => publicBotWorkspace({ workflow: value }, botWorkspaceRequest(base, 'GET')));
});
test('repair and continuation acknowledgements cannot invent owner acceptance or substitute scope', () => {
  const before = passed(), route = { kind: 'workflow', teamId, workflowId, method: 'POST', action: 'review' };
  const completed = { ...before, phase: 'completed', revision: 6, proof: '1'.repeat(64) };
  assert.throws(() => confirmWorkflowMutation({ workflow: completed }, route, { ...exact, decision: 'changes_requested' }, before), /did not accept/);
  assert.throws(() => confirmWorkflowMutation({ workflow: completed }, { ...route, action: 'resume' }, resume, before), /did not accept/);
  for (const patch of [{ goal: 'Different owner goal' }, { criteria: [{ id: criterionId, text: 'Different criterion' }] }, { createdAt: '2026-10-21T10:00:00.000Z' }]) {
    assert.throws(() => confirmWorkflowMutation({ workflow: { ...completed, ...patch } }, route, { ...exact, decision: 'accept' }, before), /different workflow scope/);
  }
  assert.equal(confirmWorkflowMutation({ workflow: completed }, route, { ...exact, decision: 'accept' }, before).phase, 'completed');
});
test('paired TLS workflow actions require authentication, current membership and exact checkpoint', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-workflow-bridge-')), calls = [];
  let current = fixture(), enabled = true, supported = true, pair, revokeOnRead = false, deceptive = false, legacy = false;
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options) {
    calls.push({ path, ...options });
    if (legacy) throw Object.assign(new Error('PRIVATE'), { status: 404 });
    if (path === '/api/bots/teams') return { teamWorkflowsSupported: supported, teams: [{ id: teamId, enabled, memberIds: [create.plannerId, create.builderId, create.evaluatorId] }] };
    if (path === '/api/bots') return { bots: [create.plannerId, create.builderId, create.evaluatorId].map(id => ({ id, policy: 'manual' })) };
    if (options?.method === 'POST') return { workflow: deceptive ? { ...current, id: 'wf_' + uuid('a') } : { ...current, phase: path.endsWith('/stop') ? 'stopped' : 'building', canResume: false, revision: current.revision + 3, proof: '1'.repeat(64) } };
    if (revokeOnRead) bridge.authority.revoke(pair.session.id);
    return path === base ? { teamWorkflowsSupported: true, available: true, workflows: [current], hasMore: false } : { workflow: current };
  } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  pair = bridge.authority.pair(bridge.authority.code, 'Workflow fixture'); const token = pair.token;
  assert.equal((await request(bridge, phone)).status, 401); assert.equal(calls.length, 0);
  assert.equal((await request(bridge, phone, { token })).status, 200);
  const postCount = () => calls.filter(row => row.method === 'POST').length;
  const path = `${phone}/${workflowId}/resume`;
  assert.equal((await request(bridge, path, { token, method: 'POST', body: { ...resume, expectedRevision: 2 } })).status, 409); assert.equal(postCount(), 0);
  assert.equal((await request(bridge, path, { token, method: 'POST', body: resume })).status, 200); assert.equal(postCount(), 1);
  assert.equal((await request(bridge, path, { token, method: 'POST', body: { ...resume, computer: 'another' } })).status, 400); assert.equal(postCount(), 1);
  enabled = false;
  assert.equal((await request(bridge, phone, { token, method: 'POST', body: create })).status, 409); assert.equal(postCount(), 1); enabled = true;
  supported = false;
  assert.equal((await request(bridge, path, { token, method: 'POST', body: resume })).status, 409); assert.equal(postCount(), 1); supported = true;
  current = fixture({ canResume: false });
  assert.equal((await request(bridge, path, { token, method: 'POST', body: resume })).status, 409); assert.equal(postCount(), 1); current = fixture();
  deceptive = true;
  assert.equal((await request(bridge, path, { token, method: 'POST', body: resume })).status, 503); assert.equal(postCount(), 2); deceptive = false;
  legacy = true;
  const old = await request(bridge, phone, { token }); assert.equal(old.status, 200); assert.equal(old.body.teamWorkflowsSupported, false); assert.equal(old.body.available, false); legacy = false;
  revokeOnRead = true;
  assert.equal((await request(bridge, path, { token, method: 'POST', body: resume })).status, 401); assert.equal(postCount(), 2);
  assert.equal(JSON.stringify(calls.filter(row => row.method === 'POST').map(row => row.body)).includes('PRIVATE'), false);
});
test('owner acceptance is not inferred from model output and POST confirms exact new checkpoint', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-workflow-review-'));
  let mode = 'valid', current = passed(), mutations = 0;
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options) {
    if (path === '/api/bots/teams') return { teamWorkflowsSupported: true, teams: [{ id: teamId, enabled: true }] };
    if (options?.method === 'POST') { mutations++; return { workflow: mode === 'stale' ? current : { ...current, phase: mode === 'wrong' ? 'awaiting_review' : 'completed', revision: 6, proof: '1'.repeat(64) } }; }
    return { workflow: current };
  } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  const token = bridge.authority.pair(bridge.authority.code, 'Review fixture').token;
  const action = `${phone}/${workflowId}/review`, body = { ...exact, decision: 'accept' };
  assert.equal((await request(bridge, action, { token, method: 'POST', body })).body.workflow.phase, 'completed');
  for (mode of ['stale', 'wrong']) assert.equal((await request(bridge, action, { token, method: 'POST', body })).status, 503);
  current = fixture();
  assert.equal((await request(bridge, action, { token, method: 'POST', body })).status, 409); assert.equal(mutations, 3);
});
test('creating a workflow uses saved team roles and confirms the exact human criteria', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-workflow-create-'));
  let mode = 'valid', mutations = 0;
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options) {
    if (path === '/api/bots/teams') return { teamWorkflowsSupported: true, teams: [{ id: teamId, enabled: true, memberIds: [create.plannerId, create.builderId, create.evaluatorId] }] };
    if (path === '/api/bots') return { bots: [create.plannerId, create.builderId, create.evaluatorId].map(id => ({ id, policy: mode === 'plan' && id === create.builderId ? 'plan' : 'manual', paused: mode === 'paused' && id === create.evaluatorId })) };
    if (options?.method === 'POST') { mutations++; return { workflow: fixture({ phase: 'planning', canResume: false, criteria: [{ id: criterionId, text: mode === 'wrong' ? 'Do something else.' : create.criteria[0] }] }) }; }
    throw new Error('No other host path is expected.');
  } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  const token = bridge.authority.pair(bridge.authority.code, 'Creation fixture').token;
  for (mode of ['paused', 'plan']) assert.equal((await request(bridge, phone, { token, method: 'POST', body: create })).status, 409);
  assert.equal(mutations, 0); mode = 'valid';
  assert.equal((await request(bridge, phone, { token, method: 'POST', body: create })).body.workflow.phase, 'planning');
  mode = 'wrong'; assert.equal((await request(bridge, phone, { token, method: 'POST', body: create })).status, 503); assert.equal(mutations, 2);
});
test('paired workflow body budget preserves supported Unicode goal and criteria bounds', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-workflow-unicode-'));
  let sent;
  const draft = { ...create, goal: '\u0800'.repeat(16000), criteria: Array.from({ length: 16 }, () => '\u0800'.repeat(1000)) };
  assert.ok(Buffer.byteLength(JSON.stringify(draft)) > 70000);
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, advertiseHost: '127.0.0.1', qr: false, host: { async json(path, options) {
    if (path === '/api/bots/teams') return { teamWorkflowsSupported: true, teams: [{ id: teamId, enabled: true, memberIds: [create.plannerId, create.builderId, create.evaluatorId] }] };
    if (path === '/api/bots') return { bots: [create.plannerId, create.builderId, create.evaluatorId].map(id => ({ id, policy: 'manual' })) };
    sent = options.body;
    return { workflow: fixture({ goal: sent.goal, phase: 'planning', canResume: false, criteria: sent.criteria.map((text, i) => ({ id: 'wc_' + uuid(i.toString(16)), text })) }) };
  } } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  const token = bridge.authority.pair(bridge.authority.code, 'Unicode fixture').token;
  const response = await request(bridge, phone, { token, method: 'POST', body: draft });
  assert.equal(response.status, 200, JSON.stringify(response.body)); assert.deepEqual(sent, draft);
  assert.equal(response.body.workflow.goal, draft.goal); assert.deepEqual(response.body.workflow.criteria.map(row => row.text), draft.criteria);
});
