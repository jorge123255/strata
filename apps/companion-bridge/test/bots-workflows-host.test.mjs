/** Actual local host + paired TLS contract. All state and tool effects are disposable. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBots, createBotRoutes } from '../../host/server/bots.mjs';
import { createConversations } from '../../host/server/conversations.mjs';
import { createBridge } from '../bridge.mjs';

const until = async predicate => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Disposable workflow did not reach the expected state.');
    await new Promise(resolve => setImmediate(resolve));
  }
};
function pairedRequest(bridge, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, agent: false, rejectUnauthorized: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', part => text += part);
      response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('paired TLS uses actual saved bots and host workflow through independent evaluation and owner acceptance', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-workflow-wire-'));
  const hostDirectory = join(directory, 'host'), counter = join(directory, 'counter.txt');
  writeFileSync(counter, '0');
  let conversations, bots, team;
  const turns = [], hostRequests = [];
  const runtime = { providers: async () => [], close() {}, async run(input) {
    turns.push(input);
    const phase = /; role (planning|building|evaluating|repairing)\./.exec(input.message)?.[1];
    if (phase === 'planning') await input.executeTool('submit_workflow_plan', { summary: 'Inspect, build, and independently check the scratch result.', items: ['Increment the scratch counter once.', 'Read the actual counter separately.'] }, 'plan');
    else if (phase === 'building') {
      await input.executeTool('write_file', { path: 'counter.txt' }, 'build-artifact');
      await input.executeTool('submit_workflow_build', { summary: 'Scratch counter incremented once. 🙂', evidence: [{ kind: 'file', label: 'Scratch result', detail: 'counter.txt' }] }, 'build');
    } else if (phase === 'evaluating') {
      const result = await input.executeTool('read_file', { path: 'counter.txt' }, 'independent-check');
      assert.match(JSON.stringify(result), /1/);
      const workflow = bots.team.workflows.list(team.id).workflows.find(row => row.steps.some(step => step.chatId === input.sessionId));
      await input.executeTool('submit_workflow_review', { decision: 'pass', summary: 'Read the independent scratch result.', checks: workflow.criteria.map(row => ({ criterionId: row.id, passed: true, detail: 'Actual scratch file contains 1.' })) }, 'review');
    } else throw Error('Unexpected disposable workflow stage.');
    input.onFrame({ type: 'delta', text: 'Private fixture transcript.' }); input.onFrame({ type: 'done' });
  } };
  const tools = { definitions: () => ['read_file', 'write_file'].map(name => ({ name, description: 'Disposable scratch file tool', inputSchema: { type: 'object' } })),
    async execute({ name }) {
      if (name === 'write_file') writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1));
      return { content: [{ type: 'text', text: readFileSync(counter, 'utf8') }] };
    }, async finish() {} };
  bots = createBots({ directory: hostDirectory, runtime, tools, defaultWorkspace: () => directory, conversations: () => conversations });
  conversations = createConversations({ directory: hostDirectory, enabled: () => bots.hasProfiles(), pending: id => bots.pending(id), stop: id => bots.stop(id), approve: value => bots.approve(value), validateSelection: value => bots.validateSelection(value), execute: value => bots.run(value) });
  const members = ['Planner', 'Builder', 'Reviewer'].map(name => bots.create({ name, provider: 'codex', workspace: directory, policy: 'bypass' }).bot);
  team = bots.team.create({ name: 'Disposable wire team', memberIds: members.map(row => row.id), coordinatorId: members[0].id, enabled: true }).team;
  let route;
  const host = http.createServer((request, response) => route(request, response, new URL(request.url, `http://127.0.0.1:${host.address().port}`)));
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const port = host.address().port, origin = `http://127.0.0.1:${port}`;
  route = createBotRoutes({ bots, port });
  const bridge = await createBridge({ directory: join(directory, 'bridge'), listen: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, adminPort: 0, qr: false,
    host: { async json(path, options = {}) {
      hostRequests.push({ path, method: options.method ?? 'GET' });
      const response = await fetch(origin + path, { method: options.method ?? 'GET', headers: { Origin: origin, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(Error(body.error ?? 'Disposable host request failed.'), { status: response.status });
      return body;
    } } });
  t.after(async () => { await bridge.close(); await bots.close(); conversations.close(); await new Promise(resolve => host.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const path = `/v1/bots/teams/${team.id}/workflows`;
  assert.equal((await pairedRequest(bridge, path)).status, 401); assert.equal(hostRequests.length, 0);
  const token = bridge.authority.pair(bridge.authority.code, 'Disposable workflow phone').token;
  const empty = await pairedRequest(bridge, path, { token });
  assert.equal(empty.status, 200); assert.deepEqual(empty.body.workflows, []);
  assert.equal(existsSync(join(hostDirectory, 'bot-workflows.json')), false);
  const draft = { requestId: 'wire-owner-create', goal: 'Increment the disposable scratch counter once.', plannerId: members[0].id, builderId: members[1].id, evaluatorId: members[2].id, criteria: ['Counter is 1.'] };
  const created = await pairedRequest(bridge, path, { token, method: 'POST', body: draft });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const workflowId = created.body.workflow.id;
  await until(() => bots.team.workflows.detail(team.id, workflowId).workflow.phase === 'awaiting_review');
  const detail = await pairedRequest(bridge, `${path}/${workflowId}`, { token });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const workflow = detail.body.workflow;
  assert.equal(workflow.phase, 'awaiting_review'); assert.equal(workflow.checks[0].passed, true);
  assert.deepEqual(workflow.steps.map(row => row.botId), members.map(row => row.id));
  assert.equal(new Set(workflow.steps.map(row => row.chatId)).size, 3); assert.equal(turns.length, 3);
  assert.equal(readFileSync(counter, 'utf8'), '1'); assert.equal(JSON.stringify(workflow).includes('Private fixture transcript.'), false);
  const mutationCount = () => hostRequests.filter(row => row.method === 'POST').length;
  const before = mutationCount();
  assert.equal((await pairedRequest(bridge, `${path}/${workflowId}/review`, { token, method: 'POST', body: { expectedRevision: 1, expectedProof: '0'.repeat(64), decision: 'accept' } })).status, 409);
  assert.equal(mutationCount(), before);
  // Owner acceptance may still be recorded after disabling future team work.
  bots.team.update(team.id, { enabled: false });
  const accepted = await pairedRequest(bridge, `${path}/${workflowId}/review`, { token, method: 'POST', body: { expectedRevision: workflow.revision, expectedProof: workflow.proof, decision: 'accept' } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body)); assert.equal(accepted.body.workflow.phase, 'completed');
  assert.ok(accepted.body.workflow.revision > workflow.revision); assert.notEqual(accepted.body.workflow.proof, workflow.proof);
  assert.equal(turns.length, 3); assert.equal(readFileSync(counter, 'utf8'), '1');
});
