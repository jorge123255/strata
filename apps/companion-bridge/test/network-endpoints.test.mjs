import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createBridge } from '../bridge.mjs';
import { normalizeNetworkEndpoints, readOwnTailscaleStatus, discoverNetworkEndpoints, createNetworkEndpointCache } from '../network-endpoints.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const lan = (address, port = 8787) => ({ kind: 'lan', url: `https://${address}:${port}` });
const tail = (address, port = 8787) => ({ kind: 'tailscale', url: `https://${address}:${port}` });

test('endpoint projection accepts numeric HTTPS origins only, strips extras, deduplicates and bounds the response', () => {
  const valid = lan('192.168.1.12');
  const invalid = [
    { kind: 'other', url: valid.url },
    { kind: 'lan', url: 'https://mac.example:8787' },
    { kind: 'lan', url: 'http://192.168.1.12:8787' },
    { kind: 'lan', url: 'https://secret@192.168.1.12:8787' },
    { kind: 'lan', url: 'https://@192.168.1.12:8787' },
    { kind: 'lan', url: `${valid.url}?` }, { kind: 'lan', url: `${valid.url}#` },
    { kind: 'lan', url: `${valid.url}/path/..` },
    { kind: 'lan', url: 'https://192.168.1.12:8788' },
    { kind: 'tailscale', url: 'https://8.8.8.8:8787' },
    { kind: 'tailscale', url: 'https://100.128.1.2:8787' },
    { kind: 'lan', url: 'https://[fe80::1%25en0]:8787' },
  ];
  const result = normalizeNetworkEndpoints([...invalid, { ...valid, token: 'private-token', peer: 'not-returned' }, valid, tail('[fd7a:115c:a1e0::1234]')], 8787);
  assert.deepEqual(result, [valid, tail('[fd7a:115c:a1e0::1234]')]);
  assert.equal(normalizeNetworkEndpoints(Array.from({ length: 30 }, (_, i) => lan(`10.0.0.${i + 1}`)), 8787).length, 8);
  assert.deepEqual(normalizeNetworkEndpoints([valid], 0), []);
});

test('CLI reads only running online Self IPs, never Peer IPs, with headless bounded status arguments', async () => {
  let calls = 0;
  const execute = async (file, args, options) => {
    calls++; assert.equal(file, '/fixture/Tailscale'); assert.deepEqual(args, ['status', '--json']);
    assert.equal(options.env.TAILSCALE_BE_CLI, '1'); assert.equal(options.timeout, 1500); assert.equal(options.maxBuffer, 1024 * 1024);
    return { stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true, TailscaleIPs: ['100.78.1.2', 'fd7a:115c:a1e0::2', 'not-an-IP', '8.8.8.8', '100.63.1.2', 'fd00::1'] }, Peer: { private: { TailscaleIPs: ['100.99.9.9'] } }, token: 'never-return' }) };
  };
  assert.deepEqual(await readOwnTailscaleStatus({ execute, findExecutable: () => '/fixture/Tailscale' }), { addresses: ['100.78.1.2', 'fd7a:115c:a1e0::2'] });
  assert.equal(calls, 1);
  for (const state of [{ BackendState: 'Stopped' }, { BackendState: 'Running', Self: { Online: false, TailscaleIPs: ['100.78.1.2'] } }]) {
    assert.equal(await readOwnTailscaleStatus({ execute: async () => ({ stdout: JSON.stringify(state) }), findExecutable: () => '/fixture/Tailscale' }), null);
  }
  assert.equal(await readOwnTailscaleStatus({ execute: async () => { throw new Error('private daemon diagnostics'); }, findExecutable: () => '/fixture/Tailscale' }), null);
  assert.equal(await readOwnTailscaleStatus({ execute: async () => { throw new Error('must not run'); }, findExecutable: () => undefined }), null);
});

test('discovery separates actual LAN interfaces from CLI-proven self addresses and honors listener family', async () => {
  const interfaces = () => ({
    en0: [{ address: '192.168.1.12', family: 'IPv4', internal: false }, { address: 'fd11::2', family: 'IPv6', internal: false }],
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    utun3: [{ address: '100.99.9.9', family: 'IPv4', internal: false }],
    bridge0: [{ address: '10.2.3.4', family: 'IPv4', internal: false }],
    en1: [{ address: '100.88.9.8', family: 'IPv4', internal: false }, { address: '169.254.3.4', family: 'IPv4', internal: false }],
  });
  const readTailscaleStatus = async () => ({ addresses: ['100.78.1.2', 'fd7a:115c:a1e0::2'] });
  const options = { port: 8787, interfaces, readTailscaleStatus };
  assert.deepEqual(await discoverNetworkEndpoints(options), [lan('192.168.1.12'), tail('100.78.1.2')]);
  assert.deepEqual(await discoverNetworkEndpoints({ ...options, listen: '::' }), [lan('192.168.1.12'), lan('[fd11::2]'), tail('100.78.1.2'), tail('[fd7a:115c:a1e0::2]')]);
  assert.deepEqual(await discoverNetworkEndpoints({ ...options, listen: '100.78.1.2' }), [tail('100.78.1.2')]);
  assert.deepEqual(await discoverNetworkEndpoints({ ...options, readTailscaleStatus: async () => { throw new Error('unavailable'); } }), [lan('192.168.1.12')]);
  const aliases = await discoverNetworkEndpoints({ ...options, interfaces: () => ({ en0: Array.from({ length: 12 }, (_, i) => ({ address: `10.0.0.${i + 1}`, internal: false })) }) });
  assert.equal(aliases.length, 8); assert.deepEqual(aliases.at(-1), tail('100.78.1.2'));
  assert.deepEqual(await discoverNetworkEndpoints({ ...options, listen: '127.0.0.1', interfaces: () => { throw new Error('must not inspect interfaces'); }, readTailscaleStatus: () => { throw new Error('must not run CLI'); } }), []);
});

test('cache coalesces refreshes, serves defensive copies, clears unavailable data and ignores late closed results', async () => {
  let calls = 0, release;
  const cache = createNetworkEndpointCache({ port: 8787, discover: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const one = cache.refresh(), two = cache.refresh(); await Promise.resolve();
  assert.equal(calls, 1); release([lan('192.168.1.12')]); await Promise.all([one, two]);
  const snapshot = cache.snapshot(); snapshot[0].url = 'changed';
  for (let i = 0; i < 100; i++) assert.deepEqual(cache.snapshot(), [lan('192.168.1.12')]);
  assert.equal(calls, 1);
  const late = cache.refresh(); await Promise.resolve(); cache.close(); release([tail('100.78.1.2')]); await late;
  assert.deepEqual(cache.snapshot(), [lan('192.168.1.12')]);
  const unavailable = createNetworkEndpointCache({ port: 8787, discover: async () => { throw new Error('private diagnostics'); } });
  assert.deepEqual(await unavailable.refresh(), []); unavailable.close();
});

test('enabled cache refresh notices Tailscale joining after startup without poll-triggered CLI requests', async t => {
  let calls = 0, joined;
  const second = new Promise(resolve => { joined = resolve; });
  const cache = createNetworkEndpointCache({ port: 8787, refreshMs: 1000, discover: async () => { calls++; if (calls > 1) { joined(); return [lan('192.168.1.12'), tail('100.78.1.2')]; } return [lan('192.168.1.12')]; } });
  t.after(() => cache.close()); await cache.start();
  assert.deepEqual(cache.snapshot(), [lan('192.168.1.12')]);
  let limit; await Promise.race([second, new Promise((_, reject) => { limit = setTimeout(() => reject(new Error('refresh did not happen')), 3000); })]); clearTimeout(limit);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cache.snapshot(), [lan('192.168.1.12'), tail('100.78.1.2')]); assert.equal(calls, 2);
});

test('a hung discovery times out and cannot publish stale addresses after a later refresh', async t => {
  let release, calls = 0;
  const keepAlive = setTimeout(() => {}, 4000); t.after(() => clearTimeout(keepAlive));
  const cache = createNetworkEndpointCache({ port: 8787, discover: () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : [tail('100.78.1.2')] });
  t.after(() => cache.close());
  assert.deepEqual(await cache.refresh(), []);
  assert.deepEqual(await cache.refresh(), [tail('100.78.1.2')]);
  release([lan('192.168.1.12')]); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cache.snapshot(), [tail('100.78.1.2')]); assert.equal(calls, 2);
});

function request(bridge, path, { method = 'GET', token, body, origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: bridge.port, path, method, rejectUnauthorized: false, agent: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('authenticated connection metadata has no upstream calls and discovery preserves QR, TLS and paired-file bytes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'strata-endpoints-'));
  let tailscale = false, upstreamCalls = 0, discovered = 0;
  const bridge = await createBridge({ directory, listen: '127.0.0.1', port: 0, adminPort: 0, qr: false, advertiseHost: '127.0.0.1', host: { json() { upstreamCalls++; throw new Error('must not read models'); } }, discoverEndpoints: async ({ port }) => { discovered++; return [lan('192.168.1.12', port), ...(tailscale ? [tail('100.78.1.2', port)] : [])]; } });
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await request(bridge, '/v1/connection')).status, 401);
  const paired = await request(bridge, '/v1/pair', { method: 'POST', body: { code: bridge.authority.code, deviceName: 'Fixture iPhone' } });
  assert.equal(paired.status, 200); const token = paired.body.token;
  const invitationHash = digest(bridge.invitation());
  const files = () => Object.fromEntries(readdirSync(directory).map(name => [name, digest(readFileSync(join(directory, name)))]));
  const before = files();
  const first = await request(bridge, '/v1/connection', { token });
  assert.equal(first.status, 200); assert.deepEqual(Object.keys(first.body).sort(), ['endpoints', 'macName']);
  assert.deepEqual(first.body.endpoints, [lan('192.168.1.12', bridge.port)]);
  assert.equal((await request(bridge, '/v1/connection', { token, origin: 'https://browser.example' })).status, 403);
  assert.equal((await request(bridge, '/v1/connection?other=1', { token })).status, 404);
  assert.equal((await request(bridge, '/v1/connection', { token, method: 'POST', body: {} })).status, 404);
  tailscale = true; await bridge.refreshEndpoints();
  const second = await request(bridge, '/v1/connection', { token });
  assert.deepEqual(second.body.endpoints, [lan('192.168.1.12', bridge.port), tail('100.78.1.2', bridge.port)]);
  assert.deepEqual(bridge.state().endpoints, second.body.endpoints);
  assert.equal(digest(bridge.invitation()), invitationHash); assert.deepEqual(files(), before);
  assert.equal(upstreamCalls, 0); assert.equal(discovered, 2);
  bridge.authority.revoke(bridge.authority.sessions[0].id);
  assert.equal((await request(bridge, '/v1/connection', { token })).status, 401);
});
