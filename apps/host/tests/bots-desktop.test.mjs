import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBotRoutes } from '../server/bots.mjs';

const packagerPath = fileURLToPath(new URL('../../desktop/scripts/build-mac-companion-app.sh', import.meta.url));
const packager = readFileSync(packagerPath, 'utf8');

test('Bots stays in the main app; retired launcher endpoints cannot discover or open another app', async t => {
  let port;
  const launches = [];
  const catalog = { bots: [], providers: [] };
  const routes = createBotRoutes({ bots: { list: async () => catalog }, port: () => port,
    desktop: { status() { launches.push('discover'); }, open() { launches.push('open'); } } });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, `http://${req.headers.host}`)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${port}`;
  for (const path of ['/api/bots/desktop', '/api/bots/desktop/open']) {
    for (const method of ['GET', 'POST']) assert.equal((await fetch(origin + path, { method })).status, 404);
  }
  const response = await fetch(origin + '/api/bots');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), catalog);
  assert.deepEqual(launches, []);
  assert.equal(existsSync(new URL('../server/bots-desktop.mjs', import.meta.url)), false);
});

test('Mac packaging removes inherited standalone Bots without building, copying or signing another app', { skip: process.platform !== 'darwin' && 'Mac packaging requires the system zsh.' }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-bots-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const resources = join(directory, 'Resources'), legacy = join(resources, 'bots', 'StrataBots.app');
  mkdirSync(join(legacy, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(legacy, 'Contents', 'MacOS', 'StrataBots'), 'retired executable');
  writeFileSync(join(resources, 'bots', 'retained-resource.txt'), 'keep');
  const definition = packager.match(/^remove_legacy_bots_app\(\)\s*\{[\s\S]*?^\}/m)?.[0];
  const invocation = packager.match(/^remove_legacy_bots_app\s+[^\n]+$/m)?.[0];
  assert.ok(definition && invocation, 'The packager must clean inherited Bots payloads.');
  const clean = () => {
    const result = spawnSync('/bin/zsh', ['-c', `${definition}\ntask_resources="$1"\n${invocation}`, 'package-cleanup', resources], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  clean(); clean();
  assert.equal(existsSync(legacy), false);
  assert.equal(readFileSync(join(resources, 'bots', 'retained-resource.txt'), 'utf8'), 'keep');

  // A carrier link must be removed without deleting an app outside the copy.
  rmSync(join(resources, 'bots'), { recursive: true });
  const external = join(directory, 'outside-carrier'), externalApp = join(external, 'StrataBots.app');
  mkdirSync(externalApp, { recursive: true });
  writeFileSync(join(externalApp, 'sentinel.txt'), 'untouched');
  symlinkSync(external, join(resources, 'bots'));
  clean();
  assert.equal(existsSync(join(resources, 'bots')), false);
  assert.equal(readFileSync(join(externalApp, 'sentinel.txt'), 'utf8'), 'untouched');
  assert.doesNotMatch(packager, /bots-macos\/scripts\/build-app\.sh|(?:ditto|cp|codesign)[^\n]*StrataBots\.app/);
});
