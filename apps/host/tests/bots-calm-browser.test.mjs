/** Rendered checks for the calm Bots pass: timestamp contrast, bubble text, compact roster. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
const longPreview = 'Finished reviewing the requested code changes and waiting for the next instruction from the team';
const css = [
  'styles/kit/tokens.css',
  'styles/kit/components.css',
  'styles/app.css',
  'styles/annotation-fixes.css',
  'styles/workspace.css',
  'styles/chat-motion.css',
  'screens/Bots.css',
  'screens/BotTeamChannel.css',
  'components/CuaBotAvatar.css',
  'styles/bots-calm.css',
].map(file => readFileSync(join(src, file), 'utf8')).join('\n');

function face(fill) {
  return `<svg class="cua-bot-avatar" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="${fill}"/></svg>`;
}
function row(name, preview) {
  return `<button class="cua-sidebar-item cua-roster-bot" type="button" aria-label="Open ${name}">${face('#61BCFF')}<span class="cua-roster-copy"><span class="cua-roster-title"><strong>${name}</strong><time>6h</time></span><small>${preview}</small></span><span class="status-dot"></span></button>`;
}
const pageHtml = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/bots.css"></head><body><div class="app"><main class="main" style="grid-column:1 / -1"><div class="main__body"><div class="bots-workspace"><div class="cua-bots-shell" data-list="true"><aside class="cua-bots-sidebar"><nav>${row('Moss', longPreview)}${row('Fern', longPreview)}${row('Pip', 'Short note')}</nav></aside><section class="cua-bots-main"><div class="bot-room"><div class="bot-room-feed"><article class="bot-room-message" data-author="user" data-message-id="tm_user"><div class="bot-room-message-main"><header><strong>You</strong><time datetime="2026-10-23T15:04:00.000Z">10:04 AM</time></header><div class="bot-room-message-bubble"><p class="bot-room-addressed">To Fern</p><blockquote class="bot-room-reply-context"><strong>Moss</strong><span>Can we keep the notes page calm?</span></blockquote><div class="bot-room-message-body"><p>Yes. See the <a href="https://example.com/notes">notes page</a> and the <code class="md-code">plan.md</code> file.</p></div><footer><button type="button">Reply</button></footer></div></div></article></div></div></section></div></div></div></main></div></body></html>`;

function measureCalm() {
  const rgba = text => {
    const n = text.match(/[\d.]+/g).map(Number);
    return text.startsWith('color(srgb') ? [n[0] * 255, n[1] * 255, n[2] * 255, n.length > 3 ? n[3] : 1] : [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
  };
  const lum = channels => channels.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const read = selector => {
    const el = document.querySelector(selector);
    const fg = rgba(getComputedStyle(el).color);
    let node = el, bg;
    while (node) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      if (color[3] === 1) { bg = color; break; }
      node = node.parentElement;
    }
    bg ??= [255, 255, 255, 1];
    const a = lum(fg), b = lum(bg);
    return { contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), bgLuminance: b, decoration: getComputedStyle(el).textDecorationLine };
  };
  const side = document.querySelector('.cua-bots-sidebar');
  const rows = [...document.querySelectorAll('.cua-roster-bot')].map(row => {
    const avatar = row.querySelector('.cua-bot-avatar');
    const copy = row.querySelector('.cua-roster-copy');
    const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    return { row: box(row), avatar: box(avatar), copyDisplay: getComputedStyle(copy).display, preview: copy.querySelector('small').textContent };
  });
  const rail = side.getBoundingClientRect();
  return { time: read('[data-message-id="tm_user"] header time'), addressed: read('.bot-room-addressed'), reply: read('.bot-room-reply-context span'), name: read('.bot-room-reply-context strong'), link: read('.bot-room-message-body a'), code: read('.md-code'), rail: { width: rail.width, left: rail.left, right: rail.right }, rows };
}

test('calm Bots keeps the user timestamp, bubble text, and compact roster readable', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 30_000 }, async t => {
  const shots = process.env.STRATA_BOTS_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const server = http.createServer((req, res) => {
    if (req.url === '/bots.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(css); }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(pageHtml); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.locator('[data-message-id="tm_user"] header time').waitFor();

  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const wide = await page.evaluate(measureCalm);
    assert.equal(errors.length, 0);
    assert.ok(wide.time.contrast >= 4.5, `${theme} timestamp contrast ${wide.time.contrast}`);
    assert.ok(theme === 'light' ? wide.time.bgLuminance > 0.7 : wide.time.bgLuminance < 0.2, `${theme} timestamp is measured on the page, not the bubble`);
    for (const [name, sample] of [['addressed', wide.addressed], ['reply', wide.reply], ['name', wide.name], ['link', wide.link], ['code', wide.code]]) {
      assert.ok(sample.contrast >= 4.5, `${theme} ${name} contrast ${sample.contrast}`);
      assert.ok(sample.bgLuminance < 0.15, `${theme} ${name} is inside the dark bubble`);
    }
    assert.equal(wide.link.decoration, 'underline');
    assert.ok(wide.rows.every(row => row.copyDisplay === 'flex'), `${theme} wide roster still shows the preview`);
    if (shots) {
      await page.locator('[data-message-id="tm_user"]').screenshot({ path: join(shots, `timestamp-${theme}.png`) });
      await page.locator('.bot-room-message-bubble').screenshot({ path: join(shots, `bubble-${theme}.png`) });
    }

    await page.setViewportSize({ width: 700, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const compact = await page.evaluate(measureCalm);
    assert.ok(compact.rail.width >= 48 && compact.rail.width <= 56, `${theme} rail width ${compact.rail.width}`);
    assert.equal(compact.rows.length, 3);
    for (const row of compact.rows) {
      assert.equal(row.copyDisplay, 'none', `${theme} compact preview stays hidden`);
      assert.ok(row.preview.length > 40 || row.preview === 'Short note');
      assert.ok(row.row.height >= 68 && row.row.height <= 80, `${theme} row height ${row.row.height}`);
      assert.ok(row.avatar.left >= compact.rail.left - 1 && row.avatar.right <= compact.rail.right + 1, `${theme} avatar escapes the rail`);
      assert.ok(row.avatar.top >= row.row.top - 1 && row.avatar.bottom <= row.row.bottom + 1, `${theme} avatar escapes its row`);
    }
    const heights = compact.rows.map(row => row.row.height);
    assert.ok(Math.max(...heights) - Math.min(...heights) < 2, `${theme} preview length still changes the row`);
    if (shots) await page.screenshot({ path: join(shots, `roster-rail-${theme}.png`) });
  }
});
