#!/usr/bin/env node
/**
 * Fail if a built Strata.app is missing Node, the harness, the engine, or the
 * host's production dependencies, or if it contains a credential, key, or VPN file.
 *
 *   node scripts/check-app-bundle.mjs
 *   node scripts/check-app-bundle.mjs /path/to/Strata.app
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleProblems, findStrataApps } from './bundle-resources.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const given = process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : '';
const apps = given ? [given] : findStrataApps(join(desktop, 'src-tauri/target/release/bundle'));
const packageJson = join(desktop, '../host/package.json');

if (!apps.length) {
  console.error('check-app: no Strata.app was found under src-tauri/target/release/bundle/macos.');
  console.error('A macOS build writes Strata.app there. This build did not produce one, so the packaged app was not checked.');
  process.exit(1);
}

let failed = false;
for (const app of apps) {
  const resources = app.endsWith('.app') ? join(app, 'Contents', 'Resources') : app;
  const mode = app.endsWith('.app') || existsSync(join(resources, 'host/server/index.mjs')) ? 'packaged' : 'staged';
  const bundledPackage = join(resources, 'host/package.json');
  const problems = bundleProblems(resources, { mode, packageJson: existsSync(bundledPackage) ? bundledPackage : packageJson });
  if (problems.length) {
    failed = true;
    console.error(`check-app: ${app} is missing pieces it needs to run, or it contains a file that must not ship:`);
    for (const problem of problems) console.error(`  - ${problem}`);
  } else {
    console.log(`check-app: ${app} has Node, the harness, the engine, and the host's production dependencies.`);
  }
}
if (failed) {
  console.error('check-app: refusing to leave an incomplete app. npm run build:app stages these pieces before Tauri bundles them.');
  process.exit(1);
}
