import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build, transform } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const shots = '/opt/cursor/artifacts/screenshots';

const widthCode = await transform(await readFile(new URL('../src/lib/conversation-roster-width.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const widths = await import(`data:text/javascript;base64,${Buffer.from(widthCode.code).toString('base64')}`);

test('the conversations list stays between 240 and 420 pixels', () => {
  assert.equal(widths.clampConversationRosterWidth(190), 240);
  assert.equal(widths.clampConversationRosterWidth(240), 240);
  assert.equal(widths.clampConversationRosterWidth(320), 320);
  assert.equal(widths.clampConversationRosterWidth(900), 420);
  assert.equal(widths.clampConversationRosterWidth(Number.NaN), 280);
  assert.equal(widths.readConversationRosterWidth({ getItem: () => '190' }), 240);
  assert.equal(widths.readConversationRosterWidth({ getItem: () => null }), 280);
});

test('roster rows keep the name on one line and the status dot at 8 pixels', async () => {
  const css = await readFile(new URL('../src/screens/Bots.css', import.meta.url), 'utf8');
  const motion = await readFile(new URL('../src/styles/chat-motion.css', import.meta.url), 'utf8');
  const bots = await readFile(new URL('../src/screens/Bots.tsx', import.meta.url), 'utf8');
  assert.match(css, /\.cua-bots-shell\[data-list\] > \.cua-bots-sidebar \{ min-width: 240px; \}/);
  assert.match(css, /\.cua-roster-face \.status-dot \{[^}]*width: 8px;[^}]*height: 8px/);
  assert.match(css, /role="separator"|cua-roster-resize/);
  assert.match(motion, /grid-template-columns: var\(--cua-roster-width, 280px\)/);
  assert.doesNotMatch(motion, /168px/);
  assert.match(bots, /ConversationRosterResize/);
  assert.match(bots, /<TeamMark team=\{team\} bots=\{bots\} size=\{16\}\/>/);
});

const executablePath = [process.env.STRATA_UI_BROWSER, '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => path && existsSync(path));

test('conversation rows stay readable at 190, 240 and 320 pixels', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 90000 }, async t => {
  const faces = [
    { id: 'a', name: 'Ada', config: { color: 'cloud', shape: 'orb', eyes: 'round', ears: 'small' } },
    { id: 'b', name: 'Bolt', config: { color: 'sky', shape: 'orb', eyes: 'round', ears: 'small' } },
    { id: 'c', name: 'Iris', config: { color: 'violet', shape: 'orb', eyes: 'round', ears: 'small' } },
  ];
  const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{CuaBotAvatar}from${JSON.stringify(join(src, 'components/CuaBotAvatar.tsx'))};import{ConversationRosterCopy,ConversationRosterFace,ConversationRosterResize}from${JSON.stringify(join(src, 'screens/ConversationRoster.tsx'))};import${JSON.stringify(join(src, 'screens/Bots.css'))};import${JSON.stringify(join(src, 'styles/chat-motion.css'))};
const faces=${JSON.stringify(faces)};
const rows=[{id:'qwen',name:'Qwen',status:'idle',time:'just now',preview:'Ready when you are'},{id:'pro',name:'Pro',status:'working',time:'52m ago',preview:'Drafting the release notes',shimmer:true},{id:'long',name:'Qwen3.8 Flash Next Companion',status:'attention',time:'just now',preview:'Needs a look at the last reply'},{id:'team',name:'Studio QA',status:'attention',time:'52m ago',preview:'Live group test',team:true}];
function App(){const [width,setWidth]=useState(280);window.setRosterWidth=setWidth;return <div className="cua-bots-shell" data-list style={{'--cua-roster-width':width+'px',width:(width+520)+'px',height:'640px'}}><aside className="cua-bots-sidebar" aria-label="Bots navigation" style={{width,minWidth:width,maxWidth:width}}><h2>Conversations <span>{rows.length}</span></h2><div className="cua-bot-list">{rows.map(row=><button className={"cua-sidebar-item cua-roster-bot"+(row.team?' cua-roster-team':'')} key={row.id} title={row.name}><ConversationRosterFace status={row.status}>{row.team?<span className="bot-team-mark" aria-hidden="true">{faces.map(face=><CuaBotAvatar key={face.id} name={face.name} config={face.config} size={16} animated={false}/>)}</span>:<CuaBotAvatar name={row.name} size={32} animated={false} mood={row.status==='working'?'working':row.status==='attention'?'error':'idle'}/>}</ConversationRosterFace><ConversationRosterCopy name={row.name} timeLabel={row.time} preview={row.preview} shimmer={row.shimmer}/></button>)}</div></aside><ConversationRosterResize width={width} onChange={setWidth}/></div>}
createRoot(document.getElementById('root')).render(<App/>);`;
  const { outputFiles } = await build({ stdin: { contents: entry, resolveDir: src, loader: 'tsx' }, bundle: true, write: false, outfile: 'harness.js', format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' } });
  const js = outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(path => readFileSync(join(src, path), 'utf8')).join('\n') + '\n' + (outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '');
  const reply = (res, body, status, type) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') return reply(res, '<!doctype html><html data-theme="dark" data-motion="reduced"><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script src="/harness.js"></script>', 200, 'text/html');
    if (path === '/harness.js') return reply(res, js, 200, 'text/javascript');
    if (path === '/harness.css') return reply(res, css, 200, 'text/css');
    res.writeHead(204); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: 'Studio QA' }).waitFor();
  mkdirSync(shots, { recursive: true });
  for (const width of [190, 240, 320]) {
    await page.evaluate(value => window.setRosterWidth(value), width);
    await page.waitForFunction(value => document.querySelector('.cua-bots-sidebar').getBoundingClientRect().width === value, width);
    const measured = await page.evaluate(() => {
      const sidebar = document.querySelector('.cua-bots-sidebar').getBoundingClientRect();
      const names = [...document.querySelectorAll('.cua-roster-title strong')].map(element => {
        const style = getComputedStyle(element);
        const line = parseFloat(style.lineHeight);
        const box = element.getBoundingClientRect();
        return { name: element.textContent, title: element.getAttribute('title'), lines: Math.round(box.height / line), wrap: style.overflowWrap, whiteSpace: style.whiteSpace, width: Math.round(box.width) };
      });
      const dots = [...document.querySelectorAll('.cua-roster-face .status-dot')].map(element => {
        const box = element.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height), status: element.getAttribute('data-status') };
      });
      return { sidebar: Math.round(sidebar.width), names, dots };
    });
    assert.equal(measured.sidebar, width, `sidebar ${width}`);
    assert.equal(measured.dots.length, 4);
    for (const dot of measured.dots) {
      assert.equal(dot.width, 8, `dot width at ${width}`);
      assert.equal(dot.height, 8, `dot height at ${width}`);
    }
    assert.ok(measured.dots.some(dot => dot.status === 'idle' || dot.status === 'working'));
    assert.ok(measured.dots.some(dot => dot.status === 'attention'));
    for (const name of measured.names) {
      assert.equal(name.title, name.name);
      assert.equal(name.wrap, 'normal');
      assert.ok(name.lines <= 2, `${name.name} used ${name.lines} lines at ${width}`);
      if (width < 280) assert.equal(name.lines, 1, `${name.name} wrapped at ${width}`);
      assert.ok(name.width >= 24, `${name.name} collapsed to ${name.width}px at ${width}`);
    }
    const team = measured.names.find(name => name.name === 'Studio QA');
    assert.equal(team.lines, 1);
    await page.locator('.cua-bots-sidebar').screenshot({ path: join(shots, `conversation-roster-${width}.png`) });
  }
  await page.getByRole('separator', { name: 'Resize conversations' }).focus();
  await page.keyboard.press('ArrowLeft');
  const narrowed = await page.evaluate(() => Math.round(document.querySelector('.cua-bots-sidebar').getBoundingClientRect().width));
  assert.equal(narrowed, 304);
  await page.keyboard.press('Home');
  const floored = await page.evaluate(() => Math.round(document.querySelector('.cua-bots-sidebar').getBoundingClientRect().width));
  assert.equal(floored, 240);
  assert.deepEqual(errors, []);
});
