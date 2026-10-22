/** Actual supervision UI, isolated data and Chromium. Never contacts an owned host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
test('harness timings and exact action review are visible without running or resuming work', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 60_000 }, async t => {
  const generated = await build({ absWorkingDir: root, stdin: { contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BotSupervision}from ${JSON.stringify(join(root, 'src/components/BotSupervision.tsx'))};import{BotHarnessActions}from ${JSON.stringify(join(root,'src/screens/BotHarnessActions.tsx'))};function App(){const[data,setData]=useState(window.fixture.snapshot),[stale,setStale]=useState(false);window.updateSnapshot=(data,stale)=>{setData(data);setStale(stale)};return <main><BotSupervision snapshot={data} bots={window.fixture.bots} stale={stale} onOpen={id=>window.opened.push(id)}/><BotHarnessActions onOpen={async id=>{window.opened.push(id)}}/></main>}createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: 'out', metafile: true, jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' }, plugins:[{name:'inert-store',setup(b){b.onResolve({filter:/(?:^|\/)store$/},args=>args.importer.includes('/src/')?{path:'store',namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const useStore=selector=>selector({});export const dismissActionError=()=>{},dismissToast=()=>{},holdToast=()=>{},releaseToast=()=>{};',loader:'js'}));}}] });
  const script = generated.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css'].map(path => readFileSync(join(root, 'src', path), 'utf8')).join('\n') + generated.outputFiles.find(file => file.path.endsWith('.css')).text;
  const at = new Date().toISOString(), row = (id, state, patch = {}) => ({ id, botId: 'bot_fixture', name: 'Builder', title: id, state, approvalCount: state === 'approval' ? 1 : 0, updatedAt: at, ...patch });
  const receipt={id:'ba_'+'a'.repeat(64),chatId:'s_receipt',toolName:'run_command',state:'uncertain',revision:2,proof:'b'.repeat(64),origin:'local',readOnly:false};let acked=false, journalAvailable=true;
  const harness={phase:'tool',elapsedMs:2500,firstOutputMs:400,timings:{startingMs:100,modelMs:2000,approvalMs:0,toolMs:400,cleanupMs:0},toolCalls:2,toolErrors:0,contextCompactions:1};
  const snapshot = { supported: true, sessions: [row('s_waiting', 'approval'), row('s_error', 'error'), row('s_working', 'working', { harness, toolName: 'browser_click', teamId: 'team_fixture', parentChatId: 's_parent', computerName: 'Remote Strata' }), row('s_thinking', 'thinking'), row('s_done', 'completed')], counts: { waiting: 1, working: 2, completed: 1, errors: 1 }, hasMore: false };
  const fixture = { snapshot, bots: [{ id: 'bot_fixture', name: 'Builder', avatarConfig: { shape: 'hexagon', color: 'sky', eyes: 'round', ears: 'round' } }] };
  const evidence = process.env.STRATA_SUPERVISION_EVIDENCE ? resolve(process.env.STRATA_SUPERVISION_EVIDENCE) : mkdtempSync(join(tmpdir(), 'strata-supervision-ui-'));
  mkdirSync(evidence, { recursive: true });
  const ephemeral = !process.env.STRATA_SUPERVISION_EVIDENCE;
  const requests = [], external = [], errors = [];
  const server = http.createServer(async(req, res) => {
    requests.push({ method: req.method, path: req.url });
    if(req.url==='/fixture-unavailable'){journalAvailable=false;res.end('ok');return;}
    if(req.url==='/fixture-available'){journalAvailable=true;res.end('ok');return;}
    if(req.url==='/api/bots/harness/actions'){res.setHeader('content-type','application/json');res.end(JSON.stringify({available:journalAvailable,actions:acked?[]:[receipt],counts:{uncertain:acked?0:1},hasMore:false}));return;}
    if(req.url===`/api/bots/harness/actions/${receipt.id}/review`&&req.method==='POST'){let raw='';for await(const c of req)raw+=c;assert.deepEqual(JSON.parse(raw),{expectedRevision:receipt.revision,expectedProof:receipt.proof,decision:'acknowledge'});acked=true;res.setHeader('content-type','application/json');res.end(JSON.stringify({acknowledged:true,action:{...receipt,state:'reviewed',revision:receipt.revision+1,proof:'c'.repeat(64)},resumed:false,retried:false}));return;}
    if (req.url === '/bundle.js') { res.setHeader('content-type','text/javascript'); res.end(script); }
    else if (req.url === '/icons/sprite.svg') { res.setHeader('content-type','image/svg+xml'); res.end(readFileSync(join(root, 'public/icons/sprite.svg'))); }
    else if (req.url === '/style.css') { res.setHeader('content-type','text/css'); res.end(css); }
    else if (req.url === '/') { res.setHeader('content-type','text/html'); res.end(`<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="/style.css"><style>body,html{height:auto!important;overflow:visible!important}#root,main{height:auto!important;max-height:none!important;min-height:100vh;overflow:visible!important}main{max-width:1100px;padding:32px;margin:auto}button{font-family:inherit}</style></head><body><div id="root"></div><script>window.fixture=${JSON.stringify(fixture)};window.opened=[]</script><script src="/bundle.js"></script></body></html>`); }
    else { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (ephemeral) rmSync(evidence, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await page.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading', { name: '1 conversation waiting for you' }).waitFor();
  assert.equal(await page.locator('.bot-supervision-card').count(), 5);
  await page.locator('.bot-harness-details summary').click();await page.getByText('First response',{exact:true}).waitFor();await page.getByText('0.4s',{exact:true}).first().waitFor();
  await page.screenshot({ path: join(evidence, 'supervision-all-dark.png'), fullPage: true });
  const needs = page.getByRole('button', { name: 'Needs you 2', exact: true });
  await needs.focus(); await page.keyboard.press('Enter');
  assert.equal(await needs.getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('.bot-supervision-card').count(), 2);
  await page.getByRole('button', { name: 'Review approval', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.opened), ['s_waiting']);
  await page.getByRole('button', { name: 'Working 2', exact: true }).click();
  assert.equal(await page.locator('.bot-supervision-card').count(), 2);
  await page.getByText('Subagent · Remote Strata', { exact: true }).waitFor();
  await page.getByText('browser click', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open conversation', exact: true }).first().click();
  assert.deepEqual(await page.evaluate(() => window.opened), ['s_waiting','s_working']);
  const cleared = { ...snapshot, sessions: snapshot.sessions.filter(row => row.id !== 's_waiting'), counts: { ...snapshot.counts, waiting: 0 } };
  await page.evaluate(value => window.updateSnapshot(value, true), cleared);
  await page.getByText('Last known activity', { exact: true }).waitFor();
  await page.getByText('Last known: Using a tool', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Needs you 1', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Review approval' }).count(), 0);
  await page.setViewportSize({ width: 820, height: 900 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(evidence, 'supervision-stale-compact.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await page.evaluate(()=>fetch('/fixture-unavailable'));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByRole('status').filter({hasText:'action journal is unavailable'}).waitFor();assert.equal(await page.getByRole('button',{name:'Record review…',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Inspect conversation',exact:true}).isEnabled(),true);await page.evaluate(()=>fetch('/fixture-available'));await page.getByRole('button',{name:'Refresh receipts',exact:true}).click();await page.getByRole('button',{name:'Record review…',exact:true}).waitFor();
  await page.getByRole('button',{name:'Record review…',exact:true}).click();assert.equal(requests.some(r=>r.method==='POST'),false);await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(requests.some(r=>r.method==='POST'),false);
  await page.getByRole('button',{name:'Inspect conversation',exact:true}).click();assert.equal((await page.evaluate(()=>window.opened)).at(-1),'s_receipt');
  await page.getByRole('button',{name:'Record review…',exact:true}).click();await page.getByRole('button',{name:'I reviewed the conversation',exact:true}).click();await page.getByRole('button',{name:'Record review…',exact:true}).waitFor({state:'hidden'});assert.equal(acked,true);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const inputs = Object.fromEntries(Object.keys(generated.metafile.inputs).filter(path => path !== '<stdin>' && !path.startsWith('fixture:')).map(path => { const file = resolve(root, path); return [file, hash(readFileSync(file))]; }));
  for (const path of ['src/styles/kit/tokens.css','src/styles/kit/components.css','src/styles/app.css','public/icons/sprite.svg','tests/bots-harness-browser.test.mjs']) inputs[join(root,path)] = hash(readFileSync(join(root,path)));
  writeFileSync(join(evidence, 'report.json'), JSON.stringify({ passed: true, browser: await browser.version(), externalRequests: external, pageErrors: errors, requests, inputSHA256: inputs, scriptSHA256: hash(script), cssSHA256: hash(css), checks: ['actual shipped component','5 exact states','keyboard attention filter','exact approval conversation ID','working subagent context','no implicit actions','cleared approval','last-known stale status','820px no horizontal overflow','reduced motion'] }, null, 2));
  assert.deepEqual(external, []); assert.deepEqual(errors, []); assert.deepEqual(requests.filter(r=>r.method!=='GET'),[{method:'POST',path:`/api/bots/harness/actions/${receipt.id}/review`}]);
});
