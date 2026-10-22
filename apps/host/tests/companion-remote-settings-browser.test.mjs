/** Pairing settings against a synthetic host; never touches owner pairing or Tailscale. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));

test('away-from-home settings remain visible after pairing and never start or change a connection', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 60000 }, async t => {
  const generated = await build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import{SettingsCompanion}from ${JSON.stringify(join(root, 'src/components/SettingsCompanion.tsx'))};createRoot(document.getElementById('root')).render(<SettingsCompanion/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: 'out', metafile: true, jsx: 'automatic', loader: { '.woff2': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const script = generated.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(path => readFileSync(join(root, 'src', path), 'utf8')).join('\n') + generated.outputFiles.find(file => file.path.endsWith('.css')).text;
  const sourceSHA256 = Object.fromEntries(Object.keys(generated.metafile.inputs).filter(path => path !== '<stdin>').map(path => [path, hash(readFileSync(resolve(root, path)))]));
  for (const path of ['src/styles/kit/tokens.css', 'src/styles/kit/components.css', 'src/styles/app.css', 'tests/companion-remote-settings-browser.test.mjs']) sourceSHA256[path] = hash(readFileSync(join(root, path)));
  const evidence = process.env.STRATA_TAILSCALE_UI_EVIDENCE ? resolve(process.env.STRATA_TAILSCALE_UI_EVIDENCE) : mkdtempSync(join(tmpdir(), 'strata-remote-settings-'));
  mkdirSync(evidence, { recursive: true });
  const remote = 'https://100.90.80.70:8787';
  let state = { enabled: true, invitation: { url: 'strata://pair', address: 'https://192.168.1.10:8787', code: '000000', fingerprint: '0'.repeat(64), available: false, expiresAt: 0, qrAvailable: false }, devices: [{ id: 'fixture-device', deviceName: 'Fixture iPhone', createdAt: '2026-01-01T00:00:00Z' }], endpoints: [{ kind: 'lan', url: 'https://192.168.1.10:8787' }, { kind: 'tailscale', url: remote }] };
  const requests = [], external = [], errors = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, method: req.method });
    if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(script); }
    else if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); res.end(css); }
    else if (req.url === '/icons/sprite.svg') { res.setHeader('content-type', 'image/svg+xml'); res.end(readFileSync(join(root, 'public/icons/sprite.svg'))); }
    else if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>html,body,#root{height:auto!important;overflow:visible!important}main{max-width:770px;padding:24px;margin:auto}</style></head><body><main id="root"></main><script src="/bundle.js"></script></body></html>'); }
    else if (req.url === '/api/companion' && req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); }
    else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (!process.env.STRATA_TAILSCALE_UI_EVIDENCE) rmSync(evidence, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 980, height: 840 }, reducedMotion: 'reduce' });
  await page.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Connect away from home', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Pair your iPhone', exact: true }).count(), 1);
  await page.getByText(remote, { exact: true }).waitFor();
  await page.getByText('Fixture iPhone', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Copy Tailscale address', exact: true }).count(), 1);
  assert.equal(await page.getByRole('heading', { name: 'Scan to connect', exact: true }).count(), 0, 'Remote address remains usable after the one-time invitation expires.');
  await page.locator('section[aria-labelledby="companion-away-title"]').screenshot({ path: join(evidence, 'remote-address-paired-dark.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('section[aria-labelledby="companion-away-title"]').screenshot({ path: join(evidence, 'remote-address-paired-light-narrow.png'), animations: 'disabled' });

  state = { ...state, endpoints: [] };
  await page.getByText('No Tailscale address detected yet. Connect Tailscale on this Mac; Strata will refresh the address automatically.', { exact: true }).waitFor();
  assert.equal(await page.getByText(remote, { exact: true }).count(), 0);
  const { endpoints, ...legacy } = state;
  state = legacy;
  await page.getByText('Update Strata on this Mac to show its Tailscale address.', { exact: true }).waitFor();
  state = { ...state, enabled: false, invitation: null };
  await page.getByRole('button', { name: 'Enable iPhone pairing', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Connect away from home', exact: true }).count(), 0);
  assert.ok(requests.every(row => row.method === 'GET'), 'Viewing and polling settings must not pair, rotate invitations, change VPN settings or start a listener.');
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  for (const [path, expected] of Object.entries(sourceSHA256)) assert.equal(hash(readFileSync(resolve(root, path))), expected, `UI input changed during verification: ${path}`);
  writeFileSync(join(evidence, 'report.json'), JSON.stringify({ passed: true, checks: ['Tailscale visible with expired invitation', 'existing paired device retained', 'copy action offered', 'missing Tailscale guidance', 'older-host guidance', 'disabled listener remains off', '390px no overflow', 'dark/light layouts', 'read-only requests', 'no external requests', 'no page errors'], requests, external, errors, sourceSHA256, bundleSHA256: hash(script), styleSHA256: hash(css) }, null, 2));
});
