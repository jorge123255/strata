/** Local address discovery only. Never changes Tailscale, routing or pairing. */
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { accessSync, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_ENDPOINTS = 8;
const CLI_PATHS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale'];
const bareHost = host => host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
const loopback = address => address === '::1' || /^127\./.test(address);
const tailscaleAddress = address => {
  if (isIP(address) === 4) { const [a, b] = address.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; }
  return isIP(address) === 6 && /^fd7a:115c:a1e0:/i.test(address);
};
const listenerAllows = (listen, address) => listen === '::' || listen === '0.0.0.0' && isIP(address) === 4 || listen === address;
const privateLAN = address => {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
  }
  // Scope-qualified/link-local addresses are deliberately omitted. They cannot
  // be copied to another device as an unambiguous connection address.
  return isIP(address) === 6 && /^(?:fc|fd)/i.test(address) && !/^fd7a:115c:a1e0:/i.test(address);
};

/** Check every discovery result again before it can enter a phone response. */
export function normalizeNetworkEndpoints(values, port) {
  if (!Array.isArray(values) || !Number.isInteger(port) || port < 1 || port > 65535) return [];
  const result = [], seen = new Set();
  for (const value of values.slice(0, 128)) {
    if (!value || !['lan', 'tailscale'].includes(value.kind) || typeof value.url !== 'string' || value.url.length > 2048 || !/^https:\/\/[^/?#@]+\/?$/.test(value.url)) continue;
    try {
      const url = new URL(value.url), host = bareHost(url.hostname);
      if (url.protocol !== 'https:' || !isIP(host) || value.kind === 'tailscale' && !tailscaleAddress(host) || host.includes('%') || url.username || url.password || url.search || url.hash || url.pathname !== '/' || Number(url.port || 443) !== port) continue;
      const normalized = `https://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
      if (seen.has(normalized)) continue;
      seen.add(normalized); result.push({ kind: value.kind, url: normalized });
      if (result.length >= MAX_ENDPOINTS) break;
    } catch { /* An unavailable or malformed address never blocks pairing. */ }
  }
  return result;
}

/** Only the local daemon's own status is read; Peer entries are never used. */
export async function readOwnTailscaleStatus({ signal, execute = run, findExecutable = () => CLI_PATHS.find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }) } = {}) {
  const executable = findExecutable();
  if (!executable) return null;
  try {
    const { stdout } = await execute(executable, ['status', '--json'], { timeout: 1500, maxBuffer: 1024 * 1024, signal, windowsHide: true, env: { ...process.env, TAILSCALE_BE_CLI: '1' } });
    const status = JSON.parse(stdout);
    return status?.BackendState === 'Running' && status?.Self?.Online === true && Array.isArray(status.Self.TailscaleIPs)
      ? { addresses: status.Self.TailscaleIPs.filter(value => typeof value === 'string' && tailscaleAddress(value)).slice(0, MAX_ENDPOINTS) }
      : null;
  } catch { return null; } // No raw CLI diagnostics, peer details or credentials.
}

export async function discoverNetworkEndpoints({ port, listen = '0.0.0.0', interfaces = networkInterfaces, readTailscaleStatus = readOwnTailscaleStatus, signal } = {}) {
  if (loopback(listen) || listen === 'localhost') return [];
  const candidates = [];
  let local = {};
  try { local = interfaces(); } catch { /* Network changes can race enumeration. */ }
  for (const [name, addresses] of Object.entries(local ?? {}).slice(0, 64)) {
    if (/^(?:utun|bridge|vmenet|tailscale|docker|veth)/i.test(name)) continue;
    for (const row of Array.isArray(addresses) ? addresses.slice(0, 16) : []) {
      if (!row || row.internal || typeof row.address !== 'string' || !privateLAN(row.address) || !listenerAllows(listen, row.address)) continue;
      candidates.push({ kind: 'lan', url: `https://${isIP(row.address) === 6 ? `[${row.address}]` : row.address}:${port}` });
    }
  }
  const tailscale = [];
  try {
    const own = await readTailscaleStatus({ signal });
    for (const address of Array.isArray(own?.addresses) ? own.addresses.slice(0, MAX_ENDPOINTS) : []) {
      if (typeof address !== 'string' || !tailscaleAddress(address) || !listenerAllows(listen, address)) continue;
      tailscale.push({ kind: 'tailscale', url: `https://${isIP(address) === 6 ? `[${address}]` : address}:${port}` });
    }
  } catch { /* LAN access remains available without Tailscale or its CLI. */ }
  // Many LAN aliases must not crowd out the very address needed away from home.
  return normalizeNetworkEndpoints([...candidates.slice(0, Math.max(0, MAX_ENDPOINTS - tailscale.length)), ...tailscale], port);
}

/** One bounded, coalesced refresh; all status polls read the cached projection. */
export function createNetworkEndpointCache({ port, listen, discover = discoverNetworkEndpoints, refreshMs = 30_000 } = {}) {
  let endpoints = [], pending = null, timer = null, closed = false;
  const abort = new AbortController();
  const snapshot = () => endpoints.map(value => ({ ...value }));
  const refresh = () => {
    if (closed) return Promise.resolve(snapshot());
    if (pending) return pending;
    // Also bound injected/custom discovery implementations. A timed-out refresh
    // cannot later publish stale addresses or hold shutdown open indefinitely.
    const request = new AbortController();
    const cancel = () => request.abort();
    abort.signal.addEventListener('abort', cancel, { once: true });
    let timeout;
    pending = Promise.race([
      Promise.resolve().then(() => discover({ port, listen, signal: request.signal })),
      new Promise(resolve => { timeout = setTimeout(() => { request.abort(); resolve([]); }, 2000); timeout.unref?.(); }),
    ]).then(values => { if (!closed) endpoints = normalizeNetworkEndpoints(values, port); return snapshot(); }, () => { if (!closed) endpoints = []; return snapshot(); })
      .finally(() => { clearTimeout(timeout); abort.signal.removeEventListener('abort', cancel); pending = null; });
    return pending;
  };
  return {
    snapshot, refresh,
    async start() {
      await refresh();
      if (!closed && !timer) { timer = setInterval(refresh, Math.max(1000, Math.min(300_000, Number.isFinite(refreshMs) ? refreshMs : 30_000))); timer.unref?.(); }
    },
    close() { closed = true; clearInterval(timer); abort.abort(); },
  };
}
