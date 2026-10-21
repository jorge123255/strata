/** Actual SVG motion in installed Chromium; no provider, account or computer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
test('avatar motion follows activity and visibility without idle roster timers', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 30_000 }, async t => {
  const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{CuaBotAvatar,CuaBotAvatarPicker,CUA_BOT_SHAPES}from${JSON.stringify(join(root, 'src/components/CuaBotAvatar.tsx'))};
    function Fixture(){const[mood,setMood]=useState('idle'),[signal,setSignal]=useState(0),[config,setConfig]=useState({color:'sky',eyes:'round',ears:'small',shape:'orb'});window.avatarFixture={setMood,setSignal,config};return <main>
      <h1>Strata faces</h1><div id="roster"><CuaBotAvatar name="Roster" size={34}/></div>
      <div id="hero"><CuaBotAvatar name="Partner" config={config} size={120} mood={mood} messageSignal={signal}/></div>
      <div id="working"><CuaBotAvatar name="Working" size={90} mood="working"/></div>
      <div id="families">{['koala','fox','cat','robot'].map(kind=><CuaBotAvatar key={kind} name={kind} size={90} config={{kind,color:'sky',eyes:'round',ears:'round'}} animated={false}/>)}</div>
      <div id="geometry" style={{display:"flex",gap:12}}>{CUA_BOT_SHAPES.map(shape=><CuaBotAvatar key={shape} name={shape} config={{...config,shape,eyes:"round"}} size={90} animated={false}/>)}</div>
      <details id="picker"><summary>Choose a character</summary><CuaBotAvatarPicker value={config} shapes={CUA_BOT_SHAPES} onChange={setConfig}/></details>
      <div id="away" style={{marginTop:2000}}><CuaBotAvatar name="Offscreen" size={100} mood="thinking"/></div></main>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const { outputFiles } = await build({ stdin: { contents: entry, resolveDir: join(root, 'src'), loader: 'tsx' }, bundle: true, write: false, outfile: 'avatar.js', jsx: 'automatic', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [];
  const server = http.createServer((req, res) => {
    const file = req.url === '/avatar.js' ? outputFiles.find(item => item.path.endsWith('.js')) : req.url === '/avatar.css' ? outputFiles.find(item => item.path.endsWith('.css')) : null;
    if (file) { res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : 'text/css' }); return res.end(file.text); }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><html data-motion="system"><meta charset="utf-8"><link rel="stylesheet" href="/avatar.css"><style>body{margin:32px;background:#111;color:#eee;font:14px system-ui}main>div{margin:20px 0}#families{display:flex;gap:20px}</style><div id="root"></div><script src="/avatar.js"></script>'); }
    res.writeHead(204); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 800 }, reducedMotion: 'no-preference' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => { window.avatarIntervals = 0; const interval = window.setInterval; window.setInterval = (...args) => { window.avatarIntervals++; return interval(...args); }; });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#working svg')?.dataset.motion === 'active');
  assert.equal(await page.locator('#roster svg').evaluate(node => node.getAnimations({ subtree: true }).length), 0, 'Idle roster faces have no continuing animation.');
  assert.equal(await page.evaluate(() => window.avatarIntervals), 0, 'No avatar uses a React frame interval.');
  assert.equal(await page.locator('#away svg').getAttribute('data-motion'), 'paused');
  assert.equal(await page.locator('#away svg').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
  assert.ok(await page.locator('#working svg').evaluate(node => node.getAnimations({ subtree: true }).length) > 0);
  const face = page.locator('#hero svg'), bounds = await face.boundingBox();
  assert.equal(await face.getAttribute('data-shape'),'orb');
  assert.equal(await face.locator('path').count(),2,'Geometric face and clipping path have no animal details.');
  await page.mouse.move(bounds.x + bounds.width * .8, bounds.y + bounds.height * .4);
  await page.waitForFunction(() => document.querySelector('#hero svg')?.style.getPropertyValue('--cua-gaze-x') !== '');
  await face.click();
  assert.ok(await face.evaluate(node => node.getAnimations().length) > 0, 'Tapping creates a bounded flourish.');
  await page.waitForFunction(() => document.querySelector('#hero svg').getAnimations().length === 0);
  await page.evaluate(() => window.avatarFixture.setSignal(1));
  await page.waitForFunction(() => document.querySelector('#hero svg').getAnimations().length > 0);
  await page.waitForFunction(() => document.querySelector('#hero svg').getAnimations().length === 0);
  await page.locator('#away').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#away svg')?.dataset.motion === 'active' && document.querySelector('#working svg')?.dataset.motion === 'paused');
  assert.equal(await page.locator('#working svg').evaluate(node => node.getAnimations({ subtree: true }).length), 0, 'Leaving the viewport stops working animation.');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('#away svg')?.dataset.motion === 'paused');
  assert.equal(await page.locator('#away svg').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.querySelector('#away svg')?.dataset.motion === 'active');
  await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
  await page.waitForFunction(() => document.querySelector('#away svg')?.dataset.motion === 'paused');
  await page.evaluate(() => { document.documentElement.dataset.motion = 'system'; window.syntheticHidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.syntheticHidden }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#away svg')?.dataset.motion === 'paused');
  assert.equal(await page.locator('#away svg').evaluate(node => node.getAnimations({ subtree: true }).length), 0, 'Background documents stop motion.');
  await page.evaluate(() => { window.syntheticHidden = false; document.dispatchEvent(new Event('visibilitychange')); window.scrollTo(0, 0); });
  await page.waitForFunction(() => document.querySelector('#working svg')?.dataset.motion === 'active');
  await page.locator('#picker summary').click();
  const picker=page.locator('#picker');
  assert.equal(await picker.getByRole('button',{name:'Small',exact:true}).count(),0);
  await picker.getByRole('button',{name:'Fox',exact:true}).click();
  await page.waitForFunction(()=>window.avatarFixture.config.shape==='classic');
  assert.equal(await picker.getByRole('button',{name:'Small',exact:true}).getAttribute('aria-pressed'),'true','Geometry retains the saved ear style when returning to animals.');
  assert.equal(await face.getAttribute('data-character'),'fox');
  await picker.getByRole('button',{name:'Hexagon',exact:true}).click();
  assert.equal(await face.getAttribute('data-shape'),'hexagon');
  assert.equal(await picker.getByRole('button',{name:'Small',exact:true}).count(),0);
  await page.locator('#picker summary').click();
  const directory = process.env.STRATA_BOTS_UI_EVIDENCE_DIR;
  if (directory) { mkdirSync(directory, { recursive: true }); await page.screenshot({ path: join(directory, 'avatar-motion-families.png') }); await page.locator('#geometry').screenshot({path:join(directory,'avatar-geometric-families.png')}); }
  assert.deepEqual(errors, []);
});
