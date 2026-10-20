import test from 'node:test';
import assert from 'node:assert/strict';
import { controlEnvironment } from '../server/control-runtime.mjs';

test('a source host using a signed Control donor cannot refresh its bytecode', () => {
  const env = controlEnvironment({ dir: '/Applications/Strata.app/Contents/Resources/control' }, { env: { PATH: '/usr/bin', PYTHONDONTWRITEBYTECODE: '0' }, components: '/tmp/strata-test-components' });
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.STRATA_NO_ACQUIRE, '1');
  assert.equal(env.PATH, '/usr/bin');
});
