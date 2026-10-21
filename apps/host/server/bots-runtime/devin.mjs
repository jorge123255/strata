/** Devin's native account stays on its execution computer. Only Strata's tool bridge is exposed. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, writeFile, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { jsonRpcProcess, killOwned, redact } from './process.mjs';
import { startToolBridge } from './tool-bridge.mjs';

export const DEVIN_DISABLED_TOOLS = Object.freeze([
  'read', 'edit', 'write', 'grep', 'glob', 'exec', 'restricted_exec', 'apply_patch', 'fetch', 'web_search',
  'run_subagent', 'read_subagent', 'skill', 'discover_skills', 'use_skill', 'exit_plan_mode',
  'todo_write', 'notebook_read', 'get_output', 'webfetch', 'extend_context', 'kill_shell', 'write_to_process',
  'notebook_edit', 'ask_user_question', 'request_scope', 'code_search', 'browser_preview', 'close_browser_preview',
  'sidekick',
]);
const CONFIG_SOURCES = ['cursor', 'windsurf', 'claude', 'opencode', 'zed', 'copilot', 'agents_standard'];
export function devinConfig() {
  return { version: 1, agent: { codex_tools: false, thinking: { mode: 'stream' } },
    subagents_enabled: false, disabled_tools: [...DEVIN_DISABLED_TOOLS], auto_update: false,
    read_config_from: Object.fromEntries([...CONFIG_SOURCES, 'cloud'].map(name => [name, false])),
    hooks: {}, mcpServers: {}, local_tools_bypass_permissions: false,
    permissions: { allow: [], deny: [...DEVIN_DISABLED_TOOLS], ask: [] }, otel: { enabled: false } };
}
async function privateFolder(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('The private Devin runtime folder is not secure.');
  return path;
}
export async function prepareDevin({ stateDir, key, env = process.env }) {
  const root = await privateFolder(join(stateDir ?? join(homedir(), '.strata/bots-runtime'), 'devin', createHash('sha256').update(String(key)).digest('hex')));
  const [home, configHome, cacheHome, sessions, cwd] = await Promise.all(['home', 'config', 'cache', 'sessions', 'workspace'].map(name => privateFolder(join(root, name))));
  const configDir = await privateFolder(join(configHome, 'devin')), configPath = join(configHome, 'devin', 'config.json'), mcpConfigPath = join(configDir, 'mcp_config.json');
  await writeFile(configPath, JSON.stringify(devinConfig()), { mode: 0o600, flag: 'w' });
  // The current CLI merges a dedicated MCP file independently of --config. Isolate both sources.
  // Session/new receives only this turn's Strata bridge, so no native account MCP definition is copied.
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600, flag: 'w' });
  const originalHome = env.HOME || homedir(), dataHome = env.XDG_DATA_HOME || join(originalHome, '.local/share');
  if (!isAbsolute(dataHome)) throw new Error('Devin account storage must use an absolute path.');
  return { cwd, configPath, mcpConfigPath, env: { ...env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_CACHE_HOME: cacheHome,
    XDG_DATA_HOME: dataHome, DEVIN_SESSIONS_DIR: sessions, DEVIN_PLUGIN_DISCOVERY: 'off' },
    close: () => rm(configPath, { force: true }) };
}
export const devinArguments = (configPath, model = '') => ['--config', configPath, '--permission-mode', 'auto', 'acp', ...(model ? ['--model', model] : [])];

/** Public CLI commands only. Raw account output is never returned to a renderer. */
async function publicCommand(command, args, settings, { signal, spawnProcess = spawn, timeoutMs = 8000 } = {}) {
  signal?.throwIfAborted();
  const child = spawnProcess(command, ['--config', settings.configPath, ...args], { cwd: settings.cwd, env: settings.env, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
  let output = '', failed = false, timer;
  const abort = () => { failed = true; void killOwned(child); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const code = await new Promise(resolve => {
      timer = setTimeout(abort, timeoutMs); timer.unref();
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) abort(); });
      child.once('error', () => { failed = true; resolve(-1); }); child.once('close', resolve);
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted(); return !failed && code === 0 ? output : null;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await killOwned(child); }
}
export function devinAuthState(output) {
  if (typeof output !== 'string') return 'unverified';
  if (/^Not logged in\.\s*$/m.test(output)) return 'signed_out';
  if (/^Logged in(?:\s|\().*$/m.test(output)) return 'signed_in';
  return 'unverified';
}
export async function devinStatus(command, options = {}) {
  const settings = await prepareDevin({ ...options, key: 'status' });
  try { return devinAuthState(await publicCommand(command, ['auth', 'status'], settings, options)); }
  finally { await settings.close(); }
}
export function devinCatalog(document) {
  if (!Array.isArray(document?.families)) throw new Error('Devin returned an unrecognized model catalog.');
  const seen = new Set(), rows = [];
  for (const family of document.families.slice(0, 500)) for (const variant of (Array.isArray(family.variants) ? family.variants : []).slice(0, 100)) {
    const id = variant.model_uid;
    if (typeof id !== 'string' || !id || id === 'adaptive' || id.startsWith('fusion-') || id.length > 250 || /[\u0000-\u001f]/.test(id) || seen.has(id)) continue;
    seen.add(id); rows.push({ id, name: String(variant.label || family.family_label || id).slice(0, 250), efforts: [] });
  }
  return rows.slice(0, 500);
}
export async function devinModels(command, options = {}) {
  const settings = await prepareDevin({ ...options, key: 'catalog' });
  try {
    const output = await publicCommand(command, ['models', 'list', '--format', 'json'], settings, options);
    if (!output) throw new Error('Could not load the Devin account model catalog. Sign in on the execution computer and refresh.');
    return devinCatalog(JSON.parse(output));
  } finally { await settings.close(); }
}
// Labels are a closed vocabulary. Never interpolate native metadata, paths,
// sockets, environment values or account responses into a diagnostic.
const isolationLabels = Object.freeze({
  'initialize.protocol': 'ACP protocol', 'initialize.mcp_path': 'private MCP configuration path',
  'config.path': 'private configuration path', 'config.version': 'configuration version',
  'config.subagents': 'native subagents disabled', 'config.updates': 'automatic updates disabled',
  'config.native_tools': 'native coding tools disabled', 'config.local_bypass': 'native permission bypass disabled',
  'config.imports': 'external configuration imports disabled', 'config.disabled_tools': 'native tool disable list',
  'config.permissions_deny': 'native tool deny list', 'config.permissions_allow': 'native permission allow list empty',
  'config.permissions_ask': 'native permission ask list empty', 'config.hooks': 'configuration hooks empty',
  'config.mcp_servers': 'configuration MCP servers empty', 'rules.list': 'inherited rules empty', 'hooks.list': 'inherited hooks empty',
  'mcp.servers': 'MCP server inventory', 'mcp.identity': 'Strata MCP server identity', 'mcp.enabled': 'Strata MCP server enabled',
  'mcp.connected': 'Strata MCP connection ready', 'mcp.source': 'private MCP server source', 'mcp.transport': 'MCP stdio transport',
  'mcp.command': 'MCP bridge command', 'mcp.arguments': 'MCP bridge arguments', 'mcp.environment': 'fresh MCP bridge environment',
  'mcp.disabled_tools': 'MCP disabled tools empty', 'mcp.tools': 'Strata MCP tool inventory', 'mcp.resources': 'MCP resources empty',
  'mcp.tool_count': 'assigned MCP tool count', 'mcp.tool_schema': 'assigned MCP tool names and schemas',
  'plugins.list': 'plugins empty', 'plugins.complete': 'plugin discovery complete', 'plugins.pending': 'plugin discovery settled',
  'plugins.failed': 'plugin discovery without errors', 'skills.list': 'skill inventory', 'skills.scope': 'built-in skills only',
});
function isolationFailure(check) {
  if (!Object.hasOwn(isolationLabels, check)) throw new Error('Unknown internal Devin isolation check.');
  return Object.assign(new Error(`Devin could not confirm its isolated tool configuration (${isolationLabels[check]}). No model prompt was sent. ${check === 'mcp.connected' ? 'Wait for the Strata MCP connection to be ready before retrying.' : 'Review this isolation check before retrying or choose another provider.'}`), { code: 'devin_isolation_unverified', isolationCheck: check });
}
const requireIsolation = (condition, check) => { if (!condition) throw isolationFailure(check); };
export function verifyDevinConfig(response, settings) {
  const c = response?.config;
  requireIsolation(response?.configPath === settings.configPath, 'config.path');
  requireIsolation(c && c.version === 1, 'config.version');
  requireIsolation(c.subagents_enabled === false, 'config.subagents');
  requireIsolation(c.auto_update === false, 'config.updates');
  requireIsolation(c.agent?.codex_tools === false, 'config.native_tools');
  requireIsolation(c.local_tools_bypass_permissions === false, 'config.local_bypass');
  requireIsolation(CONFIG_SOURCES.every(name => c.read_config_from?.[name] === false), 'config.imports');
  requireIsolation(Array.isArray(c.disabled_tools) && DEVIN_DISABLED_TOOLS.every(name => c.disabled_tools.includes(name)), 'config.disabled_tools');
  requireIsolation(Array.isArray(c.permissions?.deny) && DEVIN_DISABLED_TOOLS.every(name => c.permissions.deny.includes(name)), 'config.permissions_deny');
  requireIsolation(Array.isArray(c.permissions?.allow) && c.permissions.allow.length === 0, 'config.permissions_allow');
  requireIsolation(Array.isArray(c.permissions?.ask) && c.permissions.ask.length === 0, 'config.permissions_ask');
  requireIsolation(c.hooks && Object.keys(c.hooks).length === 0, 'config.hooks');
  requireIsolation(c.mcpServers && Object.keys(c.mcpServers).length === 0, 'config.mcp_servers');
}
const ordered = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(ordered) : Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
export function verifyDevinInventory({ servers, tools, plugins, skills }, { bridge, definitions = [], settings }) {
  requireIsolation(Array.isArray(servers?.servers) && servers.servers.length === (bridge ? 1 : 0), 'mcp.servers');
  if (bridge) {
    const server = servers.servers[0];
    requireIsolation(server?.serverId === 'strata', 'mcp.identity');
    requireIsolation(server.disabled === false, 'mcp.enabled');
    requireIsolation(server.connectionStatus === 'connected', 'mcp.connected');
    requireIsolation(server.sourcePath === settings.mcpConfigPath, 'mcp.source');
    requireIsolation(server.transport === 'stdio', 'mcp.transport');
    requireIsolation(server.command === bridge.command, 'mcp.command');
    requireIsolation(canonical(server.args) === canonical(bridge.args), 'mcp.arguments');
    requireIsolation(canonical(server.env) === canonical(bridge.env), 'mcp.environment');
    requireIsolation(Array.isArray(server.disabledTools) && server.disabledTools.length === 0, 'mcp.disabled_tools');
    requireIsolation(tools?.serverId === 'strata' && Array.isArray(tools.tools), 'mcp.tools');
    requireIsolation(Array.isArray(tools.resources) && tools.resources.length === 0, 'mcp.resources');
    requireIsolation(tools.tools.length === definitions.length, 'mcp.tool_count');
    const expected = new Map(definitions.map(tool => [tool.name, tool]));
    for (const tool of tools.tools) {
      const definition = expected.get(tool?.name);
      requireIsolation(definition && tool.description === definition.description && canonical(tool.inputSchema) === canonical(definition.inputSchema), 'mcp.tool_schema');
      expected.delete(tool.name);
    }
    requireIsolation(expected.size === 0, 'mcp.tool_schema');
  }
  requireIsolation(Array.isArray(plugins?.plugins) && plugins.plugins.length === 0, 'plugins.list');
  requireIsolation(plugins.availability?.complete === true, 'plugins.complete');
  requireIsolation(plugins.availability.originsPending === 0, 'plugins.pending');
  requireIsolation(plugins.availability.originsFailed === 0, 'plugins.failed');
  requireIsolation(Array.isArray(skills?.skills), 'skills.list');
  requireIsolation(skills.skills.every(skill => skill?.isBuiltin === true && skill.provider === 'builtin' && ['builtin:drs', 'builtin:upload-secrets'].includes(skill.path)), 'skills.scope');
}
const optionValues = option => option?.options?.flatMap(item => Array.isArray(item.options) ? item.options : [item]) ?? [];
async function setOption(rpc, sessionId, options, category, value) {
  const option = options?.find(option => option.category === category);
  if (!option || !optionValues(option).some(item => item.value === value)) throw new Error(`Devin did not advertise the selected ${category === 'thought_level' ? 'effort' : 'session mode'}. Choose Provider default or update Devin CLI.`);
  const result = await rpc.request('session/set_config_option', { sessionId, configId: option.id, value });
  if (result.configOptions?.find(item => item.id === option.id)?.currentValue !== value) throw new Error('Devin did not confirm the requested session setting. No model prompt was sent.');
  return result.configOptions;
}
export async function runDevin(c) {
  const command = await c.executable('devin'); if (!command) throw new Error('Install Devin CLI and sign in on this execution computer first.');
  if (c.bot.model === 'adaptive' || c.bot.model?.startsWith('fusion-')) throw new Error('Choose a single Devin model. Fusion models are unavailable in Strata’s host-managed bot runtime.');
  const settings = await prepareDevin({ stateDir: c.options.stateDir, key: `${c.bot.id}:${c.sessionId ?? c.checkpoint?.nativeSessionId ?? randomUUID()}`, env: c.env });
  let bridge, rpc, sessionId, projecting = false;
  const transportCalls = new Map(), seenCallIds = new Set();
  const nativeName = update => update?._meta?.['cognition.ai/toolName'];
  const knownTool = name => typeof name === 'string' && c.tools.some(tool => name === `mcp__strata__${tool.name}`);
  const cancel = () => { if (rpc && sessionId) { try { rpc.notify('session/cancel', { sessionId }); } catch { /* close owns the process group */ } } };
  c.signal.addEventListener('abort', cancel, { once: true });
  try {
    bridge = c.tools.length ? await startToolBridge({ tools: c.tools, executeTool: c.execute, signal: c.signal }) : null;
    // Devin inventories the dedicated file even when ACP session/new also receives the bridge.
    // Write only this turn's fresh socket, never merge or copy the account's MCP configuration.
    if (bridge) await writeFile(settings.mcpConfigPath, JSON.stringify({ mcpServers: { strata: { command: bridge.command, args: bridge.args, env: bridge.env } } }), { mode: 0o600 });
    rpc = jsonRpcProcess({ command, args: devinArguments(settings.configPath, c.bot.model), cwd: settings.cwd, env: { ...settings.env, ...(bridge?.env ?? {}) }, signal: c.signal, spawnProcess: c.options.spawnProcess,
      onNotification({ method, params: p = {} }) {
        if (!projecting || method !== 'session/update' || p.sessionId !== sessionId) return;
        const u = p.update ?? {};
        if (u.sessionUpdate === 'tool_call') {
          const id = u.toolCallId, name = nativeName(u);
          if (typeof id !== 'string' || !id || id.length > 300) return;
          if (seenCallIds.has(id)) { transportCalls.delete(id); return; }
          seenCallIds.add(id);
          if (knownTool(name)) transportCalls.set(id, name);
          return;
        }
        if (u.sessionUpdate === 'tool_call_update') {
          const name = nativeName(u);
          if (name !== undefined && transportCalls.get(u.toolCallId) !== name || ['completed', 'failed'].includes(u.status)) transportCalls.delete(u.toolCallId);
          return;
        }
        if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') c.frame({ type: 'delta', text: u.content.text ?? '' });
        else if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text') c.frame({ type: 'reasoning', text: u.content.text ?? '' });
        else if (u.sessionUpdate === 'usage_update') c.frame({ type: 'stats', tokensIn: u.inputTokens ?? 0, tokensOut: u.outputTokens ?? 0 });
      },
      onRequest({ id, method, params: p = {} }, process) {
        if (method !== 'session/request_permission') { process.reject(id, 'Use the supplied Strata MCP tools. Direct files, terminal, authentication and configuration RPC are unavailable.'); return; }
        // Native tools remain denied even when Strata's selected policy is Bypass.
        // The bridge's executeTool callback is the only path to the host policy ledger.
        const callId = p.toolCall?.toolCallId, name = transportCalls.get(callId);
        const known = projecting && p.sessionId === sessionId && knownTool(name)
          && (nativeName(p.toolCall) === undefined || nativeName(p.toolCall) === name);
        // The native permission request often carries only an id. Trust exact prior ACP tool metadata,
        // never a display title; consume once so stale/reused ids cannot acquire another approval.
        transportCalls.delete(callId);
        const choice = (p.options ?? []).find(option => option.kind === (known ? 'allow_once' : 'reject_once'));
        process.respond(id, { outcome: choice ? { outcome: 'selected', optionId: choice.optionId } : { outcome: 'cancelled' } });
      },
    });
    const init = await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'strata', version: '0.2.1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { 'cognition.ai/mcp': true, 'cognition.ai/plugins': true, 'cognition.ai/persistOnCreate': true } } });
    requireIsolation(init?.protocolVersion === 1, 'initialize.protocol');
    requireIsolation(init?._meta?.mcpConfigPath === settings.mcpConfigPath, 'initialize.mcp_path');
    let session;
    if (c.checkpoint?.nativeSessionId) {
      if (!init.agentCapabilities?.loadSession) throw new Error('This Devin CLI cannot restore its session. Start a new chat; your Strata history is preserved.');
      sessionId = c.checkpoint.nativeSessionId;
      session = await rpc.request('session/load', { sessionId, cwd: settings.cwd, mcpServers: bridge ? [bridge.acp] : [] });
    } else {
      session = await rpc.request('session/new', { cwd: settings.cwd, mcpServers: bridge ? [bridge.acp] : [], _meta: { 'cognition.ai/persistOnCreate': true } });
      sessionId = session.sessionId;
    }
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 300) throw new Error('Devin returned no valid native session id.');
    verifyDevinConfig(await rpc.request('_cognition.ai/config/read', { sessionId }), settings);
    const [rules, hooks] = await Promise.all([rpc.request('_cognition.ai/rules/list', { sessionId }), rpc.request('_cognition.ai/hooks/list', { sessionId })]);
    requireIsolation(Array.isArray(rules?.rules) && rules.rules.length === 0, 'rules.list');
    requireIsolation(Array.isArray(hooks?.hooks) && hooks.hooks.length === 0, 'hooks.list');
    const scope = { sessionId, cwd: settings.cwd, workspaceDir: settings.cwd };
    const [servers, plugins, skills] = await Promise.all([rpc.request('_cognition.ai/mcp/listServers', scope), rpc.request('_cognition.ai/plugins/list', scope), rpc.request('_cognition.ai/skills/list', scope)]);
    const inventory = bridge ? await rpc.request('_cognition.ai/mcp/listTools', { sessionId, serverId: 'strata' }) : null;
    verifyDevinInventory({ servers, tools: inventory, plugins, skills }, { bridge, definitions: c.tools, settings });
    const actualModel = session.configOptions?.find(option => option.category === 'model')?.currentValue;
    if (typeof actualModel !== 'string' || actualModel === 'adaptive' || actualModel.startsWith('fusion-')) throw new Error('Devin could not confirm a single native model. Choose a verified model and start a new bot chat.');
    if (c.bot.model && actualModel !== c.bot.model) throw new Error('Devin selected a different model. Refresh the native model catalog and reselect the desired model before retrying.');
    // Native Ask excludes mutating MCP tools regardless of the host's policy. Code mode permits
    // the bridge; native tools remain disabled/denied and Strata owns every action approval.
    let configOptions = await setOption(rpc, sessionId, session.configOptions, 'mode', 'accept-edits');
    if (c.bot.effort) configOptions = await setOption(rpc, sessionId, configOptions, 'thought_level', c.bot.effort);
    await c.save(sessionId);
    projecting = true;
    const result = await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${c.bot.instructions ? `Bot instructions:\n${c.bot.instructions}\n\n` : ''}${c.prompt}\n\nUse only the supplied Strata tools for all coding, files, shell, browser and computer actions. Strata owns approvals and team coordination.` }] }, c.bot.continuousTeam === true ? null : c.options.runTimeoutMs ?? 30 * 60_000);
    if (result.stopReason !== 'end_turn') throw new Error(`Devin stopped: ${result.stopReason || 'missing completion marker'}.`);
    if (result.usage) c.frame({ type: 'stats', tokensIn: result.usage.inputTokens ?? 0, tokensOut: result.usage.outputTokens ?? 0 });
  } finally {
    projecting = false; transportCalls.clear(); c.signal.removeEventListener('abort', cancel);
    try { await rpc?.close(); } finally { try { await bridge?.close(); } finally { await settings.close(); } }
  }
}
