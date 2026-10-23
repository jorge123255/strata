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

test('a step-limit pause is a card, for any step count', async () => {
  const code = await transform(await readFile(new URL('../src/lib/step-pause.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
  const pause = await import(`data:text/javascript;base64,${Buffer.from(code.code).toString('base64')}`);
  assert.equal(pause.isStepPause('The bot reached its 32-step limit. Continue in this chat to proceed.'), true);
  assert.equal(pause.isStepPause('The bot reached its 64-step limit. Continue in this chat to proceed.'), true);
  assert.equal(pause.isStepPause('This bot reached its step limit before finishing.'), true);
  assert.equal(pause.isStepPause('This stopped because it ran out of steps before it finished.'), true);
  assert.equal(pause.isStepPause('The model could not be reached.'), false);
  assert.equal(pause.stepPauseSummary({ content: 'Tightened the notes.', tools: [{ state: 'done' }, { state: 'done' }, { state: 'running' }] }), 'Worked on 2 steps. Tightened the notes.');
  assert.equal(pause.stepPauseSummary({ content: 'The bot reached its 32-step limit. Continue in this chat to proceed. Try sending the message again.', tools: [{ state: 'done' }] }), 'Worked on 1 step.');
  assert.equal(pause.stepPauseSummary({ content: '', tools: [] }), 'The run paused before it finished.');
  assert.equal(pause.isPauseNotice('Try sending the message again.'), true);
  const card = await readFile(new URL('../src/components/StepPauseCard.tsx', import.meta.url), 'utf8');
  const chat = await readFile(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8');
  const phone = await readFile(new URL('../../ios/StrataMobile/Views/ChatView.swift', import.meta.url), 'utf8');
  const model = await readFile(new URL('../../ios/StrataMobile/Models/CompanionModels.swift', import.meta.url), 'utf8');
  for (const source of [card, phone]) {
    assert.match(source, /Paused after a long run/);
    assert.match(source, /Keep going/);
    assert.match(source, /Stop here/);
    assert.doesNotMatch(source, /try sending again/i);
    assert.doesNotMatch(source, /Try again/);
  }
  assert.match(chat, /StepPauseCard/);
  assert.match(chat, /continueConversation\(\)/);
  assert.match(chat, /m\.error && !stepPause/);
  assert.doesNotMatch(chat, /try sending again/i);
  assert.match(phone, /Continue from where you left off/);
  assert.match(model, /isStepPause/);
  assert.match(model, /stepPauseSummary/);
});

const executablePath = [process.env.STRATA_UI_BROWSER, '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));

test('the pause card is a quiet inline choice', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 60000 }, async t => {
  const src = join(root, 'src');
  const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { StepPauseCard } from ${JSON.stringify(join(src, 'components/StepPauseCard.tsx'))};
import ${JSON.stringify(join(src, 'styles/bots-design.css'))};
function App(){return <div className="bots-workspace" style={{height:'100vh',padding:'48px 56px'}}><div className="st-msg st-msg--assistant"><div className="st-bubble"><p>I tightened the notes and left the checklist in the thread.</p></div><StepPauseCard summary="Worked on 3 steps. I tightened the notes and left the checklist in the thread." onContinue={()=>{}} onStop={()=>{}}/></div></div>}
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
  await page.getByRole('button', { name: 'Keep going' }).waitFor();
  await page.getByRole('button', { name: 'Stop here' }).waitFor();
  assert.equal(await page.getByText(/try sending again/i).count(), 0);
  const shot = '/opt/cursor/artifacts/screenshots/bots-step-pause.png';
  mkdirSync('/opt/cursor/artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: shot });
});
