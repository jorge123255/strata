import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const resources = await import('../scripts/bundle-resources.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'strata-bundle-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

test('personal credentials, private keys, and VPN files are refused', () => {
  assert.equal(resources.isForbiddenRelative('host/server/index.mjs'), false);
  assert.equal(resources.isForbiddenRelative('engine-bundle/pkg/engine-component.json'), false);
  assert.equal(resources.isForbiddenRelative('notes/cacert.pem'), false);
  for (const rel of ['id_rsa', 'keys/id_ed25519', '.env', '.env.local', 'feed-key.json', 'tauri-updater.key', 'vpn/office.ovpn', 'wireguard/wg0.conf', '.ssh/config', 'certs/login.p12']) {
    assert.equal(resources.isForbiddenRelative(rel), true, rel);
  }
  const root = join(scratch, 'secrets');
  write(join(root, 'lib/bin.js'), 'console.log("ok")');
  write(join(root, 'node_modules/jose/dist/import.js'), 'const sample = "-----BEGIN PRIVATE KEY-----";\n');
  write(join(root, 'certs/cacert.pem'), '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  assert.deepEqual(resources.findBundleSecrets(root), []);
  write(join(root, 'secret.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
  write(join(root, 'login.pem'), '-----BEGIN RSA PRIVATE KEY-----\nabc\n');
  write(join(root, 'office.ovpn'), 'client\n');
  const hits = resources.findBundleSecrets(root);
  assert.ok(hits.includes('secret.txt'), hits.join(','));
  assert.ok(hits.includes('login.pem'), hits.join(','));
  assert.ok(hits.includes('office.ovpn'), hits.join(','));
});

test('staging copies a clean tree, keeps an existing gitignore, and leaves the destination alone when the source is unsafe', () => {
  const source = join(scratch, 'clean-src');
  const dest = join(scratch, 'clean-dest');
  write(join(source, 'lib/bin.js'), 'bin');
  write(join(source, 'node_modules/pkg/package.json'), '{"name":"pkg"}');
  const outside = join(scratch, 'outside.txt');
  writeFileSync(outside, 'outside');
  symlinkSync(join(source, 'lib/bin.js'), join(source, 'lib/bin-link.js'));
  write(join(dest, '.gitignore'), 'keep-this\n');
  write(join(dest, 'old.txt'), 'old');
  resources.stageCleanTree(dest, source);
  assert.equal(readFileSync(join(dest, 'lib/bin.js'), 'utf8'), 'bin');
  assert.equal(readFileSync(join(dest, 'lib/bin-link.js'), 'utf8'), 'bin');
  assert.equal(readFileSync(join(dest, '.gitignore'), 'utf8'), 'keep-this\n');
  assert.equal(resources.exists(join(dest, 'old.txt')), false);

  const dirty = join(scratch, 'dirty-src');
  const kept = join(scratch, 'kept-dest');
  write(join(dirty, 'lib/bin.js'), 'bin');
  write(join(dirty, 'id_rsa'), 'private');
  write(join(kept, 'keep-me.txt'), 'stay');
  assert.throws(() => resources.stageCleanTree(kept, dirty), /credentials|keys|VPN/);
  assert.equal(readFileSync(join(kept, 'keep-me.txt'), 'utf8'), 'stay');

  const linked = join(scratch, 'linked-src');
  write(join(linked, 'lib/bin.js'), 'bin');
  symlinkSync(outside, join(linked, 'leak.txt'));
  assert.throws(() => resources.stageCleanTree(join(scratch, 'linked-dest'), linked), /symlink/);
});

test('a packaged app is incomplete until Node, the harness, the engine, and host production dependencies are all present', () => {
  const root = join(scratch, 'resources-empty');
  mkdirSync(root, { recursive: true });
  const packageJson = join(scratch, 'host-package.json');
  writeFileSync(packageJson, JSON.stringify({ dependencies: { 'playwright-core': '1.2.3' }, devDependencies: { vite: '6.0.0' } }));
  const missing = resources.bundleProblems(root, { mode: 'packaged', packageJson, minNodeBytes: 1 });
  for (const needle of [/Node runtime/, /harness/, /engine/, /playwright-core/, /host\/server\/index\.mjs/, /host\/dist/]) {
    assert.ok(missing.some(line => needle.test(line)), `${needle} not in ${missing.join(' | ')}`);
  }

  write(join(root, 'node/node'), 'node-binary');
  chmodSync(join(root, 'node/node'), 0o755);
  write(join(root, 'harness/lib/bin.js'), 'bin');
  write(join(root, 'harness/node_modules/pkg/package.json'), '{}');
  write(join(root, 'engine-bundle/0.1.48-macos-arm64-metal/engine-component.json'), JSON.stringify({
    id: 'strata-engine', version: '0.1.48', platform: 'macos-arm64', backend: 'metal', entrypoint: 'strata',
    files: [{ path: 'strata', sha256: 'a'.repeat(64), bytes: 4 }],
  }));
  write(join(root, 'engine-bundle/0.1.48-macos-arm64-metal/strata'), 'engi');
  chmodSync(join(root, 'engine-bundle/0.1.48-macos-arm64-metal/strata'), 0o755);
  write(join(root, 'host/node_modules/playwright-core/package.json'), '{}');
  write(join(root, 'host/server/index.mjs'), 'server');
  write(join(root, 'host/dist/index.html'), 'ui');
  assert.deepEqual(resources.bundleProblems(root, { mode: 'packaged', packageJson, minNodeBytes: 1 }), []);

  write(join(root, 'host/node_modules/vite/package.json'), '{}');
  write(join(root, 'office.ovpn'), 'client');
  const again = resources.bundleProblems(root, { mode: 'packaged', packageJson, minNodeBytes: 1 });
  assert.ok(again.some(line => /vite/.test(line)), again.join(' | '));
  assert.ok(again.some(line => /office\.ovpn/.test(line)), again.join(' | '));
});

test('engine release pins name one package per target and variant', () => {
  assert.equal(resources.hostNodeTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(resources.hostNodeTarget('linux', 'x64'), 'linux-x64');
  assert.equal(resources.hostNodeTarget('win32', 'x64'), 'win-x64');
  assert.throws(() => resources.hostNodeTarget('darwin', 'x64'), /Apple Silicon/);
  assert.equal(resources.defaultEngineVariant('darwin-arm64'), 'metal');
  assert.equal(resources.defaultEngineVariant('linux-x64'), null);
  const metal = resources.engineReleaseAsset('darwin-arm64', 'metal');
  assert.equal(metal.name, 'strata-engine-0.1.48-macos-arm64-metal.tar.gz');
  assert.equal(metal.platform, 'macos-arm64');
  assert.equal(metal.sha256, '7c99e5099de20685ff3a5d67ce24df23046b9804ecb68ca47c8e2169ba1961a5');
  assert.equal(resources.APP_ARCHIVE.sha256, '5f46de4e93cc97e95457b69299c1687943eb19ed7fea4d1bbf487aa6974d100e');
  assert.throws(() => resources.engineReleaseAsset('linux-x64'), /STRATA_ENGINE_VARIANT/);
  const cuda = resources.engineReleaseAsset('linux-x64', 'cuda13');
  assert.equal(cuda.platform, 'linux-x86_64');
  assert.match(cuda.sha256, /^[0-9a-f]{64}$/);
  assert.equal(resources.engineFolderName({ version: '0.1.48', platform: 'macos-arm64', backend: 'metal' }), '0.1.48-macos-arm64-metal');
  assert.equal(resources.engineFolderName({ version: '0.1.48', platform: 'linux-x86_64', backend: 'cuda', variant: 'cuda13' }), '0.1.48-linux-x86_64-cuda-cuda13');
});

test('a flat engine archive is staged as one package folder and a hostile archive is refused', () => {
  const bundle = join(scratch, 'engine-bundle');
  const archive = join(scratch, 'engine.tar.gz');
  const pack = join(scratch, 'engine-src');
  write(join(pack, 'engine-component.json'), JSON.stringify({
    id: 'strata-engine', version: '0.1.48', platform: 'macos-arm64', backend: 'metal', entrypoint: 'strata',
    files: [{ path: 'strata', bytes: 3 }],
  }));
  write(join(pack, 'strata'), 'abc');
  const made = spawnSync('tar', ['-czf', archive, '-C', pack, 'engine-component.json', 'strata'], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const placed = resources.stageEngineArchive(archive, bundle, { expectedPlatform: 'macos-arm64' });
  assert.equal(placed.name, '0.1.48-macos-arm64-metal');
  assert.equal(readFileSync(join(bundle, placed.name, 'strata'), 'utf8'), 'abc');

  const hostile = join(scratch, 'hostile.tar');
  const built = spawnSync('python3', ['-c', `
import tarfile
from pathlib import Path
info = tarfile.TarInfo('../outside.txt')
data = b'nope'
info.size = len(data)
with tarfile.open(Path(${JSON.stringify(hostile)}), 'w') as tf:
    tf.addfile(info, __import__('io').BytesIO(data))
`], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  assert.throws(() => resources.extractArchive(hostile, join(scratch, 'hostile-out')), /unsafe/);
});

test('host production install is npm ci --omit=dev from the lockfile and does not copy secrets', () => {
  assert.deepEqual(resources.HOST_PRODUCTION_NPM_ARGS, ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund']);
  const host = join(scratch, 'host');
  const out = join(scratch, 'host-out');
  write(join(host, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'is-odd': '3.0.1' }, devDependencies: { vite: '6.0.0' } }));
  write(join(host, 'package-lock.json'), '{"lock":true}');
  write(join(host, '.env'), 'TOKEN=secret');
  write(join(host, 'id_rsa'), 'nope');
  const calls = [];
  const result = resources.stageHostDeps({
    hostDir: host, outDir: out, spawn(cmd, args, opts) {
      calls.push([cmd, args, opts.cwd]);
      write(join(out, 'node_modules/is-odd/package.json'), '{"name":"is-odd"}');
      return { status: 0 };
    },
  });
  assert.equal(result.action, 'installed');
  assert.deepEqual(calls[0][1], resources.HOST_PRODUCTION_NPM_ARGS);
  assert.equal(calls[0][2], out);
  assert.equal(readFileSync(join(out, 'package-lock.json'), 'utf8'), '{"lock":true}');
  assert.equal(resources.exists(join(out, '.env')), false);
  assert.equal(resources.exists(join(out, 'id_rsa')), false);
  const again = resources.stageHostDeps({ hostDir: host, outDir: out, spawn() { throw new Error('should reuse the stamp'); } });
  assert.equal(again.action, 'kept');
});

test('npm ci --omit=dev installs a production dependency and leaves the dev dependency out', { timeout: 180000 }, () => {
  const host = join(scratch, 'real-host');
  const out = join(scratch, 'real-out');
  write(join(host, 'package.json'), JSON.stringify({
    name: 'strata-host-stage-fixture', version: '1.0.0',
    dependencies: { 'is-odd': '3.0.1' }, devDependencies: { 'is-even': '1.0.0' },
  }));
  const lock = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: host, encoding: 'utf8' });
  assert.equal(lock.status, 0, lock.stderr);
  const result = resources.stageHostDeps({ hostDir: host, outDir: out });
  assert.equal(result.action, 'installed');
  assert.equal(resources.exists(join(out, 'node_modules/is-odd/package.json')), true);
  assert.equal(resources.exists(join(out, 'node_modules/is-even/package.json')), false);
  assert.equal(resources.exists(join(out, '.env')), false);
});

test('the desktop build stages the bundle and checks the finished app', () => {
  const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['build:ui'], /stage:bundle/);
  assert.match(pkg.scripts.build, /stage:bundle|build:ui/);
  assert.match(pkg.scripts['build:app'], /check:app/);
  assert.match(pkg.scripts.dmg, /check:app/);
  assert.match(pkg.scripts['stage:bundle'], /stage-bundle\.mjs/);
  assert.match(pkg.scripts['check:app'], /check-app-bundle\.mjs/);
  const conf = JSON.parse(readFileSync(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(conf.bundle.resources['resources/host/node_modules'], 'host/node_modules');
  assert.equal(conf.bundle.resources['resources/harness'], 'harness');
  assert.equal(conf.bundle.resources['resources/node'], 'node');
  assert.equal(conf.bundle.resources['resources/engine-bundle'], 'engine-bundle');
  assert.equal(resources.exists(join(desktop, 'src-tauri/resources/harness/.gitignore')), true);
});

test('check-app-bundle fails loudly when the app is missing a required piece', () => {
  const app = join(scratch, 'Strata.app');
  const root = join(app, 'Contents/Resources');
  write(join(root, 'host/server/index.mjs'), 'server');
  write(join(root, 'host/dist/index.html'), 'ui');
  write(join(root, 'node/node'), 'tiny');
  chmodSync(join(root, 'node/node'), 0o755);
  const run = spawnSync(process.execPath, [join(desktop, 'scripts/check-app-bundle.mjs'), app], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(`${run.stderr}${run.stdout}`, /Node runtime/);
  assert.match(`${run.stderr}${run.stdout}`, /harness/);
  assert.match(`${run.stderr}${run.stdout}`, /engine/);
  assert.match(`${run.stderr}${run.stdout}`, /node_modules|production/);
});
