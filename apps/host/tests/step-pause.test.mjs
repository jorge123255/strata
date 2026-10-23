import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, transform } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
function fileURLToPath(url) { return decodeURIComponent(url.pathname); }

test('a paused run uses the shared recovery card and posts continue', async () => {
  const code = await transform(await readFile(new URL('../src/lib/step-pause.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
  const pause = await import(`data:text/javascript;base64,${Buffer.from(code.code).toString('base64')}`);
  assert.equal(pause.isStepPause('The bot reached its 32-step limit. Continue in this chat to proceed.'), true);
  assert.equal(pause.isStepPause('The bot reached its 64-step limit. Continue in this chat to proceed.'), true);
  assert.equal(pause.isStepPause('This bot reached its step limit before finishing.'), true);
  assert.equal(pause.isStepPause('The model could not be reached.'), false);
  assert.equal(pause.isPauseNotice('Try sending the message again.'), true);
  const [chat, store, card, design, channel, phone, model, workspace, choices, companion] = await Promise.all([
    readFile(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/store.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/RoomChoiceCard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/bots-design.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/BotTeamChannel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../ios/StrataMobile/Views/ChatView.swift', import.meta.url), 'utf8'),
    readFile(new URL('../../ios/StrataMobile/Models/CompanionModels.swift', import.meta.url), 'utf8'),
    readFile(new URL('../../ios/StrataMobile/Services/BotWorkspaceStore.swift', import.meta.url), 'utf8'),
    readFile(new URL('../../ios/StrataMobile/Views/Components.swift', import.meta.url), 'utf8'),
    readFile(new URL('../../ios/StrataMobile/Services/CompanionStore.swift', import.meta.url), 'utf8'),
  ]);
  assert.match(chat, /ChatPauseChoice/);
  assert.match(chat, /continuePausedChat/);
  assert.match(chat, /kind="paused"/);
  assert.match(chat, /text=\{recovery\.text\}/);
  assert.match(chat, /data-error=\{m\.error && !paused/);
  assert.match(chat, /<ErrorNotice message=\{m\.error\} detail=\{m\.errorDetail\} \{\.\.\.contextRecovery\(m\.errorCode\)\}\/>/);
  assert.match(chat, /m\.error && !legacyLimit && !paused/);
  assert.doesNotMatch(chat, /StepPauseCard|continueConversation\(\)|Paused after a long run|Stop here|try sending again|\/api\/companion\/conversations/i);
  assert.match(store, /type === 'pause'/);
  assert.match(store, /TODO: POST \{ choice: 'continue' \}/);
  assert.doesNotMatch(store, /\/api\/companion\/conversations\/\$\{encodeURIComponent\(sessionId\)\}\/messages/);
  assert.match(channel, /\/messages\/\$\{encodeURIComponent\(card\.messageId\)\}\/choice/);
  assert.match(channel, /kind=\{card\.kind\}/);
  assert.match(channel, /!paused && message\.state/);
  assert.doesNotMatch(card, /Keep going|try sending again/i);
  assert.match(card, /aria-label=\{paused \? 'Paused'/);
  assert.match(design, /button\[data-style='primary'\]/);
  assert.match(design, /\[data-kind='paused'\]/);
  assert.match(phone, /RoomChoiceCard/);
  assert.match(phone, /paused: true/);
  assert.match(phone, /continuePausedMessage/);
  assert.doesNotMatch(phone, /Paused after a long run|Stop here|Continue from where you left off|try sending again/i);
  assert.match(model, /pauseChoice/);
  assert.match(model, /isStepPause/);
  assert.doesNotMatch(model, /stepPauseSummary/);
  assert.match(workspace, /\["retry", "skip", "different", "continue"\]/);
  assert.match(workspace, /messages\/\\\(messageId\)\/choice/);
  assert.match(choices, /"retry", "skip", "different", "continue"/);
  assert.match(choices, /id == "continue" \? "primary"/);
  assert.match(choices, /paused \? StrataTheme.secondaryInk/);
  assert.match(companion, /TODO: POST \{"choice":"continue"\}/);
  assert.doesNotMatch(companion, /\/messages\/" \+ messageId \+ "\/choice/);
});

const executablePath = [process.env.STRATA_UI_BROWSER, '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));

test('the pause card shows the host summary and a primary Keep going button', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 60000 }, async t => {
  const src = join(root, 'src');
  const summary = 'I finished inspect. The rest of this request is still left.';
  const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RoomChoiceCard } from ${JSON.stringify(join(src, 'components/RoomChoiceCard.tsx'))};
import ${JSON.stringify(join(src, 'screens/BotTeamChannel.css'))};
import ${JSON.stringify(join(src, 'styles/bots-design.css'))};
function App(){return <div className="bots-workspace" style={{height:'100vh',padding:'48px 56px'}}><div className="st-msg st-msg--assistant" data-pause="true"><RoomChoiceCard kind="paused" text=${JSON.stringify(summary)} options={[{id:'continue', label:'Keep going', style:'primary'}]} onChoose={()=>{}}/></div></div>}
createRoot(document.getElementById('root')).render(<App/>);`;
  const { outputFiles } = await build({ stdin: { contents: entry, resolveDir: src, loader: 'tsx' }, bundle: true, write: false, outfile: 'harness.js', format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' } });
  const js = outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(path => readFileSync(join(src, path), 'utf8')).join('\n') + '\n' + (outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '');
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html data-theme="dark" data-motion="reduced"><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body,#root{margin:0;height:100%;background:#101114}</style></head><body><div id="root"></div><script src="/harness.js"></script></body></html>'); return; }
    if (path === '/harness.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(js); return; }
    if (path === '/harness.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(css); return; }
    res.writeHead(204); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 420 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('group', { name: 'Paused' }).waitFor();
  await page.getByText(summary).waitFor();
  const button = page.getByRole('button', { name: 'Keep going' });
  await button.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stop here' }).count(), 0);
  assert.equal(await page.getByText(/try sending again/i).count(), 0);
  assert.equal(await page.getByText(/Paused after a long run/).count(), 0);
  const style = await button.evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(style, 'rgba(0, 0, 0, 0)');
  const shot = '/opt/cursor/artifacts/screenshots/bots-step-pause.png';
  mkdirSync('/opt/cursor/artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: shot });
});
