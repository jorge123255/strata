import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessObserver } from '../server/bots-harness-observer.mjs';

test('timings separate provider wait, overlapping tools, approval and cleanup without retaining payloads', () => {
  let at = 100; const observer = createHarnessObserver({ now: () => at });
  observer.start('chat'); at += 10; observer.phase('chat', 'model');
  at += 20; observer.frame('chat', { type: 'delta', text: 'SECRET' });
  assert.equal(observer.snapshot('chat').firstOutputMs, 30);
  observer.frame('chat', { type: 'agent-tool', tool: { id: 'a', state: 'running', args: { secret: 'SECRET' } } });
  at += 30; observer.frame('chat', { type: 'agent-tool', tool: { id: 'b', state: 'proposed' } });
  at += 40; observer.frame('chat', { type: 'agent-tool', tool: { id: 'b', state: 'denied' } });
  at += 50; observer.frame('chat', { type: 'agent-tool', tool: { id: 'a', state: 'done', result: 'SECRET' } });
  at += 60; observer.phase('chat', 'cleanup'); at += 70; observer.finish('chat');
  const snapshot = observer.snapshot('chat');
  assert.deepEqual(snapshot.timings, { startingMs: 10, modelMs: 80, approvalMs: 40, toolMs: 80, cleanupMs: 70 });
  assert.equal(snapshot.elapsedMs, 280); assert.equal(snapshot.toolCalls, 1);
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);
  at += 100; assert.deepEqual(observer.snapshot('chat'), snapshot);
});

test('separate chats, duplicate frames, context compaction and late callbacks remain independent', () => {
  let at = 0; const observer = createHarnessObserver({ now: () => at, capacity: 1 });
  observer.start('a'); observer.start('b');
  for (let i = 0; i < 2; i++) observer.frame('a', { type: 'agent-tool', tool: { id: 'x', state: 'running' } });
  observer.frame('a', { type: 'notice', context: { compacted: true } });
  observer.frame('a', { type: 'agent-tool', tool: { id: 'x', state: 'error' } });
  at = 100; observer.finish('a', { outcome: 'interrupted' });
  observer.frame('a', { type: 'delta', text: 'late' });
  assert.equal(observer.snapshot('a').toolCalls, 1); assert.equal(observer.snapshot('a').toolErrors, 1);
  assert.equal(observer.snapshot('a').contextCompactions, 1); assert.equal(observer.snapshot('a').firstOutputMs, undefined);
  assert.equal(observer.snapshot('b').phase, 'starting');
  observer.start('c'); assert.equal(observer.snapshot('a'), undefined); assert.ok(observer.snapshot('b'));
  assert.throws(() => observer.start('b'));
});

test('continuous turns retain cumulative counters without retaining unlimited completed tool IDs', () => {
  const observer = createHarnessObserver(); observer.start('long');
  for (let i=0;i<5000;i++) {
    observer.frame('long',{type:'agent-tool',tool:{id:`tool_${i}`,state:'running'}});
    observer.frame('long',{type:'agent-tool',tool:{id:`tool_${i}`,state:'error'}});
  }
  assert.equal(observer.snapshot('long').toolCalls,5000); assert.equal(observer.snapshot('long').toolErrors,5000);
  observer.frame('long',{type:'agent-tool',tool:{id:'tool_4999',state:'error'}});
  observer.finish('long'); assert.equal(observer.snapshot('long').toolErrors,5000);
});
