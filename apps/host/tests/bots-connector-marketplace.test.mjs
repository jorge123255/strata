import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeMarketplace, safeCatalogURL } from '../scripts/import-connector-marketplace.mjs';
import { mergeMarketplaceCatalog } from '../server/bots-connector-marketplace.mjs';
import { botConnectorCatalog, botConnectorPreset } from '../server/bots-connector-catalog.mjs';

const snapshot = JSON.parse(readFileSync(new URL('../server/bots-connector-marketplace.json', import.meta.url)));
const source = 'https://raw.githubusercontent.com/vendor/plugin/0123456789012345678901234567890123456789/mcp.json';
const plugin = (config, changes = {}) => ({ id: '123', name: 'fixture', displayName: 'Fixture', sourceRepositoryURL: 'https://github.com/vendor/plugin', variables: {}, servers: [{ name: 'fixture', config, sourceURL: source, sourceSHA256: 'a'.repeat(64) }], ...changes });
const input = p => ({ plugins: [p], skillsOnlyOrNoMcpCount: 0 });
const proof = { dcr: true, resource: 'https://service.invalid/mcp', issuer: 'https://accounts.invalid', authorizationEndpoint: 'https://accounts.invalid/authorize', tokenEndpoint: 'https://accounts.invalid/token', registrationEndpoint: 'https://accounts.invalid/register', codeChallengeMethods: ['S256'] };

test('the frozen marketplace represents every public MCP service and excludes the skills-only listings', () => {
  assert.equal(snapshot.publicServiceCount, 391); assert.equal(snapshot.entries.length, 391);
  assert.equal(snapshot.excludedSkillsOnlyOrNoMcpCount, 70);
  assert.equal(snapshot.source.sha256, '7865764800ce69257a87d83a084713fee0ac94c1692109f5e35890f375edd5fc');
  const rows = botConnectorCatalog().connectors, ids = rows.flatMap(row => row.sourcePluginIds);
  assert.equal(ids.length, 391); assert.equal(new Set(ids).size, 391);
  assert.deepEqual(new Set(ids), new Set(snapshot.entries.flatMap(row => row.sourcePluginIds)));
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.ok(rows.every(row => /^[A-Za-z0-9_-]{1,120}$/.test(row.id)));
  for (const row of rows) {
    assert.ok(['ready', 'configuration', 'managed', 'unavailable'].includes(row.setupState));
    assert.equal(typeof row.phoneSignIn, 'boolean');
    assert.ok(row.aliases.length >= 1 && row.aliases.every(alias => typeof alias === 'string' && alias.length <= 120 && !/[\u0000-\u001f\u007f]/.test(alias)));
    for (const key of ['url', 'sourceURL', 'documentationURL']) if (row[key]) assert.equal(safeCatalogURL(row[key]), row[key]);
  }
  rows[0].name = 'changed'; rows[0].authTypes.push('changed'); rows[0].aliases.push('changed');
  assert.notEqual(botConnectorCatalog().connectors[0].name, 'changed');
  assert.ok(!botConnectorCatalog().connectors[0].authTypes.includes('changed')); assert.ok(!botConnectorPreset('github').aliases.includes('changed'));
});

test('the seven existing preset identities, endpoints and sign-in methods remain stable', () => {
  const expected = {
    github: ['https://api.githubcopilot.com/mcp/', ['bearer']], linear: ['https://mcp.linear.app/mcp', ['oauth', 'bearer']],
    'linear-readonly': ['https://mcp.linear.app/mcp/readonly', ['oauth', 'bearer']], notion: ['https://mcp.notion.com/mcp', ['oauth']],
    atlassian: ['https://mcp.atlassian.com/v2/mcp', ['oauth']], slack: ['https://mcp.slack.com/mcp', ['bearer']],
    'custom-http': [undefined, ['none', 'bearer', 'oauth']],
  };
  for (const [id, [url, authTypes]] of Object.entries(expected)) {
    const row = botConnectorPreset(id); assert.ok(row); assert.equal(row.id, id); assert.equal(row.url, url); assert.deepEqual(row.authTypes, authTypes);
  }
});

test('catalog rows contain setup requirements and provenance but no executable or registered credential configuration', () => {
  const serialized = JSON.stringify(snapshot);
  for (const key of ['command', 'args', 'env', 'headers', 'oauth', 'auth', 'clientId', 'clientSecret', 'callbackPort', 'authorizationURL']) assert.ok(!serialized.includes(`"${key}":`), key);
  assert.ok(!serialized.includes('<fixed-value-redacted>')); assert.ok(!serialized.includes('${')); assert.ok(!serialized.includes('{{'));
  const rows = botConnectorCatalog().connectors;
  const gmail = rows.find(row => row.name === 'Gmail'); assert.equal(gmail.setupState, 'configuration'); assert.equal(gmail.phoneSignIn, false); assert.deepEqual(gmail.authTypes, ['oauth']); assert.match(gmail.setupNote, /47841\/callback/);
  const outlook = rows.find(row => row.name === 'Outlook'); assert.equal(outlook.setupState, 'managed'); assert.equal(outlook.url, undefined); assert.deepEqual(outlook.authTypes, []);
  const password = rows.find(row => row.name === '1Password'); assert.equal(password.setupState, 'configuration'); assert.equal(password.transport, 'stdio'); assert.equal(password.url, undefined);
  const figma = rows.find(row => row.name === 'Figma'); assert.equal(figma.setupState, 'configuration'); assert.match(figma.setupNote, /approved clients/);
  assert.ok(rows.filter(row => row.url && /(?:api\.cursor\.com|connectors-gateway\.grok)/.test(row.url)).every(row => row.setupState !== 'ready'));
});

test('ready OAuth requires discovered resource audience, issuer, registration and S256 compatibility', () => {
  const p = plugin({ url: 'https://service.invalid/mcp' });
  assert.equal(normalizeMarketplace(input(p), { endpoints: {} }).entries[0].setupState, 'configuration');
  const rows = discovery => normalizeMarketplace(input(p), { endpoints: { 'https://service.invalid/mcp': discovery } }).entries;
  assert.equal(rows(proof)[0].setupState, 'ready'); assert.deepEqual(rows(proof)[0].authTypes, ['oauth']);
  for (const bad of [{ ...proof, dcr: false }, { ...proof, resource: 'https://other.invalid/mcp' }, { ...proof, registrationEndpoint: undefined }, { ...proof, authorizationEndpoint: 'http://accounts.invalid/authorize' }, { ...proof, codeChallengeMethods: ['plain'] }]) assert.equal(rows(bad)[0].setupState, 'configuration');
});

test('only one explicit bearer placeholder can use the API-key path; other configuration stays manual', () => {
  const config = { url: 'https://service.invalid/mcp', headers: { Authorization: 'Bearer ${SERVICE_TOKEN}' } };
  const ready = normalizeMarketplace(input(plugin(config)), {}).entries[0]; assert.equal(ready.setupState, 'ready'); assert.deepEqual(ready.authTypes, ['bearer']);
  assert.deepEqual(ready.setupFields, [{ name: 'SERVICE_TOKEN', required: true, secret: true }]);
  for (const p of [plugin({ ...config, headers: { ...config.headers, 'x-workspace': '${WORKSPACE}' } }), plugin({ ...config, headers: { Authorization: 'Bearer STATIC_PRIVATE_SENTINEL' } }), plugin({ ...config, url: 'https://service.invalid/mcp?api_key=PRIVATE_QUERY_SENTINEL' }), plugin({ ...config, oauth: { clientId: 'PRIVATE_CLIENT_SENTINEL', clientSecret: 'PRIVATE_SECRET_SENTINEL', callbackPort: 9999 } }), plugin({ command: 'PRIVATE_PROGRAM_SENTINEL', args: ['PRIVATE_ARG_SENTINEL'], env: { TOKEN: 'PRIVATE_ENV_SENTINEL' } })]) {
    const result = normalizeMarketplace(input(p), {}); assert.equal(result.entries[0].setupState, 'configuration'); assert.ok(!JSON.stringify(result).includes('SENTINEL'));
  }
});

test('multi-server, managed, template, insecure and unsupported transports cannot become a ready direct connection', () => {
  const variants = [plugin({ url: 'https://api.cursor.com/rest-mcp/outlook/mcp' }), plugin({ url: 'https://connectors-gateway.grok.com/gateway/v1/fixture/mcp' }), plugin({ url: 'https://${TENANT}.invalid/mcp' }), plugin({ url: 'http://private.invalid/mcp' }), plugin({ url: 'https://service.invalid/sse', type: 'sse' }), plugin({}, { servers: [] }), plugin({}, { servers: [{ config: { url: 'https://a.invalid/mcp' } }, { config: { url: 'https://b.invalid/mcp' } }] })];
  for (const p of variants) assert.notEqual(normalizeMarketplace(input(p), {}).entries[0].setupState, 'ready');
  for (const url of ['https://127.0.0.2/mcp', 'https://10.0.0.1/mcp', 'https://[::ffff:127.0.0.1]/mcp', 'https://service.local/mcp', 'https://service.internal/mcp', 'https://user:secret@service.invalid/mcp', 'https://service.invalid/mcp?api_key=secret']) assert.equal(safeCatalogURL(url), undefined);
});

test('deduplication uses an exact endpoint and preserves every source id and alias without mutating the legacy preset', () => {
  const legacy = [{ id: 'legacy', name: 'Legacy', url: 'https://service.invalid/mcp', authTypes: ['bearer'] }];
  const imported = normalizeMarketplace(input(plugin({ url: 'https://service.invalid/mcp' })), {});
  const combined = mergeMarketplaceCatalog(legacy, imported);
  assert.equal(combined.length, 1); assert.equal(combined[0].id, 'legacy'); assert.deepEqual(combined[0].sourcePluginIds, ['123']); assert.ok(combined[0].aliases.includes('Fixture')); assert.ok(combined[0].aliases.includes('fixture'));
  assert.equal(legacy[0].sourcePluginIds, undefined); assert.equal(imported.entries[0].id, 'service-123');
  imported.entries[0].url += '/'; assert.equal(mergeMarketplaceCatalog(legacy, imported).length, 2, 'A redirect or trailing-slash alias is not silently assumed equivalent.');
  combined[0].aliases.push('changed'); assert.ok(!botConnectorCatalog().connectors.some(row => row.aliases.includes('changed')));
});
