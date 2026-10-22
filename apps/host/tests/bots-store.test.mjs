/** Exercise the real desktop store against controlled host responses, with no provider process. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/store.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'controlled-bot-client', setup(builder) {
  builder.onResolve({ filter: /(?:^|\/)client$/ }, args => args.importer.includes('/src/') ? { path: 'controlled-client', namespace: 'controlled-client' } : undefined);
  builder.onLoad({ filter: /.*/, namespace: 'controlled-client' }, () => ({ contents: `export const api=harness.api; export const onEvent=(...args)=>harness.onEvent(...args); export const streamPost=(...args)=>harness.streamPost(...args); export class ApiError extends Error {}`, loader: 'js' }));
} }] });
const at = '2026-10-20T12:00:00.000Z';
const session = () => ({ id: 'bot-chat', title: 'Builder', workspace: '/fixture/project', revision: 1, active: false, createdAt: at, updatedAt: at, tokensIn: 0, tokensOut: 0, preferences: { botId: 'builder', botName: 'Builder', mode: 'manual' }, messages: [] });

async function fixture(t, initial = session()) {
  let event, send;
  const calls = [], model = { connectionId: 'maya', modelId: 'Maya-S24' };
  const values = new Map([['strata.sessions.v1', JSON.stringify([initial])]]);
  const api = async (method, path, body) => {
    calls.push({ method, path, body: structuredClone(body) });
    if (path.endsWith('/messages')) return send(body);
    if (path === '/api/companion/conversations' || path === '/api/companion/conversations?summary=1') return { available: true, conversations: [initial] };
    if (path.endsWith('/sync')) return { results: [] };
    const fixtures = { '/api/setup': { complete: true }, '/api/models': { variants: [] }, '/api/skills': [], '/api/workspaces': { workspaces: [{ id: 'w', path: '/fixture/project', name: 'Project' }] }, '/api/runtime': { instances: [] }, '/api/serving': { stats: { running: 0, waiting: 0 }, revision: 1 }, '/api/model-providers': { connections: [{ id: 'maya', protocol: 'openai-chat', models: [{ id: 'Maya-S24' }] }] } };
    return fixtures[path] ?? {};
  };
  const harness = { api: Object.fromEntries(['get', 'post', 'patch', 'put', 'del'].map(method => [method, (path, body) => api(method, path, body)])), onEvent: handler => { event = handler; return () => {}; }, streamPost: () => { throw new Error('A bot must not use the local model stream'); } };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'harness', 'localStorage', 'sessionStorage', 'window', 'document', 'matchMedia', 'navigator', outputFiles[0].text)(createRequire(import.meta.url), module, module.exports, harness,
    { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }, { getItem: () => null, setItem() {} }, { location: { hash: '#/chat/bot-chat' }, addEventListener() {}, removeEventListener() {} },
    { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null }, () => ({ matches: false, addEventListener() {} }), { language: 'en' });
  const store = module.exports;
  await store.bootstrap(); store.selectSession(initial.id);
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 350)); for (const toast of store.getState().toasts) store.holdToast(toast.id); });
  return { store, calls, model, sendWith: operation => { send = operation; }, emit: conversation => event({ event: 'conversation', data: { conversation } }) };
}

test('bot sends use the shared host once with no local model, and retain host history and thinking', async t => {
  const f = await fixture(t);
  f.sendWith(async body => ({ conversation: { ...session(), revision: 2, active: true, messages: [{ id: 'u', role: 'user', at, content: body.message }, { id: 'a', role: 'assistant', at, content: '', streaming: true }] } }));
  assert.equal(await f.store.sendMessage('Build this project'), true);
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/messages')), [{ method: 'post', path: '/api/companion/conversations/bot-chat/messages', body: { message: 'Build this project' } }]);
  assert.equal(f.store.getState().streaming, true);
  const canonical = { ...session(), revision: 3, messages: [{ id: 'u', role: 'user', at, content: 'Build this project' }, { id: 'a', role: 'assistant', at, content: 'Done', reasoning: 'Checked the project files.', streaming: false }] };
  f.emit(canonical);
  assert.deepEqual(f.store.getState().sessions.find(chat => chat.id === canonical.id).messages, canonical.messages);
  assert.equal(f.store.getState().streaming, false);
  f.store.selectRemoteModel(f.model);
  f.store.setChatPreferences('bot-chat', { mode: 'bypass', remoteModel: f.model });
  assert.equal(f.store.getState().remoteModel, null);
  assert.deepEqual(f.store.getState().sessions.find(chat => chat.id === canonical.id).preferences, canonical.preferences);
  assert.equal(f.store.branchFrom('u'), null, 'a native bot thread cannot become an unregistered local fork');
});

test('a duplicate send is blocked and a late POST snapshot cannot replace newer shared events', async t => {
  const f = await fixture(t);
  let release;
  f.sendWith(() => new Promise(resolve => { release = resolve; }));
  const sending = f.store.sendMessage('Work');
  assert.equal(await f.store.sendMessage('Duplicate'), false);
  const latest = { ...session(), revision: 5, messages: [{ id: 'a', role: 'assistant', at, content: 'Finished remotely', reasoning: 'A retained progress summary.' }] };
  f.emit(latest);
  release({ conversation: { ...session(), revision: 4, active: true, messages: [] } });
  assert.equal(await sending, true);
  assert.equal(f.calls.filter(call => call.path.endsWith('/messages')).length, 1);
  assert.equal(f.store.getState().sessions.find(chat => chat.id === latest.id).messages[0].content, 'Finished remotely');
  assert.equal(f.store.getState().streaming, false);
});

test('failed bot sends leave no invented messages or active turn', async t => {
  const f = await fixture(t);
  f.sendWith(async () => { throw new Error('Provider login required'); });
  assert.equal(await f.store.sendMessage('Keep this draft'), false);
  assert.deepEqual(f.store.getState().sessions.find(chat => chat.id === 'bot-chat').messages, []);
  assert.equal(f.store.getState().streaming, false);
  assert.match(f.store.getState().toasts.at(-1).body, /Provider login required/);
});

test('bot tool approvals go to the shared conversation instead of the local harness', async t => {
  const initial = { ...session(), active: true, messages: [{ id: 'a', role: 'assistant', at, content: '', tools: [{ id: 'call', name: 'shell', state: 'proposed', live: true }] }] };
  const f = await fixture(t, initial);
  f.store.resolveTool('a', 'call', true);
  await new Promise(resolve => setImmediate(resolve));
  const call = f.calls.find(call => call.path.endsWith('/approval'));
  assert.deepEqual(call, { method: 'post', path: '/api/companion/conversations/bot-chat/approval', body: { toolId: 'call', decision: 'approve' } });
  assert.equal(f.calls.some(call => call.path === '/api/chat/approval'), false);
});
