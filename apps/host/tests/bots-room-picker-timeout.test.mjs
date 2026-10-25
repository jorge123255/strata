/** Disposable picker fixtures only. No inference, owner files or computers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBots } from '../server/bots.mjs';
import { createConversations } from '../server/conversations.mjs';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'strata-room-picker-timeout-'));
  const requests = [], warnings = [], selections = [];
  const originalWarn = console.warn, originalLog = console.log;
  console.warn = (...args) => { warnings.push(args.map(item => String(item)).join(' ')); };
  console.log = (...args) => { selections.push(args.map(item => String(item)).join(' ')); };
  t.after(() => { console.warn = originalWarn; console.log = originalLog; });
  let chats, signal;
  const connection = { id: 'inert', name: 'Inert', baseUrl: 'https://fixture.invalid/v1', protocol: 'openai-chat', models: [{ id: 'lead-model' }] };
  const bots = createBots({
    directory, defaultWorkspace: () => directory, conversations: () => chats,
    tools: { definitions: () => [], finish() {} },
    modelProviders: {
      resolve: () => ({ connection, model: connection.models[0] }),
      list: () => ({ connections: [connection] }),
    },
    modelRequest: async (payload, _bot, requestSignal) => {
      requests.push(payload);
      signal = requestSignal;
      return new Promise((_resolve, reject) => {
        const abort = () => reject(requestSignal.reason);
        requestSignal.addEventListener('abort', abort, { once: true });
        if (requestSignal.aborted) abort();
      });
    },
    runtime: {
      providers: async () => [],
      async run(input) {
        const text = `Fallback reply from ${input.bot.name}`;
        input.onFrame({ type: 'delta', text });
        input.onFrame({ type: 'done', publicReply: text });
      },
      async close() {},
    },
  });
  chats = createConversations({ directory, enabled: () => true, pending: id => bots.pending(id), stop: id => bots.stop(id), execute: input => bots.run(input), validateSelection: input => bots.validateSelection(input) });
  t.after(async () => { await bots.close(); chats.close(); rmSync(directory, { recursive: true, force: true }); });
  const profile = { provider: 'configured', workspace: directory, policy: 'bypass', capabilities: 'both', computerMode: 'host' };
  const lead = bots.create({ ...profile, name: 'Lead', modelSource: { connectionId: 'inert', model: 'lead-model' } }).bot;
  const pal = bots.create({ name: 'Pal', provider: 'codex', workspace: directory, policy: 'bypass', capabilities: 'both', computerMode: 'host' }).bot;
  const team = bots.team.create({ name: 'Room', memberIds: [lead.id, pal.id], coordinatorId: lead.id, enabled: true, talkativeness: { [pal.id]: 100 } }).team;
  const run = bots.team.message(team.id, { message: 'Hello room', requestId: 'picker-timeout' }).run;
  return { pal, requests, warnings, selections, signal: () => signal };
}

test('local-model picker allows 60 seconds and caps tokens and reasoning', async t => {
  const f = fixture(t);
  await Promise.resolve();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].max_tokens, 64);
  assert.equal(f.requests[0].reasoning_effort, 'none');
  t.mock.timers.tick(18_000);
  assert.equal(f.signal().aborted, false);
  t.mock.timers.tick(41_000);
  assert.equal(f.signal().aborted, false);
  t.mock.timers.tick(1_000);
  assert.equal(f.signal().aborted, true);
});

test('picker timeout warns and uses the default picker', async t => {
  const f = fixture(t);
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.warnings.some(line => /room selection/i.test(line) && /timed? ?out|timeout/i.test(line) && /default picker|default speaker|fallback/i.test(line)), true);
  assert.equal(f.selections.some(line => /room selection/i.test(line) && line.includes(`accepted ${f.pal.id}`)), true);
});
