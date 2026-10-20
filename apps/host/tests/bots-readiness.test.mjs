import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const { code } = await transform(await readFile(new URL('../src/lib/bot-readiness.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { botReadiness } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('a provider being installed never reports an unprepared CUA computer ready', () => {
  const state = botReadiness({ available: true, detail: 'Provider installed.' }, { computerMode: 'cua', conversation: false, computerError: 'Prepare CUA on this execution computer first.' });
  assert.equal(state.label, 'Computer setup needed'); assert.equal(state.action, 'settings'); assert.match(state.detail, /Prepare CUA/);
  const unknown = botReadiness({ available: true }, { computerMode: 'cua', conversation: false, checking: true });
  assert.equal(unknown.label, 'Checking computer'); assert.notEqual(unknown.label, 'Available');
});

test('prepared stopped and running computers have separate states without starting work', () => {
  const context = { computerMode: 'cua', conversation: false, computer: { available: true, running: false } };
  assert.equal(botReadiness({ available: true }, context).label, 'Computer stopped');
  assert.equal(botReadiness({ available: true }, { ...context, computer: { available: true, running: true } }).label, 'Computer running');
  assert.equal(botReadiness({ available: false, detail: 'Sign into the provider.' }, context).label, 'Setup needed');
});

test('current profile availability is never borrowed for frozen conversations', () => {
  assert.equal(botReadiness({ available: false }, { computerMode: 'host', conversation: true }).label, 'Idle');
  assert.equal(botReadiness({ available: false }, { computerMode: 'cua', conversation: true, computer: { available: true, running: true } }).label, 'Computer running');
  assert.equal(botReadiness({ available: true }, { conversation: true, unavailableConversation: true }).label, 'Conversation unavailable');
});

test('actual work, approval and pause state supersede idle setup descriptions', () => {
  const base = { computerMode: 'cua', conversation: true, computerError: 'Not prepared.' };
  assert.equal(botReadiness({ paused: true }, { ...base, active: true }).label, 'Paused');
  assert.equal(botReadiness({}, { ...base, active: true, needsApproval: true }).label, 'Needs approval');
  assert.equal(botReadiness({}, { ...base, active: true }).label, 'Working');
});

test('unconfirmed cleanup remains actionable and cannot look like a normal stopped computer', () => {
  const state = botReadiness({ available: true }, { computerMode: 'cua', conversation: false, computer: { available: false, running: false, cleanupConfirmed: false } });
  assert.equal(state.label, 'Computer needs attention'); assert.equal(state.action, 'computer'); assert.equal(state.tone, 'warn');
});
