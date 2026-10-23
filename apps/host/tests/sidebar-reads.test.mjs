import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/lib/sidebar-reads.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, write: false, format: 'esm', platform: 'node' });
const reads = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

function query(values) {
  return { get: name => values[name] ?? null };
}

test('opening a bot or room chat is the read target, and the new-room form is not', () => {
  assert.deepEqual(reads.sidebarReadTarget('bots', 'bot_ada', query({})), { kind: 'bot', id: 'bot_ada' });
  assert.deepEqual(reads.sidebarReadTarget('bots', 'teams', query({ team: 'team_release' })), { kind: 'room', id: 'team_release' });
  assert.equal(reads.sidebarReadTarget('bots', 'teams', query({ new: 'room', team: 'team_release' })), null);
  assert.equal(reads.sidebarReadTarget('bots', 'new', query({})), null);
  assert.equal(reads.sidebarReadTarget('bots', 'activity', query({})), null);
  assert.equal(reads.sidebarReadTarget('chat', 'bot_ada', query({})), null);
  assert.equal(reads.readDelivery(null), 'queue');
  assert.equal(reads.readDelivery(false), 'skip');
  assert.equal(reads.readDelivery(true), 'post');
});
