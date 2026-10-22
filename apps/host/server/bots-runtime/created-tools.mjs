/** Reviewed command tools reuse the selected computer's ordinary command executor. */
import { randomUUID } from 'node:crypto';
import { markNoEffect } from './tool-outcome.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const keys = (value, allowed) => { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('This tool configuration contains an unsupported field.'); };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
/** Declarative presence checks only. No arbitrary probe commands or installation. */
export function createdToolRequirements(input) {
  if (input === undefined) return undefined;
  keys(input, ['platforms', 'executables', 'workspaceFiles']);
  const value = {};
  for (const [key, maximum] of [['platforms', 3], ['executables', 16], ['workspaceFiles', 16]]) {
    const rows = input[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > maximum || new Set(rows).size !== rows.length) fail('Use unique, bounded tool requirements.');
    for (const name of rows) {
      if (typeof name !== 'string') fail('Tool requirements must be text.');
      if (key === 'platforms' && !['darwin', 'linux', 'win32'].includes(name)) fail('Choose macOS, Linux or Windows tool platforms.');
      if (key === 'executables' && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name)) fail('Required executables must be simple program names, without paths or arguments.');
      if (key === 'workspaceFiles' && (!name || name.length > 240 || /[\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => ['', '.', '..'].includes(part)))) fail('Required files must be relative workspace paths without traversal or control characters.');
    }
    if (rows.length) value[key] = [...rows];
  }
  return Object.keys(value).length ? value : undefined;
}
export function createdToolSchema(input = { type: 'object', properties: {}, required: [], additionalProperties: false }) {
  keys(input, ['type', 'properties', 'required', 'additionalProperties']);
  if (input.type !== 'object' || !plain(input.properties) || input.additionalProperties !== false || !Array.isArray(input.required) || Buffer.byteLength(JSON.stringify(input)) > 16000 || Object.keys(input.properties).length > 32) fail('Use an object input schema with up to 32 simple fields and additionalProperties: false.');
  for (const [name, property] of Object.entries(input.properties)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || forbidden.has(name)) fail('Choose simple input field names.');
    keys(property, ['type', 'description', 'enum', 'minimum', 'maximum', 'maxLength']);
    if (!['string', 'number', 'integer', 'boolean'].includes(property.type) || property.description !== undefined && (typeof property.description !== 'string' || property.description.length > 500 || property.description.includes('\0'))) fail('Use string, number, integer or boolean input fields.');
    const valid = value => property.type === 'string' ? typeof value === 'string' && !value.includes('\0') : property.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'number' && Number.isFinite(value) && (property.type !== 'integer' || Number.isSafeInteger(value));
    if (property.enum !== undefined && (!Array.isArray(property.enum) || !property.enum.length || property.enum.length > 64 || property.enum.some(value => !valid(value)))) fail('Enter a bounded list of values matching the input type.');
    for (const key of ['minimum', 'maximum']) if (property[key] !== undefined && (!['number', 'integer'].includes(property.type) || typeof property[key] !== 'number' || !Number.isFinite(property[key]) || property.type === 'integer' && !Number.isSafeInteger(property[key]))) fail('Numeric bounds must match a numeric input.');
    if (property.minimum !== undefined && property.maximum !== undefined && property.minimum > property.maximum) fail('The minimum input must not exceed the maximum.');
    if (property.maxLength !== undefined && (property.type !== 'string' || !Number.isSafeInteger(property.maxLength) || property.maxLength < 0 || property.maxLength > 64000)) fail('Use a string length limit between 0 and 64000.');
  }
  if (new Set(input.required).size !== input.required.length || input.required.some(key => typeof key !== 'string' || !Object.hasOwn(input.properties, key))) fail('Required fields must exist in the input schema.');
  return structuredClone(input);
}
export function createdToolInput(schema, input) {
  createdToolSchema(schema);
  if (!plain(input) || Buffer.byteLength(JSON.stringify(input)) > 64000 || Object.keys(input).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(input, key))) fail('Supply the tool’s required inputs and no unknown fields.');
  for (const [name, value] of Object.entries(input)) {
    const p = schema.properties[name];
    if (p.type === 'string' ? typeof value !== 'string' || value.includes('\0') || value.length > (p.maxLength ?? 64000) : p.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'number' || !Number.isFinite(value) || p.type === 'integer' && !Number.isSafeInteger(value)) fail(`The ${name} input does not match its schema.`);
    if (p.enum && !p.enum.includes(value) || p.minimum !== undefined && value < p.minimum || p.maximum !== undefined && value > p.maximum) fail(`The ${name} input is outside its allowed values.`);
  }
  return structuredClone(input);
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
/** Runs in the executor's actual cwd/OS, including inside a selected CUA guest. */
export function createdToolReadinessCommand(tool, { windows = false } = {}) {
  const requirements = createdToolRequirements(tool.requirements) ?? {};
  const checks = [
    ...(requirements.platforms?.length ? [{ kind: 'platform', name: requirements.platforms.join(', ') }] : []),
    ...(requirements.executables ?? []).map(name => ({ kind: 'executable', name })),
    ...(requirements.workspaceFiles ?? []).map(name => ({ kind: 'workspaceFile', name })),
  ];
  const header = JSON.stringify({ type: 'created-tool-readiness', toolId: tool.id, digest: tool.digest }).slice(0, -1);
  if (windows) {
    const platform = "$strataPlatform = if ([Environment]::OSVersion.Platform -eq 'Win32NT') { 'win32' } elseif ($IsMacOS) { 'darwin' } elseif ($IsLinux) { 'linux' } else { 'unknown' }";
    const rows = checks.map(check => {
      const expression = check.kind === 'platform' ? `@(${requirements.platforms.map(psQuote).join(',')}) -contains $strataPlatform` : check.kind === 'executable' ? `[bool](Get-Command -Name ${psQuote(check.name)} -CommandType Application -ErrorAction SilentlyContinue)` : `Test-Path -LiteralPath ${psQuote(`./${check.name}`)} -PathType Leaf`;
      return `$strataAvailable = [bool](${expression}); if (!$strataAvailable) { $strataReady = $false }; $strataChecks += @{kind=${psQuote(check.kind)};name=${psQuote(check.name)};available=$strataAvailable}`;
    });
    return [platform, '$strataReady = $true; $strataChecks = @()', ...rows, `@{type='created-tool-readiness';toolId=${psQuote(tool.id ?? '')};digest=${psQuote(tool.digest ?? '')};platform=$strataPlatform;checks=@($strataChecks);ready=$strataReady} | ConvertTo-Json -Depth 4 -Compress`, 'if (!$strataReady) { exit 78 }'].join('\n');
  }
  const rows = checks.map((check, index) => {
    const expression = check.kind === 'platform' ? `case "$strata_platform" in ${requirements.platforms.map(quote).join('|')}) true;; *) false;; esac` : check.kind === 'executable' ? `command -v ${quote(check.name)} >/dev/null 2>&1` : `[ -f ${quote(`./${check.name}`)} ]`;
    const prefix = `${index ? ',' : ''}${JSON.stringify({ kind: check.kind, name: check.name }).slice(0, -1)},"available":`;
    return `printf '%s' ${quote(prefix)}\nif ${expression}; then printf true; else printf false; strata_ready=false; fi\nprintf '}'`;
  });
  return [
    'strata_system=$(uname -s 2>/dev/null) || strata_system=unknown',
    'case "$strata_system" in Darwin) strata_platform=darwin;; Linux) strata_platform=linux;; *) strata_platform=unknown;; esac',
    'strata_ready=true',
    `printf '%s' ${quote(`${header},"platform":"`)}; printf '%s' "$strata_platform"; printf '%s' '\",\"checks\":['`,
    ...rows,
    `printf '%s' '],"ready":'; printf '%s' "$strata_ready"; printf '}\\n'`,
    '[ "$strata_ready" = true ] || exit 78',
  ].join('\n');
}
export function createdToolCommand(tool, input, { windows = false, checkOnly = false } = {}) {
  if (typeof tool.command !== 'string' || !tool.command.trim() || tool.command.includes('\0') || tool.command.length > 32000) fail('This saved command tool is invalid.');
  const requirements = createdToolRequirements(tool.requirements);
  const source = checkOnly ? createdToolReadinessCommand(tool, { windows }) : requirements ? `${createdToolReadinessCommand(tool, { windows })}\n${tool.command}` : tool.command;
  const data = checkOnly ? '{}' : JSON.stringify(createdToolInput(tool.inputSchema, input));
  const command = windows ? `$env:STRATA_TOOL_INPUT = ${psQuote(data)}; & ([scriptblock]::Create(${psQuote(source)}))` : `STRATA_TOOL_INPUT=${quote(data)} /bin/sh -c ${quote(source)}`;
  if (command.length > 32000) fail('The command and encoded inputs exceed the selected executor’s 32,000-character limit. Use smaller inputs or read larger data from a workspace file.');
  return command;
}
/** Our generated preflight is the first stdout line, before any saved body.
 * A body that exits78 or prints a forged later report cannot certify no effect. */
function preflightBlockedBody(result, tool) {
  if (!createdToolRequirements(tool.requirements) || result?.isError !== true) return false;
  const text = result.content?.find(part => part.type === 'text')?.text;
  if (typeof text !== 'string') return false;
  const lines = text.split('\n');
  if (lines[0] !== 'Exit 78') return false;
  try {
    const report = JSON.parse(lines[1]);
    return report?.type === 'created-tool-readiness' && report.toolId === tool.id && report.digest === tool.digest && report.ready === false && Array.isArray(report.checks);
  } catch { return false; }
}
const schema = { type: 'object', properties: { toolId: { type: 'string' }, input: { type: 'object' } }, required: ['toolId', 'input'], additionalProperties: false };
const definitions = [
  { name: 'run_created_tool', description: 'Run an enabled reusable command tool assigned to this conversation on its selected computer and workspace. Supply input matching its schema.', inputSchema: schema },
  { name: 'test_created_tool', description: 'Test your own exact current command-tool draft on this conversation’s selected computer. This executes the command with normal approval; it does not enable or share the draft.', inputSchema: { ...schema, properties: { ...schema.properties, expectedDigest: { type: 'string' } }, required: [...schema.required, 'expectedDigest'] } },
  { name: 'check_created_tool', description: 'Check required platforms, executable names and workspace files on this conversation’s actual selected computer with normal command approval. Never runs the saved tool command, installs dependencies or changes its grants. Supply expectedDigest for your own draft.', inputSchema: { type: 'object', properties: { toolId: { type: 'string' }, expectedDigest: { type: 'string' } }, required: ['toolId'], additionalProperties: false } },
];
export function createCreatedCommandTools(base, { authorize, platform = process.platform } = {}) {
  const calls = new Map();
  return { ...base,
    definitions(bot) { const ordinary = base.definitions(bot); return bot.policy === 'plan' || bot.teamConversationOnly || !ordinary.some(tool => tool.name === 'run_command') ? ordinary : [...ordinary, ...structuredClone(definitions)]; },
    execute(options) {
      if (!definitions.some(tool => tool.name === options.name)) return base.execute(options);
      const { bot, chatId, name, args = {}, signal } = options;
      if (bot.policy === 'plan' || bot.teamConversationOnly || !base.definitions(bot).some(tool => tool.name === 'run_command')) return Promise.reject(new Error('Reusable command tools are unavailable in this permission or capability mode.'));
      const id = options.toolCallId || `created_${randomUUID()}`, identity = `${chatId}:${id}`, digest = JSON.stringify([name, args]);
      const old = calls.get(identity); if (old) { if (old.digest !== digest) return Promise.reject(new Error('This tool identity already belongs to another action.')); return old.promise; }
      const promise = (async () => {
        const checking = name === 'check_created_tool', testing = name === 'test_created_tool';
        keys(args, checking ? ['toolId', 'expectedDigest'] : testing ? ['toolId', 'input', 'expectedDigest'] : ['toolId', 'input']);
        signal?.throwIfAborted();
        const frozen = bot.extensionSnapshots?.createdTools?.assignments?.find(tool => tool.id === args.toolId) ?? bot.createdTools?.assignments?.find(tool => tool.id === args.toolId);
        const expectedDigest = testing || checking && args.expectedDigest !== undefined ? args.expectedDigest : frozen?.digest;
        const authorizeCall = authorize ?? options.authorizeCreatedTool;
        if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest) || typeof authorizeCall !== 'function') fail('This reusable tool was not assigned, or its exact draft revision is unavailable.');
        let check = 0;
        const verify = async () => { signal?.throwIfAborted(); const response = await authorizeCall({ mode: checking ? 'check' : testing ? 'test' : 'run', toolId: args.toolId, expectedDigest, ...(!checking ? { input: args.input } : {}) }, { ...options, toolCallId: `created_auth_${randomUUID()}_${++check}` }); signal?.throwIfAborted(); const value = response?.content ? JSON.parse(response.content.filter(part => part.type === 'text').map(part => part.text).join('\n')) : response; if (!value?.tool || value.tool.digest !== expectedDigest) fail('This reusable tool’s access changed.'); return value.tool; };
        const tool = await verify(); if (!checking) createdToolInput(tool.inputSchema, args.input);
        const command = createdToolCommand(tool, args.input, { windows: platform === 'win32' && bot.computerMode !== 'cua', checkOnly: checking });
        const action = checking ? 'Check requirements' : testing ? 'Test draft' : 'Run reusable tool';
        const requestPermission = async request => { const allowed = await options.requestPermission?.({ ...request, name: `${action} · ${tool.name}`, args: { toolId: tool.id, ...(checking ? {} : { input: args.input, command: tool.command }), ...(tool.requirements ? { requirements: tool.requirements } : {}) }, reason: `${action} ${tool.name} in ${bot.name}’s selected workspace?${checking ? ' This checks presence only; it does not run the saved command or install anything.' : ''}` }); signal?.throwIfAborted(); if (allowed) await verify(); return allowed === true; };
        const result = await base.execute({ ...options, toolCallId: id, name: 'run_command', args: { command, timeoutSeconds: checking ? 15 : tool.timeoutSeconds }, requestPermission, onFrame: frame => options.onFrame?.(frame.type === 'agent-tool' ? { ...frame, tool: { ...frame.tool, name, args, preview: `${action} ${tool.name}` } } : frame) });
        signal?.throwIfAborted(); return checking || preflightBlockedBody(result, tool) ? markNoEffect(result) : result;
      })();
      calls.set(identity, { digest, promise }); return promise;
    },
    async finish(chatId) { try { return await base.finish?.(chatId); } finally { for (const key of calls.keys()) if (key.startsWith(`${chatId}:`)) calls.delete(key); } },
  };
}
