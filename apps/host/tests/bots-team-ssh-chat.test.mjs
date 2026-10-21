import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, activeRemoteRuns, acquireComputerLease } from '../server/bots-runtime/ssh-worker.mjs';

class Reader extends EventEmitter { close() { this.emit('close'); } }
const hostTool = { name: 'post_team_message', description: 'Share a team reply', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } };
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'strata-team-ssh-chat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, reader: new Reader(), bot: { id: 'bot_room', name: 'Room member', provider: 'configured', model: 'fixture', capabilities: 'both', policy: 'bypass', execution: { kind: 'ssh', host: 'inert-fixture' }, workspace: '/workspace', computerMode: 'cua', teamConversationOnly: true, ...overrides } };
}

test('SSH room turns expose only frozen host speech and cannot reconstruct tools even with Bypass', async t => {
  const f = await fixture(t); const sent = []; let factories = 0, closed = false;
  await startWorker({ bot: f.bot, sessionId: 's_room', message: 'Hello team', checkpoint: { privateOldActionSession: true }, hostTools: [hostTool] }, {
    ...f, send(message) {
      sent.push(message);
      if (message.type === 'requestHostTool') queueMicrotask(() => f.reader.emit('line', JSON.stringify({ type: 'reply', id: message.id, value: { shared: true } })));
    },
    toolFactory() { factories++; throw new Error('Must not initialize local tools'); },
    cuaFactory() { factories++; throw new Error('Must not initialize CUA'); },
    runtimeFactory: () => ({ async run(input) {
      assert.deepEqual(input.tools.map(tool => tool.name), ['post_team_message']);
      assert.equal(input.bot.teamConversationOnly, true); assert.equal(input.checkpoint, null);
      assert.equal(await input.requestPermission({ name: 'write_file', args: {} }), false);
      for (const name of ['write_file', 'run_command', 'browser_open', 'computer_click', 'mcp_private']) await assert.rejects(input.executeTool(name, {}, 'blocked'), /cannot use local or computer tools/);
      assert.deepEqual(await input.executeTool('post_team_message', { message: 'Hello!' }, 'speech'), { shared: true });
      input.onCheckpoint({ oldSession: 'must-not-be-saved' }); return { text: 'Hello!' };
    }, async close() { closed = true; } }),
  });
  assert.equal(factories, 0); assert.equal(closed, true);
  assert.equal(sent.some(value => value.type === 'permission' || value.type === 'checkpoint'), false);
  assert.equal(sent.filter(value => value.type === 'requestHostTool').length, 1);
  assert.equal(sent.find(value => value.type === 'result').value.text, 'Hello!');
  assert.equal(await activeRemoteRuns(f.directory), 0);
});

test('SSH room conversation neither acquires nor clears an existing isolated-computer lease or uncertainty', async t => {
  const f = await fixture(t), key = `cua_${createHash('sha256').update(f.bot.id).digest('hex')}`;
  const release = await acquireComputerLease(f.directory, { key }); t.after(release);
  const leasePath = join(f.directory, 'leases', key + '.lock'), before = await readFile(leasePath, 'utf8');
  await mkdir(join(f.directory, 'uncertain'));
  const marker = join(f.directory, 'uncertain', key + '.json'); await writeFile(marker, '{"existing":true}');
  const sent = [];
  await startWorker({ bot: f.bot, sessionId: 's_room_with_guest', message: 'A chat only' }, { ...f, send: v => sent.push(v), runtimeFactory: () => ({ async run() { return { text: 'No computer needed.' }; }, async close() {} }) });
  assert.equal(sent.some(value => value.type === 'failure'), false);
  assert.equal(await readFile(leasePath, 'utf8'), before); assert.equal(await readFile(marker, 'utf8'), '{"existing":true}');
  assert.equal(sent.find(value => value.type === 'cleanup').guestCleanupConfirmed, true);
});

test('invalid room mode fails before runtime or local factories and never silently enables execution', async t => {
  const f = await fixture(t, { teamConversationOnly: 'true' }), sent = []; let called = false;
  await startWorker({ bot: f.bot, sessionId: 's_invalid_mode', message: 'A chat' }, { ...f, send: v => sent.push(v), runtimeFactory() { called = true; throw Error('Unexpected'); } });
  assert.equal(called, false); assert.match(sent.find(value => value.type === 'failure').message, /conversation mode is invalid/);
});

test('ordinary SSH turns keep their tool, permission and checkpoint path', async t => {
  const f = await fixture(t, { teamConversationOnly: undefined, computerMode: 'host', capabilities: 'code', workspace: '/tmp' }), sent = [];
  let executed = 0, factoryCalls = 0;
  await startWorker({ bot: f.bot, sessionId: 's_normal', message: 'An authorized task', checkpoint: { normal: true } }, {
    ...f, send(v) { sent.push(v); if (v.type === 'permission') queueMicrotask(() => f.reader.emit('line', JSON.stringify({ type: 'reply', id: v.id, value: true }))); },
    toolFactory() { factoryCalls++; return { definitions: () => [{ name: 'fixture_action', inputSchema: { type: 'object' } }], async execute(input) { assert.equal(await input.requestPermission({ name: 'fixture_action' }), true); executed++; return { ok: true }; }, async finish() {}, async close() {} }; },
    runtimeFactory: () => ({ async run(input) { assert.deepEqual(input.checkpoint, { normal: true }); assert.equal(input.tools[0].name, 'fixture_action'); await input.executeTool('fixture_action', {}, 'ordinary'); input.onCheckpoint({ normal: 'next' }); return { text: 'Done' }; }, async close() {} }),
  });
  assert.equal(factoryCalls, 1); assert.equal(executed, 1); assert.equal(sent.filter(value => value.type === 'permission').length, 1); assert.equal(sent.filter(value => value.type === 'checkpoint').length, 1);
});

test('distinct SSH team members share one exact anchored CUA lease and uncertainty record', async t => {
  const f = await fixture(t, { teamConversationOnly: undefined, computerOwnerId: 'bot_shared-anchor', sharedComputer: true });
  const key = `cua_${createHash('sha256').update(f.bot.computerOwnerId).digest('hex')}`;
  const release = await acquireComputerLease(f.directory, { key });
  const sent=[];let tools=0;
  await startWorker({ bot: {...f.bot,id:'bot_second-member'}, sessionId:'s_shared_guest', message:'Check shared guest' }, {
    ...f, send: value=>sent.push(value), cuaFactory(){tools++;throw Error('The held resource must prevent tools');},runtimeFactory(){tools++;throw Error('The held resource must prevent model execution');}
  });
  assert.equal(tools,0);assert.match(sent.find(row=>row.type==='failure').message,/Another Bots worker/);await release();
  await mkdir(join(f.directory,'uncertain'),{recursive:true});const marker=join(f.directory,'uncertain',key+'.json');await writeFile(marker,'{"retained":true}');
  const again=[];await startWorker({ bot:{...f.bot,id:'bot_third-member'},sessionId:'s_uncertain_shared',message:'Check again' },{...f,reader:new Reader(),send:value=>again.push(value),cuaFactory(){tools++;throw Error('No tools during uncertainty');}});
  assert.equal(tools,0);assert.match(again.find(row=>row.type==='failure').message,/cleanup is unconfirmed/);assert.equal(await readFile(marker,'utf8'),'{"retained":true}');
});
