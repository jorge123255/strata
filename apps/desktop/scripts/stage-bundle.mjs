#!/usr/bin/env node
/**
 * Put Node, the harness, one engine package, and the host's production
 * node_modules where Tauri bundles them.
 *
 *   node scripts/stage-bundle.mjs
 *   node scripts/stage-bundle.mjs --target darwin-arm64
 *   STRATA_ENGINE_VARIANT=cuda13 node scripts/stage-bundle.mjs
 *   STRATA_ENGINE_SRC=/path/to/package node scripts/stage-bundle.mjs
 *   STRATA_HARNESS_DIR=/path/to/harness node scripts/stage-bundle.mjs
 *   STRATA_DONOR_APP=/Applications/Strata.app node scripts/stage-bundle.mjs
 *
 * Sources, first match wins:
 *   Node     nodejs.org via fetch-node.sh (kept when that script's SHA-256 check already passed)
 *   Harness  STRATA_HARNESS_SRC (stage-harness.mjs), else STRATA_HARNESS_DIR,
 *            else a donor app's Contents/Resources/harness, else the pinned
 *            Strata.app.tar.gz on the GitHub release
 *   Engine   STRATA_ENGINE_SRC, else the donor app, else one pinned release package
 *            (Mac defaults to Metal; Linux and Windows need STRATA_ENGINE_VARIANT)
 *   Host     npm ci --omit=dev --omit=optional --ignore-scripts from apps/host/package-lock.json
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_ARCHIVE, HOST_PRODUCTION_NPM_ARGS, MIN_NODE_BYTES, RELEASE_BASE,
  bundleProblems, defaultEngineVariant, downloadVerified, engineReleaseAsset, ensureHostDevDependencies,
  findEnginePackages, harnessIsReady, hostNodeTarget, platformForTarget, readEngineManifest,
  stageCleanTree, stageEngineArchive, stageEnginePackage, stageHarnessArchive, stageHostDeps,
} from './bundle-resources.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const hostDir = resolve(desktop, '../host');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : ''; };
const skipped = name => args.includes(`--skip-${name}`) || process.env[`STRATA_SKIP_${name.toUpperCase()}`] === '1';
const refresh = args.includes('--refresh') || process.env.STRATA_STAGE_REFRESH === '1';
const resourcesRoot = resolve(opt('out') || process.env.STRATA_RESOURCES_DIR || join(desktop, 'src-tauri/resources'));
const cacheDir = join(desktop, '.cache/release');
const target = opt('target') || process.env.STRATA_BUNDLE_TARGET || hostNodeTarget();
const variant = opt('engine-variant') || process.env.STRATA_ENGINE_VARIANT || defaultEngineVariant(target) || '';
const harnessSrc = opt('harness-src') || process.env.STRATA_HARNESS_SRC || '';
const harnessDir = opt('harness-dir') || process.env.STRATA_HARNESS_DIR || '';
const engineSrc = opt('engine-src') || process.env.STRATA_ENGINE_SRC || '';
const donorEnv = opt('donor') || process.env.STRATA_DONOR_APP || process.env.STRATA_BASE_APP || '';

function say(line) { console.log(`stage-bundle: ${line}`); }
function fail(error) {
  console.error(`stage-bundle: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
function hostTargetSafe() {
  try { return hostNodeTarget(); } catch { return ''; }
}
function donorApp() {
  if (donorEnv) {
    if (!existsSync(donorEnv)) fail(new Error(`Donor app was not found: ${donorEnv}`));
    return donorEnv;
  }
  const installed = '/Applications/Strata.app';
  return process.platform === 'darwin' && existsSync(installed) ? installed : '';
}
function donorResource(name) {
  const app = donorApp();
  if (!app) return '';
  const dir = join(app, 'Contents', 'Resources', name);
  return existsSync(dir) ? dir : '';
}
function variantWasExplicit() {
  return Boolean(opt('engine-variant') || process.env.STRATA_ENGINE_VARIANT);
}

function stageNode() {
  const nodeDir = join(resourcesRoot, 'node');
  const exeName = target.startsWith('win') ? 'node.exe' : 'node';
  const exe = join(nodeDir, exeName);
  const stampPath = join(nodeDir, '.target');
  const stamped = existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === target;
  const big = existsSync(exe) && statSync(exe).size >= MIN_NODE_BYTES;
  const sameMachine = target === hostTargetSafe();
  if (!refresh && stamped && big && (!sameMachine || nodeCheck(nodeDir) === 0)) {
    say(`keeping Node at ${exe} (${target})`);
    return;
  }
  if (process.platform === 'win32' && target !== 'win-x64') fail(new Error(`fetch-node.ps1 installs win-x64 only, not ${target}.`));
  say(`fetching Node for ${target} from nodejs.org (SHA-256 checked by fetch-node.sh)`);
  const env = { ...process.env, STRATA_NODE_DEST: nodeDir };
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(desktop, 'scripts/fetch-node.ps1'), '-Dest', nodeDir], { stdio: 'inherit', env })
    : spawnSync('bash', [join(desktop, 'scripts/fetch-node.sh'), '--target', target], { stdio: 'inherit', env });
  if (!result || result.status !== 0) fail(new Error(`fetch-node failed for ${target} (${result?.status ?? 'could not start'}).`));
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(stampPath, `${target}\n`);
  if (!existsSync(exe) || statSync(exe).size < MIN_NODE_BYTES) fail(new Error(`Node was not installed at ${exe}.`));
  say(`installed Node at ${exe}`);
}

function nodeCheck(nodeDir) {
  const result = spawnSync('bash', [join(desktop, 'scripts/fetch-node.sh'), '--check'], {
    encoding: 'utf8', env: { ...process.env, STRATA_NODE_DEST: nodeDir },
  });
  return result.status ?? 1;
}

function stageHarness() {
  const dest = join(resourcesRoot, 'harness');
  if (harnessSrc) {
    say(`building the harness from ${harnessSrc} with stage-harness.mjs`);
    const built = join(desktop, '.cache/harness-build');
    rmSync(built, { recursive: true, force: true });
    const run = spawnSync(process.execPath, [join(desktop, 'scripts/stage-harness.mjs'), '--src', harnessSrc, '--out', built], { stdio: 'inherit' });
    if (!run || run.status !== 0) fail(new Error(`stage-harness.mjs failed (${run?.status ?? 'could not start'}).`));
    stageCleanTree(dest, built);
    say(`staged harness from ${harnessSrc} into ${dest}`);
    return;
  }
  if (harnessDir) {
    if (!harnessIsReady(harnessDir)) fail(new Error(`STRATA_HARNESS_DIR is not a built harness (lib/bin.js and node_modules): ${harnessDir}`));
    say(`copying harness from ${harnessDir}`);
    stageCleanTree(dest, harnessDir);
    return;
  }
  if (!refresh && harnessIsReady(dest)) {
    say(`keeping the harness already at ${dest}`);
    return;
  }
  const donated = donorResource('harness');
  if (donated && harnessIsReady(donated)) {
    say(`copying harness from donor app ${donated}`);
    stageCleanTree(dest, donated);
    return;
  }
  const url = RELEASE_BASE + APP_ARCHIVE.name;
  say(`downloading harness inside ${APP_ARCHIVE.name} from ${url}`);
  const archive = downloadVerified({ url, sha256: APP_ARCHIVE.sha256, cacheDir });
  stageHarnessArchive(archive, dest);
  say(`staged harness from ${APP_ARCHIVE.name} (sha256 ${APP_ARCHIVE.sha256}) into ${dest}`);
}

function stageEngine() {
  const dest = join(resourcesRoot, 'engine-bundle');
  const stampPath = join(dest, '.source');
  const expectedPlatform = platformForTarget(target);
  const packagesFor = root => findEnginePackages(root).filter(dir => {
    try { return !expectedPlatform || readEngineManifest(dir).platform === expectedPlatform; } catch { return false; }
  });
  let wanted = '';
  if (engineSrc) wanted = `dir:${resolve(engineSrc)}`;
  else if (!variantWasExplicit() && packagesFor(donorResource('engine-bundle') || '\0').length === 1) wanted = `donor:${donorResource('engine-bundle')}`;
  else wanted = `release:${engineReleaseAsset(target, variant).name}`;
  if (!refresh && existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === wanted && findEnginePackages(dest).length) {
    say(`keeping the engine already at ${dest} (${wanted})`);
    return;
  }
  if (engineSrc) {
    const packages = packagesFor(engineSrc);
    if (packages.length !== 1) fail(new Error(`STRATA_ENGINE_SRC must contain one ${expectedPlatform || target} engine package. Found ${packages.length} at ${engineSrc}.`));
    say(`copying engine package from ${packages[0]}`);
    const placed = stageEnginePackage(packages[0], dest, { expectedPlatform });
    writeFileSync(stampPath, `${wanted}\n`);
    say(`staged engine ${placed.name} from ${packages[0]}`);
    return;
  }
  const donated = donorResource('engine-bundle');
  const donatedPackages = donated && !variantWasExplicit() ? packagesFor(donated) : [];
  if (donatedPackages.length === 1) {
    say(`copying engine package from donor app ${donatedPackages[0]}`);
    const placed = stageEnginePackage(donatedPackages[0], dest, { expectedPlatform });
    writeFileSync(stampPath, `donor:${donated}\n`);
    say(`staged engine ${placed.name} from the donor app`);
    return;
  }
  const asset = engineReleaseAsset(target, variant);
  const url = RELEASE_BASE + asset.name;
  say(`downloading engine ${asset.name} from ${url}`);
  const archive = downloadVerified({ url, sha256: asset.sha256, cacheDir });
  const placed = stageEngineArchive(archive, dest, { expectedPlatform: asset.platform });
  writeFileSync(stampPath, `release:${asset.name}\n`);
  say(`staged engine ${placed.name} from ${asset.name} (sha256 ${asset.sha256})`);
}

try {
  if (skipped('engine')) say('skipping the engine (--skip-engine)');
  else stageEngine();
  if (skipped('dev')) say('skipping the host dev install (--skip-dev)');
  else {
    say(`installing host build dependencies with npm ci in ${hostDir}`);
    const dev = ensureHostDevDependencies({ hostDir, refresh });
    say(dev.action === 'kept' ? `keeping host build dependencies in ${hostDir}` : `installed host build dependencies in ${hostDir}`);
  }
  if (skipped('node')) say('skipping Node (--skip-node)');
  else stageNode();
  if (skipped('harness')) say('skipping the harness (--skip-harness)');
  else stageHarness();
  if (skipped('host')) say('skipping host production dependencies (--skip-host)');
  else {
    const outDir = join(resourcesRoot, 'host');
    say(`installing host production dependencies with npm ${HOST_PRODUCTION_NPM_ARGS.join(' ')} from ${join(hostDir, 'package-lock.json')} into ${outDir}`);
    const host = stageHostDeps({ hostDir, outDir, refresh });
    say(host.action === 'kept' ? `keeping host production dependencies in ${outDir}` : `installed host production dependencies in ${outDir}`);
  }
  const problems = bundleProblems(resourcesRoot, {
    mode: 'staged', packageJson: join(hostDir, 'package.json'),
    requireNode: !skipped('node'), requireHarness: !skipped('harness'), requireEngine: !skipped('engine'), requireHost: !skipped('host'),
  });
  if (problems.length) {
    console.error('stage-bundle: the staged resources are still incomplete:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  say(`staged ${target}${variant ? ` / ${variant}` : ''} into ${resourcesRoot}`);
} catch (error) {
  fail(error);
}
