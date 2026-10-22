/** Reviewed command tools reuse the selected computer's ordinary command executor. */
import { randomUUID } from 'node:crypto';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const keys = (value, allowed) => { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('This tool configuration contains an unsupported field.'); };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
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
export function createdToolCommand(tool, input, { windows = false } = {}) {
  if (typeof tool.command !== 'string' || !tool.command.trim() || tool.command.includes('\0') || tool.command.length > 32000) fail('This saved command tool is invalid.');
  const data = JSON.stringify(createdToolInput(tool.inputSchema, input));
  const command = windows ? `$env:STRATA_TOOL_INPUT = ${psQuote(data)}; & ([scriptblock]::Create(${psQuote(tool.command)}))` : `STRATA_TOOL_INPUT=${quote(data)} /bin/sh -c ${quote(tool.command)}`;
  if (command.length > 32000) fail('The command and encoded inputs exceed the selected executor’s 32,000-character limit. Use smaller inputs or read larger data from a workspace file.');
  return command;
}
const schema = { type: 'object', properties: { toolId: { type: 'string' }, input: { type: 'object' } }, required: ['toolId', 'input'], additionalProperties: false };
const definitions = [
  { name: 'run_created_tool', description: 'Run an enabled reusable command tool assigned to this conversation on its selected computer and workspace. Supply input matching its schema.', inputSchema: schema },
  { name: 'test_created_tool', description: 'Test your own exact current command-tool draft on this conversation’s selected computer. This executes the command with normal approval; it does not enable or share the draft.', inputSchema: { ...schema, properties: { ...schema.properties, expectedDigest: { type: 'string' } }, required: [...schema.required, 'expectedDigest'] } },
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
        keys(args, name === 'test_created_tool' ? ['toolId', 'input', 'expectedDigest'] : ['toolId', 'input']);
        signal?.throwIfAborted();
        const frozen = bot.extensionSnapshots?.createdTools?.assignments?.find(tool => tool.id === args.toolId) ?? bot.createdTools?.assignments?.find(tool => tool.id === args.toolId);
        const expectedDigest = name === 'test_created_tool' ? args.expectedDigest : frozen?.digest;
        const authorizeCall = authorize ?? options.authorizeCreatedTool;
        if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest) || typeof authorizeCall !== 'function') fail('This reusable tool was not assigned, or its exact draft revision is unavailable.');
        let check = 0;
        const verify = async () => { signal?.throwIfAborted(); const response = await authorizeCall({ mode: name === 'test_created_tool' ? 'test' : 'run', toolId: args.toolId, expectedDigest, input: args.input }, { ...options, toolCallId: `created_auth_${randomUUID()}_${++check}` }); signal?.throwIfAborted(); const value = response?.content ? JSON.parse(response.content.filter(part => part.type === 'text').map(part => part.text).join('\n')) : response; if (!value?.tool || value.tool.digest !== expectedDigest) fail('This reusable tool’s access changed.'); return value.tool; };
        const tool = await verify(); createdToolInput(tool.inputSchema, args.input);
        const command = createdToolCommand(tool, args.input, { windows: platform === 'win32' && bot.computerMode !== 'cua' });
        const requestPermission = async request => { const allowed = await options.requestPermission?.({ ...request, name: `${name === 'test_created_tool' ? 'Test' : 'Run'} tool · ${tool.name}`, args: { toolId: tool.id, input: args.input, command: tool.command }, reason: `${name === 'test_created_tool' ? 'Test draft' : 'Run reusable tool'} ${tool.name} in ${bot.name}’s selected workspace?` }); signal?.throwIfAborted(); if (allowed) await verify(); return allowed === true; };
        const result = await base.execute({ ...options, toolCallId: id, name: 'run_command', args: { command, timeoutSeconds: tool.timeoutSeconds }, requestPermission, onFrame: frame => options.onFrame?.(frame.type === 'agent-tool' ? { ...frame, tool: { ...frame.tool, name, args, preview: `${name === 'test_created_tool' ? 'Test' : 'Run'} ${tool.name}` } } : frame) });
        signal?.throwIfAborted(); return result;
      })();
      calls.set(identity, { digest, promise }); return promise;
    },
    async finish(chatId) { try { return await base.finish?.(chatId); } finally { for (const key of calls.keys()) if (key.startsWith(`${chatId}:`)) calls.delete(key); } },
  };
}
