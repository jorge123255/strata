/** Narrow Bots labels stay whole, and the open profile scrolls inside the rail. */
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
].map(file => readFileSync(join(src, file), 'utf8')).join('\n');

const labels = ['Team', 'Activity', 'Skills', 'Tools', 'Connectors'];
const sections = ['Profile defaults', 'Shared work', 'Connectors', 'Computers', 'Activity', 'Outputs', 'Customize'];
const pageHtml = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/bots.css"></head><body>
<div class="bots-workspace" id="workspace"><nav class="bots-destinations" aria-label="Bots workspace">${labels.map(label => `<button type="button"${label === 'Team' ? ' aria-current="page"' : ''}><span>${label}</span></button>`).join('')}</nav></div>
<section class="cua-bots-main" id="rail"><div class="cua-bot-detail" id="detail"><div class="cua-bot-chat"><p>Chat</p></div><aside class="cua-bot-profile spring-pane" data-open="true"><h2>Reader</h2><p class="cua-profile-hint">The configured provider and execution computer are available for this bot.</p>${sections.map(title => `<section class="cua-profile-section"><h3>${title}</h3><div><div class="cua-profile-row"><strong>${title === 'Customize' ? 'Permissions' : title}</strong><small>Ask before tools run on the selected computer.</small></div></div></section>`).join('')}</aside></div></section>
</body></html>`;

function measure() {
  const box = el => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const workspace = document.querySelector('#workspace');
  const destinations = document.querySelector('.bots-destinations');
  const buttons = [...destinations.querySelectorAll('button')].map(button => {
    const label = button.querySelector('span');
    return { text: label.textContent, button: box(button), labelScroll: label.scrollWidth, labelClient: label.clientWidth };
  });
  const detail = document.querySelector('#detail');
  const profile = document.querySelector('.cua-bot-profile');
  const tail = [...profile.querySelectorAll('strong')].find(node => node.textContent === 'Permissions');
  return {
    workspace: box(workspace),
    destinations: box(destinations),
    buttons,
    detail: box(detail),
    profile: box(profile),
    profileScroll: profile.scrollHeight,
    profileClient: profile.clientHeight,
    tail: box(tail),
  };
}

test('narrow Bots labels stay whole and the open profile scrolls inside the rail', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 30_000 }, async t => {
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

  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
    page.on('pageerror', error => { throw error; });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.locator('.bots-destinations').waitFor();
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);

    for (const width of [320, 380, 560]) {
      await page.evaluate(value => { document.querySelector('#workspace').style.width = `${value}px`; }, width);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const narrow = await page.evaluate(measure);
      assert.deepEqual(narrow.buttons.map(button => button.text), labels);
      for (const button of narrow.buttons) {
        assert.ok(button.button.right <= narrow.workspace.right + 1, `${theme} ${width} ${button.text} ends at ${button.button.right}, workspace ${narrow.workspace.right}`);
        assert.ok(button.button.left >= narrow.workspace.left - 1, `${theme} ${width} ${button.text} starts outside the workspace`);
        assert.ok(button.labelScroll <= button.labelClient + 1, `${theme} ${width} ${button.text} is clipped inside its label`);
      }
    }

    for (const width of [857, 577]) {
      await page.evaluate(value => {
        const rail = document.querySelector('#rail');
        rail.style.width = `${value}px`;
        rail.style.height = '640px';
      }, width);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const open = await page.evaluate(measure);
      assert.ok(open.profile.bottom <= open.detail.bottom + 1, `${theme} ${width} profile bottom ${open.profile.bottom} past detail ${open.detail.bottom}`);
      assert.ok(open.profile.height <= open.detail.height + 1, `${theme} ${width} profile height ${open.profile.height}`);
      assert.ok(open.profileScroll > open.profileClient + 40, `${theme} ${width} profile does not scroll (${open.profileScroll} vs ${open.profileClient})`);
      await page.evaluate(() => {
        const profile = document.querySelector('.cua-bot-profile');
        profile.scrollTop = profile.scrollHeight;
      });
      const tail = await page.evaluate(measure);
      assert.ok(tail.tail.bottom <= tail.profile.bottom + 1 && tail.tail.top >= tail.profile.top - 1, `${theme} ${width} Permissions is outside the profile`);
    }
    await page.close();
  }
});
