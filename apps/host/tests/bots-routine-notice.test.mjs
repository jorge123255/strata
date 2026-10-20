import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const { code } = await transform(await readFile(new URL('../src/lib/bot-routine-notice.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { botRoutineNotice } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('completion notifications display the routine title without its prompt or tool data', () => {
  assert.deepEqual(botRoutineNotice({ routineCompleted: { id: 'routine', title: 'Morning report', state: 'done', prompt: 'PRIVATE-PROMPT', detail: 'PRIVATE-TOOL-DATA' } }), { tone: 'success', title: 'Bot routine finished', body: 'Morning report' });
  assert.deepEqual(botRoutineNotice({ routineCompleted: { id: 'routine', title: 'Morning report', state: 'error' } }), { tone: 'error', title: 'Bot routine failed', body: 'Morning report' });
});
test('ordinary work updates and incomplete routine states produce no completion alert', () => {
  for (const data of [{ changed: 'bot' }, {}, { routineCompleted: null }, { routineCompleted: { id: 'r', title: {}, state: 'done' } }, { routineCompleted: { id: 'r', title: 'Still working', state: 'running' } }]) assert.equal(botRoutineNotice(data), null);
});
