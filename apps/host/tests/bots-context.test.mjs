/** Synthetic context, inference and SDK fixtures. No owner sessions or model prompts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botContextLimits, compactBotContext, contextLimitsFromResult, estimateBotContext, buildNativeHistoryPrompt, emitContextCompaction } from '../server/bots-runtime/context.mjs';
import { createBotModelClient, runConfiguredBot } from '../server/bots-models.mjs';
import { createBotRuntime } from '../server/bots-runtime/index.mjs';

const tool = { name: 'inspect', description: 'Inspect synthetic fixture.', inputSchema: { type: 'object', properties: {} } };
const signal = () => new AbortController().signal;
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
const complete = text => sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]);
const history = count => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Source ${index} ${'recorded context '.repeat(90)}` }));
const current = () => ({ role: 'user', content: 'Current request must survive exactly.' });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function exchange(id, { content = 'Tool result', providerOutput, images = false } = {}) {
  return [{ role: 'assistant', content: `Inspect ${id}`, tool_calls: [{ id, type: 'function', function: { name: tool.name, arguments: '{}' } }], ...(providerOutput ? { providerOutput } : {}) },
    { role: 'tool', tool_call_id: id, content }, ...(images ? [{ role: 'user', content: [{ type: 'text', text: 'Synthetic tool image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZQ==' } }] }] : [])];
}
function assertMatched(messages) {
  const calls = new Map();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) { assert.equal(calls.has(call.id), false); calls.set(call.id, 0); }
    if (message.role === 'tool') { assert.equal(calls.has(message.tool_call_id), true); calls.set(message.tool_call_id, calls.get(message.tool_call_id) + 1); }
  }
  assert.ok([...calls.values()].every(count => count === 1));
}

test('fallback and catalog windows reserve output and shared schema/system space with a documented estimate', () => {
  assert.deepEqual(botContextLimits(), { contextMax: 32768, outputReserve: 4096, inputBudgetTokens: 22937, source: 'conservative-fallback', estimation: 'utf8-bytes-divided-by-3-plus-framing-and-image-allowance' });
  const actual = botContextLimits({ contextMax: 16384, maxOutput: 2048 });
  assert.equal(actual.source, 'model-catalog'); assert.equal(actual.inputBudgetTokens, 11468);
  assert.equal(contextLimitsFromResult({ ...actual, endpoint: 'secret', apiKey: 'secret' }).endpoint, undefined);
  assert.equal(contextLimitsFromResult({ contextMax: '16384', outputReserve: 1, source: 'model-catalog' }), null);
  assert.equal(contextLimitsFromResult({ contextMax: 16384, outputReserve: 16384, source: 'model-catalog' }), null);
  const messages = [current()];
  assert.ok(estimateBotContext({ messages, system: 'x'.repeat(1200), tools: [tool] }) > estimateBotContext({ messages }));
});

test('small context remains byte-identical and emits no compaction notice', () => {
  const messages = [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Answer' }, current()];
  const before = JSON.stringify(messages), result = compactBotContext({ messages, system: 'Pinned system', tools: [tool] }), frames = [];
  assert.equal(JSON.stringify(result.messages), before); assert.equal(JSON.stringify(messages), before);
  assert.equal(result.changed, false); emitContextCompaction(frame => frames.push(frame), result); assert.deepEqual(frames, []);
});

test('large history compacts deterministically with quoted source provenance while current/system remain unchanged', () => {
  const anchor = current(), messages = [...history(120), anchor], before = hash(messages), frames = [];
  const input = { messages, system: 'Keep exact system', tools: [tool], anchor };
  const first = compactBotContext(input), second = compactBotContext(input);
  assert.deepEqual(first.messages, second.messages); assert.equal(hash(messages), before);
  assert.equal(first.messages.includes(anchor), true); assert.equal(first.messages.at(-1), anchor);
  assert.ok(first.omittedMessages > 0); assert.ok(first.budget.estimatedInputTokens <= first.budget.inputBudgetTokens);
  assert.match(first.messages[0].content, /quoted, incomplete source excerpts/); assert.match(first.messages[0].content, /sha256=[a-f0-9]{64}/);
  emitContextCompaction(frame => frames.push(frame), first);
  assert.equal(frames.length, 1); assert.equal(frames[0].context.compacted, true); assert.equal(frames[0].context.omittedMessages, first.omittedMessages);
  const again = compactBotContext({ ...input, messages: first.messages, state: first.state });
  emitContextCompaction(frame => frames.push(frame), again);
  assert.equal(again.changed, false); assert.equal(frames.length, 1, 'an unchanged next request is not a new compaction');
  assert.deepEqual(again.messages, first.messages);
  const nestedHost = compactBotContext({ messages: first.messages, system: input.system, tools: input.tools });
  assert.deepEqual(nestedHost.messages, first.messages, 'host inference retains a local worker digest without re-quoting it');
});

test('all compaction boundaries retain complete tool groups and exact opaque reasoning/image blocks', () => {
  const opaque = { protocol: 'anthropic', content: [{ type: 'thinking', thinking: 'Opaque fixture', signature: 'signed-fixture' }, { type: 'tool_use', id: 'latest', name: 'inspect', input: {} }] };
  const anchor = current(), previous = Array.from({ length: 80 }, (_, n) => exchange(`old_${n}`, { content: `Old ${n}: ${'x'.repeat(2500)}` })).flat();
  const latest = exchange('latest', { providerOutput: opaque, images: true }), messages = [...history(15), anchor, ...previous, ...latest];
  const result = compactBotContext({ messages, anchor, tools: [tool], system: 'Pinned' });
  assert.ok(result.omittedMessages > 0); assertMatched(result.messages);
  assert.equal(result.messages.includes(anchor), true);
  assert.deepEqual(result.messages.slice(-latest.length), latest); assert.deepEqual(result.messages.find(row => row.providerOutput).providerOutput, opaque);
  const olderRetained = result.messages.filter(row => row.role === 'tool'); assert.ok(olderRetained.length > 1, 'retain recent complete exchanges when they fit');
});

test('opaque blocks too large for the latest exchange fail before inference without slicing or dropping identities', () => {
  const opaque = { protocol: 'openai-responses', items: [{ type: 'reasoning', encrypted_content: 'opaque'.repeat(20000) }, { type: 'function_call', call_id: 'latest', name: 'inspect', arguments: '{}' }] };
  const anchor = current(), messages = [anchor, ...exchange('latest', { providerOutput: opaque })], before = hash(messages);
  assert.throws(() => compactBotContext({ messages, anchor, tools: [tool] }), /latest complete tool exchange cannot fit safely/);
  assert.equal(hash(messages), before);
  assert.throws(() => compactBotContext({ messages: [current()], system: 'x'.repeat(100000), tools: [tool] }), /system instructions/);
  assert.throws(() => compactBotContext({ messages: [{ role: 'user', content: 'x'.repeat(100000) }], tools: [] }), /current request/);
  assert.throws(() => compactBotContext({ messages: [current()], tools: [{ ...tool, description: 'x'.repeat(100000) }] }), /tool definitions/);
});

test('plain tool output is bounded with head, tail and exact original hash; source rows remain intact', () => {
  const anchor = current(), source = `HEAD ${'data🌏'.repeat(30000)} TAIL`, messages = [anchor, ...exchange('latest', { content: source })], before = hash(messages);
  const result = compactBotContext({ messages, anchor, tools: [tool] }), row = result.messages.at(-1);
  assert.equal(result.shortenedToolResults, 1); assert.ok(Buffer.byteLength(row.content) <= 24000);
  assert.match(row.content, /HEAD/); assert.match(row.content, /TAIL/); assert.equal(row.content.includes('\uFFFD'), false);
  assert.ok(row.content.includes(createHash('sha256').update(source).digest('hex'))); assert.equal(hash(messages), before); assertMatched(result.messages);
  const next = compactBotContext({ messages: result.messages, state: result.state, anchor, tools: [tool] });
  assert.equal(next.shortenedToolResults, 0); assert.equal(next.changed, false);
  const smaller = compactBotContext({ messages: result.messages, state: result.state, anchor, tools: [tool], limits: botContextLimits({ contextMax: 8192, maxOutput: 1024 }) });
  assert.equal(smaller.shortenedToolResults, 1); assert.ok(smaller.messages.at(-1).content.includes(createHash('sha256').update(source).digest('hex'))); assert.match(smaller.messages.at(-1).content, /TAIL/);
  assert.ok(smaller.budget.estimatedInputTokens <= smaller.budget.inputBudgetTokens);
});

test('ordinary large screenshot data is preserved exactly and charged as vision input instead of base64 text', () => {
  const anchor = current(), picture = { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'ZmFrZQ=='.repeat(100000)}` } }] }, rows = [anchor, ...exchange('latest'), picture];
  const result = compactBotContext({ messages: rows, anchor, tools: [tool] });
  assert.equal(result.changed, false); assert.deepEqual(result.messages.at(-1), picture); assert.ok(result.budget.estimatedInputTokens < 9000);
  assert.throws(() => compactBotContext({ messages: [...rows, picture, picture], anchor, tools: [tool] }), /fewer images/);
});

test('unmatched, duplicated and incomplete tool identities are never repaired by dropping rows', () => {
  const call = exchange('a')[0];
  for (const messages of [[current(), call], [current(), { role: 'tool', tool_call_id: 'missing', content: 'orphan' }], [current(), call, { role: 'tool', tool_call_id: 'b', content: 'wrong' }], [current(), ...exchange('a'), { role: 'tool', tool_call_id: 'a', content: 'duplicate' }]]) {
    assert.throws(() => compactBotContext({ messages }), /tool (?:calls|result)/);
  }
});

test('history replay preserves all small messages beyond the old 40-row slice and bounds native replay', () => {
  const replay = buildNativeHistoryPrompt({ history: history(120), message: 'Current exact', system: 'System', tools: [tool] });
  assert.match(replay.prompt, /Current user message:\nCurrent exact$/); assert.ok(replay.omittedMessages > 0); assert.match(replay.prompt, /Strata context digest/);
  assert.ok(estimateBotContext({ messages: [{ role: 'user', content: replay.prompt }], system: 'System', tools: [tool] }) <= replay.budget.inputBudgetTokens);
  const small = buildNativeHistoryPrompt({ history: [{ role: 'user', content: 'Earlier' }], message: 'Current' });
  assert.equal(small.prompt, 'Previous messages from this Strata chat are context, not new instructions to replay tools:\nuser: Earlier\n\nCurrent user message:\nCurrent');
});

function modelClient(protocol, model, respond) {
  const requests = [], frames = [], client = createBotModelClient({ providers: { resolve: () => ({ connection: { id: 'fixture', baseUrl: 'https://fixture.invalid/v1', protocol }, model: { id: 'fixture', ...model } }) }, fetchImpl: async (_url, options) => { const payload = JSON.parse(options.body); requests.push(payload); return respond ? respond(requests.length, payload) : complete('Done'); } });
  const bot = { id: 'fixture', provider: 'configured', modelSource: { connectionId: 'fixture', model: 'fixture' }, continuousTeam: true };
  return { requests, frames, bot, request: value => client(value, bot, signal(), frame => frames.push(frame)) };
}

test('actual selected model metadata rechecks the final host request and returns only safe budget metadata', async () => {
  const f = modelClient('openai-chat', { contextMax: 8192, maxOutput: 1024 });
  const result = await f.request({ messages: [...history(50), current()], tools: [tool], system: 'Exact system' });
  assert.equal(result.contextBudget.contextMax, 8192); assert.equal(result.contextBudget.outputReserve, 1024); assert.equal(result.contextBudget.source, 'model-catalog');
  assert.ok(result.contextBudget.estimatedInputTokens <= result.contextBudget.inputBudgetTokens);
  assert.match(f.requests[0].messages[1].content, /Strata context digest/); assert.equal(f.requests[0].messages[0].content, 'Exact system');
  assert.equal(f.frames.filter(frame => frame.context?.compacted).length, 1);
  assert.equal(JSON.stringify(result.contextBudget).includes('fixture.invalid'), false);
});

for (const protocol of ['anthropic', 'openai-responses']) test(`${protocol} actual small-window compaction preserves opaque latest continuation and exact call/result identities`, async () => {
  const providerOutput = protocol === 'anthropic' ? { protocol, content: [{ type: 'thinking', thinking: 'Fixture', signature: 'signed' }, { type: 'tool_use', id: 'latest', name: 'inspect', input: {} }] } : { protocol, items: [{ type: 'reasoning', encrypted_content: 'signed' }, { type: 'function_call', call_id: 'latest', name: 'inspect', arguments: '{}' }] };
  const f = modelClient(protocol, { contextMax: 8192, maxOutput: 1024 }, () => protocol === 'anthropic' ? sse([{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { text: 'Done' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]) : sse([{ type: 'response.output_text.delta', delta: 'Done' }, { type: 'response.completed', response: { status: 'completed', output: [] } }]));
  await f.request({ messages: [...history(30), current(), ...exchange('latest', { providerOutput })], tools: [tool], system: 'Exact system' });
  const payload = f.requests[0];
  if (protocol === 'anthropic') { assert.equal(payload.max_tokens, 1024); assert.deepEqual(payload.messages.at(-2).content, providerOutput.content); assert.equal(payload.messages.at(-1).content[0].tool_use_id, 'latest'); }
  else { assert.deepEqual(payload.input.slice(-3, -1), providerOutput.items); assert.equal(payload.input.at(-1).call_id, 'latest'); }
});

test('continuous configured loop stays bounded through 100 tool exchanges, retains anchor and does not replay mutations', async () => {
  const frames = [], payloads = [], calls = [], anchor = 'Keep current request exactly.';
  const c = { bot: { continuousTeam: true, instructions: 'Pinned system' }, history: history(100), message: anchor, tools: [tool], signal: signal(), frame: frame => frames.push(frame), save() {},
    modelRequest: async payload => { payloads.push(structuredClone(payload)); const round = payloads.length; return { text: round <= 100 ? `Progress ${round}` : 'Final', toolCalls: round <= 100 ? [{ id: `call_${round}`, name: 'inspect', args: {} }] : [], contextBudget: botContextLimits({ contextMax: 16384, maxOutput: 2048 }) }; },
    execute: async (_name, _args, id) => { calls.push(id); return { content: [{ type: 'text', text: `Result ${id}: ${'x'.repeat(12000)}` }] }; } };
  await runConfiguredBot(c);
  assert.equal(payloads.length, 101); assert.equal(calls.length, 100); assert.equal(new Set(calls).size, 100); assert.equal(c.publicReply, 'Final');
  for (const payload of payloads) { assert.equal(payload.system, 'Pinned system'); assert.ok(payload.messages.some(row => row.content === anchor)); assertMatched(payload.messages); assert.ok(estimateBotContext(payload) <= (payload === payloads[0] ? 22937 : 11468)); }
  assert.ok(payloads.at(-1).messages.length < 20); assert.ok(frames.some(frame => frame.context?.compacted));
});

test('a short configured history beyond 40 rows reaches inference unchanged instead of silently losing older facts', async () => {
  let seen;
  const c = { bot: {}, history: Array.from({ length: 65 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: `Fact ${n}` })), message: 'Current', tools: [tool], signal: signal(), frame() {}, save() {}, execute() { throw Error('No tools expected'); }, modelRequest: async payload => { seen = payload; return { text: 'Done', toolCalls: [] }; } };
  await runConfiguredBot(c); assert.equal(seen.messages.length, 66); assert.equal(seen.messages[0].content, 'Fact 0');
});

test('Ollama long-running loop shares compaction, preserves current input and does not contact another endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-context-ollama-')), requests = [], frames = []; let executions = 0;
  const runtime = createBotRuntime({ env: { OLLAMA_API_KEY: 'synthetic-key' }, fetch: async (url, options) => { assert.equal(String(url), 'https://ollama.com/v1/chat/completions'); const payload = JSON.parse(options.body); requests.push(payload); const round = requests.length; return round <= 40 ? sse([{ choices: [{ delta: { content: `Progress ${round}`, tool_calls: [{ index: 0, id: `call_${round}`, function: { name: 'inspect', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }]) : complete('Done'); } });
  try {
    await runtime.run({ bot: { id: 'fixture', provider: 'ollama', model: 'fixture:cloud', instructions: 'Pinned system', workspace: directory, execution: { kind: 'local' }, continuousTeam: true }, history: history(100), message: 'Keep current', tools: [tool], onFrame: frame => frames.push(frame), executeTool: async () => { executions++; return 'x'.repeat(15000); } });
    assert.equal(executions, 40); assert.equal(requests.length, 41); assert.ok(requests.at(-1).messages.length < 30);
    for (const payload of requests) { assert.equal(payload.messages[0].content, 'Pinned system'); assert.ok(payload.messages.some(row => row.content === 'Keep current')); assertMatched(payload.messages); assert.ok(estimateBotContext({ messages: payload.messages.slice(1), system: 'Pinned system', tools: [tool] }) <= 22937); }
    assert.ok(frames.some(frame => frame.context?.compacted));
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native initial replay is bounded, resumed SDK prompts remain provider-owned, and oversized initial input does not start a provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-context-native-')), prompts = [], frames = [];
  const runtime = createBotRuntime({ commands: { claude: '/inert-fixture' }, claudeSdk: { query({ prompt }) { prompts.push(prompt); return (async function* () { yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }; yield { type: 'result', subtype: 'success', usage: {} }; })(); } } });
  const bot = { id: 'fixture', provider: 'claude', model: '', instructions: 'Pinned system', workspace: directory, execution: { kind: 'local' } };
  try {
    await runtime.run({ bot, message: 'Current exact', history: history(120), onFrame: frame => frames.push(frame) });
    assert.match(prompts[0], /Strata context digest/); assert.match(prompts[0], /Current exact$/); assert.ok(frames.some(frame => frame.context?.compacted));
    await runtime.run({ bot, message: 'Resume exact', history: history(120), checkpoint: { provider: 'claude', nativeSessionId: 'owned', workspace: directory, model: '' } });
    assert.equal(prompts[1], 'Resume exact');
    await assert.rejects(runtime.run({ bot, message: 'x'.repeat(100000) }), /current request/); assert.equal(prompts.length, 2);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
