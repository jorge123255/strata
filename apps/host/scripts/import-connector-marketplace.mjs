/** Offline, credential-free normalization of a reviewed public MCP catalog snapshot. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

const sourceURL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/ListMarketplacePlugins';
const managedHosts = new Set(['api.cursor.com', 'api2.cursor.sh', 'connectors-gateway.grok.com', 'connectors-gateway.grok.gcp.mouseion.dev']);
const googleHosts = new Set(['gmailmcp.googleapis.com', 'calendarmcp.googleapis.com', 'drivemcp.googleapis.com', 'docsmcp.googleapis.com', 'sheetsmcp.googleapis.com', 'slidesmcp.googleapis.com']);
const secretName = /token|secret|password|api.?key|credential|authorization/i;
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
export function safeCatalogURL(value) {
  if (typeof value !== 'string' || value.length > 4000 || /[\u0000-\u0020\u007f${}<>]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname
      || isIP(url.hostname.replace(/^\[|\]$/g, '')) || url.hostname === 'localhost' || /\.(localhost|local|internal)$/i.test(url.hostname)) return undefined;
    return url.href;
  } catch { return undefined; }
}
function category(plugin) {
  const keys = plugin.categories || [];
  if (keys.some(k => /INBOX|COLLABORATION|COMMUNICATION/.test(k))) return 'Communication';
  if (keys.some(k => /SCHEDULING|PRODUCTIVITY|PROJECT/.test(k))) return 'Productivity';
  if (keys.some(k => /DESIGN|CREATIVE/.test(k))) return 'Design';
  if (keys.some(k => /DATA|ANALYTICS/.test(k))) return 'Data';
  if (keys.some(k => /DEVELOP|CODE|ENGINEER|INFRA|SECURITY/.test(k))) return 'Development';
  return 'Services';
}
function namesFrom(value, names = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{(?:(?:env|input):|user_config\.)?([A-Za-z_][A-Za-z0-9_]{0,127})\}|\{\{([A-Za-z_][A-Za-z0-9_]{0,127})\}\}/g)) names.add(match[1] || match[2]);
  } else if (Array.isArray(value)) for (const item of value) namesFrom(item, names);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) namesFrom(item, names);
  return names;
}
function fields(plugin, servers) {
  const result = new Map();
  const properties = plugin.variables?.properties || {};
  for (const server of servers) {
    for (const name of namesFrom(server.config)) {
      if (['CLAUDE_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT'].includes(name)) continue;
      const property = properties[name];
      result.set(name, { name, required: true, secret: property?.writeOnly === true || secretName.test(name) });
    }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function compatibleDcr(proof, address) {
  if (!safeCatalogURL(proof?.resource)) return false;
  const target = new URL(address), resource = new URL(proof.resource);
  if (target.origin !== resource.origin || target.pathname.length < resource.pathname.length || !(target.pathname.replace(/\/$/, '') + '/').startsWith(resource.pathname.replace(/\/$/, '') + '/')) return false;
  return proof?.dcr === true && safeCatalogURL(proof.resource) && safeCatalogURL(proof.issuer)
    && safeCatalogURL(proof.authorizationEndpoint) && safeCatalogURL(proof.tokenEndpoint) && safeCatalogURL(proof.registrationEndpoint)
    && (!proof.codeChallengeMethods?.length || proof.codeChallengeMethods.includes('S256'));
}
export function normalizeMarketplace(input, discovery, { publicSnapshotSHA256, normalizedInputSHA256, discoverySHA256 } = {}) {
  if (!Array.isArray(input.plugins) || input.plugins.length > 1000) throw new Error('Expected a bounded public service inventory.');
  const seen = new Set();
  const entries = input.plugins.map(plugin => {
    if (!/^\d{1,30}$/.test(plugin.id) || seen.has(plugin.id)) throw new Error('Public service ids must be unique.');
    seen.add(plugin.id);
    const name = clean(plugin.displayName || plugin.name, 120), servers = plugin.servers || [];
    const firstSource = servers.map(s => safeCatalogURL(s.sourceURL)).find(Boolean) || safeCatalogURL(plugin.sourceRepositoryURL);
    const entry = { id: `service-${plugin.id}`, name, description: `Connect ${name} through an MCP integration.`, category: category(plugin),
      transport: servers.some(s => s.config?.command) ? 'stdio' : 'http', setupState: 'configuration', phoneSignIn: false, authTypes: [],
      ...(firstSource ? { sourceURL: firstSource, documentationURL: firstSource } : {}), sourcePluginIds: [plugin.id], aliases: [...new Set([name, clean(plugin.name, 120)].filter(Boolean))],
      sourceConfigSHA256: [...new Set(servers.map(s => s.sourceSHA256).filter(s => /^[a-f0-9]{64}$/.test(s)))],
      setupFields: fields(plugin, servers) };
    // Sentry documents this exact query-free address. Do not generalize query
    // removal: other query strings may contain credentials or tenant settings.
    const sentry = plugin.name === 'sentry' && plugin.sourceRepositoryURL === 'https://github.com/getsentry/plugin-cursor';
    const configurations = servers.map(s => sentry ? { ...s.config, url: 'https://mcp.sentry.dev/mcp' } : s.config || {}), addresses = configurations.map(c => safeCatalogURL(c.url || c.serverUrl));
    if (sentry) entry.documentationURL = 'https://blog.sentry.io/yes-sentry-has-an-mcp-server-and-its-pretty-good/';
    const rawAddresses = configurations.map(c => c.url || c.serverUrl).filter(v => typeof v === 'string');
    const rawManaged = rawAddresses.some(value => { try { return managedHosts.has(new URL(value).hostname); } catch { return false; } });
    if (!servers.length) { entry.setupState = 'unavailable'; entry.setupNote = 'The public catalog lists this service, but its connection setup could not be verified. Review its source for updates.'; return entry; }
    if (rawManaged) { entry.setupState = 'managed'; entry.setupNote = 'This listing uses a Cursor or Grok managed connector backend. Strata needs an independent service integration; the vendor account connection cannot be imported.'; return entry; }
    if (entry.transport === 'stdio') { entry.setupNote = plugin.name === '1password'
      ? 'Requires the 1Password desktop app, a subscription and its Labs MCP server on the Mac. Follow the official local setup; this connection uses the desktop app rather than a browser account login.'
      : 'Requires a local program and its dependencies on the Mac. Review the source setup before adding a program connection. Strata does not install or start it from this listing.'; return entry; }
    if (servers.length !== 1) { entry.setupNote = 'This service publishes multiple server configurations. Choose the required server and review its setup in the source before creating a custom connection.'; return entry; }
    const config = configurations[0], address = addresses[0], url = address && new URL(address);
    if (!address) { entry.setupNote = 'Requires a service-specific server address or credential configuration. Review the source setup, then add a custom connector with your own values.'; return entry; }
    const transport = config.type || config.transport;
    if (transport === 'sse') { entry.setupNote = 'The published setup uses the older SSE transport. Review the service source for a supported Streamable HTTP endpoint.'; return entry; }
    entry.url = address;
    if (plugin.name === 'figma' && url.hostname === 'mcp.figma.com') {
      entry.authTypes = ['oauth']; entry.documentationURL = 'https://help.figma.com/hc/en-us/articles/39216419318551-Get-started-with-the-Figma-MCP-server';
      entry.setupFields = [{ name: 'oauthClientId', required: true, secret: false }];
      entry.setupNote = 'Figma currently limits its remote MCP server to approved clients. Strata needs its own supported client registration before browser login is available; another app’s registration cannot be reused.';
      return entry;
    }
    if (googleHosts.has(url.hostname)) {
      entry.authTypes = ['oauth'];
      entry.setupFields = [{ name: 'oauthClientId', required: true, secret: false }, { name: 'oauthClientSecret', required: true, secret: true }];
      entry.setupNote = 'Enable the service and MCP API in your Google Cloud project, configure consent, and create your own OAuth client. Register the Mac callback http://127.0.0.1:47841/callback and enter your client ID and secret in Advanced setup. Google Workspace MCP is in Developer Preview; iPhone browser sign-in is unavailable.';
      return entry;
    }
    if (config.oauth || Object.keys(config.auth || {}).some(key => /client.?id|client.?secret|callback/i.test(key))) {
      entry.authTypes = ['oauth']; entry.setupFields = [...entry.setupFields, { name: 'oauthClientId', required: true, secret: false }];
      entry.setupNote = 'The published setup uses an application-specific OAuth registration. Configure your own registered client on the Mac; Strata does not copy another app’s client ID, secret or callback settings.'; return entry;
    }
    const headers = Object.entries(config.headers || {});
    const bearer = headers.length === 1 && /^authorization$/i.test(headers[0][0]) && /^Bearer\s+(?:\$\{(?:(?:env|input):)?[A-Za-z_][A-Za-z0-9_]*\}|\{\{[A-Za-z_][A-Za-z0-9_]*\}\})$/i.test(headers[0][1]);
    if (bearer && entry.setupFields.length === 1) { entry.setupState = 'ready'; entry.authTypes = ['bearer']; entry.setupNote = 'Add your own service API key. Credentials remain on your Strata Mac; choose bot, team and tool access after checking the connection.'; return entry; }
    if (headers.length || entry.setupFields.length || config.envFile) { entry.setupNote = 'Requires service-specific credentials, headers or configuration fields. Review the source setup; these settings are not supplied by Strata.'; return entry; }
    const proof = discovery.endpoints?.[address];
    if (compatibleDcr(proof, address)) {
      entry.setupState = 'ready'; entry.authTypes = ['oauth']; entry.setupNote = 'Sign in with your service account on the Mac, then choose the bots, teams and tools to share. Public OAuth discovery supports dynamic client registration; account login has not been performed by Strata’s catalog importer.';
      entry.readiness = { method: 'public-oauth-discovery', resource: proof.resource, issuer: proof.issuer, registrationEndpoint: proof.registrationEndpoint };
      return entry;
    }
    entry.setupNote = 'The service endpoint is published, but compatible account sign-in has not been verified. Review the source for credentials or a registered OAuth client before creating a connection.';
    return entry;
  });
  return { version: 1, source: { url: sourceURL, ...(publicSnapshotSHA256 ? { sha256: publicSnapshotSHA256 } : {}),
    ...(normalizedInputSHA256 ? { normalizedInputSHA256 } : {}), ...(discoverySHA256 ? { discoverySHA256 } : {}),
    ...(typeof discovery.at === 'string' ? { metadataObservedAt: discovery.at } : {}) },
    publicServiceCount: entries.length, excludedSkillsOnlyOrNoMcpCount: input.skillsOnlyOrNoMcpCount || 0,
    entries };
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputPath, discoveryPath, outputPath, publicPath] = process.argv.slice(2);
  if (!inputPath || !discoveryPath || !outputPath || !publicPath) throw new Error('Usage: import-connector-marketplace.mjs normalized-public-input.json public-oauth-discovery.json output.json public-catalog.json');
  const read = path => { const bytes = readFileSync(path); if (bytes.length > 16 * 1024 * 1024) throw new Error('Catalog input exceeds limit.'); return JSON.parse(bytes); };
  const output = normalizeMarketplace(read(inputPath), read(discoveryPath), { publicSnapshotSHA256: digest(readFileSync(publicPath)), normalizedInputSHA256: digest(readFileSync(inputPath)), discoverySHA256: digest(readFileSync(discoveryPath)) });
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ services: output.publicServiceCount, states: Object.fromEntries(['ready', 'configuration', 'managed', 'unavailable'].map(state => [state, output.entries.filter(entry => entry.setupState === state).length])), sha256: digest(readFileSync(outputPath)) }));
}
