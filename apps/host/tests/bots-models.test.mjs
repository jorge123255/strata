/** Configured inference protocol fixtures only. No account, model server, SSH or weights are used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { botModelDestination, createBotModelClient, createBotModelSources, runConfiguredBot } from '../server/bots-models.mjs';

const tools = [{ name: 'read_file', description: 'Read a fixture file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const key = 'fixture-private-api-key';
function sse(events, { size = 3, trailing = true } = {}) {
  const input = events.map(event => typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (trailing ? 'data: [DONE]\r\n\r\n' : '');
  const bytes = new TextEncoder().encode(input);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(protocol, response) {
  const selected = { id: 'maya', name: 'Maya separate connection', baseUrl: 'https://maya.example.test/v1', protocol, apiKey: key, models: [{ id: 'shared-name', name: 'Maya model', vision: true }] };
  const other = { id: 'strata', name: 'Other Strata', baseUrl: 'https://strata.example.test/v1', protocol, apiKey: 'other-private-key', models: [{ id: 'shared-name', name: 'Strata model' }] };
  const requests = [], resolves = [];
  const providers = { list: () => ({ connections: [selected, other].map(({ apiKey, ...connection }) => structuredClone(connection)) }), resolve(source) {
    resolves.push(structuredClone(source));
    const connection = [selected, other].find(item => item.id === source.connectionId), model = connection?.models.find(item => item.id === source.modelId);
    if (!connection || !model) throw new Error('Unknown fixture connection or model');
    return { connection, model };
  } };
  const client = createBotModelClient({ providers, fetchImpl: async (url, options) => {
    const request = { url: String(url), options, payload: JSON.parse(options.body) }; requests.push(request);
    return response(request, requests.length);
  } });
  const bot = { id: 'bot-fixture', name: 'Fixture', provider: 'configured', instructions: 'Inspect only fixture files.', model: 'shared-name', modelSource: { connectionId: selected.id, model: 'shared-name' }, modelDestination: botModelDestination(selected) };
  return { client, bot, selected, other, requests, resolves, providers };
}
function context(f, { controller = new AbortController(), execute } = {}) {
  const frames = [], calls = [], checkpoints = [];
  const c = { bot: f.bot, message: 'Check this fixture', history: [{ role: 'user', content: 'Previous question' }, { role: 'assistant', content: 'Previous answer' }], tools, signal: controller.signal,
    frame: frame => frames.push(frame), save: value => checkpoints.push(value),
    execute: async (name, args, id) => { calls.push({ name, args, id }); return execute ? execute(name, args, id) : { content: [{ type: 'text', text: 'Fixture file contents' }] }; },
  };
  c.modelRequest = request => f.client(request, c.bot, c.signal, c.frame);
  return { c, frames, calls, checkpoints, controller };
}
const text = frames => frames.filter(frame => frame.type === 'delta').map(frame => frame.text).join('');
const reasoning = frames => frames.filter(frame => frame.type === 'reasoning').map(frame => frame.text).join('');
const finishedChat = answer => sse([{ choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }]);

test('OpenAI chat reassembles fragmented UTF-8, thinking and tools, preserving the chosen Maya connection', async () => {
  const f = fixture('openai-chat', (_request, round) => round === 1 ? sse([
    { choices: [{ index: 0, delta: { reasoning_content: 'Inspecting 🌿', content: 'Reading ', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_', arguments: '{"pa' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"README.md"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ]) : finishedChat('Finished'));
  const c = context(f); await runConfiguredBot(c.c);
  assert.deepEqual(c.calls, [{ name: 'read_file', args: { path: 'README.md' }, id: 'call_1' }]);
  assert.equal(text(c.frames), 'Reading Finished'); assert.equal(reasoning(c.frames), 'Inspecting 🌿');
  assert.deepEqual(c.checkpoints, [null]);
  assert.equal(c.frames.at(-1).tokensIn, 22); assert.equal(c.frames.at(-1).tokensOut, 5);
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.equal(request.url, 'https://maya.example.test/v1/chat/completions');
    assert.equal(request.payload.model, 'shared-name'); assert.equal(request.options.headers.authorization, `Bearer ${key}`); assert.equal(request.options.redirect, 'error');
  }
  assert.equal(f.requests[1].payload.messages.filter(message => message.content === 'Previous question').length, 1);
  assert.deepEqual(f.requests[1].payload.messages.at(-1), { role: 'tool', tool_call_id: 'call_1', content: 'Fixture file contents' });
  assert.ok(f.resolves.every(source => source.connectionId === 'maya'));
});

test('Responses keeps stateless encrypted reasoning/output items and tool outputs on the next request', async () => {
  const output = [{ id: 'reasoning_1', type: 'reasoning', encrypted_content: 'opaque-signed-context', summary: [{ type: 'summary_text', text: 'Inspecting fixture.' }] }, { id: 'function_1', type: 'function_call', call_id: 'call_response', name: 'read_file', arguments: '{"path":"a.txt"}', status: 'completed' }];
  const f = fixture('openai-responses', (_request, round) => round === 1 ? sse([
    { type: 'response.reasoning_summary_text.delta', delta: 'Inspecting fixture.' },
    { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 11, output_tokens: 2 } } },
  ]) : sse([{ type: 'response.output_text.delta', delta: 'Response answer' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Response answer' }] }], usage: { input_tokens: 15, output_tokens: 4 } } }]));
  const c = context(f); await runConfiguredBot(c.c);
  assert.equal(reasoning(c.frames), 'Inspecting fixture.'); assert.equal(text(c.frames), 'Response answer');
  assert.deepEqual(c.calls, [{ name: 'read_file', args: { path: 'a.txt' }, id: 'call_response' }]);
  const payload = f.requests[1].payload;
  assert.equal(payload.store, false); assert.deepEqual(payload.include, ['reasoning.encrypted_content']);
  assert.deepEqual(payload.input.slice(-3, -1), output);
  assert.deepEqual(payload.input.at(-1), { type: 'function_call_output', call_id: 'call_response', output: 'Fixture file contents' });
  assert.equal(payload.previous_response_id, undefined);
  assert.equal(f.requests[1].url, 'https://maya.example.test/v1/responses');
});

test('Anthropic preserves signed thinking and parsed tool use in the assistant continuation', async () => {
  const f = fixture('anthropic', (_request, round) => round === 1 ? sse([
    { type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking the fixture.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature-part-one' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '-two' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_anthropic', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
  ]) : sse([
    { type: 'message_start', message: { usage: { input_tokens: 14, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic answer' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
  ]));
  const c = context(f); await runConfiguredBot(c.c);
  assert.equal(reasoning(c.frames), 'Checking the fixture.'); assert.equal(text(c.frames), 'Anthropic answer');
  assert.equal(c.calls.length, 1);
  const request = f.requests[1], assistant = request.payload.messages.findLast(message => message.role === 'assistant');
  assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'Checking the fixture.', signature: 'signature-part-one-two' });
  assert.deepEqual(assistant.content[1], { type: 'tool_use', id: 'tool_anthropic', name: 'read_file', input: { path: 'a.txt' } });
  assert.deepEqual(request.payload.messages.at(-1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_anthropic', content: 'Fixture file contents', is_error: false }] });
  assert.equal(request.options.headers['x-api-key'], key); assert.equal(request.options.headers.authorization, undefined);
  assert.equal(request.url, 'https://maya.example.test/v1/messages');
});

test('configured image tool results reach each selected protocol without losing the tool result', async () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic']) {
    const f = fixture(protocol, (_request, round) => {
      if (protocol === 'anthropic') return round === 1 ? sse([{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'image_call', name: 'read_file', input: { path: 'image.png' } } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }]) : sse([{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { text: 'done' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]);
      if (protocol === 'openai-responses') return round === 1 ? sse([{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'image_call', name: 'read_file', arguments: '{"path":"image.png"}' }] } }]) : sse([{ type: 'response.output_text.delta', delta: 'done' }, { type: 'response.completed', response: { status: 'completed', output: [] } }]);
      return round === 1 ? sse([{ choices: [{ index: 0, delta: { tool_calls: [{ id: 'image_call', index: 0, function: { name: 'read_file', arguments: '{"path":"image.png"}' } }] }, finish_reason: 'tool_calls' }] }]) : finishedChat('done');
    });
    const c = context(f, { execute: () => ({ content: [{ type: 'text', text: 'Image fixture' }, { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }] }) });
    await runConfiguredBot(c.c);
    const payload = JSON.stringify(f.requests[1].payload);
    assert.ok(payload.includes('ZmFrZQ=='), protocol); assert.ok(payload.includes('Image fixture'), protocol);
  }
});

test('source ownership rejects missing connections and destination drift without a fallback request', async () => {
  const f = fixture('openai-chat', () => finishedChat('unused'));
  const request = { messages: [{ role: 'user', content: 'Fixture' }], tools, system: '' }, signal = new AbortController().signal;
  await assert.rejects(f.client(request, { ...f.bot, modelSource: { connectionId: 'missing', model: 'shared-name' } }, signal), /Unknown fixture/);
  f.selected.baseUrl = 'https://changed.example.test/v1';
  await assert.rejects(f.client(request, f.bot, signal), /changed its address/);
  assert.equal(f.requests.length, 0);
});

test('redirects and HTTP failures never follow another endpoint or expose a credential', async () => {
  const f = fixture('openai-chat', request => { assert.equal(request.options.redirect, 'error'); throw new TypeError(`redirect with ${key}`); });
  const request = { messages: [{ role: 'user', content: 'Fixture' }], tools, system: '' }, signal = new AbortController().signal;
  await assert.rejects(f.client(request, f.bot, signal), error => !error.message.includes(key) && /Could not reach/.test(error.message));
  const denied = fixture('openai-chat', () => new Response(`secret ${key}`, { status: 401 }));
  await assert.rejects(denied.client(request, denied.bot, signal), error => !error.message.includes(key) && /HTTP 401/.test(error.message));
  assert.equal(f.requests.length, 1); assert.equal(denied.requests.length, 1);
});

test('redaction spans fragmented text and reasoning before anything reaches shared history', async () => {
  const f = fixture('openai-chat', () => sse([
    { choices: [{ index: 0, delta: { content: 'Answer: fixture-private-', reasoning: 'Thinking: fixture-' } }] },
    { choices: [{ index: 0, delta: { content: 'api-key.', reasoning: 'private-api-key.' }, finish_reason: 'stop' }] },
  ]));
  const c = context(f); await runConfiguredBot(c.c);
  assert.equal(text(c.frames), 'Answer: [redacted].'); assert.equal(reasoning(c.frames), 'Thinking: [redacted].');
  assert.equal(JSON.stringify(c.frames).includes(key), false);
});

test('escaped credentials are redacted in parsed tool arguments and native continuation output for every protocol', async () => {
  const secret = 'synthetic"escaped\\key';
  for (const protocol of ['openai-chat','openai-responses','anthropic']) {
    const args = JSON.stringify({ path: secret });
    const f = fixture(protocol, (_request, round) => {
      if (protocol === 'openai-responses') return sse([{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'redaction', name: 'read_file', arguments: args }] } }]);
      if (protocol === 'anthropic') return sse([{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'redaction', name: 'read_file', input: { path: secret } } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }]);
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'redaction', function: { name: 'read_file', arguments: args } }] }, finish_reason: 'tool_calls' }] }]);
    });
    f.selected.apiKey = secret;
    const result = await f.client({ messages: [{ role: 'user', content: 'Fixture' }], tools, system: '' }, f.bot, new AbortController().signal);
    assert.equal(result.toolCalls[0].args.path, '[redacted]', protocol);
    if (protocol === 'openai-responses') assert.equal(JSON.parse(result.providerOutput.items[0].arguments).path, '[redacted]');
    if (protocol === 'anthropic') assert.equal(result.providerOutput.content[0].input.path, '[redacted]');
    assert.equal(JSON.stringify(result).includes(JSON.stringify(secret).slice(1,-1)), false);
  }
});

test('truncated, malformed and incomplete streams preserve partial text but execute no tool', async () => {
  const samples = [
    () => sse([{ choices: [{ delta: { content: 'Partial' } }] }], { trailing: false }),
    () => sse(['data: {bad-json}\n\n'], { trailing: false }),
    () => sse([{ type: 'response.incomplete', response: { status: 'incomplete' } }]),
  ];
  for (const [index, sample] of samples.entries()) {
    const f = fixture(index === 2 ? 'openai-responses' : 'openai-chat', sample), c = context(f);
    await assert.rejects(runConfiguredBot(c.c), /before completing|unreadable|could not complete/);
    assert.equal(c.calls.length, 0); assert.equal(c.checkpoints.length, 0);
    if (index === 0) assert.equal(text(c.frames), 'Partial');
  }
});

test('malformed and unlisted tool arguments are refused before execution', async () => {
  for (const [name, args] of [['read_file', '{bad'], ['read_file', '[]'], ['unavailable', '{}']]) {
    const f = fixture('openai-chat', () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }] }])), c = context(f);
    await assert.rejects(runConfiguredBot(c.c), /malformed tool arguments|unavailable tool|invalid arguments/); assert.equal(c.calls.length, 0);
  }
});

test('malformed Anthropic partial JSON has a safe error without leaking echoed credentials', async () => {
  const f = fixture('anthropic', () => sse([{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'read_file', input: {} } }, { type: 'content_block_delta', index: 0, delta: { partial_json: `{"path":"${key}"` } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }])), c = context(f);
  await assert.rejects(runConfiguredBot(c.c), error => !error.message.includes(key) && /malformed tool arguments/.test(error.message));
  assert.equal(c.calls.length, 0);
});

test('picker generation controls reach the actual HTTP body for every protocol', async () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic']) {
    const f = fixture(protocol, () => {
      if (protocol === 'anthropic') return sse([
        { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { text: '{"speakers":[]}' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
      ]);
      if (protocol === 'openai-responses') return sse([
        { type: 'response.output_text.delta', delta: '{"speakers":[]}' },
        { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
      return finishedChat('{"speakers":[]}');
    });
    f.selected.models[0].maxOutput = 512;
    await f.client({ messages: [{ role: 'user', content: 'Pick speakers' }], tools: [], system: 'JSON only.', max_tokens: 64, reasoning_effort: 'none' }, f.bot, new AbortController().signal);
    assert.equal(f.requests.length, 1, protocol);
    const payload = f.requests[0].payload;
    if (protocol === 'openai-responses') {
      assert.equal(payload.max_output_tokens, 64, protocol);
      assert.deepEqual(payload.reasoning, { effort: 'none' }, protocol);
    } else {
      assert.equal(payload.max_tokens, 64, protocol);
      if (protocol === 'anthropic') assert.deepEqual(payload.thinking, { type: 'disabled' }, protocol);
      else assert.equal(payload.reasoning_effort, 'none', protocol);
    }
  }
});

test('Stop after inference resolves revokes tool execution before a mutation can run', async () => {
  const controller = new AbortController(); let executed = 0, saved = 0;
  await assert.rejects(runConfiguredBot({ bot: { instructions: '' }, history: [], message: 'Fixture', tools, signal: controller.signal, frame() {}, save() { saved++; },
    modelRequest: async () => { controller.abort(); return { text: '', toolCalls: [{ id: 'call', name: 'read_file', args: { path: 'a.txt' } }] }; }, execute: async () => { executed++; } }), { name: 'AbortError' });
  assert.equal(executed, 0); assert.equal(saved, 0);
});

test('catalog exposes only serving native sources alongside Maya, without keys or lifecycle actions', () => {
  const f = fixture('openai-chat', () => { throw new Error('No inference during catalog reads'); });
  let serving = [{ id: 'native-one', label: 'Local coder', apiModelId: 'coder', port: 40001, key: 'native-private-key', vision: false }];
  const sources = createBotModelSources({ providers: f.providers, localInstances: () => serving });
  const listed = sources.list().connections;
  assert.deepEqual(listed.map(connection => connection.id), ['maya', 'strata', 'native:native-one']);
  assert.equal(JSON.stringify(listed).includes('private-key'), false);
  const selected = sources.resolve({ connectionId: 'native:native-one', modelId: 'coder' });
  assert.equal(selected.connection.baseUrl, 'http://127.0.0.1:40001/v1'); assert.equal(selected.connection.apiKey, 'native-private-key');
  serving = [];
  assert.throws(() => sources.resolve({ connectionId: 'native:native-one', modelId: 'coder' }), /no longer serving/);
  assert.equal(sources.resolve({ connectionId: 'maya', modelId: 'shared-name' }).connection.id, 'maya');
  assert.equal(f.requests.length, 0);
});
