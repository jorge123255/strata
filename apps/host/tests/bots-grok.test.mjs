import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { grokCatalog, grokModelMetadata, grokModels } from '../server/bots-runtime/grok.mjs';
import { createBotRuntime } from '../server/bots-runtime/index.mjs';

const root = await mkdtemp(join(tmpdir(), 'strata-grok-'));
test.after(() => rm(root, { recursive: true, force: true }));
const listing = 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n';
const metadata = { models: { 'grok-4.7': { info: { id: 'grok-4.7', name: 'Grok 4.7', reasoning_efforts: [{ id: 'high', default: true }, { value: 'low' }, { id: 'high' }], reasoning_effort: 'high', api_key: 'nested-secret' }, api_key: 'native-cache-secret', env_key: 'PRIVATE_ENV_KEY', api_base_url: 'https://private.example' }, 'not-in-account': { info: { id: 'not-in-account', name: 'Must not add this' } } }, identity: 'private-account-identity' };

async function fixture(name, { output = listing, exitCode = 0, cache = metadata, delay = 0 } = {}) {
  const directory = join(root, name); await mkdir(directory, { recursive: true });
  const home = join(directory, '.grok'); await mkdir(home);
  if (cache !== null) await writeFile(join(home, 'models_cache.json'), JSON.stringify(cache));
  const log = join(directory, 'argv.json'), program = join(directory, 'grok.mjs');
  await writeFile(program, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));setTimeout(()=>{process.stdout.write(${JSON.stringify(output)});process.exit(${exitCode});},${delay});`);
  const children = [];
  return { stateDir: join(directory, 'state'), env: { HOME: directory, GROK_HOME: home, PATH: '' }, log, home, children, spawnProcess: (_command, args, options) => { const child = spawn(process.execPath, [program, ...args], options); children.push(child); return child; } };
}

test('native listing supplies current account models and default without static guesses', () => {
  const result = grokCatalog(listing + '  - grok-4.7\n  - not a valid ID\n');
  assert.equal(result.authState, 'signed_in');
  assert.deepEqual(result.models.map(row => row.id), ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']);
  assert.equal(result.models.filter(row => row.isDefault).length, 1);
  assert.equal(result.models[0].isDefault, true);
  assert.deepEqual(grokCatalog('\u001b[32m' + listing + '\u001b[0m').models, result.models);
  assert.deepEqual(grokCatalog('You are not logged in. Run grok login.\n'), { models: [], authState: 'signed_out' });
  assert.throws(() => grokCatalog('unrecognized native-cache-secret'), error => !error.message.includes('native-cache-secret'));
});

test('only whitelisted model metadata is projected; cache cannot add an account model or expose credentials', () => {
  const rows = grokModelMetadata(metadata, grokCatalog(listing).models);
  assert.deepEqual(rows[0], { id: 'grok-4.7', name: 'Grok 4.7', efforts: ['high', 'low'], defaultEffort: 'high', isDefault: true });
  assert.equal(rows.length, 4);
  for (const secret of ['nested-secret', 'native-cache-secret', 'PRIVATE_ENV_KEY', 'private-account-identity', 'private.example', 'not-in-account']) assert.equal(JSON.stringify(rows).includes(secret), false);
  assert.deepEqual(grokModelMetadata({ models: [{ info: { id: 'grok-4.5', name: 'Legacy', reasoning_efforts: ['low', 'high', 'bad effort'], reasoning_effort: 'unsupported' } }] }, [{ id: 'grok-4.5', name: 'grok-4.5', efforts: [] }]), [{ id: 'grok-4.5', name: 'Legacy', efforts: ['low', 'high'] }]);
});

test('native discovery invokes models only and merges verified metadata without opening a session', async () => {
  const settings = await fixture('catalog');
  const result = await grokModels('/fixture/grok', settings);
  assert.deepEqual(JSON.parse(await readFile(settings.log, 'utf8')), ['models']);
  assert.equal(result.authState, 'signed_in');
  assert.deepEqual(result.models[0].efforts, ['high', 'low']);
  assert.equal(settings.children.every(child => child.exitCode === 0), true);
});

test('bad or symlinked native cache keeps the verified list without invented effort', async () => {
  const settings = await fixture('bad-cache', { cache: null });
  const cache = join(settings.home, 'models_cache.json');
  await writeFile(cache, '{broken');
  assert.deepEqual((await grokModels('/fixture/grok', settings)).models[0].efforts, []);
  await rm(cache); const elsewhere = join(root, 'elsewhere.json'); await writeFile(elsewhere, JSON.stringify(metadata)); await symlink(elsewhere, cache);
  assert.deepEqual((await grokModels('/fixture/grok', settings)).models[0].efforts, []);
});

test('runtime exposes Grok models and signed-in availability while keeping the installed CLI account', async () => {
  const settings = await fixture('runtime');
  const missing = Object.fromEntries(['claude', 'codex', 'kimi', 'ollama', 'devin'].map(id => [id, '/not-installed']));
  const runtime = createBotRuntime({ ...settings, commands: { ...missing, grok: '/fixture/grok' }, fetch: async () => { throw new Error('No network in fixture'); } });
  try {
    const catalog = await runtime.models('grok');
    assert.equal(catalog.models[0].name, 'Grok 4.7');
    catalog.models[0].efforts.push('injected');
    assert.deepEqual((await runtime.models('grok')).models[0].efforts, ['high', 'low']);
    const provider = (await runtime.providers()).find(row => row.id === 'grok');
    assert.equal(provider.installed, true); assert.equal(provider.ready, true); assert.equal(provider.auth.state, 'signed_in');
    assert.equal(provider.catalogSource, 'native-cli');
    assert.deepEqual(provider.models, ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']);
    assert.equal(JSON.stringify(provider).includes('native-cache-secret'), false);
  } finally { await runtime.close(); }
});

test('signed-out Grok is reported as signed out without exposing native account output', async () => {
  const settings = await fixture('signed-out', { output: 'You are not logged in.\nprivate-native-data\n' });
  const runtime = createBotRuntime({ ...settings, commands: Object.fromEntries(['claude', 'codex', 'grok', 'kimi', 'ollama', 'devin'].map(id => [id, '/fixture/grok'])), fetch: async () => { throw new Error('offline'); } });
  try {
    assert.equal((await runtime.models('grok')).authState, 'signed_out');
    const grok = (await runtime.providers()).find(row => row.id === 'grok');
    assert.equal(grok.ready, false); assert.equal(grok.auth.state, 'signed_out');
    assert.equal(JSON.stringify(grok).includes('private-native-data'), false);
  } finally { await runtime.close(); }
});

test('failed native listing stays generic and leaves Provider default available', async () => {
  const settings = await fixture('failed', { output: 'Bearer private-provider-token native-cache-secret', exitCode: 1 });
  const runtime = createBotRuntime({ ...settings, commands: { grok: '/fixture/grok' } });
  try {
    const result = await runtime.models('grok');
    assert.deepEqual(result.models, []); assert.match(result.detail, /Provider default remains available/);
    for (const value of ['private-provider-token', 'native-cache-secret']) assert.equal(JSON.stringify(result).includes(value), false);
  } finally { await runtime.close(); }
});

test('catalog timeout and cancellation close only the owned native process', async () => {
  const timed = await fixture('timeout', { delay: 30_000 });
  await assert.rejects(grokModels('/fixture/grok', { ...timed, timeoutMs: 40 }), /Could not load/);
  assert.equal(timed.children[0].signalCode, 'SIGTERM');
  const cancelled = await fixture('cancel', { delay: 30_000 }), controller = new AbortController();
  const pending = grokModels('/fixture/grok', { ...cancelled, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled.children[0].signalCode, 'SIGTERM');
});
