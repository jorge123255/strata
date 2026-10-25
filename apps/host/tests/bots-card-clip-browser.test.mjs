/** Open profile beside an existing conversation must not collapse the chat when the computer is also open. */
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
  'styles/annotation-fixes.css',
  'styles/workspace.css',
  'styles/chat-motion.css',
  'styles/bots-calm.css',
  'screens/Bots.css',
  'screens/ChatEmbedded.css',
].map(file => readFileSync(join(src, file), 'utf8')).join('\n');

const pageHtml = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/bots.css"></head><body>
<section class="cua-bots-main" id="rail">
  <header class="cua-bot-toolbar"><span>Conversation</span></header>
  <div class="cua-bot-detail" id="detail" data-computer="true">
    <div class="cua-bot-chat">
      <div class="bot-chat-embedded">
        <div class="chatsplit"><p class="clip-copy">Keep this existing conversation readable beside the computer while the profile is open.</p></div>
        <div class="composerwrap"><div class="composer"><div class="composer__inner"><div class="st-composer"><textarea aria-label="Message Strata" placeholder="Message your bot…">Hello from the existing conversation</textarea><div class="st-composer__bar"></div></div></div></div></div>
      </div>
    </div>
    <aside class="cua-bot-computer" aria-label="Bot computer">Computer</aside>
    <aside class="cua-bot-profile spring-pane" data-open="true" aria-label="Reader profile"><h2>Permissions</h2><p>Ask before tools run.</p></aside>
  </div>
</section>
</body></html>`;

function measureClip() {
  const box = el => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const visibleIn = (el, clip) => {
    const item = box(el), edge = box(clip);
    return {
      layoutWidth: item.width,
      layoutHeight: item.height,
      width: Math.max(0, Math.min(item.right, edge.right) - Math.max(item.left, edge.left)),
      height: Math.max(0, Math.min(item.bottom, edge.bottom) - Math.max(item.top, edge.top)),
    };
  };
  const rail = document.querySelector('#rail');
  const detail = document.querySelector('#detail');
  const chat = document.querySelector('.cua-bot-chat');
  const profile = document.querySelector('.cua-bot-profile');
  const copy = document.querySelector('.clip-copy');
  const field = document.querySelector('textarea');
  const chatStyle = getComputedStyle(chat);
  const pad = parseFloat(chatStyle.paddingRight);
  return {
    container: rail.getBoundingClientRect().width,
    direction: getComputedStyle(detail).flexDirection,
    profilePosition: getComputedStyle(profile).position,
    pad,
    detail: box(detail),
    chat: box(chat),
    profile: box(profile),
    copy: box(copy),
    content: chat.clientWidth - pad - parseFloat(chatStyle.paddingLeft),
    field: visibleIn(field, chat),
  };
}

test('an open profile leaves an existing conversation usable beside the computer', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 30_000 }, async t => {
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
    await page.locator('textarea').waitFor();
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);

    async function place(width, computer) {
      await page.evaluate(({ width, computer }) => {
        const rail = document.querySelector('#rail');
        rail.style.width = `${width}px`;
        rail.style.height = '640px';
        const detail = document.querySelector('#detail');
        const pane = document.querySelector('.cua-bot-computer');
        if (computer) { detail.setAttribute('data-computer', 'true'); pane.hidden = false; }
        else { detail.removeAttribute('data-computer'); pane.hidden = true; }
      }, { width, computer });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return page.evaluate(measureClip);
    }

    const beside = await place(627, true);
    assert.ok(beside.container > 620 && beside.container <= 800, `${theme} container ${beside.container}`);
    assert.equal(beside.direction, 'row');
    assert.equal(beside.profilePosition, 'absolute');
    assert.ok(beside.pad < 8, `${theme} side-by-side chat padding ${beside.pad}`);
    assert.ok(beside.chat.width > 250, `${theme} chat outer ${beside.chat.width}`);
    assert.ok(beside.content > 240, `${theme} chat content ${beside.content}`);
    assert.ok(beside.content > beside.chat.width - 24, `${theme} content ${beside.content} collapsed inside chat ${beside.chat.width}`);
    assert.ok(beside.field.layoutWidth > 160 && beside.field.width > 160 && beside.field.height > 24, `${theme} composer ${JSON.stringify(beside.field)}`);
    assert.ok(beside.profile.left >= beside.chat.right - 2, `${theme} profile overlaps the chat`);
    assert.ok(beside.profile.bottom <= beside.detail.bottom + 1 && beside.profile.height <= beside.detail.height + 1, `${theme} profile leaves the rail`);

    const stacked = await place(560, true);
    assert.ok(stacked.container <= 620, `${theme} stacked container ${stacked.container}`);
    assert.equal(stacked.direction, 'column');
    assert.ok(stacked.pad > 280, `${theme} stacked padding ${stacked.pad}`);
    assert.ok(stacked.copy.right <= stacked.profile.left + 1, `${theme} stacked copy runs under the profile`);
    assert.ok(stacked.field.width > 80 && stacked.field.height > 24, `${theme} stacked composer ${JSON.stringify(stacked.field)}`);
    assert.ok(stacked.profile.bottom <= stacked.detail.bottom + 1, `${theme} stacked profile leaves the rail`);

    const covered = await place(577, false);
    assert.equal(covered.profilePosition, 'absolute');
    assert.ok(covered.pad > 280, `${theme} covered-chat padding ${covered.pad}`);
    assert.ok(covered.copy.right <= covered.profile.left + 1, `${theme} chat copy runs under the profile`);
    assert.ok(covered.field.width > 80 && covered.field.height > 24, `${theme} covered composer ${JSON.stringify(covered.field)}`);

    const wide = await place(860, true);
    assert.equal(wide.profilePosition, 'static');
    assert.ok(wide.pad < 8, `${theme} wide padding ${wide.pad}`);
    assert.ok(wide.field.width > 80 && wide.field.height > 24, `${theme} wide composer ${JSON.stringify(wide.field)}`);
    assert.ok(wide.profile.bottom <= wide.detail.bottom + 1 && wide.profile.height <= wide.detail.height + 1, `${theme} wide profile leaves the rail`);
    await page.close();
  }
});
