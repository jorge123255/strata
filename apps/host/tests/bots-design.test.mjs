import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, transform } from 'esbuild';
import { chromium } from 'playwright-core';

const root = new URL('..', import.meta.url);
const src = join(filePath(root), 'src');
const shots = '/opt/cursor/artifacts/screenshots';

function filePath(url) {
  return decodeURIComponent(url.pathname);
}

test('the open spring moves toward its target and can pass it', async () => {
  const code = await transform(await readFile(new URL('../src/lib/coucou-spring.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
  const spring = await import(`data:text/javascript;base64,${Buffer.from(code.code).toString('base64')}`);
  const motion = new spring.Spring(0);
  motion.target = 1;
  let peak = 0;
  for (let i = 0; i < 90; i++) {
    motion.step(1 / 60);
    peak = Math.max(peak, motion.value);
  }
  assert.ok(peak > 1, 'damping 0.72 overshoots');
  assert.ok(motion.settled);
  assert.ok(Math.abs(motion.value - 1) < 0.01);
  const tracked = new spring.Tracked(1);
  tracked.curveTowards(0, 340, 0);
  tracked.step(0.34, 340);
  assert.equal(tracked.animating, false);
  assert.ok(Math.abs(tracked.value) < 0.001);
  const ease = spring.springEase();
  assert.match(ease.linear, /^linear\(/);
  assert.ok(ease.ms >= 400 && ease.ms <= 1200);
});

test('the bots screen keeps one sidebar, a shut details pane, and one step line', async () => {
  const bots = await readFile(new URL('../src/screens/Bots.tsx', import.meta.url), 'utf8');
  const chat = await readFile(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/styles/bots-design.css', import.meta.url), 'utf8');
  const steps = await readFile(new URL('../src/components/WorkedSteps.tsx', import.meta.url), 'utf8');
  assert.match(bots, /useState\(false\)/);
  assert.match(bots, /cua-roster-places/);
  assert.doesNotMatch(bots, /bots-destinations/);
  assert.match(bots, /data-coucou-spring/);
  assert.match(chat, /WorkedSteps/);
  assert.match(steps, /Worked on \$\{count\} \$\{count === 1 \? 'step' : 'steps'\}/);
  assert.match(css, /--st-accent:\s*#8ea2ff/);
  assert.match(css, /@container bots \(max-width: 920px\)/);
});

const executablePath = [process.env.STRATA_UI_BROWSER, '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));

test('the redesigned bots screen holds a readable sidebar at 1280 and 900', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 120000 }, async t => {
  const faces = [
    { id: 'ada', name: 'Ada', config: { color: 'cloud', shape: 'orb', eyes: 'round', ears: 'small' } },
    { id: 'bolt', name: 'Bolt', config: { color: 'sky', shape: 'orb', eyes: 'round', ears: 'small' } },
    { id: 'cleo', name: 'Cleo', config: { color: 'violet', shape: 'orb', eyes: 'round', ears: 'small' } },
    { id: 'dot', name: 'Dot', config: { color: 'mint', shape: 'orb', eyes: 'round', ears: 'small' } },
  ];
  const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CuaBotAvatar } from ${JSON.stringify(join(src, 'components/CuaBotAvatar.tsx'))};
import { ConversationRosterCopy, ConversationRosterFace } from ${JSON.stringify(join(src, 'screens/ConversationRoster.tsx'))};
import { ReplyGroupStack } from ${JSON.stringify(join(src, 'components/ReplyGroupStack.tsx'))};
import { RoomChoiceCard } from ${JSON.stringify(join(src, 'components/RoomChoiceCard.tsx'))};
import { WorkedSteps } from ${JSON.stringify(join(src, 'components/WorkedSteps.tsx'))};
import { Icon } from ${JSON.stringify(join(src, 'components/ui.tsx'))};
import ${JSON.stringify(join(src, 'screens/Bots.css'))};
import ${JSON.stringify(join(src, 'screens/BotTeamChannel.css'))};
import ${JSON.stringify(join(src, 'styles/chat-motion.css'))};
import ${JSON.stringify(join(src, 'styles/bots-design.css'))};
const faces = ${JSON.stringify(faces)};
const bots = faces.map(face => ({ id: face.id, name: face.name, avatarConfig: face.config }));
const rows = [
  { id: 'ada', name: 'Ada', status: 'idle', time: 'just now', preview: 'Ready when you are' },
  { id: 'bolt', name: 'Bolt', status: 'working', time: '52m ago', preview: 'Drafting the release notes', shimmer: true },
  { id: 'long', name: 'Qwen3.8 Flash Next Companion', status: 'attention', time: 'just now', preview: 'Needs a look at the last reply' },
  { id: 'team', name: 'Studio QA', status: 'idle', time: '12m ago', preview: 'Live group test', team: true },
];
function message(id, botId, name, content) {
  return { id, sequence: 1, teamId: 'team_1', kind: 'message', author: { type: 'bot', botId, name }, content, createdAt: '2026-10-23T17:00:00.000Z', replyGroupId: 'user_1' };
}
function Roster() {
  return <aside className="cua-bots-sidebar" aria-label="Bots navigation">
    <nav id="conversation-roster">
      <button className="cua-sidebar-item cua-sidebar-new" aria-label="New bot"><Icon name="plus" size={16}/><span>New bot</span></button>
      <div className="cua-roster-search"><input aria-label="Search bots" placeholder="Search conversations…" readOnly value=""/></div>
      <h2>Conversations <span>4</span></h2>
      <div className="cua-bot-list">{rows.map(row => <button className={"cua-sidebar-item cua-roster-bot" + (row.team ? " cua-roster-team" : "")} key={row.id} title={row.name} data-selected={row.id === 'ada' || undefined}>
        <ConversationRosterFace status={row.status}>{row.team ? <span className="bot-team-mark" aria-hidden="true">{faces.slice(0, 3).map(face => <CuaBotAvatar key={face.id} name={face.name} config={face.config} size={16} animated={false}/>)}</span> : <CuaBotAvatar name={row.name} size={32} animated={false} mood={row.status === 'working' ? 'working' : row.status === 'attention' ? 'error' : 'idle'}/>}</ConversationRosterFace>
        <ConversationRosterCopy name={row.name} timeLabel={row.time} preview={row.preview} shimmer={row.shimmer}/>
      </button>)}</div>
    </nav>
    <nav className="cua-roster-places" aria-label="Bots workspace">
      <button className="cua-sidebar-item"><Icon name="activity" size={16}/><span>Activity</span></button>
      <button className="cua-sidebar-item"><Icon name="skills" size={16}/><span>Skills</span></button>
      <button className="cua-sidebar-item"><Icon name="tool" size={16}/><span>Tools</span></button>
      <button className="cua-sidebar-item"><Icon name="link" size={16}/><span>Connectors</span></button>
    </nav>
  </aside>;
}
function Shell({ width, children }) {
  return <div className="bots-workspace" style={{ height: '100vh' }}>
    <div className="cua-bots-shell" data-list style={{ '--cua-roster-width': width + 'px' }}>
      <Roster/>
      <section className="cua-bots-main">{children}</section>
    </div>
  </div>;
}
function Main() {
  return <Shell width={280}>
    <header className="cua-bot-toolbar"><div className="cua-conversation-control"/><span className="spacer"/><div className="cua-toolbar-controls" role="group" aria-label="Bot controls"><button className="st-btn st-btn--icon" aria-label="Show profile"><Icon name="panel" size={16}/></button></div></header>
    <div className="cua-bot-chat" style={{ overflow: 'auto', padding: '28px 36px' }}>
      <div className="st-msg st-msg--user"><div className="st-bubble">Can you tidy the release notes?</div></div>
      <div className="st-msg st-msg--assistant">
        <WorkedSteps tools={[{ id: 'a', name: 'read', verb: 'Read file', target: 'notes.md' }, { id: 'b', name: 'search', verb: 'Search', target: 'release checklist' }, { id: 'c', name: 'edit', verb: 'Edit', target: 'Bots.css' }]}/>
        <div className="st-bubble"><p>I tightened the notes and left the checklist in the thread.</p></div>
      </div>
    </div>
  </Shell>;
}
function Room() {
  const messages = [message('m1', 'ada', 'Ada', 'The notes read cleanly now.'), message('m2', 'bolt', 'Bolt', 'I checked the checklist against the last tag.')];
  return <Shell width={280}>
    <div className="bot-room" style={{ height: '100%' }}>
      <header className="bots-page-heading bot-group-header"><div className="bot-group-identity"><div><h2>Studio QA</h2><p>4 teammates</p></div></div></header>
      <div className="bot-room-feed">
        <article className="bot-room-message" data-author="user"><div className="bot-room-message-main"><header><strong>You</strong></header><div className="bot-room-message-bubble"><div className="bot-room-message-body"><p>@everyone how does the release look?</p></div></div></div></article>
        <ReplyGroupStack messages={messages} triggerId="user_1" roster={['ada','bolt','cleo','dot']} live={false} records={[{ kind: 'pass', botId: 'cleo', replyGroupId: 'user_1', passed: true, at: '2026-10-23T17:01:00.000Z' }]} bots={bots} entranceFor={() => undefined} disabled={false} onReply={() => {}}/>
        <RoomChoiceCard text="The checklist step failed. What should I do next?" options={[{ id: 'retry', label: 'Try again' }, { id: 'skip', label: 'Skip this' }, { id: 'different', label: 'Try a different way' }]} onChoose={() => {}}/>
      </div>
    </div>
  </Shell>;
}
function Narrow() { return <Shell width={240}><div className="cua-bot-chat" style={{ padding: 28 }}><p>Ada</p></div></Shell>; }
const scene = new URLSearchParams(location.search).get('scene');
createRoot(document.getElementById('root')).render(scene === 'room' ? <Room/> : scene === 'sidebar' ? <Narrow/> : <Main/>);
`;
  const { outputFiles } = await build({
    stdin: { contents: entry, resolveDir: src, loader: 'tsx' },
    bundle: true,
    write: false,
    outfile: 'harness.js',
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' },
  });
  const js = outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(path => readFileSync(join(src, path), 'utf8')).join('\n')
    + '\n' + (outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '');
  const sprite = readFileSync(join(filePath(root), 'public/icons/sprite.svg'));
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html data-theme="dark" data-motion="reduced"><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body,#root{margin:0;height:100%;background:#101114}</style></head><body><div id="root"></div><script src="/harness.js"></script></body></html>');
      return;
    }
    if (path === '/harness.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(js); return; }
    if (path === '/harness.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(css); return; }
    if (path === '/icons/sprite.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end(sprite); return; }
    res.writeHead(204); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.on('pageerror', error => { throw error; });
  mkdirSync(shots, { recursive: true });
  const port = server.address().port;
  for (const viewport of [{ w: 1280, h: 800 }, { w: 900, h: 700 }]) {
    await page.setViewportSize({ width: viewport.w, height: viewport.h });
    for (const scene of ['main', 'room', 'sidebar']) {
      await page.goto(`http://127.0.0.1:${port}/?scene=${scene}`, { waitUntil: 'networkidle' });
      await page.locator('.cua-sidebar-item[title="Ada"]').waitFor();
      const measured = await page.evaluate(() => {
        const sidebar = document.querySelector('.cua-bots-sidebar').getBoundingClientRect();
        const name = document.querySelector('.cua-roster-title strong');
        return { width: sidebar.width, name: name.textContent, lines: name.getClientRects().length };
      });
      assert.ok(measured.width >= 240, `${scene} ${viewport.w} sidebar is ${measured.width}`);
      assert.equal(measured.name, 'Ada');
      assert.equal(measured.lines, 1);
      if (scene === 'main') {
        assert.equal(await page.getByRole('button', { name: 'Worked on 3 steps' }).count(), 1);
        assert.equal(await page.getByText('Conversation', { exact: true }).count(), 0);
        assert.equal(await page.locator('.cua-bot-profile').count(), 0);
      }
      if (scene === 'room') {
        await page.getByText('2 of 4 bots replied').waitFor();
        await page.locator('[data-reply-state="passed"]').waitFor();
        await page.getByRole('button', { name: 'Try again' }).waitFor();
      }
      await page.screenshot({ path: join(shots, `bots-${scene}-after-${viewport.w}x${viewport.h}.png`) });
    }
  }
});
