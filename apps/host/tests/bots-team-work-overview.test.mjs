/** Pure presentation and actual Team panel; inert transport, no owner/model traffic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url)), src = join(root, 'src');
const { outputFiles: selectorFiles } = await build({ entryPoints: [join(src, 'screens/botTeamWorkSelectors.ts')], bundle: true, write: false, format: 'esm', platform: 'node' });
const selectors = await import(`data:text/javascript;base64,${Buffer.from(selectorFiles[0].text).toString('base64')}`);
const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const evidence = [{ kind: 'file', label: 'Deliverable', detail: '/fixture/private/work/output.txt' }, { kind: 'test', label: 'Focused checks', detail: 'Reported check result. Full evidence end marker.' }];
function task(id, status, state = 'completed', extra = {}) {
  return { id, teamId: 'team_first', runId: 'tr_fixture', botId: 'bot_builder', chatId: `s_${id}`, type: 'delivery', title: id, state, createdAt: at, updatedAt: at,
    work: { status, revision: 3, summary: `Saved summary for ${id}`, evidence: [], resultHistory: [], reviewHistory: [], ...extra } };
}
function mixed() {
  return [task('Ready result', 'ready_for_review', 'completed', { evidence }),
    task('Blocked work', 'blocked', 'error', { reviewHistory: [{ decision: 'reject', resultId: 'result_previous', reviewedAt: at, note: 'Check the missing detail before continuing.' }] }),
    task('Interrupted modern work', 'interrupted', 'interrupted'), task('Active work', 'working', 'running'),
    task('Submitted while finishing', 'ready_for_review', 'running', { evidence }), task('Earlier cleanup still active', 'working', 'cleanup_pending', { legacy: true }),
    task('Legacy working remains current', 'working', 'completed', { legacy: true }),
    task('Verified result', 'verified'), task('Earlier completed turn', 'blocked', 'completed', { legacy: true }),
    task('Continued original result', 'blocked', 'error', { recoveryJobId: 'tj_not_in_this_snapshot' }),
    { ...task('Other room task', 'ready_for_review'), teamId: 'team_second' }];
}

test('current work retains every task, prioritizes active and ready, and collapses only explicit history', () => {
  const rows = mixed(), before = structuredClone(rows), groups = selectors.teamWorkGroups(rows, 'team_first');
  assert.equal(groups.needsYou.length, 3); assert.equal(groups.working.length, 4); assert.equal(groups.continuing.length, 1); assert.equal(groups.history.length, 2);
  assert.ok(groups.working.some(row => row.id === 'Earlier cleanup still active'));
  assert.ok(groups.working.some(row => row.id === 'Submitted while finishing'));
  assert.ok(groups.needsYou.some(row => row.id === 'Interrupted modern work'), 'Missing legacy metadata is current, not assumed history.');
  assert.equal(Object.values(groups).flat().length, 10); assert.deepEqual(rows, before);
  assert.equal(new Set(Object.values(groups).flat().map(row => row.id)).size, 10);
});

test('recovery links never hide active, ready or unknown work, or infer a child outcome', () => {
  const rows = [task('Active linked', 'blocked', 'running', { recoveryJobId: 'unknown' }), task('Ready linked', 'ready_for_review', 'completed', { recoveryJobId: 'unknown' }), task('Unknown state', 'future_state'), task('Legacy ready', 'ready_for_review', 'completed', { legacy: true })];
  const groups = selectors.teamWorkGroups(rows, 'team_first');
  assert.equal(groups.working.length, 1); assert.equal(groups.needsYou.length, 3); assert.deepEqual(groups.history, []);
  assert.equal(selectors.teamTaskLabel(task('Old', 'blocked', 'completed', { legacy: true })), 'Earlier turn');
  assert.equal(selectors.teamTaskLabel(task('Active', 'working', 'cleanup_pending', { legacy: true })), 'Checking cleanup');
  assert.equal(selectors.teamTaskLabel(task('Linked', 'blocked', 'error', { recoveryJobId: 'missing' })), 'Continuation created');
  assert.equal(selectors.teamTaskLabel(rows[2]), 'Needs review');
  const contradictory = task('Still working', 'working', 'completed', { legacy: true });
  assert.equal(selectors.teamTaskLabel(contradictory), 'Working');
  assert.equal(selectors.teamWorkGroups([contradictory], 'team_first').working.length, 1);
});

test('evidence counts describe reported items without interpreting success claims', () => {
  const row = task('Evidence', 'ready_for_review', 'completed', { evidence: [...evidence, ...evidence, { kind: 'note', label: 'Claim', detail: 'All checks passed and independently verified' }] });
  assert.equal(selectors.teamTaskEvidence(row), '2 files · 2 test reports · 1 note');
  assert.equal(selectors.teamTaskEvidence(task('No result', 'working')), '');
});

test('an errored run older than a day leaves the need-you count, and dismiss or a resolved review clears it', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-10-23T12:00:00Z');
  const oldAt = new Date(now - day).toISOString();
  const freshAt = new Date(now - day + 1000).toISOString();
  const stale = { ...task('Oct 22 error', 'blocked', 'error'), createdAt: oldAt, updatedAt: oldAt };
  const fresh = { ...task('Fresh error', 'blocked', 'error'), createdAt: freshAt, updatedAt: freshAt };
  const ready = task('Ready result', 'ready_for_review');
  const verified = { ...task('Verified result', 'verified'), updatedAt: oldAt };
  const interrupted = { ...task('Interrupted modern work', 'interrupted', 'interrupted'), updatedAt: oldAt };
  const continued = { ...task('Continued original result', 'blocked', 'error', { recoveryJobId: 'tj_kept' }), updatedAt: oldAt };
  const groups = selectors.teamWorkGroups([stale, fresh, ready, verified, interrupted, continued], 'team_first', { now });
  assert.deepEqual(groups.stale.map(row => row.id), ['Oct 22 error']);
  assert.deepEqual(groups.needsYou.map(row => row.id).sort(), ['Fresh error', 'Interrupted modern work', 'Ready result']);
  assert.deepEqual(groups.continuing.map(row => row.id), ['Continued original result']);
  assert.deepEqual(groups.history.map(row => row.id), ['Verified result']);
  assert.equal(groups.needsYou.length + groups.stale.length + groups.continuing.length + groups.history.length, 6);
  const dismissed = selectors.teamWorkGroups([stale, fresh, ready], 'team_first', { now, dismissed: new Set(['Oct 22 error', 'Ready result']) });
  assert.deepEqual(dismissed.stale.map(row => row.id), []);
  assert.deepEqual(dismissed.history.map(row => row.id), ['Oct 22 error']);
  assert.deepEqual(dismissed.needsYou.map(row => row.id).sort(), ['Fresh error', 'Ready result']);
  const resolved = { ...stale, state: 'completed', work: { ...stale.work, status: 'verified' } };
  const afterReview = selectors.teamWorkGroups([resolved], 'team_first', { now, dismissed: new Set(['Oct 22 error']) });
  assert.equal(afterReview.needsYou.length, 0);
  assert.equal(afterReview.stale.length, 0);
  assert.deepEqual(afterReview.history.map(row => row.id), ['Oct 22 error']);
  assert.deepEqual(selectors.retainedStaleDismissals([stale, fresh, resolved], new Set(['Oct 22 error', 'Fresh error', 'gone']), now), ['Oct 22 error']);
  assert.equal(selectors.STALE_TEAM_ERROR_MS, day);
});

test('the work screen offers dismiss for an older error and keeps that choice on this computer', () => {
  const overview = readFileSync(join(src, 'screens/BotTeamWorkOverview.tsx'), 'utf8');
  const workspace = readFileSync(join(src, 'screens/BotsWorkspace.tsx'), 'utf8');
  assert.match(overview, /Older errors/);
  assert.match(overview, />Dismiss</);
  assert.match(workspace, /retainedStaleDismissals/);
  assert.match(workspace, /strata\.dismissed-team-work/);
});

test('earlier unverified records are counted without promoting history into current work', () => {
  const earlier = Array.from({ length: 32 }, (_, index) => task(`Earlier turn ${index}`, index === 0 ? 'interrupted' : 'blocked', index === 0 ? 'interrupted' : 'completed', { legacy: true }));
  const before = structuredClone(earlier), groups = selectors.teamWorkGroups([...earlier, task('Saved verified result', 'verified')], 'team_first');
  assert.equal(groups.needsYou.length, 0); assert.equal(groups.working.length, 0);
  assert.equal(groups.history.length, 33); assert.equal(selectors.teamEarlierUnverifiedCount(groups), 32);
  assert.deepEqual(earlier, before);
  const current = selectors.teamWorkGroups([task('Modern blocked task', 'blocked'), task('Legacy active', 'working', 'running', { legacy: true })], 'team_first');
  assert.equal(selectors.teamEarlierUnverifiedCount(current), 0);
});

const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(value => value && existsSync(value));
test('Team Work counts, current groups, history, stale reads and room resets remain read-only', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 90000 }, async t => {
  const bots = [{ id: 'bot_builder', name: 'Builder with a long readable name', workspace: '/fixture/project', provider: 'codex', avatarConfig: { color: 'sky', eyes: 'round', ears: 'small' } }, { id: 'bot_peer', name: 'Peer', workspace: '/fixture/project', provider: 'codex' }];
  const limits = { maxParallel: 0, maxDepth: 0, maxHops: 0, maxTurns: 0, maxDurationMs: 0 };
  const teams = ['first', 'second'].map(name => ({ id: `team_${name}`, name: name === 'first' ? 'Fixture studio' : 'Second room', memberIds: bots.map(bot => bot.id), coordinatorId: bots[0].id, enabled: true, limits, createdAt: at, updatedAt: at }));
  const runs = [{ id: 'tr_finished', teamId: 'team_first', rootChatId: 's_finished', rootBotId: bots[0].id, state: 'completed', limits, consumedTurns: 4, createdAt: at, updatedAt: at }, { id: 'tr_cleanup', teamId: 'team_first', rootChatId: 's_cleanup', rootBotId: bots[0].id, state: 'cleanup_pending', limits, consumedTurns: 2, createdAt: at, updatedAt: at }];
  let rows = mixed(), failActivity = false, holdNext = false, entered, release;
  const calls = [], errors = [], blocked = [], unexpected = [];
  const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotTeamPanel,useBotsResource}from${JSON.stringify(join(src, 'screens/BotsWorkspace.tsx'))};import${JSON.stringify(join(src, 'screens/Bots.css'))};function App(){const[id,setId]=useState('team_first');const resource=useBotsResource('/api/bots/teams');return <><nav aria-label="Fixture rooms"><button onClick={()=>setId('team_first')}>Fixture studio</button><button onClick={()=>setId('team_second')}>Second room</button></nav><main className="main" style={{height:'calc(100dvh - 40px)',display:'flex'}}><BotTeamPanel bots={${JSON.stringify(bots)}} resource={resource} teamId={id} onSelect={setId} onOpenConversation={async()=>{}} onNewTeam={()=>{}} onNewBot={()=>{}}/></main></>};createRoot(document.getElementById('root')).render(<App/>);`;
  const { outputFiles } = await build({ stdin: { contents: entry, resolveDir: src, loader: 'tsx' }, bundle: true, write: false, outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'isolated-store', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)store$/ }, args => args.importer.includes('/src/') ? { path: 'store', namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useStore=s=>s({});export const dismissActionError=()=>{},dismissToast=()=>{},holdToast=()=>{},releaseToast=()=>{};', loader: 'js' }));
  } }] });
  const script = outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css', 'styles/annotation-fixes.css'].map(path => readFileSync(join(src, path), 'utf8')).join('\n') + '\n' + (outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '');
  function respond(res, value, status = 200, type = 'application/json') { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(value) : value); }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture'), path = url.pathname;
      if (path === '/') return respond(res, '<!doctype html><html data-theme="dark" data-motion="reduced"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>', 200, 'text/html');
      if (path === '/fixture.js') return respond(res, script, 200, 'text/javascript');
      if (path === '/fixture.css') return respond(res, css, 200, 'text/css');
      if (path === '/icons/sprite.svg') return respond(res, readFileSync(join(root, 'public/icons/sprite.svg')), 200, 'image/svg+xml');
      if (path.startsWith('/fonts/') && existsSync(join(root, 'public', path))) return respond(res, readFileSync(join(root, 'public', path)), 200, 'font/woff2');
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      calls.push({ path, method: req.method });
      assert.equal(req.method, 'GET', 'Overview navigation and disclosures cannot start, review or resume work.');
      if (path === '/api/bots/teams') return respond(res, { teams, runs, channelsSupported: true, teamContinuousSupported: true, teamUnrestrictedSupported: true, teamWorkReviewSupported: true });
      if (path === '/api/bots/activity') {
        if (failActivity) return respond(res, { error: 'Fixture work is temporarily unavailable.' }, 503);
        const captured = structuredClone(rows);
        if (holdNext) { holdNext = false; entered?.(); await new Promise(resolve => { release = resolve; }); }
        return respond(res, { teamWorkReviewSupported: true, activity: captured });
      }
      const room = /^\/api\/bots\/teams\/(team_first|team_second)\/channel$/.exec(path);
      if (room) return respond(res, { teamId: room[1], supported: true, messages: [], activeRuns: [], nextSequence: 0, hasMore: false, hasMoreBefore: false });
      unexpected.push(path); return respond(res, { error: 'Unexpected fixture request' }, 404);
    } catch (cause) { return respond(res, { error: cause.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release?.(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' }); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push(route.request().url()), route.abort()));
  const evidenceDirectory = process.env.STRATA_TEAM_WORK_EVIDENCE_DIR;
  if (evidenceDirectory) mkdirSync(evidenceDirectory, { recursive: true });
  async function screenshot(name) { if (evidenceDirectory) { await page.evaluate(() => document.fonts.ready); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await page.screenshot({ path: join(evidenceDirectory, `${name}.png`) }); } }
  await page.goto(origin);
  const workTab = page.getByRole('tab', { name: /Work/ });
  await page.getByRole('tab', { name: /Work.*3 need you.*4 working/ }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Channel', exact: true }).getAttribute('aria-selected'), 'true');
  assert.ok(calls.some(call => call.path === '/api/bots/activity'), 'Counts load without opening Work.');
  await screenshot('channel-work-counts-wide'); await workTab.click();
  const current = page.getByRole('region', { name: 'Current team work', exact: true });
  await current.getByRole('article', { name: 'Blocked work', exact: true }).waitFor();
  assert.equal(await current.getByRole('article', { includeHidden: true }).count(), 10, 'Every received team task remains in current or disclosed history.');
  assert.equal(await current.getByRole('article', { name: 'Other room task', exact: true }).count(), 0);
  assert.equal(await current.getByRole('article', { name: 'Verified result', exact: true }).isVisible(), false);
  assert.equal(await current.getByRole('article', { name: 'Earlier completed turn', exact: true }).isVisible(), false);
  assert.equal(await current.getByRole('article', { name: 'Earlier cleanup still active', exact: true }).isVisible(), true);
  assert.equal(await current.getByRole('article', { name: 'Continued original result', exact: true }).isVisible(), true);
  await current.getByText('Check the missing detail before continuing.', { exact: true }).waitFor();
  await current.getByText('Reported evidence · 1 file · 1 test report', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry Stop', exact: true }).isVisible(), true, 'Active cleanup controls are never hidden in history.');
  await screenshot('current-work-wide');
  await current.getByRole('article', { name: 'Ready result', exact: true }).getByRole('button', { name: 'Review task', exact: true }).click();
  await page.getByText('Reported check result. Full evidence end marker.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('current-work-compact');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await current.locator('details.bot-work-history > summary').click();
  assert.equal(await current.getByRole('article', { name: 'Verified result', exact: true }).isVisible(), true);
  assert.equal(await current.getByRole('article', { name: 'Earlier completed turn', exact: true }).isVisible(), true);
  const requests = page.locator('details.bot-work-disclosure').filter({ has: page.getByRole('heading', { name: 'Team requests', exact: true }) });
  assert.equal(await requests.evaluate(element => element.open), false);
  await requests.locator('summary').click(); await requests.getByText('Turn finished', { exact: true }).waitFor();
  failActivity = true;
  await page.getByText('Fixture work is temporarily unavailable.', { exact: true }).waitFor();
  await current.getByRole('article', { name: 'Blocked work', exact: true }).getByText('Last known: Blocked', { exact: true }).waitFor();
  assert.equal(await current.getByRole('article', { name: 'Ready result', exact: true }).getByRole('button', { name: 'Review task', exact: true }).isDisabled(), true);
  assert.match(await workTab.innerText(), /Last known:/);
  failActivity = false; holdNext = true; const held = new Promise(resolve => { entered = resolve; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await held;
  rows = rows.map(row => row.teamId === 'team_second' ? { ...row, title: 'Fresh second-room task' } : row);
  await page.getByRole('navigation', { name: 'Fixture rooms', exact: true }).getByRole('button', { name: 'Second room', exact: true }).click();
  await page.getByRole('tab', { name: /Work.*1 need you.*0 working/ }).waitFor();
  await page.waitForFunction(() => document.getElementById('team-channel-tab')?.getAttribute('aria-selected') === 'true');
  await workTab.click(); await page.getByRole('article', { name: 'Fresh second-room task', exact: true }).waitFor();
  release(); await page.waitForTimeout(100);
  assert.equal(await page.getByRole('article', { name: 'Other room task', exact: true }).count(), 0, 'Late prior-team response cannot replace the new snapshot.');
  assert.equal(await page.getByRole('article', { name: 'Ready result', exact: true }).count(), 0);
  await page.getByRole('navigation', { name: 'Fixture rooms', exact: true }).getByRole('button', { name: 'Fixture studio', exact: true }).click();
  await page.getByRole('tab', { name: /Work.*3 need you.*4 working/ }).waitFor(); await workTab.click();
  assert.equal(await page.locator('details.bot-work-history').evaluate(element => element.open), false, 'History disclosure resets when changing teams.');
  failActivity = true;
  await page.getByRole('navigation', { name: 'Fixture rooms', exact: true }).getByRole('button', { name: 'Second room', exact: true }).click();
  await page.getByRole('tab', { name: /Work.*Unavailable/ }).waitFor(); await workTab.click();
  await page.getByText('Fixture work is temporarily unavailable.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Current team work', exact: true }).count(), 0, 'An initial failed read cannot claim there are no current tasks.');
  assert.equal(await page.getByText('Nothing needs your attention right now.', { exact: true }).count(), 0);
  failActivity = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('article', { name: 'Fresh second-room task', exact: true }).waitFor();
  rows = Array.from({ length: 32 }, (_, index) => task(`Earlier turn ${index + 1}`, index === 0 ? 'interrupted' : 'blocked', index === 0 ? 'interrupted' : 'completed', { legacy: true }));
  await page.getByRole('navigation', { name: 'Fixture rooms', exact: true }).getByRole('button', { name: 'Fixture studio', exact: true }).click();
  await page.getByRole('tab', { name: /Work.*0 need you.*0 working/ }).waitFor(); await workTab.click();
  await current.getByText('No current tasks are tracked.', { exact: true }).waitFor();
  await current.getByText('32 earlier turns have no verified result.', { exact: true }).waitFor();
  assert.equal(await current.locator('details.bot-work-history').evaluate(element => element.open), false);
  assert.equal(await current.getByText('Nothing needs your attention right now.', { exact: true }).count(), 0);
  await page.setViewportSize({ width: 1440, height: 1100 }); await current.getByText('No current tasks are tracked.', { exact: true }).scrollIntoViewIfNeeded(); await screenshot('earlier-unverified-notice-wide');
  await page.setViewportSize({ width: 760, height: 1100 }); await current.getByRole('button', { name: 'Review earlier work', exact: true }).scrollIntoViewIfNeeded(); await screenshot('earlier-unverified-notice-compact');
  await current.getByRole('button', { name: 'Review earlier work', exact: true }).click();
  assert.equal(await current.locator('details.bot-work-history').evaluate(element => element.open), true);
  assert.equal(await current.getByRole('article').count(), 32, 'The explicit review entry reveals every retained record without creating current work.');
  await page.setViewportSize({ width: 1440, height: 1100 }); await screenshot('earlier-unverified-review-entry');
  failActivity = true; await page.getByText('Fixture work is temporarily unavailable.', { exact: true }).waitFor();
  await current.getByText('At the last check, no current tasks were tracked.', { exact: true }).waitFor();
  await current.getByText('32 earlier turns have no verified result.', { exact: true }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual(unexpected, []); assert.ok(calls.every(call => call.method === 'GET'));
  if (evidenceDirectory) writeFileSync(join(evidenceDirectory, 'report.json'), JSON.stringify({ passed: true, scope: 'Actual BotTeamPanel and current-work overview with inert HTTP fixture', modelPrompts: 0, ownerMutations: 0, browserErrors: errors, screenshots: 6, requests: calls }, null, 2) + '\n');
});
