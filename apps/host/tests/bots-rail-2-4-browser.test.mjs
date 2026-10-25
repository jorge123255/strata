/** Bug 2: a narrow team list is a 52px rail, not a 248px band with the names hidden. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function row(name) {
  return `<button class="cua-sidebar-item cua-roster-bot" type="button" aria-label="Open ${name}"><span class="cua-roster-copy"><span class="cua-roster-title"><strong>${name}</strong></span><small>Idle</small></span></button>`;
}
const rosterHtml = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/bots.css"></head><body style="margin:0"><div class="bots-workspace"><div class="cua-bots-shell" data-list="true"><aside class="cua-bots-sidebar" aria-label="Bots navigation"><nav><h2>Conversations <span>2</span></h2><div class="cua-bot-list">${row('Reader')}${row('Scout')}</div></nav></aside><section class="cua-bots-main"></section></div><div class="cua-bots-shell" id="activity"><aside class="cua-bots-sidebar"><nav><h2>Conversations <span>8</span></h2></nav></aside><section class="cua-bots-main"></section></div></div></body></html>`;

test('narrow team rail stays icon-width and activity does not paint a roster band', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 30_000 }, async t => {
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
    const copy = rail.querySelector('.cua-roster-copy');
    const heading = rail.querySelector('h2');
    const row = rail.querySelector('.cua-roster-bot');
    const activity = document.querySelector('#activity .cua-bots-sidebar');
    return {
      rail: Math.round(rail.getBoundingClientRect().width),
      row: Math.round(row.getBoundingClientRect().width),
      copy: getComputedStyle(copy).display,
      heading: getComputedStyle(heading).display,
      rows: rail.querySelectorAll('.cua-roster-bot').length,
      activityDisplay: getComputedStyle(activity).display,
      activityWidth: Math.round(activity.getBoundingClientRect().width),
    };
  });
  const wide = await measure();
  assert.equal(wide.rail, 248);
  assert.notEqual(wide.copy, 'none');
  assert.notEqual(wide.heading, 'none');
  assert.equal(wide.rows, 2);
  assert.equal(wide.activityDisplay, 'none');
  assert.equal(wide.activityWidth, 0);
  await page.setViewportSize({ width: 900, height: 820 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const narrow = await measure();
  assert.ok(narrow.rail <= 60, `compact rail should be 52px, was ${narrow.rail}`);
  assert.ok(narrow.row <= 60, `roster row should fit the icon rail, was ${narrow.row}`);
  assert.equal(narrow.copy, 'none');
  assert.equal(narrow.rows, 2);
  assert.equal(narrow.activityDisplay, 'none');
  assert.equal(narrow.activityWidth, 0);
});
