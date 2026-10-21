/** MCP OAuth sessions live on the host. No tokens, verifiers or codes enter a bot snapshot. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { auth as sdkAuth, discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/client/auth.js';
import { botExtensionFault as fault, extensionHash as hash, privateExtensionStore } from './bots-extension-store.mjs';
import { startOpener } from './app-ui.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TTL = 10 * 60 * 1000;
export const companionConnectorCallback = 'strata://connector-oauth/callback';
export const registeredConnectorCallback = 'http://127.0.0.1:47841/callback';
export async function openConnectorBrowser(url, { platform = process.platform, start = startOpener } = {}) {
  const target = safeURL(url, true);
  const [command, ...args] = platform === 'darwin' ? ['/usr/bin/open'] : platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler'] : ['xdg-open'];
  return start(command, [...args, target.href]);
}
const copy = value => value === undefined ? undefined : structuredClone(value);
const setup = c => hash([c.id, c.url, c.authType, c.oauthClientId || '', c.oauthClientSecret || '']);
const equal = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string') return false; const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const sameIssuer = (a, b) => { try { return new URL(a).href.replace(/\/$/, '') === new URL(b).href.replace(/\/$/, ''); } catch { return false; } };
function safeURL(input, local = false) {
  const url = new URL(input);
  if (url.username || url.password || url.hash || url.href.length > 16384 || url.protocol !== 'https:' && !(local && url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw fault(400, 'Use a secure service URL for connector sign-in.');
  return url;
}
/** Shared network boundary for MCP messages and SDK OAuth discovery/token requests. */
export async function botConnectorFetch(url, init = {}, { signal, fetchImpl = fetch, local = false } = {}) {
  safeURL(String(url), local);
  const result = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(25000), ...(signal ? [signal] : []), ...(init.signal ? [init.signal] : [])]) });
  if (result.status >= 300 && result.status < 400) { await result.body?.cancel(); throw fault(503, 'The connector returned a redirect. Check its official server URL.'); }
  if (Number(result.headers.get('content-length')) > 2 * 1024 * 1024) { await result.body?.cancel(); throw fault(503, 'The connector response is too large.'); }
  if (!result.body) return result;
  const reader = result.body.getReader(); let size = 0;
  return new Response(new ReadableStream({ async pull(controller) { const part = await reader.read(); if (part.done) { controller.close(); return; } size += part.value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); controller.error(fault(503, 'The connector response is too large.')); return; } controller.enqueue(part.value); }, cancel: reason => reader.cancel(reason) }), { status: result.status, statusText: result.statusText, headers: result.headers });
}

export function createBotConnectorAuth({ directory, connectionFor, notify = () => {}, now = () => Date.now(), fetchImpl = fetch, authorize = sdkAuth, discoverResource = discoverOAuthProtectedResourceMetadata, openBrowser = openConnectorBrowser, registeredCallbackPort = 47841 }) {
  const store = privateExtensionStore(directory, 'bots-connector-auth.json', { version: 1, accounts: {} }), state = store.value;
  if (!state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts) || Object.keys(state.accounts).length > 50 || Object.entries(state.accounts).some(([key, value]) => !/^mcpc_[a-f0-9-]+$/.test(key) || !value || typeof value !== 'object' || typeof value.setupDigest !== 'string' || typeof value.epoch !== 'string')) throw fault(503, 'Saved connector sign-in data is invalid. It was left unchanged.');
  const pending = new Map(), statuses = new Map();
  const changed = () => { store.save(state); notify('bots', { connections: true }); };
  const current = c => { const live = connectionFor(c.id); if (!live || live.enabled === false || setup(live) !== setup(c)) throw fault(409, 'This connector changed. Start sign-in again from its current settings.'); return live; };
  const record = c => { const value = state.accounts[c.id]; return value?.setupDigest === setup(c) ? value : undefined; };
  const stopListener = flow => { clearTimeout(flow.timer); flow.server?.close(); flow.server?.closeIdleConnections?.(); };
  const stop = (id, expected) => { const flow = pending.get(id); if (!flow || expected && flow !== expected) return; pending.delete(id); flow.controller.abort(); stopListener(flow); };
  const secrets = c => { const saved = record(c); return [c.oauthClientSecret, saved?.clientInformation?.client_secret, saved?.tokens?.access_token, saved?.tokens?.refresh_token, saved?.tokens?.id_token].filter(value => typeof value === 'string' && value); };
  function publicStatus(c) {
    const flow = pending.get(c.id);
    if (flow && now() >= flow.expiresAt) { stop(c.id); statuses.set(c.id, { status: 'expired', detail: 'Sign-in expired. Start again on your Mac.' }); }
    const active = pending.get(c.id);
    if (active) return { status: active.authorizationURL ? 'waiting' : 'connecting', detail: active.authorizationURL ? active.owner ? 'Finish sign-in in Strata on the iPhone that started it.' : 'Finish sign-in in a browser on this Mac.' : 'Preparing connector sign-in…', callbackTarget: active.owner ? 'iphone' : 'mac', ...(active.authorizationURL ? { authorizationURL: active.authorizationURL } : {}), redirectURL: active.redirectURL, expiresAt: new Date(active.expiresAt).toISOString() };
    const status = statuses.get(c.id); if (status && status.status !== 'connected') return copy(status);
    const saved = record(c);
    if (saved?.tokens?.access_token) {
      if (saved.expiresAt && now() >= saved.expiresAt && !saved.tokens.refresh_token) return { status: 'expired', detail: 'This sign-in expired. Reconnect this account on your Mac.' };
      return { status: 'connected', detail: 'Account connected. Credentials stay on this Mac.' };
    }
    return { status: 'not_connected', detail: 'Sign in on your Mac before checking this connector.' };
  }
  function provider(c, flow, onSecrets = () => {}) {
    current(c);
    const epoch = record(c)?.epoch;
    const requireRecord = () => { current(c); const value = record(c); if (!value || value.epoch !== epoch || flow && (pending.get(c.id) !== flow || now() >= flow.expiresAt)) throw fault(409, 'Connector sign-in changed or expired. Start again.'); return value; };
    const saved = requireRecord();
    onSecrets(secrets(c));
    const result = {
      get redirectUrl() { return flow?.redirectURL || saved.redirectURL; },
      get clientMetadata() { return { client_name: 'Strata', redirect_uris: [String(this.redirectUrl)], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: c.oauthClientSecret ? 'client_secret_post' : 'none' }; },
      state: () => { if (!flow) throw fault(401, 'Reconnect this connector on your Mac.'); requireRecord(); return flow.state; },
      clientInformation: () => copy(requireRecord().clientInformation),
      tokens: () => copy(requireRecord().tokens),
      saveTokens(tokens) { const value = requireRecord(); onSecrets(secrets(c)); if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 32768 || JSON.stringify(tokens).length > 100000 || typeof tokens.issuer !== 'string') throw fault(503, 'The connector returned invalid sign-in data.'); value.tokens = copy(tokens); onSecrets(secrets(c)); value.expiresAt = Number.isFinite(tokens.expires_in) && tokens.expires_in >= 0 ? now() + tokens.expires_in * 1000 : undefined; statuses.delete(c.id); changed(); },
      redirectToAuthorization(url) { if (!flow) throw fault(401, 'Reconnect this connector on your Mac.'); requireRecord(); const target = safeURL(String(url), LOOPBACK.has(new URL(c.url).hostname)); if (target.searchParams.getAll('state').length !== 1 || !equal(target.searchParams.get('state'), flow.state) || target.searchParams.get('redirect_uri') !== flow.redirectURL || target.searchParams.get('code_challenge_method') !== 'S256' || !target.searchParams.get('code_challenge')) throw fault(503, 'The connector did not provide a protected sign-in link.'); if (['gmailmcp.googleapis.com', 'calendarmcp.googleapis.com', 'drivemcp.googleapis.com', 'docsmcp.googleapis.com', 'sheetsmcp.googleapis.com', 'slidesmcp.googleapis.com'].includes(new URL(c.url).hostname)) { target.searchParams.set('access_type', 'offline'); target.searchParams.set('prompt', 'consent'); } flow.authorizationURL = target.href; notify('bots', { connections: true }); },
      saveCodeVerifier(verifier) { if (!flow) throw fault(401, 'Reconnect this connector on your Mac.'); requireRecord(); if (typeof verifier !== 'string' || verifier.length < 32 || verifier.length > 256) throw fault(503, 'The connector returned an invalid sign-in verifier.'); flow.verifier = verifier; },
      codeVerifier() { requireRecord(); if (!flow?.verifier) throw fault(409, 'Start connector sign-in again on your Mac.'); return flow.verifier; },
      saveDiscoveryState(discovery) { const value = requireRecord(); if (!discovery.resourceMetadata || !Array.isArray(discovery.resourceMetadata.authorization_servers) || !discovery.resourceMetadata.authorization_servers.length || !discovery.authorizationServerMetadata || !sameIssuer(discovery.authorizationServerMetadata.issuer, discovery.authorizationServerUrl)) throw fault(503, 'The connector did not provide valid authorization metadata.'); const local = LOOPBACK.has(new URL(c.url).hostname); safeURL(discovery.authorizationServerUrl, local); safeURL(discovery.authorizationServerMetadata.authorization_endpoint, local); safeURL(discovery.authorizationServerMetadata.token_endpoint, local); if (discovery.authorizationServerMetadata.registration_endpoint) safeURL(discovery.authorizationServerMetadata.registration_endpoint, local); value.discovery = copy(discovery); changed(); },
      discoveryState: () => copy(requireRecord().discovery),
      invalidateCredentials(scope) { const value = requireRecord(); if (scope === 'all') { delete value.tokens; delete value.clientInformation; delete value.discovery; } else if (scope === 'tokens') delete value.tokens; else if (scope === 'client') delete value.clientInformation; else if (scope === 'discovery') delete value.discovery; else if (scope === 'verifier' && flow) flow.verifier = undefined; changed(); },
    };
    // A running bot may refresh an existing session. It cannot register a new account or start browser sign-in.
    if (flow) result.saveClientInformation = information => { const value = requireRecord(); if (!information || typeof information.client_id !== 'string' || !information.client_id || JSON.stringify(information).length > 100000 || typeof information.issuer !== 'string') throw fault(503, 'The connector returned invalid client information.'); value.clientInformation = copy(information); onSecrets(secrets(c)); changed(); };
    return result;
  }
  async function complete(c, callbackURL, { owner } = {}) {
    const flow = pending.get(c.id);
    if (!flow || now() >= flow.expiresAt) { if (flow) stop(c.id); throw fault(409, 'Connector sign-in expired or was already completed. Start again.'); }
    if (flow.owner && flow.owner !== owner) throw fault(403, 'Finish this sign-in from the iPhone that started it.');
    current(c);
    let callback; try { callback = new URL(callbackURL); } catch { throw fault(400, 'Paste the complete connector callback URL.'); }
    const expected = new URL(flow.redirectURL);
    if (typeof callbackURL !== 'string' || callbackURL.length > 16384 || callback.protocol !== expected.protocol || callback.host !== expected.host || callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash || callback.username || callback.password || callback.searchParams.getAll('state').length !== 1 || !equal(callback.searchParams.get('state'), flow.state)) throw fault(400, 'This sign-in callback does not match the pending connector request.');
    if (flow.finishing) throw fault(409, 'This connector callback is already being processed.');
    if (callback.searchParams.has('error')) { stop(c.id); statuses.set(c.id, { status: 'error', detail: 'Sign-in was declined or could not be completed. Try again on your Mac.' }); notify('bots', { connections: true }); throw fault(400, 'Connector sign-in was not completed.'); }
    const code = callback.searchParams.get('code');
    if (callback.searchParams.getAll('code').length !== 1 || !code || code.length > 4096 || !flow.verifier) throw fault(400, 'The connector callback did not include a valid authorization code.');
    flow.finishing = true;
    try {
      const fetchFn = (url, init) => botConnectorFetch(url, init, { signal: flow.controller.signal, fetchImpl, local: LOOPBACK.has(new URL(c.url).hostname) });
      const result = await authorize(provider(c, flow), { serverUrl: c.url, authorizationCode: code, fetchFn });
      if (result !== 'AUTHORIZED' || !record(c)?.tokens?.access_token) throw new Error('Incomplete OAuth exchange');
      current(c); if (pending.get(c.id) !== flow || record(c)?.epoch !== flow.epoch) throw new Error('Sign-in superseded'); statuses.delete(c.id); stop(c.id, flow); notify('bots', { connections: true }); return { auth: publicStatus(c) };
    } catch { if (pending.get(c.id) === flow) { stop(c.id, flow); const value = record(c); if (value?.epoch === flow.epoch) { delete value.tokens; changed(); } statuses.set(c.id, { status: 'error', detail: 'Connector sign-in failed. Check its account setup and try again on your Mac.' }); } throw fault(503, 'Connector sign-in failed. Check its account setup and try again on your Mac.'); }
  }
  async function start(c, { callbackTarget, owner } = {}) {
    if (c.authType !== 'oauth' || c.transport !== 'http' || c.enabled === false) throw fault(400, 'Enable a browser sign-in connector before connecting its account.');
    if (callbackTarget !== undefined && callbackTarget !== 'iphone') throw fault(400, 'Choose a supported connector sign-in destination.');
    if (callbackTarget === 'iphone' && (typeof owner !== 'string' || !/^phone:[a-f0-9]{32}$/.test(owner))) throw fault(403, 'Start iPhone sign-in from your paired Strata app.');
    current(c); publicStatus(c);
    if (pending.has(c.id)) throw fault(409, 'Finish or cancel this connector’s current sign-in before starting again.');
    statuses.delete(c.id);
    if (pending.size >= 8) throw fault(409, 'Finish another connector sign-in before starting more.');
    const flow = { state: randomBytes(32).toString('hex'), expiresAt: now() + TTL, controller: new AbortController(), ...(callbackTarget === 'iphone' ? { owner } : {}) };
    pending.set(c.id, flow);
    try {
      if (flow.owner) flow.redirectURL = companionConnectorCallback;
      else {
      const server = createServer(async (req, res) => {
        res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'"); res.setHeader('content-type', 'text/plain; charset=utf-8'); res.setHeader('connection', 'close');
        if (req.method !== 'GET' || req.headers.host !== new URL(flow.redirectURL).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !req.url || req.url.length > 16384) { res.writeHead(400); res.end('Invalid Strata sign-in callback.'); return; }
        try { await complete(c, new URL(req.url, flow.redirectURL).href); res.end('Connected to Strata. You may close this window and return to the app.'); }
        catch (failure) { res.writeHead(failure.status || 503); res.end('Strata could not complete this sign-in. Return to the app and try again.'); }
      });
      flow.server = server;
      server.requestTimeout = 10000; server.headersTimeout = 10000; server.timeout = 5000; server.maxConnections = 8; server.on('connection', socket => socket.unref());
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(c.oauthClientId ? registeredCallbackPort : 0, '127.0.0.1', resolve); });
      flow.redirectURL = `http://127.0.0.1:${server.address().port}/callback`;
      server.unref();
      }
      flow.timer = setTimeout(() => { if (pending.get(c.id) === flow) { stop(c.id); statuses.set(c.id, { status: 'expired', detail: 'Sign-in expired. Start again in Strata.' }); notify('bots', { connections: true }); } }, TTL); flow.timer.unref?.();
      const old = record(c);
      flow.epoch = randomUUID();
      state.accounts[c.id] = { setupDigest: setup(c), epoch: flow.epoch, redirectURL: flow.redirectURL, ...(c.oauthClientId ? { clientInformation: { client_id: c.oauthClientId, ...(c.oauthClientSecret ? { client_secret: c.oauthClientSecret } : {}) } } : {}), ...(old?.discovery ? { discovery: old.discovery } : {}) }; changed();
      const fetchFn = (url, init) => botConnectorFetch(url, init, { signal: flow.controller.signal, fetchImpl, local: LOOPBACK.has(new URL(c.url).hostname) });
      // Require protected-resource discovery; a bare legacy issuer fallback cannot establish an audience.
      const metadata = await discoverResource(c.url, {}, fetchFn);
      if (!metadata || !Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.length) throw new Error('Missing protected-resource metadata');
      const result = await authorize(provider(c, flow), { serverUrl: c.url, fetchFn });
      if (result === 'AUTHORIZED') { if (!record(c)?.tokens?.access_token) throw new Error('Missing tokens'); stop(c.id); }
      else if (result !== 'REDIRECT' || !flow.authorizationURL) throw new Error('Missing authorization link');
      return { auth: publicStatus(c) };
    } catch { if (pending.get(c.id) === flow) { stop(c.id, flow); statuses.set(c.id, { status: 'error', detail: 'Could not start connector sign-in. Check the MCP URL and whether this service requires a registered client.' }); notify('bots', { connections: true }); } throw fault(503, 'Could not start connector sign-in. Check the MCP URL and whether this service requires a registered client.'); }
  }
  function cancel(c, { owner, expectedState } = {}) {
    if (typeof expectedState !== 'string' || !/^[a-f0-9]{64}$/.test(expectedState)) throw fault(400, 'Choose the pending sign-in you want to cancel.');
    current(c); publicStatus(c);
    const flow = pending.get(c.id);
    if (!flow) return { auth: publicStatus(c) };
    // The Mac manages its accounts. A paired phone can cancel only its own pending flow.
    if (owner && flow.owner !== owner) throw fault(403, 'Cancel this sign-in from the device that started it.');
    if (!equal(expectedState, flow.state)) throw fault(409, 'This sign-in changed. Review the current sign-in before cancelling.');
    stop(c.id, flow); statuses.delete(c.id); notify('bots', { connections: true });
    return { auth: publicStatus(c) };
  }
  async function open(c) {
    current(c); publicStatus(c);
    const flow = pending.get(c.id);
    if (!flow?.authorizationURL) throw fault(409, 'Start connector sign-in before opening its browser page.');
    if (flow.owner) throw fault(409, 'Continue this sign-in in Strata on your iPhone.');
    const target = safeURL(flow.authorizationURL, LOOPBACK.has(new URL(c.url).hostname));
    let opened = false;
    try { opened = await openBrowser(target.href); } catch { /* Do not expose system opener errors or its private arguments. */ }
    if (!opened) throw fault(503, 'Could not open the browser. Use the sign-in link shown in this account.');
    return { auth: publicStatus(c) };
  }
  function disconnect(id) { stop(id); statuses.delete(id); if (Object.hasOwn(state.accounts, id)) { delete state.accounts[id]; changed(); } }
  return { start, complete, cancel, open, disconnect, publicStatus, secrets, epoch: c => record(c)?.tokens?.access_token ? record(c).epoch : null,
    providerFor(c, onSecrets) { if (!record(c)?.tokens?.access_token) throw fault(401, 'Sign in to this connector on your Mac before using its tools.'); return provider(c, undefined, onSecrets); },
    pendingCount: () => pending.size,
    close() { for (const id of pending.keys()) stop(id); },
  };
}
