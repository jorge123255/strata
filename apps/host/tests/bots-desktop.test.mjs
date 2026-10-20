import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotsDesktop } from '../server/bots-desktop.mjs';

test('native Bots discovery is read-only and opening uses only the bundled component and loopback host', async () => {
  const calls = [];
  const desktop = createBotsDesktop({ platform: 'darwin', port: () => 47831, exists: path => path.endsWith('/bots/StrataBots.app/Contents/MacOS/StrataBots'), run: (...args) => { calls.push(args.slice(0, 3)); args.at(-1)(null); } });
  assert.equal(desktop.status().available, true); assert.deepEqual(calls, []);
  assert.deepEqual(await desktop.open(), { opened: true });
  assert.equal(calls[0][0], '/usr/bin/open');
  assert.ok(calls[0][1][1].endsWith('/bots/StrataBots.app'));
  assert.deepEqual(calls[0][1].slice(2), ['--args', '--strata-host', 'http://127.0.0.1:47831']);
  assert.deepEqual(Object.keys(calls[0][2].env).sort(), ['HOME', 'PATH']);
});

test('missing or non-Mac native components fail without executing an alternate command', async () => {
  for (const platform of ['linux', 'darwin']) {
    const desktop = createBotsDesktop({ platform, port: 47831, exists: () => platform !== 'darwin', run: () => assert.fail('No command should run') });
    assert.equal(desktop.status().available, false);
    await assert.rejects(desktop.open(), error => error.status === 503);
  }
});
