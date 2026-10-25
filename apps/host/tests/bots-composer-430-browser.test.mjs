/** At a 430px window an open profile must not squeeze the composer. 900 and 1180 stay beside it. */
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
const shotDir = process.env.STRATA_COMPOSER_SHOTS || '';
// Same order as the running app: Bots.css, then chat-motion, then bots-calm.
const css = [
  'styles/kit/tokens.css',
  'styles/kit/components.css',
  'styles/app.css',
  'screens/Bots.css',
  'styles/chat-motion.css',
  'styles/bots-calm.css',
].map(file => readFileSync(join(src, file), 'utf8')).join('\n');

const pageHtml = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/bots.css"></head><body>
<div class="app" data-rail="true" data-layout="compact">
  <aside class="nav"></aside>
  <main class="main">
    <div class="mobile-bar"><span>Bots</span></div>
    <div class="bots-workspace">
      <nav class="bots-destinations" aria-label="Bots workspace"><button type="button" aria-current="page"><span>Team</span></button><button type="button"><span>Activity</span></button><button type="button"><span>Skills</span></button><button type="button"><span>Tools</span></button><button type="button"><span>Connectors</span></button></nav>
      <div class="cua-bots-shell" data-list="true">
        <aside class="cua-bots-sidebar" aria-label="Bots navigation"><nav><h2>Conversations <span>2</span></h2><button class="cua-sidebar-item cua-roster-bot" type="button" data-selected="true"><span class="cua-roster-copy"><span class="cua-roster-title"><strong>Reader</strong></span><small>Idle</small></span></button></nav></aside>
        <section class="cua-bots-main" id="rail">
          <header class="cua-bot-toolbar"><span class="cua-toolbar-label">Conversation</span><span class="spacer"></span><button type="button">Show profile</button></header>
          <div class="cua-bot-detail" id="detail">
            <div class="cua-bot-chat">
              <div class="bot-chat-embedded">
                <p class="clip-copy">Keep this conversation readable beside the profile.</p>
                <div class="composerwrap"><div class="composer"><div class="composer__inner"><div class="st-composer"><textarea aria-label="Message">Hello from the conversation</textarea><div class="st-composer__bar"></div></div></div></div></div>
              </div>
            </div>
            <aside class="cua-bot-computer" hidden aria-label="Bot computer">Computer</aside>
            <aside class="cua-bot-profile spring-pane" data-open="true" aria-label="Reader profile"><h2>Reader</h2><p class="cua-profile-hint">The configured provider and execution computer are available for this bot.</p><section class="cua-profile-section"><h3>Profile defaults</h3><div><div class="cua-profile-row"><strong>Permissions</strong><small>Ask before tools run.</small></div></div></section></aside>
          </div>
        </section>
      </div>
    </div>
  </main>
</div>
</body></html>`;

function measureClip() {
  const box = el => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const rail = document.querySelector('#rail');
  const detail = document.querySelector('#detail');
  const chat = document.querySelector('.cua-bot-chat');
  const profile = document.querySelector('.cua-bot-profile');
  const field = document.querySelector('.st-composer');
  const chatStyle = getComputedStyle(chat);
  const pad = parseFloat(chatStyle.paddingRight);
  const fieldBox = box(field);
  const profileBox = box(profile);
  const visibleWidth = Math.max(0, Math.min(fieldBox.right, profileBox.left) - fieldBox.left);
  return {
    container: rail.getBoundingClientRect().width,
    direction: getComputedStyle(detail).flexDirection,
    profilePosition: getComputedStyle(profile).position,
    profileWidth: getComputedStyle(profile).width,
    pad,
    detail: box(detail),
    chat: box(chat),
    profile: profileBox,
    field: fieldBox,
    sliver: Math.max(0, profileBox.left - box(chat).left),
    visibleComposer: visibleWidth,
  };
}

test('a 430px window does not squeeze the composer when the profile is open', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 30_000 }, async t => {
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
  if (shotDir) mkdirSync(shotDir, { recursive: true });

  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
    page.on('pageerror', error => { throw error; });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.locator('.st-composer').waitFor();
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);

    async function place(width, computer = false) {
      await page.setViewportSize({ width, height: 820 });
      await page.evaluate(({ width, computer }) => {
        const app = document.querySelector('.app');
        app.dataset.layout = width <= 767 ? 'mobile' : 'compact';
        app.dataset.rail = 'true';
        const detail = document.querySelector('#detail');
        const pane = document.querySelector('.cua-bot-computer');
        if (computer) { detail.setAttribute('data-computer', 'true'); pane.hidden = false; }
        else { detail.removeAttribute('data-computer'); pane.hidden = true; }
      }, { width, computer });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return page.evaluate(measureClip);
    }

    const narrow = await place(430);
    assert.ok(narrow.container < 480, `${theme} 430 column ${narrow.container}`);
    assert.ok(narrow.pad < 8, `${theme} 430 padding ${narrow.pad}`);
    assert.ok(narrow.profile.left <= narrow.chat.left + 4 && narrow.profile.right >= narrow.chat.right - 4, `${theme} 430 profile does not cover the chat ${JSON.stringify(narrow.profile)} chat ${JSON.stringify(narrow.chat)}`);
    assert.ok(narrow.sliver < 12, `${theme} 430 sliver ${narrow.sliver}`);
    assert.ok(narrow.field.width > 200, `${theme} 430 composer layout ${narrow.field.width}`);
    if (shotDir) await page.screenshot({ path: join(shotDir, `bots-430-${theme}-profile.png`) });

    const coveredComputer = await place(430, true);
    assert.ok(coveredComputer.pad < 8, `${theme} 430 computer padding ${coveredComputer.pad}`);
    assert.ok(coveredComputer.profile.right >= coveredComputer.detail.right - 4 && coveredComputer.profile.left <= coveredComputer.detail.left + 4, `${theme} 430 computer profile leaves a sliver`);
    assert.ok(coveredComputer.field.width > 200, `${theme} 430 computer composer ${coveredComputer.field.width}`);

    const mid = await place(900);
    assert.ok(mid.container > 480 && mid.container <= 800, `${theme} 900 column ${mid.container}`);
    assert.ok(mid.pad > 280, `${theme} 900 padding ${mid.pad}`);
    assert.ok(mid.profile.width > 280 && mid.profile.width < 330, `${theme} 900 profile ${mid.profile.width}`);
    assert.ok(mid.field.width > 300, `${theme} 900 composer ${mid.field.width}`);
    assert.ok(mid.field.right <= mid.profile.left + 4, `${theme} 900 composer runs under the profile`);
    if (shotDir) await page.screenshot({ path: join(shotDir, `bots-900-${theme}-profile.png`) });

    const wide = await place(1180);
    assert.ok(wide.container > 800, `${theme} 1180 column ${wide.container}`);
    assert.equal(wide.profilePosition, 'static');
    assert.ok(wide.pad < 8, `${theme} 1180 padding ${wide.pad}`);
    assert.ok(wide.profile.width > 280 && wide.profile.width < 330, `${theme} 1180 profile ${wide.profile.width}`);
    assert.ok(wide.field.width > 400, `${theme} 1180 composer ${wide.field.width}`);
    assert.ok(wide.field.right <= wide.profile.left + 4, `${theme} 1180 composer runs under the profile`);
    if (shotDir) await page.screenshot({ path: join(shotDir, `bots-1180-${theme}-profile.png`) });
    await page.close();
  }
});
