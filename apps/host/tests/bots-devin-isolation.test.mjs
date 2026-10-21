/** Structural diagnostics only; no installed CLI, account, model or connection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { devinConfig, verifyDevinConfig, verifyDevinInventory } from '../server/bots-runtime/devin.mjs';
const secret = 'PRIVATE_RESPONSE_SOCKET_CREDENTIAL_82ca';
const settings = { configPath: '/private/fixture/config.json', mcpConfigPath: '/private/fixture/mcp.json' };
function rejectsCheck(fn, check) {
  assert.throws(fn, error => {
    assert.equal(error.code, 'devin_isolation_unverified'); assert.equal(error.isolationCheck, check);
    assert.match(error.message, /Devin could not confirm its isolated tool configuration \(.+\)\. No model prompt was sent\./);
    assert.equal(error.message.includes(secret), false); assert.equal(error.message.includes('/private/fixture'), false);
    assert.equal(error.message.includes('Update Devin CLI'), false);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'isolationCheck']); return true;
  });
}
const configs = [
  ['config.path', r => { r.configPath = secret; }], ['config.version', r => { r.config.version = secret; }],
  ['config.subagents', r => { r.config.subagents_enabled = true; }], ['config.updates', r => { r.config.auto_update = true; }],
  ['config.native_tools', r => { r.config.agent.codex_tools = true; }], ['config.local_bypass', r => { r.config.local_tools_bypass_permissions = true; }],
  ['config.imports', r => { r.config.read_config_from.claude = true; }], ['config.disabled_tools', r => { r.config.disabled_tools = [secret]; }],
  ['config.permissions_deny', r => { r.config.permissions.deny = []; }], ['config.permissions_allow', r => { r.config.permissions.allow = [secret]; }],
  ['config.permissions_ask', r => { r.config.permissions.ask = [secret]; }], ['config.hooks', r => { r.config.hooks = { unsafe: secret }; }],
  ['config.mcp_servers', r => { r.config.mcpServers = { unsafe: secret }; }],
];
test('strict isolated configuration is still accepted without changing it', () => { const response = { configPath: settings.configPath, config: devinConfig() }, before = structuredClone(response); verifyDevinConfig(response, settings); assert.deepEqual(response, before); });
for (const [check, corrupt] of configs) test('configuration diagnostic identifies only the closed check: ' + check, () => {
  const response = { configPath: settings.configPath, config: devinConfig() }; corrupt(response); rejectsCheck(() => verifyDevinConfig(response, settings), check);
});
test('missing native configuration produces a closed check instead of exposing metadata', () => rejectsCheck(() => verifyDevinConfig({ configPath: settings.configPath }, settings), 'config.version'));

function inventory() {
  const definitions = [{ name: 'inspect', description: 'Inert assigned tool', inputSchema: { type: 'object', properties: {}, required: [] } }];
  const bridge = { command: '/private/fixture/bridge', args: ['fixture'], env: { SECOND: 'two', FIRST: 'one' } };
  const value = { servers: { servers: [{ serverId: 'strata', disabled: false, connectionStatus: 'connected', sourcePath: settings.mcpConfigPath, transport: 'stdio', command: bridge.command, args: [...bridge.args], env: { FIRST: 'one', SECOND: 'two' }, disabledTools: [] }] }, tools: { serverId: 'strata', tools: structuredClone(definitions), resources: [] }, plugins: { plugins: [], availability: { complete: true, originsPending: 0, originsFailed: 0 } }, skills: { skills: [{ isBuiltin: true, provider: 'builtin', path: 'builtin:drs' }, { isBuiltin: true, provider: 'builtin', path: 'builtin:upload-secrets' }] } };
  return { value, expected: { bridge, definitions, settings } };
}
const inventories = [
  ['mcp.servers', v => { v.servers.servers.push({ serverId: secret }); }],
  ['mcp.identity', v => { v.servers.servers[0].serverId = secret; }], ['mcp.enabled', v => { v.servers.servers[0].disabled = true; }],
  ['mcp.connected', v => { v.servers.servers[0].connectionStatus = secret; }], ['mcp.source', v => { v.servers.servers[0].sourcePath = secret; }],
  ['mcp.transport', v => { v.servers.servers[0].transport = secret; }], ['mcp.command', v => { v.servers.servers[0].command = secret; }],
  ['mcp.arguments', v => { v.servers.servers[0].args = [secret]; }], ['mcp.environment', v => { v.servers.servers[0].env.FIRST = secret; }],
  ['mcp.disabled_tools', v => { v.servers.servers[0].disabledTools = [secret]; }], ['mcp.tools', v => { v.tools.serverId = secret; }],
  ['mcp.resources', v => { v.tools.resources = [{ uri: secret }]; }], ['mcp.tool_count', v => { v.tools.tools.push({ name: secret }); }],
  ['mcp.tool_schema', v => { v.tools.tools[0].description = secret; }], ['mcp.tool_schema', v => { v.tools.tools[0].inputSchema = { type: secret }; }],
  ['mcp.tool_schema', v => { v.tools.tools[0] = null; }], ['mcp.identity', v => { v.servers.servers[0] = null; }],
  ['plugins.list', v => { v.plugins.plugins = [{ name: secret }]; }], ['plugins.complete', v => { v.plugins.availability.complete = false; }],
  ['plugins.pending', v => { v.plugins.availability.originsPending = 1; }], ['plugins.failed', v => { v.plugins.availability.originsFailed = 1; }],
  ['skills.list', v => { v.skills.skills = secret; }], ['skills.scope', v => { v.skills.skills.push({ isBuiltin: false, provider: 'global', path: secret }); }],
  ['skills.scope', v => { v.skills.skills = [null]; }],
];
test('strict inventory preserves canonical object-order equality and the allowed built-in skills', () => { const { value, expected } = inventory(), before = structuredClone(value); verifyDevinInventory(value, expected); assert.deepEqual(value, before); });
for (const [index, [check, corrupt]] of inventories.entries()) test(`inventory diagnostic ${index} identifies only the closed check: ${check}`, () => {
  const { value, expected } = inventory(); corrupt(value); rejectsCheck(() => verifyDevinInventory(value, expected), check);
});
test('without a bridge the inventory still accepts no MCP server and still rejects a server', () => {
  const { value, expected } = inventory(); value.servers.servers = []; expected.bridge = null; verifyDevinInventory(value, expected);
  value.servers.servers.push({ serverId: secret }); rejectsCheck(() => verifyDevinInventory(value, expected), 'mcp.servers');
});
