/** Inert providers, fake browsers and temporary files only; no SSH or VM actions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createBotTools } from '../server/bots-tools.mjs';
import { startWorker, acquireComputerLease, activeRemoteRuns } from '../server/bots-runtime/ssh-worker.mjs';

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const held = signal => new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve(); });
function fixture(t, run) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bot-parallel-')); let chats;
  const page = { goto: async () => {}, url: () => 'https://example.test', screenshot: async () => Buffer.from('fixture'), locator: () => ({ innerText: async () => 'Fixture browser' }) };
  const tools = createBotTools({ directory, browserProbe: () => ({ found: true }), browserFactory: async () => ({ page, close: async () => {} }) });
  const bots = createBots({ directory, defaultWorkspace: () => directory, conversations: () => chats, tools,
    runtime: { providers: async () => [], run, close() {} }, remoteSSH: { run: () => assert.fail('No SSH'), cua: () => assert.fail('No CUA') } });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), approve: input => bots.approve(input), validateSelection: input => bots.validateSelection(input), execute: input => bots.run(input) });
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const make = (name, patch = {}) => bots.create({ name, provider: 'codex', workspace: directory, computerMode: 'host', capabilities: 'both', policy: 'bypass', ...patch }).bot;
  return { directory, bots, chats, make };
}

test('two shared host teams and a personal browser chat overlap; stopping one team leaves the others running', async t => {
  let f; const running = new Map(), assigned = new Map();
  f = fixture(t, async input => {
    if (input.bot.teamConversationOnly) {
      const child = assigned.get(input.message);
      if (child) await input.executeTool('assign_team_task', { botId: child, message: `work ${input.message}` }, 'assignment');
      return;
    }
    if (input.message === 'personal') await input.executeTool('browser_open', { url: 'https://example.test' }, 'browser');
    else {
      const marker = await input.executeTool('read_file', { path: 'marker.txt' }, 'read');
      await input.executeTool('write_file', { path: `${input.bot.id}.txt`, content: marker.content[0].text }, 'write');
    }
    running.set(input.sessionId, input); await held(input.signal);
  });
  const folders = ['a', 'b'].map(name => { const path = join(f.directory, name); mkdirSync(path); writeFileSync(join(path, 'marker.txt'), `workspace ${name}`); return path; });
  const teams = folders.map((folder, index) => {
    const coordinator = f.make(`Coordinator ${index}`), child = f.make(`Worker ${index}`);
    assigned.set(`request ${index}`, child.id);
    const team = f.bots.team.create({ name: `Team ${index}`, memberIds: [coordinator.id, child.id], coordinatorId: coordinator.id, enabled: true }).team;
    f.bots.team.update(team.id, { execution: { mode: 'shared', computerId: 'host:local', workspace: folder } });
    return { team, child, folder };
  });
  // A plain message is room chat and does not start file work. Address each
  // worker in Work so the two host folders and the personal browser overlap.
  const first = f.bots.team.message(teams[0].team.id, { message: 'request 0', requestId: 'first', workMode: 'work', recipientIds: [teams[0].child.id] }).run;
  await until(() => running.size === 1);
  const second = f.bots.team.message(teams[1].team.id, { message: 'request 1', requestId: 'second', workMode: 'work', recipientIds: [teams[1].child.id] }).run;
  const personal = f.bots.createConversation(f.make('Personal', { workspace: folders[0] }).id).conversation;
  f.chats.send(personal.id, 'personal');
  await until(() => running.size === 3);
  for (const entry of teams) assert.match(readFileSync(join(entry.folder, `${entry.child.id}.txt`), 'utf8'), /workspace/);
  await f.bots.team.stop(teams[0].team.id, first.id);
  assert.equal(f.bots.team.detail(teams[0].team.id, first.id).run.state, 'cancelled');
  assert.equal(f.bots.team.detail(teams[1].team.id, second.id).run.state, 'running');
  assert.equal(f.chats.detail(personal.id).conversation.active, true);
  assert.equal([...running.values()].filter(input => !input.signal.aborted).length, 2);
});

test('different CUA guests on one SSH account are independent while a second chat in the same guest is rejected', async t => {
  const entered = new Map(), f = fixture(t, async input => { entered.set(input.sessionId, input); await held(input.signal); });
  const execution = { kind: 'ssh', host: 'fixture.invalid', user: 'fixture' };
  const a = f.make('Guest A', { execution, computerMode: 'cua', workspace: '/workspace' });
  const b = f.make('Guest B', { execution, computerMode: 'cua', workspace: '/workspace' });
  const one = f.bots.createConversation(a.id).conversation, two = f.bots.createConversation(b.id).conversation, same = f.bots.createConversation(a.id).conversation;
  f.chats.send(one.id, 'held'); await until(() => entered.size === 1);
  f.chats.send(two.id, 'independent'); await until(() => entered.size === 2);
  assert.throws(() => f.chats.send(same.id, 'same guest'), /shared computer/);
  await f.bots.stop(one.id); assert.equal(entered.get(two.id).signal.aborted, false);
});

class Reader extends EventEmitter { close() { this.emit('close'); } }
function workerFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-worker-parallel-')), workers = [];
  t.after(async () => { for (const worker of workers) worker.reader.emit('line', JSON.stringify({ type: 'cancel' })); await Promise.all(workers.map(worker => worker.done)); rmSync(directory, { recursive: true, force: true }); });
  const start = (name, patch = {}, options = {}) => {
    const reader = new Reader(), sent = [], worker = { reader, sent, input: null };
    const bot = { id: `bot_${name}`, name, provider: 'codex', policy: 'bypass', workspace: directory, capabilities: 'both', computerMode: 'host', execution: { kind: 'ssh', host: 'fixture.invalid' }, ...patch };
    worker.done = startWorker({ bot, sessionId: `s_${name}`, message: 'fixture' }, { reader, send: message => sent.push(message), directory,
      runtimeFactory: () => ({ async run(input) { worker.input = input; await held(input.signal); return { text: 'fixture' }; }, async close() {} }),
      toolFactory: config => { worker.config = config; return { definitions: () => [], async finish() {}, async close() {} }; },
      cuaFactory: () => ({ definitions: () => [], async finish() {}, async close() {} }), ...options });
    workers.push(worker); return worker;
  };
  return { directory, start };
}

test('remote shared host work reserves no desktop until a desktop tool claims it; file-only workers overlap', async t => {
  const f = workerFixture(t), one = f.start('one', { sharedComputer: true, capabilities: 'code' });
  await until(() => one.input);
  const two = f.start('two', { sharedComputer: true }); await until(() => two.input);
  await assert.rejects(access(join(f.directory, 'leases', 'computer.lock')), { code: 'ENOENT' });
  assert.equal(await activeRemoteRuns(f.directory), 2);
  const release = await one.config.acquireDesktopLease();
  await assert.rejects(two.config.acquireDesktopLease(), /Another Bots worker/);
  const three = f.start('three'); await until(() => three.input);
  assert.equal(await activeRemoteRuns(f.directory), 3);
  await release(); const nextRelease = await two.config.acquireDesktopLease(); await nextRelease();
});

test('remote distinct guests hold independent per-guest leases and the same guest cannot start twice', async t => {
  const f = workerFixture(t), one = f.start('guestA', { computerMode: 'cua' }); await until(() => one.input);
  const two = f.start('guestB', { computerMode: 'cua' }); await until(() => two.input);
  const names = await readdir(join(f.directory, 'leases'));
  assert.equal(names.length, 2); assert.ok(names.every(name => /^cua_[a-f0-9]+\.lock$/.test(name)));
  const same = f.start('sameGuest', { computerMode: 'cua', computerOwnerId: 'bot_guestA' });
  await same.done; assert.equal(same.input, null); assert.match(same.sent.find(message => message.type === 'failure').message, /Another Bots worker/);
  const release = await acquireComputerLease(f.directory); await release();
});

test('a failed lazy desktop release produces an unconfirmed worker cleanup ACK and keeps physical ownership', async t => {
  const f = workerFixture(t); let releaseFixtureLease;
  const worker = f.start('releaseFailure', {}, {
    toolFactory: config => createBotTools({ ...config, platform: 'darwin',
      processRunner: async () => ({ code: 0, stdout: 'fixture desktop action', stderr: '' }),
      acquireDesktopLease: async () => { releaseFixtureLease = await config.acquireDesktopLease(); return async () => { throw Error('fixture desktop release uncertain'); }; },
    }),
    runtimeFactory: () => ({ async run(input) { await input.executeTool('computer_click', { x: 1, y: 1 }, 'fixture_click'); return { text: 'fixture' }; }, async close() {} }),
  });
  await worker.done;
  assert.equal(worker.sent.find(message => message.type === 'cleanup').confirmed, false);
  assert.equal(worker.sent.find(message => message.type === 'failure').code, 'ssh_cleanup_unconfirmed');
  assert.equal(worker.sent.some(message => message.type === 'result'), false);
  await assert.rejects(acquireComputerLease(f.directory), /Another Bots worker/);
  assert.equal(await activeRemoteRuns(f.directory), 0);
  await releaseFixtureLease();
});
