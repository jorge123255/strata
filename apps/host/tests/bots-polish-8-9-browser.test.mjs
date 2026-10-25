/** Bugs 8 and 9: the conversation count matches the rail, and the open row keeps its edge. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
const css = [
  'styles/kit/tokens.css',
  'styles/kit/components.css',
  'styles/app.css',
  'styles/chat-motion.css',
  'screens/Bots.css',
  'styles/bots-calm.css',
].map(file => readFileSync(join(src, file), 'utf8')).join('\n');

function row(name, selected) {
  return `<button class="cua-sidebar-item cua-roster-bot" type="button" ${selected ? 'data-selected="true"' : ''} aria-label="Open ${name}"><span class="cua-roster-copy"><span class="cua-roster-title"><strong>${name}</strong></span><small>Idle</small></span></button>`;
}
const rosterHtml = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/bots.css"></head><body style="margin:0"><div class="bots-workspace"><div class="cua-bots-shell" data-list="true"><aside class="cua-bots-sidebar" aria-label="Bots navigation"><nav><h2>Conversations <span>2</span></h2><div class="cua-bot-list">${row('Reader', true)}${row('Scout', false)}</div></nav></aside><section class="cua-bots-main"></section></div><div class="cua-bots-shell" id="activity"><aside class="cua-bots-sidebar"><nav><h2>Conversations <span>59</span></h2></nav></aside><section class="cua-bots-main"></section></div></div></body></html>`;

test('roster count follows the visible rail and the open row keeps its edge', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 30_000 }, async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/bots.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(css); }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(rosterHtml); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, reducedMotion: 'reduce' });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const measure = () => page.evaluate(() => {
    const rail = document.querySelector('.cua-bots-shell[data-list] .cua-bots-sidebar');
    const heading = rail.querySelector('h2');
    const rows = [...rail.querySelectorAll('.cua-roster-bot')];
    const open = rail.querySelector('.cua-roster-bot[data-selected]');
    const activity = document.querySelector('#activity .cua-bots-sidebar');
    const number = Number(heading.querySelector('span').textContent);
    return {
      rail: Math.round(rail.getBoundingClientRect().width),
      headingDisplay: getComputedStyle(heading).display,
      number,
      rows: rows.length,
      activityDisplay: getComputedStyle(activity).display,
      activityWidth: Math.round(activity.getBoundingClientRect().width),
      shadow: getComputedStyle(open).boxShadow,
    };
  });
  const wide = await measure();
  assert.equal(wide.rail, 248);
  assert.notEqual(wide.headingDisplay, 'none');
  assert.equal(wide.number, wide.rows);
  assert.equal(wide.activityDisplay, 'none');
  assert.equal(wide.activityWidth, 0);
  assert.notEqual(wide.shadow, 'none');
  const open = page.locator('.cua-bots-shell[data-list] .cua-roster-bot[data-selected]');
  await open.hover();
  const hovered = await open.evaluate(el => getComputedStyle(el).boxShadow);
  assert.equal(hovered, wide.shadow);
  assert.notEqual(hovered, 'none');
  await page.setViewportSize({ width: 900, height: 820 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const narrow = await measure();
  assert.ok(narrow.rail <= 60, `compact rail should be 52px, was ${narrow.rail}`);
  assert.equal(narrow.headingDisplay, 'none');
  assert.equal(narrow.rows, 2);
});

test('activity chips count rendered sessions when the profile total disagrees', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 30_000 }, async t => {
  const generated = await build({ absWorkingDir: root, stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{BotSupervision}from ${JSON.stringify(join(root, 'src/components/BotSupervision.tsx'))};createRoot(document.getElementById('root')).render(<BotSupervision snapshot={window.fixture.snapshot} bots={window.fixture.bots} stale={false} onOpen={()=>{}}/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: 'out', jsx: 'automatic', loader: { '.woff2': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const script = generated.outputFiles.find(file => file.path.endsWith('.js')).text;
  const style = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(file => readFileSync(join(src, file), 'utf8')).join('\n') + generated.outputFiles.find(file => file.path.endsWith('.css')).text;
  const at = new Date().toISOString();
  const session = (id, state) => ({ id, botId: 'bot_fixture', name: 'Reader', title: id, state, approvalCount: state === 'approval' ? 1 : 0, updatedAt: at });
  const fixture = { snapshot: { supported: true, sessions: [session('s1', 'approval'), session('s2', 'completed')], counts: { waiting: 59, working: 0, completed: 0, errors: 0 }, hasMore: false }, bots: [{ id: 'bot_fixture', name: 'Reader' }] };
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); return res.end(script); }
    if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); return res.end(style); }
    if (req.url === '/icons/sprite.svg') { res.setHeader('content-type', 'image/svg+xml'); return res.end(readFileSync(join(root, 'public/icons/sprite.svg'))); }
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(`<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script>window.fixture=${JSON.stringify(fixture)}</script><script src="/bundle.js"></script></body></html>`); }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, reducedMotion: 'reduce' });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button', { name: 'All 2', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Needs you 1', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Recently finished 1', exact: true }).waitFor();
  assert.equal(await page.locator('.bot-supervision-card').count(), 2);
  assert.equal(await page.getByRole('button', { name: /59/ }).count(), 0);
});
