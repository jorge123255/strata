import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTeamWorkflows } from '../server/bots-workflows.mjs';
import { workflowStore } from '../server/bots-workflows-store.mjs';
function fixture(t, supplied = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-workflow-')), teamId = `team_${randomUUID()}`, team = { id: teamId, enabled: true, revision: 1, memberIds: ['a', 'b', 'c'] }, sent = [], notices = [], states = [];
  let blocked = false, auth = 'a'.repeat(64), verifier = true, saves = 0, failSave = 0;
  const durable = workflowStore(directory), store = { ...durable, save(v) { saves++; if (saves === failSave) throw new Error('injected write failure'); durable.save(v); } };
  const options = { directory, store, teamFor(id) { assert.equal(id, teamId); return team; }, prepare() { return { a: auth, b: auth, c: auth }; }, ensure(row) { if (blocked || !team.enabled || team.revision !== row.teamRevision || Object.values(row.authorities).some(v => v !== auth)) throw new Error('access changed'); }, dispatch(row, step, message) { const chatId = `s_${randomUUID()}`, jobId = `tj_${randomUUID()}`; sent.push({ row, step, message, chatId, jobId }); return { chatId, jobId }; }, stopRun: async () => { if (blocked) throw new Error('cleanup unconfirmed'); }, publish: (r, e) => notices.push({ r, e }), stateChanged: r => states.push(r), ...supplied };
  let service = createTeamWorkflows(options);
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  const createInput = (requestId = 'owner1') => ({ requestId, goal: 'Build the requested feature without release actions.', plannerId: 'a', builderId: 'b', evaluatorId: 'c', criteria: ['Actual check passes', 'Owner scope is preserved'] });
  const current = id => service.detail(teamId, id).workflow;
  function launch(id) { service.pump(); const dispatch = sent.at(-1); assert.equal(dispatch.row.id, id); service.beforeStart(id, dispatch.step.id, dispatch.chatId); return { ...service.binding(id, dispatch.step.id), botId: dispatch.step.botId, chatId: dispatch.chatId, assertLive() {}, hasVerificationEvidence: () => verifier }; }
  function result(id, binding, type, args, outcome = {}) { service.submission(type, args, binding); service.finish(id, binding.stepId, outcome); return current(id); }
  const plan = { summary: 'Plan scoped work', items: ['Inspect the current workspace', 'Implement and independently check'] }, build = { summary: 'Built scoped changes', evidence: [{ kind: 'file', label: 'Changed source', detail: 'src/fixture.mjs' }] };
  const review = (id, passed = true, detail = 'Ran an independent verification') => ({ decision: passed ? 'pass' : 'changes_requested', summary: passed ? 'All criteria assessed' : 'A repair is needed', checks: current(id).criteria.map(c => ({ criterionId: c.id, passed, detail })) });
  const select = id => ({ expectedRevision: current(id).revision, expectedProof: current(id).proof });
  return { directory, teamId, team, sent, notices, states, createInput, current, launch, result, plan, build, review, select, get service() { return service; }, set blocked(v) { blocked = v; }, set auth(v) { auth = v; }, set verifier(v) { verifier = v; }, failNext() { failSave = saves + 1; }, restart() { service.close(); service = createTeamWorkflows({ ...options, store: workflowStore(directory) }); }, options };
}
function complete(f, id) { f.result(id, f.launch(id), 'submit_workflow_plan', f.plan); f.result(id, f.launch(id), 'submit_workflow_build', f.build); f.result(id, f.launch(id), 'submit_workflow_review', f.review(id)); }
test('unused workflow feature leaves files absent; corrupt optional state is visible and never reset', t => {
  const f = fixture(t); assert.equal(f.service.list(f.teamId).available, true); assert.equal(existsSync(join(f.directory, 'bot-workflows.json')), false);
  f.service.close(); writeFileSync(join(f.directory, 'bot-workflows.json'), '{corrupt', { mode: 0o600 }); const bad = createTeamWorkflows({ ...f.options, store: workflowStore(f.directory) });
  assert.equal(bad.list(f.teamId).available, false); assert.throws(() => bad.create(f.teamId, f.createInput()), /unavailable/); assert.equal(readFileSync(join(f.directory, 'bot-workflows.json'), 'utf8'), '{corrupt'); bad.close();
});
test('create validates independent roles, strict scope and durable idempotency before model dispatch', t => {
  const f = fixture(t); assert.throws(() => f.service.create(f.teamId, { ...f.createInput(), evaluatorId: 'b' }), /independent/); assert.throws(() => f.service.create(f.teamId, { ...f.createInput(), hiddenPermission: true }), /Unsupported/);
  const row = f.service.create(f.teamId, f.createInput()).workflow; assert.equal(f.sent.length, 0); assert.equal(f.service.create(f.teamId, f.createInput()).workflow.id, row.id); assert.throws(() => f.service.create(f.teamId, { ...f.createInput(), goal: 'Other' }), /request ID/); assert.equal(statSync(join(f.directory, 'bot-workflows.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'bot-workflows.json'))).workflows[0].steps[0].state, 'pending');
});
test('only exact assigned live stage can submit and a model pass requires its own verification activity', t => {
  const f = fixture(t), id = f.service.create(f.teamId, f.createInput()).workflow.id, a = f.launch(id);
  assert.throws(() => f.service.submission('submit_workflow_build', f.build, a), /assigned role/); assert.throws(() => f.service.submission('submit_workflow_plan', f.plan, { ...a, botId: 'b' }), /another bot/);
  f.result(id, a, 'submit_workflow_plan', f.plan); f.result(id, f.launch(id), 'submit_workflow_build', f.build); const c = f.launch(id); f.verifier = false;
  assert.throws(() => f.service.submission('submit_workflow_review', f.review(id), c), /actual supplied/); f.verifier = true; f.result(id, c, 'submit_workflow_review', f.review(id)); assert.equal(f.current(id).phase, 'awaiting_review');
  assert.throws(() => f.service.submission('submit_workflow_review', f.review(id), c), /ended/);
});
test('successful evaluator assessment awaits exact owner review and cannot self-mark completed', t => {
  const f = fixture(t), id = f.service.create(f.teamId, f.createInput()).workflow.id; complete(f, id); const assessed = f.current(id); assert.equal(assessed.phase, 'awaiting_review'); assert.equal(assessed.checks.every(c => c.passed), true);
  assert.throws(() => f.service.review(f.teamId, id, { ...f.select(id), expectedProof: '0'.repeat(64), decision: 'accept' }), /changed/);
  f.team.enabled = false; assert.equal(f.service.review(f.teamId, id, { ...f.select(id), decision: 'accept' }).workflow.phase, 'completed'); assert.equal(f.current(id).canResume, false);
});
test('repair cycles have no fixed round cap and block only when both build and review stop progressing', t => {
  const f = fixture(t), id = f.service.create(f.teamId, f.createInput()).workflow.id; f.result(id, f.launch(id), 'submit_workflow_plan', f.plan);
  for (let round = 0; round < 6; round++) { f.result(id, f.launch(id), 'submit_workflow_build', { ...f.build, summary: `Actual new changes ${round}` }); const row = f.result(id, f.launch(id), 'submit_workflow_review', f.review(id, false)); assert.equal(row.phase, 'repairing'); }
  f.result(id, f.launch(id), 'submit_workflow_build', { ...f.build, summary: 'Actual new changes 5' }); assert.equal(f.result(id, f.launch(id), 'submit_workflow_review', f.review(id, false)).phase, 'blocked');
});
test('a submitted checkpoint cannot dispatch the next stage until the originating turn and cleanup settle', t => {
  const f = fixture(t), id = f.service.create(f.teamId, f.createInput()).workflow.id, binding = f.launch(id); f.service.submission('submit_workflow_plan', f.plan, binding); f.service.pump(); assert.equal(f.sent.length, 1); assert.equal(f.current(id).phase, 'planning');
  f.service.finish(id, binding.stepId, { error: 'cleanup failure with private secret' }); assert.equal(f.current(id).phase, 'blocked'); assert.equal(JSON.stringify(f.current(id)).includes('private secret'), false); f.service.pump(); assert.equal(f.sent.length, 1);
});
test('restart projects interrupted without rewriting or replay and explicit resume preserves completed checkpoints', t => {
  const f = fixture(t), id = f.service.create(f.teamId, f.createInput()).workflow.id; f.result(id, f.launch(id), 'submit_workflow_plan', f.plan); const b = f.launch(id); f.service.submission('submit_workflow_build', f.build, b); const before = readFileSync(join(f.directory, 'bot-workflows.json')); const sent = f.sent.length;
  f.restart(); assert.equal(f.current(id).phase, 'interrupted'); assert.deepEqual(readFileSync(join(f.directory, 'bot-workflows.json')), before); f.service.pump(); assert.equal(f.sent.length, sent);
  const selection = { ...f.select(id), requestId: 'resume1', inspected: true }; const resumed = f.service.resume(f.teamId, id, selection).workflow; assert.equal(resumed.phase, 'building'); assert.equal(resumed.steps[0].state, 'completed'); assert.equal(f.service.resume(f.teamId, id, selection).workflow.id, id); f.launch(id); assert.match(f.sent.at(-1).message, /FIRST inspect/); assert.equal(f.sent.at(-1).step.phase, 'building'); assert.throws(() => f.service.submission('submit_workflow_build', f.build, b), /another bot|ended/);
});
test('revoked authority and unresolved action/cleanup holds block explicit resume and queued stage launch', async t => {
  const f = fixture(t), id = f.service.create(f.teamId, f.createInput()).workflow.id; f.launch(id); await f.service.stop(f.teamId, id, f.select(id)); f.auth = 'b'.repeat(64); assert.equal(f.current(id).canResume, false); assert.throws(() => f.service.resume(f.teamId, id, { ...f.select(id), requestId: 'r', inspected: true }), /access/);
  f.auth = 'a'.repeat(64); f.service.resume(f.teamId, id, { ...f.select(id), requestId: 'r', inspected: true }); f.blocked = true; f.service.pump(); assert.equal(f.current(id).phase, 'blocked'); assert.equal(f.sent.length, 1);
});
test('Stop fences stale stage submissions, retains history and cleanup uncertainty never resumes', async t => {
  const f = fixture(t), id = f.service.create(f.teamId, f.createInput()).workflow.id, binding = f.launch(id); f.blocked = true;
  assert.equal((await f.service.stop(f.teamId, id, f.select(id))).workflow.phase, 'stopping'); assert.equal(f.current(id).canResume, false); assert.throws(() => f.service.submission('submit_workflow_plan', f.plan, binding), /ended/); f.blocked = false;
  assert.equal((await f.service.stop(f.teamId, id, f.select(id))).workflow.phase, 'stopped'); assert.equal(f.current(id).canResume, true); assert.equal(f.current(id).steps[0].state, 'stopped');
});
test('checkpoint write failure never starts the next model stage or overwrites saved progress', t => {
  const f = fixture(t), id = f.service.create(f.teamId, f.createInput()).workflow.id, binding = f.launch(id); f.service.submission('submit_workflow_plan', f.plan, binding); const bytes = readFileSync(join(f.directory, 'bot-workflows.json')); f.failNext();
  assert.throws(() => f.service.finish(id, binding.stepId), /unavailable/); f.service.pump(); assert.equal(f.sent.length, 1); assert.deepEqual(readFileSync(join(f.directory, 'bot-workflows.json')), bytes); assert.equal(f.service.list(f.teamId).available, false);
});
test('live writer excludes another controller and external/symlink replacement is never overwritten', t => {
  const f = fixture(t), id = f.service.create(f.teamId, f.createInput()).workflow.id; const other = createTeamWorkflows({ ...f.options, store: workflowStore(f.directory) }); assert.throws(() => other.resume(f.teamId, id, { ...other.detail(f.teamId, id).workflow, requestId: 'r', inspected: true }), /Unsupported|changed/); assert.throws(() => other.create(f.teamId, f.createInput('other')), /unavailable/); other.close();
  const path = join(f.directory, 'bot-workflows.json'), foreign = join(f.directory, 'foreign'); writeFileSync(foreign, 'keep'); unlinkSync(path); symlinkSync(foreign, path); assert.throws(() => f.service.create(f.teamId, f.createInput('x')), /unavailable/); assert.equal(readFileSync(foreign, 'utf8'), 'keep');
});
test('public step history stays bounded across useful rounds without cutting Unicode or losing criteria', t => {
  const f = fixture(t), id = f.service.create(f.teamId, f.createInput()).workflow.id; f.result(id, f.launch(id), 'submit_workflow_plan', f.plan);
  for (let i = 0; i < 9; i++) { f.result(id, f.launch(id), 'submit_workflow_build', { summary: 'a'.repeat(999)+'😀'+i, evidence: [{ kind: 'note', label: 'Public evidence', detail: 'a'.repeat(999)+'😀' }] }); f.result(id, f.launch(id), 'submit_workflow_review', f.review(id, false, `Changed review ${i}`)); }
  const row = f.current(id); assert.equal(row.steps.length, 12); assert.equal(row.stepsTruncated, true); assert.equal(row.steps.every(s => (!s.summary || s.summary.isWellFormed() && s.summary.length <= 1000) && (!s.evidence || s.evidence.every(e => e.detail.isWellFormed() && e.detail.length <= 1000))), true); assert.equal(f.service.list(f.teamId).hasMore, false);
  assert.throws(() => f.service.create(f.teamId, { ...f.createInput('broken'), goal: '\ud800' }), /valid/);
});

test('public UTF-16 field limits remain exact with multibyte geometric avatar text', t => {
  const f=fixture(t),id=f.service.create(f.teamId,f.createInput()).workflow.id;f.result(id,f.launch(id),'submit_workflow_plan',f.plan);f.result(id,f.launch(id),'submit_workflow_build',{summary:'😀'.repeat(600),evidence:[{kind:'note',label:'Result',detail:'😀'.repeat(600)}]});const step=f.current(id).steps.find(s=>s.phase==='building');assert.equal(step.summary.length,1000);assert.equal(step.summary.isWellFormed(),true);assert.equal(step.evidence[0].detail.length,1000);assert.equal(step.evidence[0].detail.isWellFormed(),true);
});

test('owner feedback remains append-only across repair reviews and is never copied into public status', t => {
 const f=fixture(t),id=f.service.create(f.teamId,f.createInput()).workflow.id;complete(f,id);const hold='Do not deploy, release or restart any owner service.';f.service.review(f.teamId,id,{...f.select(id),decision:'changes_requested',note:hold});f.result(id,f.launch(id),'submit_workflow_build',{...f.build,summary:'First owner repair'});f.result(id,f.launch(id),'submit_workflow_review',f.review(id));f.service.review(f.teamId,id,{...f.select(id),decision:'changes_requested',note:'Also improve the result display.'});f.launch(id);assert.match(f.sent.at(-1).message,/Do not deploy, release or restart/);assert.match(f.sent.at(-1).message,/Also improve/);const row=JSON.parse(readFileSync(join(f.directory,'bot-workflows.json'))).workflows[0];assert.equal(row.ownerFeedback.length,2);assert.equal(row.ownerFeedback[0].note,hold);assert.equal(f.notices.some(n=>n.e.content.includes(hold)),false);
});
test('more than eighty checkpoints remain loadable across repeated interruption and resume',t=>{
 const f=fixture(t),id=f.service.create(f.teamId,f.createInput()).workflow.id;f.result(id,f.launch(id),'submit_workflow_plan',f.plan);for(let i=0;i<42;i++){f.result(id,f.launch(id),'submit_workflow_build',{...f.build,summary:'Actual build '+i});f.result(id,f.launch(id),'submit_workflow_review',f.review(id,false,'Actual check '+i));}const total=f.current(id).totalSteps;assert.ok(total>80);f.restart();f.service.resume(f.teamId,id,{...f.select(id),requestId:'after-80',inspected:true});assert.equal(JSON.parse(readFileSync(join(f.directory,'bot-workflows.json'))).workflows[0].steps.length,80);f.restart();assert.equal(f.service.list(f.teamId).available,true);assert.equal(f.current(id).totalSteps,total+1);
});
test('large public reports may be omitted with notice while exact goal, all criteria and prior holds remain',t=>{
 const f=fixture(t),input={...f.createInput(),goal:'g'.repeat(16000),criteria:Array.from({length:16},(_,i)=>('Criterion'+i+' ').padEnd(1000,'c'))},id=f.service.create(f.teamId,input).workflow.id;f.result(id,f.launch(id),'submit_workflow_plan',{summary:'p'.repeat(2000),items:Array.from({length:16},()=> 'i'.repeat(1000))});f.result(id,f.launch(id),'submit_workflow_build',{summary:'b'.repeat(8000),evidence:Array.from({length:32},()=>({kind:'note',label:'Artifact',detail:'e'.repeat(4000)}))});f.launch(id);const prompt=f.sent.at(-1).message;assert.ok(prompt.length<100000);assert.match(prompt,/contextNotice/);assert.ok(prompt.includes(input.goal));for(const c of input.criteria)assert.ok(prompt.includes(c));
});

test('paired list budget remains bounded for escape-heavy report previews without hiding owner scope',t=>{
 const f=fixture(t),goal='"'.repeat(16000),criteria=Array.from({length:16},(_,i)=>String(i).padEnd(1000,'"')),id=f.service.create(f.teamId,{...f.createInput(),goal,criteria}).workflow.id;f.result(id,f.launch(id),'submit_workflow_plan',{summary:'"'.repeat(2000),items:Array.from({length:16},()=> '"'.repeat(1000))});for(let i=0;i<7;i++){f.result(id,f.launch(id),'submit_workflow_build',{summary:String(i)+'"'.repeat(7999),evidence:Array.from({length:4},()=>({kind:'note',label:'"'.repeat(160),detail:'"'.repeat(4000)}))});f.result(id,f.launch(id),'submit_workflow_review',{...f.review(id,false),summary:'"'.repeat(8000),checks:f.current(id).criteria.map(c=>({criterionId:c.id,passed:false,detail:String(i)+'"'.repeat(1999)}))});}const list=f.service.list(f.teamId);assert.equal(list.workflows.length,1);assert.ok(Buffer.byteLength(JSON.stringify(list))<256*1024);assert.equal(list.workflows[0].goal,goal);assert.deepEqual(list.workflows[0].criteria.map(c=>c.text),criteria);
});

test('link evidence is an unbroken public HTTP(S) target, and local paths require file kind',t=>{
 const f=fixture(t),id=f.service.create(f.teamId,f.createInput()).workflow.id;f.result(id,f.launch(id),'submit_workflow_plan',f.plan);const binding=f.launch(id);for(const detail of ['file:///fixture/output.txt','https://user:secret@example.invalid/result','https://example.invalid/'+ 'x'.repeat(1000)])assert.throws(()=>f.service.submission('submit_workflow_build',{...f.build,evidence:[{kind:'link',label:'Result',detail}]},binding),/HTTP/);f.result(id,binding,'submit_workflow_build',{...f.build,evidence:[{kind:'link',label:'Result',detail:'https://example.invalid/result'}]});assert.equal(f.current(id).steps.find(s=>s.phase==='building').evidence[0].detail,'https://example.invalid/result');
});
test('Unicode input limits match UTF-16 clients and oversized mandatory serialized scope blocks visibly',t=>{
 const f=fixture(t);assert.doesNotThrow(()=>f.service.create(f.teamId,{...f.createInput(),criteria:['😀'.repeat(400)]}));const id=f.service.create(f.teamId,{...f.createInput('escaped'),goal:'\u0001'.repeat(16000),criteria:Array.from({length:16},()=> '\u0001'.repeat(1000))}).workflow.id;f.service.pump();const row=f.current(id);assert.equal(row.phase,'blocked');assert.match(row.blockedReason,/goal, criteria and owner feedback.*budget/);assert.equal(row.canResume,false);assert.equal(f.sent.some(s=>s.row.id===id),false);
});
