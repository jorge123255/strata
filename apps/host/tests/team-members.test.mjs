import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, transform } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const bundled = await build({
  entryPoints: [join(src, 'lib/team-members.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  plugins: [{ name: 'stub-store', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)store$/ }, () => ({ path: 'store', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function pushToast(tone, title){ globalThis.__teamToasts.push({ tone, title }); }', loader: 'js' }));
  } }],
});
const members = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const botsCode = await transform(await readFile(new URL('../src/lib/bots.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const bots = await import(`data:text/javascript;base64,${Buffer.from(botsCode.code).toString('base64')}`);
const limits = { ...bots.DEFAULT_BOT_TEAM_LIMITS };

test('member removal and team delete use one roster patch and a bodyless delete', () => {
  assert.equal(members.DELETED_BOT_NAME, 'Deleted bot');
  const team = { id: 'team id/1', memberIds: ['ava', 'bolt', 'gone'], coordinatorId: 'ava', revision: 4 };
  assert.deepEqual(members.teamMemberRemovalRequest(team, 'gone'), {
    path: '/api/bots/teams/team%20id%2F1',
    body: { expectedRevision: 4, memberIds: ['ava', 'bolt'], coordinatorId: 'ava' },
  });
  assert.deepEqual(members.teamMemberRemovalRequest({ ...team, coordinatorId: 'gone', revision: 0 }, 'gone'), {
    path: '/api/bots/teams/team%20id%2F1',
    body: { memberIds: ['ava', 'bolt'], coordinatorId: 'ava' },
  });
  assert.equal(members.teamMemberRemovalRequest(team, 'missing'), null);
  assert.equal(members.teamMemberRemovalRequest({ ...team, memberIds: ['ava'], coordinatorId: 'ava' }, 'ava'), null);
  assert.equal(members.teamMemberRemovalRequest({ ...team, revision: 1.5 }, 'bolt').body.expectedRevision, undefined);
  assert.deepEqual(members.teamDeleteRequest('team id/1'), { method: 'DELETE', path: '/api/bots/teams/team%20id%2F1' });
  globalThis.__teamToasts = [];
  members.reportTeamMemberError('Choose from 2 to 12 team members.');
  assert.deepEqual(globalThis.__teamToasts, [{ tone: 'error', title: 'Choose from 2 to 12 team members.' }]);
});

test('a saved roster can shrink while a new or larger roster stays capped', () => {
  const ids = Array.from({ length: 17 }, (_, index) => `m${index}`);
  const draft = { name: 'Crew', memberIds: ids, coordinatorId: ids[0], limits };
  assert.ok(bots.botTeamDraftError(draft, ids.map(id => ({ id }))));
  assert.equal(bots.botTeamDraftError(draft, [], undefined, false, false, ids), null);
  assert.equal(bots.botTeamDraftError({ ...draft, memberIds: [...ids, 'fresh'], coordinatorId: ids[0] }, [...ids.map(id => ({ id })), { id: 'fresh' }], undefined, false, false, ids), 'Remove members until this team has 12 or fewer before adding anyone.');
  assert.equal(bots.botTeamDraftError({ ...draft, memberIds: ['m0', 'gone'], coordinatorId: 'm0' }, [{ id: 'm0' }], undefined, false, false, ['m0', 'm1', 'gone']), null);
  assert.ok(bots.botTeamDraftError({ ...draft, memberIds: ['m0', 'm1', 'fresh'], coordinatorId: 'm0' }, [{ id: 'm0' }, { id: 'm1' }], undefined, false, false, ['m0', 'm1', 'gone']));
  assert.ok(bots.botTeamDraftError({ ...draft, memberIds: [...ids, 'fresh'] }, [...ids.map(id => ({ id })), { id: 'fresh' }], undefined, true, false, ids));
  assert.ok(bots.botTeamDraftError({ name: 'Crew', memberIds: ['a', 'removed'], coordinatorId: 'a', limits }, [{ id: 'a' }]));
  assert.ok(bots.botTeamDraftError({ ...draft, memberIds: ids.slice(0, 13) }, ids.map(id => ({ id })), undefined, true));
});

test('desktop and iPhone member editing keep the remove, cap, and delete affordances', async () => {
  const workspace = await readFile(new URL('../src/screens/BotsWorkspace.tsx', import.meta.url), 'utf8');
  const editor = await readFile(new URL('../src/screens/BotTeamEditor.tsx', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../src/lib/team-members.ts', import.meta.url), 'utf8');
  const row = await readFile(new URL('../src/components/TeamMemberRow.tsx', import.meta.url), 'utf8');
  const iosViews = await readFile(new URL('../../ios/StrataMobile/Views/BotWorkspaceViews.swift', import.meta.url), 'utf8');
  const iosStore = await readFile(new URL('../../ios/StrataMobile/Services/BotWorkspaceStore.swift', import.meta.url), 'utf8');
  assert.match(row, /onContextMenu/);
  assert.match(row, /Deleted bot|DELETED_BOT_NAME/);
  assert.match(workspace, /api\.patch\(request\.path, request\.body\)/);
  assert.match(workspace, /reportTeamMemberError/);
  assert.match(editor, /deleteBotTeam\(base\.id\)/);
  assert.doesNotMatch(editor, /teamDeleteUnsupported/);
  assert.doesNotMatch(editor, /not available on this host yet/);
  assert.match(helper, /pushToast\('error', message\)/);
  assert.match(editor, /Delete team/);
  assert.doesNotMatch(workspace, /teamCapMessage/);
  assert.match(iosViews, /swipeActions/);
  assert.match(iosViews, /deletedBotName/);
  assert.doesNotMatch(iosViews, /teamCapMessage/);
  assert.doesNotMatch(iosStore, /teamCapMessage/);
  assert.match(iosStore, /\/v1\/bots\/teams\/\\?\(team\.id\)/);
  assert.match(iosStore, /retainedMemberIds/);
  assert.match(iosStore, /func removeTeamMember/);
});

/** Pictures go to STRATA_TEST_SCREENSHOTS, or a temp test-output folder. A path that cannot be created is skipped. */
export function screenshotDirectory(envValue = process.env.STRATA_TEST_SCREENSHOTS) {
  const requested = envValue || join(tmpdir(), 'test-output');
  try {
    mkdirSync(requested, { recursive: true });
    accessSync(requested, constants.W_OK);
    return requested;
  } catch {
    return null;
  }
}

test('screenshots follow STRATA_TEST_SCREENSHOTS and skip a path that cannot be written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-shots-'));
  assert.equal(screenshotDirectory(dir), dir);
  const blocked = join(dir, 'not-a-directory');
  writeFileSync(blocked, 'x');
  assert.equal(screenshotDirectory(join(blocked, 'shots')), null);
  assert.equal(screenshotDirectory(''), join(tmpdir(), 'test-output'));
});

const executablePath = [process.env.STRATA_UI_BROWSER, '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => path && existsSync(path));
test('team member remove saves an over-cap roster, and team delete stays available', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 90000 }, async t => {
  const at = '2026-10-23T12:00:00Z';
  const rosterLimits = { maxParallel: 2, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 };
  const bots = ['Ava', 'Bolt', 'Iris'].map((name, index) => ({ id: name.toLowerCase(), name, provider: 'codex', model: 'fixture', policy: 'manual', capabilities: 'both', instructions: '', workspace: '/fixture', execution: { kind: 'local' }, computerMode: 'host', avatarConfig: { color: ['cloud', 'sky', 'violet'][index], shape: 'orb', eyes: 'round', ears: 'small' }, createdAt: at, updatedAt: at }));
  let revision = 4;
  let deleteStatus = 500;
  let team = { id: 'crew', name: 'Product studio', memberIds: ['ava', 'bolt', 'iris', 'gone'], coordinatorId: 'ava', enabled: true, revision, limits: rosterLimits, createdAt: at, updatedAt: at };
  const calls = [], errors = [], unexpected = [];
  const entry = `import React from'react';import{createRoot}from'react-dom/client';import{BotTeamPanel,useBotsResource}from${JSON.stringify(join(src, 'screens/BotsWorkspace.tsx'))};import${JSON.stringify(join(src, 'screens/Bots.css'))};window.teamToasts=[];function App(){const resource=useBotsResource('/api/bots/teams',60000);window.refreshTeam=resource.refresh;return <main className="main" style={{height:'100dvh',display:'flex'}}><BotTeamPanel bots={${JSON.stringify(bots)}} resource={resource} teamId="crew" onSelect={()=>{}} onOpenConversation={async()=>{}} onNewTeam={()=>{}} onNewBot={()=>{}}/></main>};createRoot(document.getElementById('root')).render(<App/>);`;
  const { outputFiles } = await build({ stdin: { contents: entry, resolveDir: src, loader: 'tsx' }, bundle: true, write: false, outfile: 'harness.js', format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'stub-store', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)store$/ }, args => args.importer.includes('/src/') ? { path: 'store', namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useStore=()=>({toasts:[]});export const pushToast=(tone,title)=>{window.teamToasts.push({tone,title})};export const dismissActionError=()=>{},dismissToast=()=>{},holdToast=()=>{},releaseToast=()=>{};', loader: 'js' }));
  } }] });
  const js = outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(path => readFileSync(join(src, path), 'utf8')).join('\n') + '\n' + (outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '') + '\n' + readFileSync(join(src, 'screens/Bots.css'), 'utf8') + '\n' + readFileSync(join(src, 'screens/BotTeamChannel.css'), 'utf8') + '\n' + readFileSync(join(src, 'screens/BotTeamSettings.css'), 'utf8');
  const reply = (res, body, status = 200, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), path = url.pathname;
    if (path === '/') return reply(res, '<!doctype html><html data-theme="dark" data-motion="reduced"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script src="/harness.js"></script>', 200, 'text/html');
    if (path === '/harness.js') return reply(res, js, 200, 'text/javascript');
    if (path === '/harness.css') return reply(res, css, 200, 'text/css');
    if (path === '/icons/sprite.svg') return reply(res, readFileSync(join(root, 'public/icons/sprite.svg')), 200, 'image/svg+xml');
    if (path.startsWith('/fonts/') && existsSync(join(root, 'public', path))) return reply(res, readFileSync(join(root, 'public', path)), 200, 'font/woff2');
    if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, path, body });
    if (path === '/api/bots/teams' && req.method === 'GET') return reply(res, { teams: [team], runs: [], channelsSupported: true, teamSettingsSupported: true });
    if (path === '/api/bots/teams/crew/channel' && req.method === 'GET') return reply(res, { teamId: 'crew', supported: true, messages: [], activeRuns: [], nextSequence: 0, hasMore: false, hasMoreBefore: false });
    if (path === '/api/bots/teams/crew' && req.method === 'PATCH') {
      if (!Array.isArray(body.memberIds) || body.memberIds.length < 2) return reply(res, { error: 'Choose at least two different bots.' }, 400);
      team = { ...team, ...body, revision: ++revision, updatedAt: at };
      delete team.expectedRevision;
      return reply(res, { team });
    }
    if (path === '/api/bots/teams/crew' && req.method === 'DELETE') {
      const status = deleteStatus; deleteStatus = 405;
      return reply(res, { error: status === 405 ? 'Method not allowed' : 'The team could not be deleted.' }, status);
    }
    unexpected.push(`${req.method} ${path}`);
    return reply(res, { error: 'Unexpected fixture operation' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  const shots = screenshotDirectory();
  async function shot(name) {
    if (!shots) return;
    try { await page.screenshot({ path: join(shots, `${name}.png`) }); }
    catch { /* A missing picture does not change the remove or delete result. */ }
  }
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Product studio' }).waitFor();
  await page.getByRole('tab', { name: 'Work', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Team members' }).click();
  const work = page.locator('#team-work-panel');
  await work.getByRole('button', { name: 'Remove Deleted bot', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Team details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Product studio', exact: true });
  await details.getByRole('button', { name: 'Remove Deleted bot', exact: true }).waitFor();
  await shot('team_member_deleted');
  await details.getByRole('button', { name: 'Done', exact: true }).click();
  await work.getByRole('button', { name: 'Remove Deleted bot', exact: true }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('Deleted bot'));
  const iris = work.locator('[data-bot-id="iris"]');
  await iris.hover();
  await iris.getByRole('button', { name: 'Remove Iris', exact: true }).click();
  const confirmIris = page.getByRole('dialog', { name: 'Remove Iris from this team?', exact: true });
  await confirmIris.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-bot-id="iris"]'));
  const bolt = work.locator('[data-bot-id="bolt"]');
  await bolt.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
  const confirmBolt = page.getByRole('dialog', { name: 'Remove Bolt from this team?', exact: true });
  await shot('team_member_confirm');
  await confirmBolt.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForFunction(() => window.teamToasts.some(toast => toast.title === 'Choose at least two different bots.'));
  await work.locator('[data-bot-id="bolt"]').waitFor();
  team = { ...team, memberIds: Array.from({ length: 17 }, (_, index) => `m${index}`), coordinatorId: 'm0', revision: team.revision };
  await page.evaluate(() => window.refreshTeam());
  await page.getByText('17 members', { exact: false }).first().waitFor();
  assert.equal(await page.getByText('This team has 17 of 12 members; remove some to save changes', { exact: true }).count(), 0);
  await shot('team_over_cap');
  await page.getByRole('button', { name: 'Team details', exact: true }).click();
  await page.getByRole('dialog', { name: 'Product studio', exact: true }).getByRole('button', { name: 'Team settings', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Product studio settings', exact: true });
  assert.equal(await editor.getByText('This team has 17 of 12 members; remove some to save changes', { exact: true }).count(), 0);
  assert.equal(await editor.getByRole('button', { name: 'Save team', exact: true }).isEnabled(), true);
  await editor.getByRole('button', { name: 'Save team', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Work', exact: true }).click();
  const overCap = page.locator('#team-work-panel');
  const disclosure = overCap.locator('details.bot-work-disclosure').filter({ hasText: 'Team members' });
  if (!(await disclosure.evaluate(element => element.open))) await disclosure.locator('summary').click();
  await overCap.getByRole('button', { name: 'Remove Deleted bot', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('#team-work-panel summary')?.textContent?.includes('16'));
  await page.getByRole('button', { name: 'Team details', exact: true }).click();
  await page.getByRole('dialog', { name: 'Product studio', exact: true }).getByRole('button', { name: 'Team settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Product studio settings', exact: true });
  await settings.getByRole('button', { name: 'Delete team', exact: true }).click();
  const destroy = page.getByRole('dialog', { name: 'Delete this team?', exact: true });
  await shot('team_delete_confirm');
  const confirmDelete = destroy.getByRole('button', { name: 'Delete team', exact: true });
  assert.equal(await confirmDelete.isEnabled(), false);
  await destroy.getByRole('textbox', { name: 'Type the team name to confirm', exact: true }).fill('Product studio');
  assert.equal(await confirmDelete.isEnabled(), true);
  await confirmDelete.click();
  await settings.getByText('The team could not be deleted.', { exact: true }).waitFor();
  assert.equal(await settings.getByRole('button', { name: 'Delete team', exact: true }).count(), 1);
  await settings.getByRole('button', { name: 'Delete team', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete this team?', exact: true }).getByRole('textbox', { name: 'Type the team name to confirm', exact: true }).fill('Product studio');
  await page.getByRole('dialog', { name: 'Delete this team?', exact: true }).getByRole('button', { name: 'Delete team', exact: true }).click();
  await settings.getByText('Method not allowed', { exact: true }).waitFor();
  assert.equal(await settings.getByRole('button', { name: 'Delete team', exact: true }).count(), 1);
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Team details', exact: true }).click();
  await page.getByRole('dialog', { name: 'Product studio', exact: true }).getByRole('button', { name: 'Team settings', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Product studio settings', exact: true }).getByRole('button', { name: 'Delete team', exact: true }).count(), 1);
  const patches = calls.filter(call => call.method === 'PATCH');
  assert.equal(patches[0].path, '/api/bots/teams/crew');
  assert.deepEqual(patches[0].body, { expectedRevision: 4, memberIds: ['ava', 'bolt', 'iris'], coordinatorId: 'ava' });
  assert.deepEqual(patches[1].body, { expectedRevision: 5, memberIds: ['ava', 'bolt'], coordinatorId: 'ava' });
  assert.deepEqual(patches[2].body, { expectedRevision: 6, memberIds: ['ava'], coordinatorId: 'ava' });
  const kept = patches.find(call => call.body.memberIds.length === 17);
  assert.equal(kept.body.coordinatorId, 'm0');
  const shrunk = patches.find(call => call.body.memberIds.length === 16);
  assert.equal(shrunk.body.memberIds.includes('m0'), false);
  assert.equal(shrunk.body.coordinatorId, 'm1');
  const deletes = calls.filter(call => call.method === 'DELETE');
  assert.equal(deletes.length, 2);
  assert.deepEqual(deletes.map(call => call.path), ['/api/bots/teams/crew', '/api/bots/teams/crew']);
  assert.deepEqual(deletes.map(call => call.body), [undefined, undefined]);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
});
