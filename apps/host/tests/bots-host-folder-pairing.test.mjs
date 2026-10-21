/** Actual TLS bridge -> HTTP host cancellation; disposable profiles and folders only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBots, createBotRoutes } from '../server/bots.mjs';
import { createBridge, HostClient } from '../../companion-bridge/bridge.mjs';

async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw Error('Fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(t, { holdNotificationCleanup = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'strata-folder-pairing-'))), folder = join(directory, 'project'); mkdirSync(folder);
  const bots = createBots({ directory: join(directory, 'host'), defaultWorkspace: () => directory,
    runtime: { providers: async () => [], run: () => assert.fail('No model work'), close() {} },
    tools: { definitions: () => [], finish() {}, close() {} } });
  let port, entered, resume, settled;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { resume = resolve; }), finished = new Promise(resolve => { settled = resolve; });
  let signal;
  let enteredNotification, resumeNotification;
  const notificationStarted = new Promise(resolve => { enteredNotification = resolve; });
  const notificationGate = new Promise(resolve => { resumeNotification = resolve; });
  const original = bots.setHostFolder;
  bots.setHostFolder = async (...args) => { signal = args[2]?.signal; entered(); await gate; try { return await original(...args); } finally { settled(); } };
  const routes = createBotRoutes({ bots, port: () => port });
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/bots/notifications/device') { enteredNotification(); if (holdNotificationCleanup) await notificationGate; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    await routes(req, res, new URL(req.url, `http://${req.headers.host}`));
    if (!res.headersSent) res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  const bridge = await createBridge({ directory: join(directory, 'pairing'), host: new HostClient({ upstream: `http://127.0.0.1:${port}` }), listen: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, adminPort: 0, qr: false });
  const owner = bridge.authority.pair(bridge.authority.code, 'Owner fixture phone');
  const bot = bots.create({ name: 'Isolated fixture', provider: 'codex', workspace: '/workspace', computerMode: 'cua' }).bot;
  t.after(async () => { resume(); resumeNotification(); await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await bots.close(); rmSync(directory, { recursive: true, force: true }); });
  let socket;
  const pending = new Promise(resolve => {
    socket = https.request({ hostname: '127.0.0.1', port: bridge.port, path: `/v1/bots/${bot.id}/host-folder`, method: 'PUT', ca: readFileSync(join(directory, 'pairing/server-cert.pem')), agent: false,
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' } }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
    socket.on('error', error => resolve({ status: 0, error: error.code }));
    socket.end(JSON.stringify({ expectedUpdatedAt: bot.updatedAt, hostFolder: { path: folder, access: 'read-write' } }));
  });
  await started;
  const deleteSession = () => new Promise(resolve => {
    const deletion = https.request({ hostname: '127.0.0.1', port: bridge.port, path: '/v1/session', method: 'DELETE', ca: readFileSync(join(directory, 'pairing/server-cert.pem')), agent: false, headers: { authorization: `Bearer ${owner.token}` } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    deletion.on('error', error => resolve({ status: 0, error: error.code })); deletion.end();
  });
  return { bots, bot, bridge, owner, pending, finished, resume, signal: () => signal, disconnect: () => socket.destroy(), folder, deleteSession, notificationStarted, resumeNotification };
}

for (const mode of ['revoke', 'disconnect', 'close']) test(`in-flight folder grant stops before saving after paired ${mode}`, async t => {
  const f = await fixture(t);
  let closing;
  if (mode === 'revoke') f.bridge.revokeSession(f.owner.session.id);
  else if (mode === 'disconnect') f.disconnect();
  else closing = f.bridge.close();
  await until(() => f.signal()?.aborted);
  f.resume(); await f.finished;
  const response = await f.pending; if (mode === 'revoke') assert.equal(response.status, 401);
  await closing;
  assert.equal((await f.bots.list()).bots.find(bot => bot.id === f.bot.id).hostFolder, undefined);
});

test('session DELETE revokes the in-flight folder grant before awaiting notification cleanup', async t => {
  const f = await fixture(t, { holdNotificationCleanup: true });
  const deletion = f.deleteSession(); await f.notificationStarted;
  await until(() => f.signal()?.aborted);
  f.resume(); await f.finished;
  assert.equal((await f.pending).status, 401);
  assert.equal((await f.bots.list()).bots.find(bot => bot.id === f.bot.id).hostFolder, undefined);
  f.resumeNotification(); assert.equal((await deletion).status, 200);
});

for (const mode of ['direct', 'session-delete']) test(`failed ${mode} session journal save still cancels a pending folder grant`, async t => {
  const f = await fixture(t), file = f.bridge.authority.file;
  renameSync(file, `${file}.fixture-backup`); mkdirSync(file);
  let deletion;
  if (mode === 'direct') assert.throws(() => f.bridge.revokeSession(f.owner.session.id), error => ['EISDIR', 'ENOTEMPTY', 'EEXIST'].includes(error.code));
  else deletion = f.deleteSession();
  await until(() => f.signal()?.aborted);
  f.resume(); await f.finished;
  assert.equal((await f.pending).status, 401);
  if (deletion) assert.equal((await deletion).status, 500);
  assert.equal((await f.bots.list()).bots.find(bot => bot.id === f.bot.id).hostFolder, undefined);
});

test('removing another phone leaves the current owner’s folder request independent', async t => {
  const f = await fixture(t); f.bridge.authority.rotate();
  const other = f.bridge.authority.pair(f.bridge.authority.code, 'Other fixture phone');
  f.bridge.revokeSession(other.session.id);
  assert.equal(f.signal().aborted, false);
  f.resume(); await f.finished; assert.equal((await f.pending).status, 200);
  assert.deepEqual((await f.bots.list()).bots.find(bot => bot.id === f.bot.id).hostFolder, { path: f.folder, access: 'read-write' });
});

test('folder validation has independent per-phone and global limits before any extra host request', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'strata-folder-bounds-')));
  const catalog = { lifecycleSupported: true, hostFolderSupported: true, bots: [{ id: 'bot_fixture', name: 'Fixture', provider: 'codex', computerMode: 'cua', execution: { kind: 'local' }, updatedAt: 'version' }], computers: [], providers: [] };
  let inventories = 0, validations = 0;
  const bridge = await createBridge({ directory, listen: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, adminPort: 0, qr: false,
    host: { async json(path, { signal } = {}) {
      if (path === '/api/bots') { inventories++; return catalog; }
      if (path.endsWith('/host-folder')) {
        validations++;
        return new Promise((_, reject) => { const aborted = () => reject(Object.assign(Error('Fixture cancelled'), { name: 'AbortError' })); signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted(); });
      }
      return {};
    } },
  });
  const pending = [];
  t.after(async () => { await bridge.close(); await Promise.all(pending); rmSync(directory, { recursive: true, force: true }); });
  const ca = readFileSync(join(directory, 'server-cert.pem'));
  const pair = () => { bridge.authority.rotate(); return bridge.authority.pair(bridge.authority.code, 'Bounded fixture phone'); };
  const send = token => {
    const promise = new Promise(resolve => {
      const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path: '/v1/bots/bot_fixture/host-folder', method: 'PUT', ca, agent: false, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(0)); req.end(JSON.stringify({ expectedUpdatedAt: 'version', hostFolder: { path: '/synthetic/project', access: 'read' } }));
    }); pending.push(promise); return promise;
  };
  const owner = pair(); send(owner.token); send(owner.token); await until(() => validations === 2);
  assert.equal(await send(owner.token), 429); assert.equal(inventories, 2); assert.equal(validations, 2);
  for (let index = 0; index < 3; index++) { const other = pair(); send(other.token); send(other.token); await until(() => validations === 4 + index * 2); }
  const last = pair(); assert.equal(await send(last.token), 429);
  assert.equal(validations, 8); assert.equal(inventories, 8);
});
