/** Real BotsScreen navigation; shared ChatScreen/store and HTTP are inert fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url)), source = join(root, 'src');
const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));

test('bot taps open personal chat or one empty default chat, preserving team links and navigation ownership', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 60_000 }, async t => {
  const at = '2026-10-21T12:00:00Z';
  const bots = [
    ['ava', 'Ava', false], ['fresh', 'New partner', false], ['paused', 'Paused partner', true], ['paused-empty', 'Paused newcomer', true],
    ['failure', 'Unavailable partner', false], ['lookup', 'Lookup partner', false], ['creation', 'Creation partner', false], ['phone', 'Phone partner', false], ['malformed', 'Mismatched partner', false],
  ].map(([id, name, paused]) => ({ id, name, paused, provider: 'codex', model: 'saved-model', effort: 'high', policy: 'bypass', capabilities: 'both',
    instructions: '', workspace: '/workspace', execution: { kind: 'local' }, computerMode: 'cua',
    avatarConfig: { color: 'sky', eyes: 'round', ears: 'round' }, createdAt: at, updatedAt: at, available: true }));
  const chat = (id, botId, date, metadata = {}) => ({ id, title: id, createdAt: at, updatedAt: date,
    workspace: '/workspace', preferences: { botId, botComputerMode: 'cua', botComputer: 'Saved computer', botModel: 'Saved model', mode: 'bypass', ...metadata }, messages: [], active: false });
  const conversations = [
    chat('ava-old-personal', 'ava', '2026-10-01T12:00:00Z'), chat('ava-latest-personal', 'ava', '2026-10-10T12:00:00Z'),
    chat('ava-newer-router', 'ava', at, { teamId: 'crew', teamRunId: 'run' }),
    chat('ava-legacy-worker', 'ava', '2026-10-22T12:00:00Z', { parentChatId: 'root' }),
    chat('fresh-team-worker', 'fresh', at, { teamRunId: 'run' }), chat('paused-personal', 'paused', at),
  ];
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{BotsScreen}from${JSON.stringify(join(source, 'screens/Bots.tsx'))};
    window.fixtureState={sessions:[],workspaces:[{id:'fixture',path:'/fixture'}],activeWorkspace:'fixture',workspacePath:'/fixture'};
    createRoot(document.getElementById('root')).render(<main className="main" style={{height:'100dvh'}}><BotsScreen/></main>);`;
  const { outputFiles } = await build({ stdin: { contents: entry, resolveDir: source, loader: 'tsx' }, bundle: true, write: false, outfile: 'harness.js', format: 'iife', platform: 'browser', jsx: 'automatic',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'inert-bot-chat', setup(builder) {
      builder.onResolve({ filter: /^\.\/Chat$/ }, args => args.importer.endsWith('/screens/Bots.tsx') ? { path: 'chat', namespace: 'fixture' } : undefined);
      builder.onResolve({ filter: /(?:^|\/)store$/ }, args => args.importer.includes('/src/') ? { path: 'store', namespace: 'fixture' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => args.path === 'chat' ? { contents: `import React from'react';export function ChatScreen({sessionId}){return <section data-testid="shared-chat" data-session={sessionId}><h2>Shared conversation {sessionId}</h2><textarea aria-label="Message bot" placeholder="Message your bot…"/></section>}`, loader: 'tsx', resolveDir: source } : {
        contents: `import{useSyncExternalStore}from'react';const listeners=new Set();function emit(state){window.fixtureState=state;for(const listener of listeners)listener()}export const useStore=selector=>selector(useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener)},()=>window.fixtureState));export const adoptSharedConversation=conversation=>{const state=window.fixtureState;emit({...state,sessions:state.sessions.some(row=>row.id===conversation.id)?state.sessions.map(row=>row.id===conversation.id?conversation:row):[conversation,...state.sessions]})};export const selectSession=id=>emit({...window.fixtureState,activeSession:id});export const answerChatTool=()=>{},pickWorkspace=async()=>'/fixture',dismissActionError=()=>{},dismissToast=()=>{},holdToast=()=>{},releaseToast=()=>{};`, loader: 'js', resolveDir: source,
      });
    } }] });
  const script = outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(path => readFileSync(join(source, path), 'utf8')).join('\n') + '\n' + outputFiles.find(file => file.path.endsWith('.css')).text;
  const calls = [], unexpected = [], errors = [], blocked = [];
  let holdLookup = false, releaseLookup, holdCreation = false, releaseCreation, malformed = 'wrong-bot';
  const reply = (res, body, status = 200, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') return reply(res, '<!doctype html><html data-theme="dark" data-motion="reduced"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script src="/harness.js"></script>', 200, 'text/html');
    if (path === '/harness.js') return reply(res, script, 200, 'text/javascript');
    if (path === '/harness.css') return reply(res, css, 200, 'text/css');
    if (path === '/icons/sprite.svg') return reply(res, readFileSync(join(root, 'public/icons/sprite.svg')), 200, 'image/svg+xml');
    if (/^\/fonts\/GTWalsheimPro-(Regular|Medium|Bold|Black)\.woff2$/.test(path)) return reply(res, readFileSync(join(root, 'public', path)), 200, 'font/woff2');
    if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined; calls.push({ method: req.method, path, body });
    if (path === '/api/bots') return reply(res, { bots, providers: [{ id: 'codex', name: 'Codex', available: true }], computers: [{ id: 'local', name: 'This Mac', kind: 'local', available: true }], models: [] });
    if (path === '/api/bots/teams') return reply(res, { teams: [], runs: [] });
    if (path === '/api/companion/conversations') {
      if (holdLookup) { holdLookup = false; await new Promise(resolve => { releaseLookup = resolve; }); }
      return reply(res, { available: true, conversations });
    }
    if (/^\/api\/bots\/[^/]+\/work$/.test(path)) return reply(res, { memory: '', rules: [], routines: [], outputs: [], files: [] });
    if (/^\/api\/bots\/[^/]+\/computer$/.test(path) && req.method === 'GET') return reply(res, { available: true, running: false, detail: 'Fixture computer is stopped.' });
    const creation = /^\/api\/bots\/([^/]+)\/conversations$/.exec(path);
    if (creation && req.method === 'POST') {
      if (creation[1] === 'failure') return reply(res, { error: 'The saved bot is temporarily unavailable. Please retry.' }, 409);
      if (creation[1] === 'malformed') {
        const conversation = chat('mismatched-response', 'malformed', at);
        if (malformed === 'wrong-bot') conversation.preferences.botId = 'ava';
        if (malformed === 'team') conversation.preferences.parentChatId = 'legacy-root';
        if (malformed === 'missing-id') delete conversation.id;
        return reply(res, { conversation }, 201);
      }
      if (creation[1] === 'creation' && holdCreation) { holdCreation = false; await new Promise(resolve => { releaseCreation = resolve; }); }
      const conversation = chat(`${creation[1]}-empty-personal`, creation[1], at);
      conversations.push(conversation); return reply(res, { conversation }, 201);
    }
    unexpected.push(req.method + ' ' + path); return reply(res, { error: 'Unexpected fixture operation' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { releaseLookup?.(); releaseCreation?.(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10_000); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push(route.request().url()), route.abort()));
  const nav = page.getByRole('complementary', { name: 'Bots navigation', exact: true }), opened = page.getByTestId('shared-chat');
  const tap = name => nav.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  const openedId = async id => { await page.waitForFunction(wanted => document.querySelector('[data-testid="shared-chat"]')?.getAttribute('data-session') === wanted, id); };
  const mutations = () => calls.filter(call => call.method !== 'GET');
  const waitFor = async condition => { for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail('Fixture did not settle.'); };
  await page.goto(origin + '/#/bots/new'); await nav.getByRole('button', { name: 'Open Ava', exact: true }).waitFor();
  await tap('Ava'); await openedId('ava-latest-personal');
  assert.equal(await page.getByRole('textbox', { name: 'Message bot', exact: true }).isVisible(), true);
  assert.equal(mutations().length, 0, 'An existing personal conversation opens with no mutation.');
  await page.getByRole('combobox', { name: 'Bot conversation', exact: true }).click();
  await page.getByRole('option', { name: 'ava-newer-router', exact: true }).click(); await openedId('ava-newer-router');
  assert.equal(await page.getByRole('combobox', { name: 'Bot conversation', exact: true }).isVisible(), true, 'Explicit team transcripts remain available in full history.');
  await tap('Ava'); await openedId('ava-latest-personal');
  await page.evaluate(() => { const button = document.querySelector('[aria-label="Open New partner"]'); button.click(); button.click(); });
  await openedId('fresh-empty-personal');
  assert.deepEqual(mutations().map(call => ({ path: call.path, body: call.body })), [{ path: '/api/bots/fresh/conversations', body: {} }]);
  assert.equal(conversations.find(row => row.id === 'fresh-empty-personal').messages.length, 0);
  assert.equal(await page.locator('.cua-frozen-policy').textContent(), 'Bypass approvals');
  await tap('New partner'); await openedId('fresh-empty-personal'); assert.equal(mutations().length, 1, 'Later taps reuse the empty conversation.');
  conversations.push(chat('phone-created-personal', 'phone', at));
  await tap('Phone partner'); await openedId('phone-created-personal'); assert.equal(mutations().length, 1, 'The current host catalog wins over the earlier roster snapshot.');
  await tap('Paused partner'); await openedId('paused-personal');
  await tap('Paused newcomer'); await page.getByText('This bot is paused. Resume it before starting a new chat.', { exact: true }).waitFor();
  assert.equal(mutations().length, 1, 'Paused bots can read personal history but cannot create a chat.');
  await tap('Unavailable partner'); await page.getByText('The saved bot is temporarily unavailable. Please retry.', { exact: true }).waitFor();
  assert.equal(await opened.getAttribute('data-session'), 'paused-personal', 'A failed create cannot replace an existing conversation.');
  await page.waitForResponse(response => response.url() === origin + '/api/bots' && response.request().method() === 'GET');
  assert.equal(await page.getByText('The saved bot is temporarily unavailable. Please retry.', { exact: true }).isVisible(), true, 'Background roster refresh keeps the actionable conversation error visible.');
  for (malformed of ['wrong-bot', 'team', 'missing-id']) {
    await tap('Mismatched partner'); await page.getByText('Strata returned a different conversation. Refresh Bots and try again.', { exact: true }).waitFor();
    assert.equal(await opened.getAttribute('data-session'), 'paused-personal');
    assert.equal(await page.evaluate(() => window.fixtureState.sessions.some(row => row.id === 'mismatched-response')), false, 'A mismatched response is never adopted.');
  }
  holdLookup = true; await tap('Lookup partner'); await waitFor(() => !!releaseLookup);
  await nav.getByRole('button', { name: 'All teams', exact: true }).click(); releaseLookup();
  await waitFor(() => !holdLookup); await nav.getByRole('button', { name: 'Open Ava', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Open Ava"]').disabled);
  assert.equal(await page.evaluate(() => location.hash), '#/bots/teams');
  assert.equal(calls.some(call => call.path === '/api/bots/lookup/conversations'), false, 'Navigation during lookup prevents a late create.');
  await tap('Ava'); await openedId('ava-latest-personal');
  holdCreation = true; await tap('Creation partner'); await waitFor(() => !!releaseCreation);
  await nav.getByRole('button', { name: 'All teams', exact: true }).click(); releaseCreation();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Open Ava"]').disabled);
  assert.equal(await page.evaluate(() => location.hash), '#/bots/teams', 'A late create response cannot steal navigation.');
  await tap('Creation partner'); await openedId('creation-empty-personal');
  assert.equal(calls.filter(call => call.path === '/api/bots/creation/conversations').length, 1);
  assert.equal(calls.some(call => /\/messages|\/prepare|\/start|\/stop|\/takeover|serving|native|model-providers|\/ssh/.test(call.path)), false, 'Opening a conversation never starts model work or a computer.');
  assert.equal(conversations.filter(row => row.preferences.teamId || row.preferences.teamRunId || row.preferences.parentChatId).length, 3, 'All team history remains present.');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(blocked, []);
  const evidence = process.env.STRATA_BOTS_PERSONAL_EVIDENCE_DIR;
  if (evidence) {
    mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'personal-chat-navigation.png') });
    writeFileSync(join(evidence, 'browser-report.json'), JSON.stringify({ passed: true, scope: 'Real BotsScreen and helpers with inert shared ChatScreen/store and HTTP', modelPrompts: 0, computerMutations: 0, ownerMutations: 0, calls }, null, 2) + '\n');
  }
});
