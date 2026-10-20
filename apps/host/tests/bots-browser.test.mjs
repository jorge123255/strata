/** Real Bots screen with disposable HTTP fixtures; no real account, bot or computer is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(value => value && existsSync(value));
const skip = executablePath ? false : 'Set STRATA_UI_BROWSER to installed Chromium; no browser is downloaded.';

test('Mac Bots creates profiles without work, preserves provider and target choices, and opens shared history', { skip, timeout: 45_000 }, async t => {
  const source = join(root, 'src');
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BotsScreen} from ${JSON.stringify(join(source, 'screens/Bots.tsx'))};
    window.botFixtureCalls=[]; window.botFixtureState={sessions:[{id:'existing-chat',title:'Existing work',updatedAt:'2026-10-20T12:00:00Z',preferences:{botId:'existing'},messages:[]}],workspaces:[{id:'workspace',path:'/fixture/project'}],activeWorkspace:'workspace',workspacePath:'/fixture/project'};
    createRoot(document.getElementById('root')).render(<main className="main" style={{height:'100dvh'}}><BotsScreen/></main>);`;
  const { outputFiles } = await build({ stdin: { contents: entry, resolveDir: source, loader: 'tsx' }, bundle: true, write: false, outfile: 'harness.js', format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'isolated-bot-store', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)store$/ }, args => args.importer.includes('/src/') ? { path: 'fixture-store', namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const useStore=s=>s(window.botFixtureState);export const adoptSharedConversation=conversation=>window.botFixtureCalls.push(['adopt',conversation]);export const selectSession=id=>window.botFixtureCalls.push(['select',id]);export const pickWorkspace=async()=>'/fixture/chosen';export const dismissActionError=()=>{},dismissToast=()=>{},holdToast=()=>{},releaseToast=()=>{};`, loader: 'js' }));
  } }] });
  const script = outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css', 'styles/kit/components.css', 'styles/app.css', 'styles/annotation-fixes.css'].map(path => readFileSync(join(source, path), 'utf8')).join('\n') + '\n' + (outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '');
  const at = '2026-10-20T12:00:00Z';
  let profiles = [{ id: 'existing', name: 'Project partner', instructions: 'Review code and use the browser when needed.', provider: 'codex', model: '', capabilities: 'both', policy: 'manual', workspace: '/fixture/project', execution: { kind: 'local' }, createdAt: at, updatedAt: at, available: true }];
  const providers = [['claude', 'Claude Code'], ['codex', 'Codex'], ['grok', 'Grok'], ['kimi', 'Kimi'], ['ollama', 'Ollama Cloud']].map(([id, name]) => ({ id, name, available: id === 'codex', detail: id === 'codex' ? 'Installed CLI is available.' : 'Sign in to the provider on this computer.' }));
  const computers = [{ id: 'local', kind: 'local', name: 'This Mac', available: true, detail: 'Local execution computer.' }, { id: 'ssh', kind: 'ssh', name: 'SSH computer', available: false, detail: 'A remote bot runtime must be configured before work can start.' }];
  const calls = [], errors = [], blocked = [];
  const respond = (res, body, status = 200, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') return respond(res, '<!doctype html><html data-theme="dark" data-motion="reduced"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script src="/harness.js"></script>', 200, 'text/html');
    if (path === '/harness.js') return respond(res, script, 200, 'text/javascript');
    if (path === '/harness.css') return respond(res, css, 200, 'text/css');
    if (path === '/icons/sprite.svg') return respond(res, readFileSync(join(root, 'public/icons/sprite.svg')), 200, 'image/svg+xml');
    if (/^\/fonts\/GTWalsheimPro-(Regular|Medium|Bold|Black)\.woff2$/.test(path)) return respond(res, readFileSync(join(root, 'public', path)), 200, 'font/woff2');
    if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    let input = ''; for await (const chunk of req) input += chunk;
    const body = input ? JSON.parse(input) : undefined; calls.push({ path, method: req.method, body });
    if (path === '/api/bots' && req.method === 'GET') return respond(res, { bots: profiles, providers, computers });
    if (path === '/api/bots' && req.method === 'POST') { const bot = { ...body, id: 'created', createdAt: at, updatedAt: at, available: false }; profiles = [bot, ...profiles]; return respond(res, { bot }); }
    if (path === '/api/bots/created' && req.method === 'PATCH') { const bot = { ...profiles.find(profile => profile.id === 'created'), ...body }; profiles = profiles.map(profile => profile.id === 'created' ? bot : profile); return respond(res, { bot }); }
    if (path === '/api/bots/created/conversations') return respond(res, { error: 'Configure the remote bot runtime before starting a conversation.' }, 409);
    if (path === '/api/bots/existing/conversations') return respond(res, { conversation: { id: 'new-shared-chat', preferences: { botId: 'existing', botName: 'Project partner' }, messages: [] } });
    return respond(res, { error: 'Unexpected fixture request' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1320, height: 1000 }, colorScheme: 'dark' }); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push(route.request().url()), route.abort()));
  async function screenshot(name) { const directory = process.env.STRATA_BOTS_UI_EVIDENCE_DIR; if (directory) { mkdirSync(directory, { recursive: true }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await page.screenshot({ path: join(directory, `${name}.png`) }); } }
  await page.goto(origin + '/#/bots');
  await page.getByRole('heading', { name: 'Project partner', exact: true }).waitFor();
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0, 'Opening Bots does no work.');
  await page.locator('.bots-providers > summary').click();
  for (const provider of providers) await page.locator('.bots-provider').getByText(provider.name, { exact: true }).waitFor();
  await screenshot('bots-dark');
  await page.getByRole('button', { name: 'New bot', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New bot', exact: true });
  await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Remote developer');
  await editor.getByRole('combobox', { name: 'Bot provider', exact: true }).click();
  await page.getByRole('option', { name: 'Grok', exact: true }).click();
  await editor.getByRole('combobox', { name: 'Bot execution computer', exact: true }).click();
  await page.getByRole('option', { name: 'SSH computer', exact: true }).click();
  await editor.getByRole('textbox', { name: 'SSH host or alias', exact: true }).fill('my-server');
  await editor.getByRole('textbox', { name: 'SSH user', exact: true }).fill('another-user');
  await editor.getByRole('spinbutton', { name: 'SSH port', exact: true }).fill('2222');
  await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Review this project and help with browser checks.');
  await editor.locator('.dialog-body').evaluate(element => { element.scrollTop = 0; });
  await screenshot('bot-editor-ssh');
  await editor.getByRole('button', { name: 'Save bot', exact: true }).click();
  await page.getByRole('heading', { name: 'Remote developer', exact: true }).waitFor();
  const created = calls.find(call => call.path === '/api/bots' && call.method === 'POST');
  assert.deepEqual(created.body.execution, { kind: 'ssh', host: 'my-server', user: 'another-user', port: 2222 });
  assert.equal(created.body.provider, 'grok'); assert.equal(created.body.capabilities, 'both'); assert.equal(created.body.policy, 'manual');
  assert.equal(calls.some(call => call.path.endsWith('/conversations')), false, 'Saving starts no conversation or provider turn.');
  const remote = page.locator('.bot-card').filter({ has: page.getByRole('heading', { name: 'Remote developer', exact: true }) });
  await remote.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByText('Configure the remote bot runtime before starting a conversation.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.botFixtureCalls.length), 0, 'A failed capability check opens no fabricated chat.');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await screenshot('bots-light');
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.bots-providers > summary').click(); await screenshot('bots-mobile');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'The Bots screen fits a phone-width web view.');
  const existing = page.locator('.bot-card').filter({ has: page.getByRole('heading', { name: 'Project partner', exact: true }) });
  await existing.getByRole('button', { name: 'Continue', exact: true }).click();
  assert.equal(await page.evaluate(() => window.location.hash), '#/chat/existing-chat');
  await page.goto(origin + '/#/bots');
  await page.locator('.bot-card').filter({ has: page.getByRole('heading', { name: 'Project partner', exact: true }) }).getByRole('button', { name: 'New chat', exact: true }).click();
  await page.waitForURL('**/#/chat/new-shared-chat');
  assert.equal(await page.evaluate(() => window.location.hash), '#/chat/new-shared-chat');
  assert.deepEqual(await page.evaluate(() => window.botFixtureCalls.slice(-2).map(call => call[0])), ['adopt', 'select']);
  assert.equal(calls.some(call => /\/messages$|\/model-providers|\/native/.test(call.path)), false);
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
});
