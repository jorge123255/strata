import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotComputers } from '../server/bots-computers.mjs';
function fixture() {
  const bot = { id: 'bot_fixture', name: 'Ada', computerMode: 'cua', execution: { kind: 'local' } };
  let time = 1000, running = false, stopFailure = null, cleared = 0;
  const calls = [];
  const frame = { available: true, width: 100, height: 100, image: { mimeType: 'image/png', data: 'fixture' } };
  const cua = Object.fromEntries(['state','start','control','stop'].map(method => [method, async options => { calls.push([method, options]); return method === 'stop' ? { available: false, stopped: true, cleanupConfirmed: true } : structuredClone(frame); }]));
  const controller = createBotComputers({ profile: (id, chatId) => { assert.equal(id, bot.id); if (chatId && chatId !== 'original') throw new Error('Unknown chat'); return structuredClone(bot); }, cua, busy: () => running, stopOwned: async () => { calls.push(['stopOwned']); if (stopFailure) throw stopFailure; running = false; }, clearUncertain: () => { cleared++; }, now: () => time });
  return { bot, controller, cua, calls, advance: ms => { time += ms; }, running: value => { running = value; }, failStop: value => { stopFailure = value; }, cleared: () => cleared };
}
test('viewing is read-only and never starts a CUA computer', async () => {
  const f = fixture(); await f.controller.state(f.bot.id, { chatId: 'original' });
  assert.deepEqual(f.calls.map(c => c[0]), ['state']);
  f.bot.computerMode = 'host'; await assert.rejects(f.controller.state(f.bot.id), /isolated CUA/);
});
test('takeover waits for confirmed Stop then grants an owner-scoped expiring lease', async () => {
  const f = fixture(); f.running(true);
  const lease = await f.controller.takeover(f.bot.id, { owner: 'phone:A' });
  assert.deepEqual(f.calls.map(c => c[0]), ['stopOwned','state']);
  assert.equal(lease.control.owned, true); assert.equal(lease.expiresAt, 31000);
  assert.throws(() => f.controller.checkRun(f.bot), /person has control/);
  await assert.rejects(f.controller.control(f.bot.id, { leaseToken: lease.leaseToken, action: 'click', x: 1, y: 1 }, { owner: 'phone:B' }), e => e.status === 403);
  assert.equal(f.calls.some(c => c[0] === 'control'), false);
  await f.controller.control(f.bot.id, { leaseToken: lease.leaseToken, action: 'click', x: 1, y: 1 }, { owner: 'phone:A' });
  assert.equal(f.calls.at(-1)[0], 'control');
  f.advance(31000);
  await assert.rejects(f.controller.control(f.bot.id, { leaseToken: lease.leaseToken, action: 'key', key: 'Enter' }, { owner: 'phone:A' }), e => e.status === 403);
  f.controller.checkRun(f.bot);
});
test('failed Stop never grants human input or starts another machine', async () => {
  const f = fixture(); f.running(true); f.failStop(Object.assign(new Error('cleanup unknown'), { code: 'ssh_cleanup_unconfirmed' }));
  await assert.rejects(f.controller.takeover(f.bot.id), /cleanup unknown/);
  assert.deepEqual(f.calls.map(c => c[0]), ['stopOwned']);
  f.controller.checkRun(f.bot);
});
test('release requires the matching owner and token, never resumes a bot', async () => {
  const f = fixture(), lease = await f.controller.takeover(f.bot.id, { owner: 'phone:A' });
  assert.throws(() => f.controller.release(f.bot.id, { leaseToken: lease.leaseToken }, { owner: 'phone:B' }), e => e.status === 403);
  const result = f.controller.release(f.bot.id, { leaseToken: lease.leaseToken }, { owner: 'phone:A' });
  assert.deepEqual(result, { released: true }); f.controller.checkRun(f.bot);
  assert.equal(f.calls.some(c => c[0] === 'start'), false);
});
test('validated control refuses unsupported actions and serializes input until completion', async () => {
  const f = fixture(), lease = await f.controller.takeover(f.bot.id);
  for (const input of [{ action: 'run_command', text: 'bad' }, { action: 'click', x: -1, y: 3 }, { action: 'type', text: '' }, { action: 'key', key: '\n' }]) await assert.rejects(f.controller.control(f.bot.id, { ...input, leaseToken: lease.leaseToken }), e => e.status === 400);
  let finish; f.cua.control = () => new Promise(resolve => { finish = resolve; });
  const pending = f.controller.control(f.bot.id, { action: 'type', text: 'hello', leaseToken: lease.leaseToken });
  await new Promise(r => setImmediate(r));
  await assert.rejects(f.controller.control(f.bot.id, { action: 'type', text: 'again', leaseToken: lease.leaseToken }), e => e.status === 409);
  assert.throws(() => f.controller.checkRun(f.bot), /person has control/);
  finish({ available: true }); await pending;
});
test('explicit isolated computer Stop recovers CUA cleanup uncertainty only after shutdown acknowledgement', async () => {
  const f = fixture(); f.failStop(Object.assign(new Error('CUA cleanup unknown'), { cleanupUnconfirmed: true }));
  await f.controller.stop(f.bot.id); assert.equal(f.calls.at(-1)[0], 'stop'); assert.equal(f.cleared(), 1);
  f.cua.stop = async () => ({ stopped: false, cleanupConfirmed: false });
  await assert.rejects(f.controller.stop(f.bot.id), /did not confirm/); assert.equal(f.cleared(), 1);
});
test('SSH computer operations never invoke local CUA tools', async () => {
  const calls = [], bot = { id: 'b', computerMode: 'cua', execution: { kind: 'ssh', host: 'custom', user: 'operator' } };
  const controller = createBotComputers({ profile: () => bot, busy: () => false, stopOwned: async () => {}, cua: { state: () => assert.fail('local fallback') }, remoteSSH: { cua: async (...args) => { calls.push(args); return { available: false, detail: 'Prepare CUA remotely' }; } } });
  const value = await controller.state('b'); assert.equal(value.available, false); assert.equal(calls[0][0].host, 'custom'); assert.equal(calls[0][1], 'state');
});

test('uncertain manual input reports cleanup uncertainty to persistent bot ownership', async () => {
  const bot = { id: 'b', computerMode: 'cua', execution: { kind: 'local' } }, marked = [];
  const failure = Object.assign(new Error('Input cleanup unknown'), { code: 'cua_cleanup_unconfirmed', cleanupUnconfirmed: true });
  const controller = createBotComputers({ profile: () => bot, busy: () => false, stopOwned: async () => {}, markUncertain: value => marked.push(value), cua: {
    state: async () => ({ available: true, image: { mimeType: 'image/png', data: 'fixture' } }), control: async () => { throw failure; },
  } });
  const lease = await controller.takeover('b');
  await assert.rejects(controller.control('b', { leaseToken: lease.leaseToken, action: 'type', text: 'Hello' }), e => e === failure);
  assert.deepEqual(marked, [bot]);
});

test('persisted uncertainty and unconfirmed guest state block takeover, Start and further input', async () => {
  const bot = { id: 'b', computerMode: 'cua', execution: { kind: 'local' } }, calls = [];
  let blocked = true, confirmed = true;
  const controller = createBotComputers({ profile: () => bot, busy: () => false, stopOwned: async () => {}, checkClean: () => { if (blocked) throw Object.assign(new Error('Stop this isolated computer'), { status: 409 }); }, cua: {
    state: async () => ({ available: true, cleanupConfirmed: confirmed, frame: { data: 'fixture', mimeType: 'image/png', width: 100, height: 100 } }),
    start: async () => { calls.push('start'); return {}; }, control: async () => { calls.push('control'); return {}; },
  } });
  await assert.rejects(controller.takeover('b'), /Stop this isolated/);
  await assert.rejects(controller.start('b'), /Stop this isolated/);
  blocked = false; confirmed = false;
  await assert.rejects(controller.takeover('b'), /cleanup is unconfirmed/);
  await assert.rejects(controller.start('b'), /cleanup is unconfirmed/);
  confirmed = true; const lease = await controller.takeover('b'); blocked = true;
  await assert.rejects(controller.control('b', { leaseToken: lease.leaseToken, action: 'key', key: 'Enter' }), /Stop this isolated/);
  assert.deepEqual(calls, []);
});
