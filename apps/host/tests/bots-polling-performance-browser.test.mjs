/** Actual production Bots UI; render counters and disposable GET/message transport only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
const host = fileURLToPath(new URL('..', import.meta.url)), source = join(host, 'src');
const browserPath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(existsSync);
test('unchanged Bots polls and draft edits skip saved report parsing; route work loading and fresh channel actions remain correct', { skip: browserPath ? false : 'Installed Chromium required.', timeout: 60000 }, async t => {
  const at = '2026-10-21T12:00:00Z', calls = [], errors = [], unexpected = [], blocked = [];
  const bots = Array.from({ length: 18 }, (_, i) => ({ id: 'bot_' + i, name: i ? 'Teammate ' + i : 'Coordinator', provider: 'codex', model: 'fixture', policy: 'manual', capabilities: 'both', instructions: '', workspace: '/fixture', execution: { kind: 'local' }, computerMode: 'host', avatarConfig: { color: 'sky', eyes: 'round', ears: 'round' }, createdAt: at, updatedAt: at }));
  const team = { id: 'team_fixture', name: 'Performance fixture', memberIds: bots.map(b => b.id), coordinatorId: bots[0].id, enabled: true, limits: { maxParallel: 0, maxDepth: 0, maxHops: 0, maxTurns: 0, maxDurationMs: 0 }, createdAt: at, updatedAt: at };
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: 'msg_' + (i + 1), sequence: i + 1, teamId: team.id, kind: 'report', author: { type: 'bot', name: bots[i % 18].name, botId: bots[i % 18].id }, content: `Saved report ${i + 1}\n${'### Existing checks\n- Preserve scope and saved permissions.\n- Keep the existing files.\n'.repeat(25)}`, createdAt: at, state: 'done' }));
  let failChannel = false;
  const entry = `import React from'react';import{createRoot}from'react-dom/client';import{BotsScreen}from${JSON.stringify(join(source, 'screens/Bots.tsx'))};import{setTranslationLanguage}from${JSON.stringify(join(source, 'lib/i18n.ts'))};window.fixtureState={sessions:[],workspaces:[{id:'fixture',path:'/fixture'}],activeWorkspace:'fixture',workspacePath:'/fixture'};window.setFixtureLanguage=setTranslationLanguage;window.renders={markdown:0,channel:0};createRoot(document.getElementById('root')).render(<main className="main" style={{height:'100dvh'}}><BotsScreen/></main>);`;
  const result = await build({ stdin: { contents: entry, resolveDir: source, loader: 'tsx' }, bundle: true, write: false, outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [{ name: 'inert-store-and-render-counts', setup(b) {
    b.onResolve({ filter: /^\.\/Chat$/ }, a => a.importer.endsWith('/screens/Bots.tsx') ? { path: 'chat', namespace: 'fixture' } : undefined);
    b.onResolve({ filter: /(?:^|\/)store$/ }, a => a.importer.includes('/src/') ? { path: 'store', namespace: 'fixture' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: a.path === 'chat' ? `export function ChatScreen(){return null}` : `export const useStore=s=>s(window.fixtureState);export const adoptSharedConversation=()=>{},adoptSharedConversations=()=>{},selectSession=()=>{},answerChatTool=()=>{},pickWorkspace=async()=>'/fixture',dismissActionError=()=>{},dismissToast=()=>{},holdToast=()=>{},releaseToast=()=>{};`, loader: 'js', resolveDir: source }));
    b.onLoad({ filter: /\/(?:Markdown|BotTeamChannel)\.tsx$/ }, a => {
      let text = readFileSync(a.path, 'utf8');
      text = a.path.endsWith('/Markdown.tsx') ? text.replace('    const nodes: ReactNode[] = [];', '    window.renders.markdown++; const nodes: ReactNode[] = [];') : text.replace('  const channel = useTeamChannel(team.id, visible, onUnsupported);', '  window.renders.channel++; const channel = useTeamChannel(team.id, visible, onUnsupported);');
      return { contents: text, loader: 'tsx', resolveDir: join(a.path, '..') };
    });
  } }] });
  const script = result.outputFiles.find(x => x.path.endsWith('.js')).text, css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(p => readFileSync(join(source, p), 'utf8')).join('\n') + '\n' + result.outputFiles.find(x => x.path.endsWith('.css')).text;
  const snapshot = after => ({ teamId: team.id, supported: true, messages: rows.filter(x => x.sequence > after), activeRuns: [], nextSequence: rows.length, hasMore: false, hasMoreBefore: false });
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://fixture'), p = u.pathname;
    const send = (data, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
    if (p === '/') return send('<!doctype html><html data-theme="dark" data-motion="reduced"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>', 'text/html');
    if (p === '/fixture.js') return send(script, 'text/javascript'); if (p === '/fixture.css') return send(css, 'text/css');
    if (p === '/icons/sprite.svg') return send(readFileSync(join(host, 'public', p)), 'image/svg+xml');
    if (p.startsWith('/fonts/') && existsSync(join(host, 'public', p))) return send(readFileSync(join(host, 'public', p)), 'font/woff2');
    if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
    let raw = ''; for await (const part of req) raw += part; const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: p, method: req.method, body });
    if (p === '/api/bots') return send({ bots, providers: [{ id: 'codex', name: 'Codex', available: true }], computers: [], models: [] });
    if (p === '/api/bots/teams') return send({ teams: [team], runs: [], channelsSupported: true, teamWorkReviewSupported: true, teamCoordinatorWorkToolsSupported: true });
    if (p === '/api/bots/activity') return send({ activity: [], teamWorkReviewSupported: true });
    if (p === '/api/companion/conversations') return send({ available: true, conversations: [] });
    if (/^\/api\/bots\/[^/]+\/work$/.test(p)) return send({ memory: '', rules: [], routines: [], outputs: [], files: [] });
    if (p === '/api/bots/teams/team_fixture/channel') return failChannel ? send({ error: 'Synthetic channel temporarily unavailable.' }, 'application/json', 503) : send(snapshot(Number(u.searchParams.get('after') ?? 0)));
    if (p === '/api/bots/teams/team_fixture/messages' && req.method === 'POST') {
      rows.push({ id: 'posted_' + (rows.length + 1), sequence: rows.length + 1, teamId: team.id, kind: 'message', author: { type: 'user', name: 'You' }, content: body.message, createdAt: at, state: 'done', replyToId: body.replyToId, recipientIds: body.recipientIds, workMode: body.workMode });
      return send({ channel: snapshot(0) });
    }
    unexpected.push(req.method + ' ' + p); return send({ error: 'Unexpected request' }, 'application/json', 404);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); }); const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : (blocked.push(r.request().url()), r.abort()));
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const reset = () => page.evaluate(() => { window.renders = { markdown: 0, channel: 0 }; });
  const poll = async () => { const response = page.waitForResponse(r => r.url().includes('/team_fixture/channel')); await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settle(); };
  const works = () => calls.filter(x => x.path.endsWith('/work'));
  await page.goto(origin + '/#/bots/teams?team=team_fixture'); await page.locator('[data-message-id="msg_100"]').waitFor(); await settle(); await reset();
  for (let i = 0; i < 3; i++) await poll();
  const unchanged = await page.evaluate(() => window.renders); assert.equal(unchanged.markdown, 0); assert.equal(unchanged.channel, 0); assert.equal(works().length, 0, 'A team channel reads no bot private work bundles.');
  const input = page.getByRole('textbox', { name: 'Message team', exact: true });
  for (let i = 0; i < 8; i++) await input.fill('Draft ' + i);
  assert.equal(await page.evaluate(() => window.renders.markdown), 0, 'Draft typing cannot reparse existing report bodies.');
  // Memoized bodies must invalidate when language changes, not strand control labels.
  await page.evaluate(() => window.setFixtureLanguage('es')); await input.fill('Language changed'); await settle(); assert.equal(await page.evaluate(() => window.renders.markdown), 100); await page.evaluate(() => window.setFixtureLanguage('en')); await input.fill('English restored');
  failChannel = true; await poll(); await page.getByText('Synthetic channel temporarily unavailable.', { exact: true }).waitFor(); assert.equal(await page.locator('[data-message-id="msg_100"]').count(), 1); assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), false);
  failChannel = false; await poll(); assert.equal(await page.getByText('Synthetic channel temporarily unavailable.', { exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true);
  rows.push({ id: 'msg_101', sequence: 101, teamId: team.id, kind: 'message', author: { type: 'bot', name: bots[1].name, botId: bots[1].id }, content: 'New progress remains visible.', createdAt: at, state: 'done' }); await poll(); await page.getByText('New progress remains visible.', { exact: true }).waitFor();
  await page.locator('[data-message-id="msg_101"]').getByRole('button', { name: /Reply/ }).click(); await input.fill('Perform the selected fixture task'); await page.getByRole('group', { name: 'Team message mode', exact: true }).getByRole('button', { name: 'Work', exact: true }).click(); await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.getByText('Perform the selected fixture task', { exact: true }).waitFor();
  const posts = calls.filter(x => x.method === 'POST'); assert.equal(posts.length, 1); assert.equal(posts[0].body.workMode, 'work'); assert.equal(posts[0].body.replyToId, 'msg_101'); assert.deepEqual(posts[0].body.recipientIds, ['bot_1']);
  let before = works().length; await page.evaluate(() => { location.hash = '#/bots/scheduled'; }); await page.getByRole('heading', { name: 'Scheduled', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.cua-work') && !document.querySelector('.bot-room')); await page.waitForTimeout(150); assert.equal(works().length - before, 18, 'Scheduled work retains every bot.');
  before = works().length; await page.evaluate(() => { location.hash = '#/bots/bot_0'; }); await page.getByRole('complementary', { name: 'Coordinator profile', exact: true }).waitFor(); await page.waitForTimeout(150); assert.deepEqual(works().slice(before).map(x => x.path), ['/api/bots/bot_0/work'], 'A selected profile reads only its own private work.');
  before = works().length; await page.evaluate(() => { location.hash = '#/bots/outputs'; }); await page.getByRole('heading', { name: 'Outputs', exact: true }).waitFor(); await page.waitForTimeout(150); assert.equal(works().length - before, 18, 'Outputs retain every bot.');
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual(unexpected, []);
  const evidence = process.env.STRATA_BOTS_PERF_EVIDENCE_DIR; if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, 'functional-report.json'), JSON.stringify({ passed: true, unchangedRenders: unchanged, savedMessages: 100, errorAndRecovery: true, freshProgressAndExplicitReplyWork: true, languageInvalidation: true, routeWorkScope: true, ownerWrites: 0, liveProviders: 0, calls }, null, 2) + '\n'); }
});
