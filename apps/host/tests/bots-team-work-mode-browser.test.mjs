/** Actual team composer; synthetic loopback transport, no providers or owner data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url)), source = join(root, 'src');
const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
test('Chat and Work require explicit send, bind retries, preserve targets and keep old hosts compatible', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 60000 }, async t => {
  const at = '2026-10-21T12:00:00Z', limits = { maxParallel: 0, maxDepth: 0, maxHops: 0, maxTurns: 0, maxDurationMs: 0 };
  const bots = ['Coordinator', 'Builder'].map((name, index) => ({ id: 'bot_' + index, name, provider: 'codex', model: 'fixture', policy: 'manual', capabilities: 'both', instructions: '', workspace: '/fixture', execution: { kind: 'local' }, createdAt: at, updatedAt: at }));
  const team = { id: 'team_fixture', name: 'Fixture team', memberIds: bots.map(bot => bot.id), coordinatorId: bots[0].id, enabled: true, limits, createdAt: at, updatedAt: at };
  let capability, failNext = false;
  const rows = [], calls = [], errors = [], blocked = [], unexpected = [];
  const snapshot = () => ({ teamId: team.id, supported: true, messages: rows, activeRuns: [], nextSequence: rows.length, hasMore: false, hasMoreBefore: false });
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{BotTeamPanel,useBotsResource}from${JSON.stringify(join(source, 'screens/BotsWorkspace.tsx'))};import${JSON.stringify(join(source, 'screens/Bots.css'))};function App(){const resource=useBotsResource('/api/bots/teams');return <><button onClick={()=>void resource.refresh()}>Refresh fixture capabilities</button><main className="main" style={{height:'calc(100dvh - 40px)',display:'flex'}}><BotTeamPanel bots={${JSON.stringify(bots)}} resource={resource} teamId="team_fixture" onSelect={()=>{}} onOpenConversation={async()=>{throw new Error('No conversations may open')}} onNewTeam={()=>{}} onNewBot={()=>{}}/></main></>};createRoot(document.getElementById('root')).render(<App/>);`;
  const { outputFiles } = await build({ stdin: { contents: entry, resolveDir: source, loader: 'tsx' }, bundle: true, write: false, outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'inert-store', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)store$/ }, args => args.importer.includes('/src/') ? { path: 'store', namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useStore=s=>s({});export const dismissActionError=()=>{},dismissToast=()=>{},holdToast=()=>{},releaseToast=()=>{};', loader: 'js' }));
  } }] });
  const script = outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css', 'styles/annotation-fixes.css'].map(path => readFileSync(join(source, path), 'utf8')).join('\n') + '\n' + (outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '');
  const respond = (res, value, status = 200, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(value) : value); };
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') return respond(res, '<!doctype html><html data-theme="dark" data-motion="reduced"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>', 200, 'text/html');
    if (path === '/fixture.js') return respond(res, script, 200, 'text/javascript');
    if (path === '/fixture.css') return respond(res, css, 200, 'text/css');
    if (path === '/icons/sprite.svg') return respond(res, readFileSync(join(root, 'public/icons/sprite.svg')), 200, 'image/svg+xml');
    if (path.startsWith('/fonts/') && existsSync(join(root, 'public', path))) return respond(res, readFileSync(join(root, 'public', path)), 200, 'font/woff2');
    if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
    const body = req.method === 'POST' ? await new Promise(resolve => { let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => resolve(JSON.parse(raw))); }) : undefined;
    calls.push({ path, method: req.method, ...(body ? { body } : {}) });
    if (path === '/api/bots/teams' && req.method === 'GET') return respond(res, { teams: [team], runs: [], channelsSupported: true, teamContinuousSupported: true, ...(capability === undefined ? {} : { teamCoordinatorWorkToolsSupported: capability }) });
    if (path === '/api/bots/teams/team_fixture/channel' && req.method === 'GET') return respond(res, snapshot());
    if (path === '/api/bots/teams/team_fixture/messages' && req.method === 'POST') {
      if (failNext) { failNext = false; return respond(res, { error: 'Synthetic receipt interrupted. Retry the same message.' }, 503); }
      rows.push({ id: 'message_' + (rows.length + 1), sequence: rows.length + 1, teamId: team.id, kind: 'message', author: { type: 'user', name: 'You' }, content: body.message, createdAt: at, ...(body.workMode === 'work' ? { workMode: 'work' } : {}), ...(body.recipientIds ? { recipientIds: body.recipientIds } : {}), ...(body.replyToId ? { replyToId: body.replyToId } : {}) });
      return respond(res, { channel: snapshot() });
    }
    unexpected.push(path); return respond(res, { error: 'Unexpected fixture request' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push(route.request().url()), route.abort()));
  const evidence = process.env.STRATA_TEAM_MODE_EVIDENCE_DIR; if (evidence) mkdirSync(evidence, { recursive: true });
  const screenshot = async name => { if (evidence) { await page.evaluate(() => document.fonts.ready); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await page.screenshot({ path: join(evidence, name + '.png') }); } };
  const posts = () => calls.filter(call => call.method === 'POST');
  const mode = page.getByRole('group', { name: 'Team message mode', exact: true }), input = page.getByRole('textbox', { name: 'Message team', exact: true }), send = page.getByRole('button', { name: 'Send', exact: true });
  await page.goto(origin); await input.waitFor(); assert.equal(await mode.count(), 0); assert.equal(posts().length, 0);
  await input.fill('Legacy chat'); await send.click(); await page.getByText('Legacy chat', { exact: true }).waitFor(); assert.equal('workMode' in posts().at(-1).body, false);
  capability = 'true'; await page.getByRole('button', { name: 'Refresh fixture capabilities', exact: true }).click(); await page.waitForTimeout(100); assert.equal(await mode.count(), 0, 'A truthy string is not capability support.');
  capability = true; await page.getByRole('button', { name: 'Refresh fixture capabilities', exact: true }).click(); await mode.waitFor();
  assert.equal(await mode.getByRole('button', { name: 'Chat', exact: true }).getAttribute('aria-pressed'), 'true');
  const beforeSelection = posts().length; await mode.getByRole('button', { name: 'Work', exact: true }).click(); await input.fill('Read the saved source');
  await page.getByRole('button', { name: 'To: Team', exact: false }).click(); await page.getByRole('checkbox', { name: /Builder/ }).check();
  assert.equal(posts().length, beforeSelection, 'Choosing Work or teammates cannot start work.');
  await page.getByText('Coordinator and teammates can use their saved tools, approvals and selected team computer/folder.', { exact: true }).waitFor(); await screenshot('work-mode-wide');
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await screenshot('work-mode-compact'); await page.setViewportSize({ width: 1440, height: 1000 });
  failNext = true; await send.click(); await page.getByText('Synthetic receipt interrupted. Retry the same message.', { exact: true }).waitFor(); const failed = posts().at(-1).body;
  await send.click(); await page.getByText('Read the saved source', { exact: true }).waitFor(); const retry = posts().at(-1).body;
  assert.deepEqual(retry, failed); assert.equal(retry.workMode, 'work'); assert.deepEqual(retry.recipientIds, ['bot_1']);
  await page.getByText('Work request', { exact: true }).waitFor(); assert.equal(await mode.getByRole('button', { name: 'Chat', exact: true }).getAttribute('aria-pressed'), 'true');
  await mode.getByRole('button', { name: 'Work', exact: true }).click(); await input.fill('Same draft, changed mode'); failNext = true; await send.click(); await page.getByText('Synthetic receipt interrupted. Retry the same message.', { exact: true }).waitFor(); const prior = posts().at(-1).body;
  await mode.getByRole('button', { name: 'Chat', exact: true }).click(); await send.click(); await page.getByText('Same draft, changed mode', { exact: true }).waitFor(); assert.notEqual(posts().at(-1).body.requestId, prior.requestId); assert.equal(posts().at(-1).body.workMode, 'chat');
  await mode.getByRole('button', { name: 'Work', exact: true }).click(); const beforeGreeting = posts().length;
  await page.getByRole('button', { name: 'Team actions', exact: true }).click(); await page.getByRole('button', { name: 'Draft a greeting to everyone', exact: true }).click();
  assert.equal(await input.inputValue(), 'Hi everyone!'); assert.equal(await mode.getByRole('button', { name: 'Chat', exact: true }).getAttribute('aria-pressed'), 'true'); assert.equal(posts().length, beforeGreeting);
  await send.click(); await page.getByText('Hi everyone!', { exact: true }).waitFor(); assert.equal(posts().at(-1).body.workMode, 'chat'); assert.deepEqual(posts().at(-1).body.recipientIds, team.memberIds);
  await mode.getByRole('button', { name: 'Work', exact: true }).click(); capability = false; await page.getByRole('button', { name: 'Refresh fixture capabilities', exact: true }).click(); await mode.waitFor({ state: 'hidden' });
  await input.fill('Compatibility retained'); await send.click(); await page.getByText('Compatibility retained', { exact: true }).waitFor(); assert.equal('workMode' in posts().at(-1).body, false);
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual(unexpected, []); assert.ok(calls.every(call => call.method === 'GET' || call.path.endsWith('/messages')));
  if (evidence) writeFileSync(join(evidence, 'report.json'), JSON.stringify({ passed: true, scope: 'Actual Mac team composer with inert transport', browserErrors: errors, modelPrompts: 0, ownerWrites: 0, screenshots: 2, requests: calls }, null, 2) + '\n');
});
