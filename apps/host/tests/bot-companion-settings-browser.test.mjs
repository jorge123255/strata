/** Real settings component against a disposable local fixture; no owner host or preferences. */
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
const screenId = 'C7DDE080-0312-4B00-8C17-156946E53311';
const initial = () => ({ available: true, settings: { enabled: false, screen: 'main' }, screens: [{ id: screenId, name: 'Studio Display' }], visible: false, expanded: false });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('actual native companion settings preserve opt-in and display choices through failures, races and lifecycle changes', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 120000 }, async t => {
  const generated = await build({ stdin: { contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SettingsBotCompanion}from ${JSON.stringify(join(root, 'src/components/SettingsBotCompanion.tsx'))};function Fixture(){const[mounted,setMounted]=useState(true),[revision,setRevision]=useState(0);window.mountCompanion=()=>{setRevision(v=>v+1);setMounted(true)};window.unmountCompanion=()=>setMounted(false);return <main>{mounted?<SettingsBotCompanion key={revision}/>:<p>Companion settings closed</p>}</main>}createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: 'out', metafile: true, jsx: 'automatic', loader: { '.woff2': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const script = generated.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(path => readFileSync(join(root, 'src', path), 'utf8')).join('\n') + generated.outputFiles.find(file => file.path.endsWith('.css')).text;
  const inputs = Object.fromEntries(Object.keys(generated.metafile.inputs).filter(path => path !== '<stdin>').map(path => { const file = resolve(root, path); return [file, hash(readFileSync(file))]; }));
  for (const path of ['src/styles/kit/tokens.css', 'src/styles/kit/components.css', 'src/styles/app.css', 'public/icons/sprite.svg', 'tests/bot-companion-settings-browser.test.mjs', 'src/screens/Settings.tsx']) inputs[join(root, path)] = hash(readFileSync(join(root, path)));
  const evidence = process.env.STRATA_COMPANION_SETTINGS_EVIDENCE ? resolve(process.env.STRATA_COMPANION_SETTINGS_EVIDENCE) : mkdtempSync(join(tmpdir(), 'strata-companion-settings-'));
  mkdirSync(evidence, { recursive: true });
  const ephemeral = !process.env.STRATA_COMPANION_SETTINGS_EVIDENCE;
  let status = initial(), readCode = 200, writeFailure = '', holdRead = false, holdWrite = false;
  const requests = [], heldReads = [], heldWrites = [], external = [], errors = [];
  const json = (res, body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const entry = { method: req.method, path: req.url }; requests.push(entry);
    if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(script); }
    else if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); res.end(css); }
    else if (req.url === '/icons/sprite.svg') { res.setHeader('content-type', 'image/svg+xml'); res.end(readFileSync(join(root, 'public/icons/sprite.svg'))); }
    else if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="/style.css"><style>body{overflow:auto}main{max-width:770px;padding:32px;margin:auto}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); }
    else if (req.url === '/api/bots/companion' && req.method === 'GET') { if (holdRead) { holdRead = false; heldReads.push(res); } else json(res, status, readCode); }
    else if (req.url === '/api/bots/companion/settings' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk; entry.body = JSON.parse(body);
      assert.ok(Object.keys(entry.body).length === 1 && ['enabled', 'screen'].includes(Object.keys(entry.body)[0]));
      if (holdWrite) { holdWrite = false; heldWrites.push(res); }
      else if (writeFailure) json(res, { error: writeFailure }, 503);
      else { status = { ...status, settings: { ...status.settings, ...entry.body }, visible: entry.body.enabled ?? status.settings.enabled }; json(res, status); }
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(async () => { for (const response of [...heldReads, ...heldWrites]) if (!response.writableEnded) response.end(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (ephemeral) rmSync(evidence, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 980, height: 840 }, reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.fixtureRequests = []; window.ignoreNextAbort = false;
    const fetcher = window.fetch;
    window.fetch = (input, init = {}) => {
      const entry = { path: String(input), method: init.method ?? 'GET', aborted: false, completed: false }; window.fixtureRequests.push(entry);
      init.signal?.addEventListener('abort', () => { entry.aborted = true; });
      const ignore = window.ignoreNextAbort; window.ignoreNextAbort = false;
      return fetcher(input, ignore ? { ...init, signal: undefined } : init).then(value => { entry.completed = true; return value; });
    };
  });
  await page.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const toggle = page.getByRole('switch', { name: 'Show bot companion', exact: true }), display = page.getByRole('combobox', { name: 'Bot companion display', exact: true });
  await page.getByText('Off until you turn it on.', { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false'); assert.equal(await toggle.isEnabled(), true);
  assert.equal(requests.some(row => row.method === 'POST'), false, 'Opening settings is read-only.');
  await page.screenshot({ path: join(evidence, 'companion-settings-dark-off.png'), fullPage: true });

  await toggle.focus(); await page.keyboard.press('Space');
  await page.getByText('Your companion is on the desktop.', { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await display.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[role="combobox"]')?.textContent.includes('Studio Display') && !document.querySelector('[role="combobox"]')?.hasAttribute('disabled'));
  assert.equal(status.settings.screen, screenId);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.screenshot({ path: join(evidence, 'companion-settings-light-enabled.png'), fullPage: true });

  status = { ...status, screens: [] };
  await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.getByText('Unavailable display · using Main display', { exact: true }).waitFor();
  await page.getByText(/Your chosen display is disconnected/).waitFor();
  assert.equal(status.settings.screen, screenId, 'Disconnect preserves the native saved display.');
  const writesBeforeDisconnect = requests.filter(row => row.method === 'POST').length;
  await page.setViewportSize({ width: 390, height: 900 }); await settle(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(evidence, 'companion-settings-disconnected-narrow.png'), fullPage: true });
  assert.equal(requests.filter(row => row.method === 'POST').length, writesBeforeDisconnect);
  status = { ...status, screens: initial().screens };
  await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="combobox"]')?.textContent.includes('Studio Display'));
  await toggle.click(); await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false' && !document.querySelector('[role="switch"]')?.hasAttribute('disabled'));
  assert.equal(status.settings.enabled, false);

  writeFailure = 'The native companion is temporarily unavailable.';
  await toggle.click(); await page.getByText(writeFailure, { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'A failed write does not optimistically enable.');
  assert.equal(await toggle.isDisabled(), true); assert.equal(await display.isDisabled(), true);
  await page.getByText('Last known settings. Refresh to check the current companion.', { exact: true }).waitFor();
  writeFailure = ''; await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="switch"]')?.hasAttribute('disabled'));

  holdRead = true; await page.evaluate(() => { window.ignoreNextAbort = true; });
  await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.waitForFunction(() => window.fixtureRequests.at(-1)?.path === '/api/bots/companion' && !window.fixtureRequests.at(-1)?.completed);
  const oldRead = status;
  status = { ...status, settings: { ...status.settings, enabled: true }, visible: true };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true' && !document.querySelector('[role="switch"]')?.hasAttribute('disabled'));
  assert.equal(heldReads.length, 1); json(heldReads.shift(), oldRead);
  await page.waitForFunction(() => window.fixtureRequests.some(row => row.aborted && row.completed)); await settle(page);
  assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'A late cancelled read cannot undo newer state.');

  holdWrite = true; await toggle.click();
  await page.getByText('Updating the Mac companion…', { exact: true }).waitFor();
  assert.equal(await toggle.isDisabled(), true); assert.equal(await display.isDisabled(), true);
  assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'Native confirmation is required before the switch changes.');
  await page.evaluate(() => window.unmountCompanion());
  await page.getByText('Companion settings closed', { exact: true }).waitFor();
  await page.waitForFunction(() => window.fixtureRequests.findLast(row => row.method === 'POST')?.aborted);
  status = { ...status, settings: { ...status.settings, enabled: false }, visible: false };
  assert.equal(heldWrites.length, 1); json(heldWrites.shift(), status);
  await page.evaluate(() => window.mountCompanion());
  await page.getByText('Off until you turn it on.', { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');

  holdRead = true; await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.waitForFunction(() => !window.fixtureRequests.at(-1)?.completed);
  const beforeHidden = requests.filter(row => row.path === '/api/bots/companion').length;
  await page.evaluate(() => { window.fixtureHidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.fixtureHidden }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => window.fixtureRequests.at(-1)?.aborted);
  assert.equal(requests.filter(row => row.path === '/api/bots/companion').length, beforeHidden);
  assert.equal(heldReads.length, 1); json(heldReads.shift(), { ...status, settings: { ...status.settings, enabled: true } });
  await page.evaluate(() => { window.fixtureHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => !document.querySelector('[role="switch"]')?.hasAttribute('disabled'));
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'A hidden cancelled read never becomes confirmed native state.');

  status = { ...initial(), settings: { enabled: 'yes', screen: 'main' } };
  await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.getByText('The Mac companion settings were incomplete. Refresh to check them again.', { exact: true }).waitFor();
  assert.equal(await toggle.isDisabled(), true);
  status = initial(); await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="switch"]')?.hasAttribute('disabled'));

  holdRead = true; await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.getByText('The Mac did not answer in time. Refresh to check the current companion settings.', { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(await toggle.isDisabled(), true); assert.equal(heldReads.length, 1); json(heldReads.shift(), initial());
  await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="switch"]')?.hasAttribute('disabled'));

  readCode = 404; await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.getByText('The bot companion is available in the updated Strata Mac app.', { exact: true }).waitFor();
  assert.equal(await toggle.isDisabled(), true); assert.equal(await display.count(), 0);
  readCode = 200; status = { available: false, detail: 'This browser does not have the native Strata companion.' };
  await page.getByRole('button', { name: 'Refresh companion settings', exact: true }).click();
  await page.getByText(status.detail, { exact: true }).waitFor();
  assert.equal(await toggle.isDisabled(), true);
  await page.screenshot({ path: join(evidence, 'companion-settings-browser-unavailable.png'), fullPage: true });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  assert.equal(requests.filter(row => row.method === 'POST').length, 5);
  assert.ok(requests.every(row => row.method !== 'POST' || row.path === '/api/bots/companion/settings'));
  for (const [path, expected] of Object.entries(inputs)) assert.equal(hash(readFileSync(path)), expected, `UI input changed during the browser check: ${path}`);
  writeFileSync(join(evidence, 'report.json'), JSON.stringify({ passed: true, browser: await browser.version(), externalRequests: external, pageErrors: errors, requests, inputSHA256: inputs, scriptSHA256: hash(script), cssSHA256: hash(css), checks: ['actual shipped component', 'read-only mount', 'default off', 'keyboard enable', 'keyboard display choice', 'disable', 'no optimistic mutation', 'controls locked during update', 'retained unplugged display preference', 'reconnected display', 'dark and light layouts', '390px no overflow', 'failed write stays last-known', 'fresh read recovers', 'late cancelled read ignored', 'pending write unmount abort', 'remount rereads native state', 'hidden read abort and resume', 'malformed native status rejected', 'timeout becomes stale', '404 old carrier', 'native unavailable browser', 'reduced motion', 'no external requests', 'no bot/provider/approval operations'] }, null, 2));
});
