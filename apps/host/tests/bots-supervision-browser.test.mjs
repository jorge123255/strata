/** Actual supervision UI, isolated data and Chromium. Never contacts an owned host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
test('supervision cards show urgency, keyboard filters, exact review links, stale state and responsive bounds', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 60_000 }, async t => {
  const generated = await build({ absWorkingDir: root, stdin: { contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BotSupervision}from ${JSON.stringify(join(root, 'src/components/BotSupervision.tsx'))};function App(){const[data,setData]=useState(window.fixture.snapshot),[stale,setStale]=useState(false);window.updateSnapshot=(data,stale)=>{setData(data);setStale(stale)};return <main><BotSupervision snapshot={data} bots={window.fixture.bots} stale={stale} onOpen={id=>window.opened.push(id)}/></main>}createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: 'out', metafile: true, jsx: 'automatic', loader: { '.woff2': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const script = generated.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(path => readFileSync(join(root, 'src', path), 'utf8')).join('\n') + generated.outputFiles.find(file => file.path.endsWith('.css')).text;
  const at = new Date().toISOString(), row = (id, state, patch = {}) => ({ id, botId: 'bot_fixture', name: 'Builder', title: id, state, approvalCount: state === 'approval' ? 1 : 0, updatedAt: at, ...patch });
  const snapshot = { supported: true, sessions: [row('s_waiting', 'approval'), row('s_error', 'error'), row('s_working', 'working', { toolName: 'browser_click', teamId: 'team_fixture', parentChatId: 's_parent', computerName: 'Remote Strata' }), row('s_thinking', 'thinking'), row('s_done', 'completed')], counts: { waiting: 1, working: 2, completed: 1, errors: 1 }, hasMore: false };
  const fixture = { snapshot, bots: [{ id: 'bot_fixture', name: 'Builder', avatarConfig: { shape: 'hexagon', color: 'sky', eyes: 'round', ears: 'round' } }] };
  const evidence = process.env.STRATA_SUPERVISION_EVIDENCE ? resolve(process.env.STRATA_SUPERVISION_EVIDENCE) : mkdtempSync(join(tmpdir(), 'strata-supervision-ui-'));
  mkdirSync(evidence, { recursive: true });
  const ephemeral = !process.env.STRATA_SUPERVISION_EVIDENCE;
  const requests = [], external = [], errors = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (req.url === '/bundle.js') { res.setHeader('content-type','text/javascript'); res.end(script); }
    else if (req.url === '/icons/sprite.svg') { res.setHeader('content-type','image/svg+xml'); res.end(readFileSync(join(root, 'public/icons/sprite.svg'))); }
    else if (req.url === '/style.css') { res.setHeader('content-type','text/css'); res.end(css); }
    else if (req.url === '/') { res.setHeader('content-type','text/html'); res.end(`<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="/style.css"><style>body{overflow:auto}main{max-width:1100px;padding:32px;margin:auto}button{font-family:inherit}</style></head><body><div id="root"></div><script>window.fixture=${JSON.stringify(fixture)};window.opened=[]</script><script src="/bundle.js"></script></body></html>`); }
    else { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (ephemeral) rmSync(evidence, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await page.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading', { name: '1 conversation waiting for you' }).waitFor();
  assert.equal(await page.locator('.bot-supervision-card').count(), 5);
  await page.screenshot({ path: join(evidence, 'supervision-all-dark.png'), fullPage: true });
  const needs = page.getByRole('button', { name: 'Needs you 2', exact: true });
  await needs.focus(); await page.keyboard.press('Enter');
  assert.equal(await needs.getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('.bot-supervision-card').count(), 2);
  await page.getByRole('button', { name: 'Review approval', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.opened), ['s_waiting']);
  await page.getByRole('button', { name: 'Working 2', exact: true }).click();
  assert.equal(await page.locator('.bot-supervision-card').count(), 2);
  await page.getByText('Subagent · Remote Strata', { exact: true }).waitFor();
  await page.getByText('browser click', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open conversation', exact: true }).first().click();
  assert.deepEqual(await page.evaluate(() => window.opened), ['s_waiting','s_working']);
  const cleared = { ...snapshot, sessions: snapshot.sessions.filter(row => row.id !== 's_waiting'), counts: { ...snapshot.counts, waiting: 0 } };
  await page.evaluate(value => window.updateSnapshot(value, true), cleared);
  await page.getByText('Last known activity', { exact: true }).waitFor();
  await page.getByText('Last known: Using a tool', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Needs you 1', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Review approval' }).count(), 0);
  await page.setViewportSize({ width: 820, height: 900 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(evidence, 'supervision-stale-compact.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const inputs = Object.fromEntries(Object.keys(generated.metafile.inputs).filter(path => path !== '<stdin>').map(path => { const file = resolve(root, path); return [file, hash(readFileSync(file))]; }));
  for (const path of ['src/styles/kit/tokens.css','src/styles/kit/components.css','src/styles/app.css','public/icons/sprite.svg','tests/bots-supervision-browser.test.mjs']) inputs[join(root,path)] = hash(readFileSync(join(root,path)));
  writeFileSync(join(evidence, 'report.json'), JSON.stringify({ passed: true, browser: await browser.version(), externalRequests: external, pageErrors: errors, requests, inputSHA256: inputs, scriptSHA256: hash(script), cssSHA256: hash(css), checks: ['actual shipped component','5 exact states','keyboard attention filter','exact approval conversation ID','working subagent context','no implicit actions','cleared approval','last-known stale status','820px no horizontal overflow','reduced motion'] }, null, 2));
  assert.deepEqual(external, []); assert.deepEqual(errors, []); assert.equal(requests.some(request => request.method !== 'GET'), false);
});
