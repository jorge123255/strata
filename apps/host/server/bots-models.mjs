/** Saved model APIs provide inference; tools and credentials retain separate owners. */
import { randomUUID, createHash } from 'node:crypto';

const failure = message => { throw new Error(message); };
const MAX = 16 * 1024 * 1024;
const copy = value => structuredClone(value);
export const botModelDestination = connection => createHash('sha256').update(JSON.stringify([connection.id, connection.baseUrl, connection.protocol])).digest('hex');
const textOf = content => typeof content === 'string' ? content : (content ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join('\n');
const safeText = (value, key) => key ? String(value ?? '').replaceAll(key, '[redacted]') : String(value ?? '');
function safeResult(value, key) {
  if (!key) return value;
  // Tool arguments can be parsed objects or JSON strings inside native output
  // items. Redact both string values and their JSON-escaped representation.
  const escaped = JSON.stringify(key).slice(1, -1);
  const redact = text => safeText(text, key).replaceAll(escaped, '[redacted]');
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => safeResult(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name), safeResult(item, key)]));
  return value;
}
function historyText(message) {
  const tools = (message.tools ?? []).filter(t => ['done', 'error', 'denied'].includes(t.state)).slice(-20).map(t => `${t.name} [${t.state}] ${JSON.stringify(t.args ?? {}).slice(0, 4000)}\n${String(t.result ?? '').slice(0, 20000)}`);
  return `${message.content ?? ''}${tools.length ? `\nRecorded completed tool activity (context only; do not replay):\n${tools.join('\n')}` : ''}`;
}

/** Native and SSH workers use the same tool loop. The Mac alone resolves saved API credentials. */
export async function runConfiguredBot(c) {
  if (typeof c.modelRequest !== 'function') failure('Configured model inference is unavailable. Reconnect to the Mac and try again.');
  const messages = c.history.filter(m => ['user', 'assistant'].includes(m.role)).slice(-40).map(m => ({ role: m.role, content: historyText(m) }));
  messages.push({ role: 'user', content: c.message });
  let tokensIn = 0, tokensOut = 0;
  const executedIds = new Set();
  for (let round = 0; round < 32; round++) {
    c.signal.throwIfAborted();
    const result = await c.modelRequest({ messages, tools: c.tools, system: c.bot.instructions || 'You are a Strata bot. Use the provided tools for coding and computer tasks.' });
    c.signal.throwIfAborted();
    if (!result || typeof result.text !== 'string' || !Array.isArray(result.toolCalls)) failure('The configured model returned an unreadable response.');
    if (!result.streamed) {
      if (result.reasoning) c.frame({ type: 'reasoning', text: result.reasoning });
      if (result.text) c.frame({ type: 'delta', text: result.text });
    }
    tokensIn += result.tokensIn ?? 0; tokensOut += result.tokensOut ?? 0;
    c.frame({ type: 'stats', tokensIn, tokensOut });
    if (!result.toolCalls.length) {
      if (!result.text.trim()) failure('The configured model returned no answer. Choose a model with text and tool support.');
      await c.save(null); return;
    }
    if (result.toolCalls.length > 100) failure('The configured model requested too many tools.');
    messages.push({ role: 'assistant', content: result.text, tool_calls: result.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })), ...(result.providerOutput ? { providerOutput: result.providerOutput } : {}) });
    for (const call of result.toolCalls) {
      c.signal.throwIfAborted();
      if (typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) failure('The configured model returned invalid tool arguments.');
      if (executedIds.has(call.id)) failure('The model repeated a completed tool identity. Continue in this chat to retry safely.');
      executedIds.add(call.id);
      const toolResult = await c.execute(call.name, call.args, call.id);
      messages.push({ role: 'tool', tool_call_id: call.id, content: textOf(toolResult.content), isError: toolResult.isError === true });
      const pictures = (toolResult.content ?? []).filter(item => item.type === 'image');
      if (pictures.length) messages.push({ role: 'user', content: [{ type: 'text', text: `Images returned by ${call.name}:` }, ...pictures.map(item => ({ type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.data}` } }))] });
    }
  }
  failure('The bot reached its 32-step limit. Continue in this chat to proceed.');
}

function anthropicContent(value, vision) {
  if (typeof value === 'string') return [{ type: 'text', text: value || ' ' }];
  return (value ?? []).flatMap(part => {
    if (part.type === 'text') return [{ type: 'text', text: part.text || ' ' }];
    const image = /^data:([^;]+);base64,(.+)$/s.exec(part.image_url?.url ?? '');
    return image && vision !== false ? [{ type: 'image', source: { type: 'base64', media_type: image[1], data: image[2] } }] : [];
  });
}
function payloadFor(protocol, model, request) {
  const { messages, tools = [], system = '' } = request;
  if (!Array.isArray(messages) || messages.length > 500 || !Array.isArray(tools) || tools.length > 100 || typeof system !== 'string') failure('The bot model request is invalid.');
  if (protocol === 'anthropic') {
    const rows = [];
    for (const message of messages) {
      let row;
      if (message.role === 'tool') row = { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content || ' ', is_error: message.isError === true }] };
      else if (message.role === 'assistant' && message.providerOutput?.protocol === protocol) row = { role: 'assistant', content: copy(message.providerOutput.content) };
      else row = { role: message.role, content: [...anthropicContent(message.content, model.vision), ...(message.tool_calls ?? []).map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }))] };
      if (!['assistant', 'user'].includes(row.role)) failure('The bot model request has an invalid message.');
      if (rows.at(-1)?.role === row.role) rows.at(-1).content.push(...row.content); else rows.push(row);
    }
    return { model: model.id, system, messages: rows, stream: true, max_tokens: Math.min(model.maxOutput || 8192, 16384), ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}) };
  }
  if (protocol === 'openai-responses') {
    const input = [];
    for (const message of messages) {
      if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content || '' });
      else if (message.role === 'assistant' && message.providerOutput?.protocol === protocol) input.push(...copy(message.providerOutput.items));
      else input.push({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.flatMap(part => part.type === 'text' ? [{ type: 'input_text', text: part.text }] : part.image_url && model.vision !== false ? [{ type: 'input_image', image_url: part.image_url.url }] : []) });
    }
    return { model: model.id, instructions: system, input, stream: true, store: false, include: ['reasoning.encrypted_content'], ...(tools.length ? { tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false })) } : {}) };
  }
  return { model: model.id, messages: [{ role: 'system', content: system }, ...messages.map(({ providerOutput, isError, ...m }) => ({ ...m, ...(model.vision === false && Array.isArray(m.content) ? { content: textOf(m.content) } : {}) }))], stream: true, ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}) };
}

async function* events(response, signal) {
  if (!response.body) failure('The model API returned no response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', data = [], bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length; if (bytes > MAX) failure('The model API response exceeded the size limit.');
      pending += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        if (!line && data.length) { const raw = data.join('\n'); data = []; if (raw === '[DONE]') yield { done: true }; else { try { yield JSON.parse(raw); } catch { failure('The model API returned an unreadable stream.'); } } }
      }
      if (pending.length > 4 * 1024 * 1024) failure('The model API event exceeded the size limit.');
    }
    if (pending.startsWith('data:')) data.push(pending.slice(5).trim());
    if (data.length) { const raw = data.join('\n'); if (raw === '[DONE]') yield { done: true }; else { try { yield JSON.parse(raw); } catch { failure('The model API returned an unreadable stream.'); } } }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Request fields contain no address or key. A frozen profile selects one configured connection. */
export function createBotModelClient({ providers, fetchImpl = fetch }) {
  return async function request(request, bot, signal, onFrame = () => {}) {
    const source = bot.modelSource;
    if (!source || bot.provider !== 'configured') failure('Choose a saved model from Models for this bot.');
    const { connection, model } = providers.resolve({ connectionId: source.connectionId, modelId: source.model });
    if (bot.modelDestination && bot.modelDestination !== botModelDestination(connection)) failure('This model connection changed its address. Edit the bot and start a new chat to use it.');
    const protocol = connection.protocol;
    const payload = payloadFor(protocol, model, request), body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX) failure('The bot model context exceeded the size limit. Start a new chat.');
    const headers = { 'content-type': 'application/json', ...(protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(connection.apiKey ? { 'x-api-key': connection.apiKey } : {}) } : connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}) };
    let response;
    try { response = await fetchImpl(`${connection.baseUrl}/${protocol === 'anthropic' ? 'messages' : protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`, { method: 'POST', headers, body, signal, redirect: 'error' }); }
    catch { signal?.throwIfAborted(); failure('Could not reach the configured model API. Check the selected connection in Models.'); }
    if (!response.ok) { await response.body?.cancel(); failure(`The configured model API returned HTTP ${response.status}. Check its credentials and tool support in Models.`); }
    let text = '', reasoning = '', tokensIn = 0, tokensOut = 0, finished = false, providerOutput;
    const calls = new Map(), blocks = [];
    // Keep a possible credential prefix between chunks so a split header echo never reaches history.
    const pendingText = { delta: '', reasoning: '' };
    const publish = (type, value) => { if (!value) return; signal?.throwIfAborted(); if (type === 'delta') text += value; else reasoning += value; onFrame({ type, text: value }); };
    const emit = (type, value) => {
      if (typeof value !== 'string' || !value) return;
      let safe = safeText(pendingText[type] + value, connection.apiKey), held = 0;
      if (connection.apiKey) for (let count = Math.min(connection.apiKey.length - 1, safe.length); count > 0; count--) if (safe.endsWith(connection.apiKey.slice(0, count))) { held = count; break; }
      pendingText[type] = held ? safe.slice(-held) : '';
      publish(type, held ? safe.slice(0, -held) : safe);
    };
    const usage = u => { tokensIn = u?.input_tokens ?? u?.prompt_tokens ?? tokensIn; tokensOut = u?.output_tokens ?? u?.completion_tokens ?? tokensOut; };
    for await (const event of events(response, signal)) {
      if (event.error || event.type === 'error' || ['response.failed', 'response.incomplete'].includes(event.type)) failure('The configured model API could not complete this turn. Partial output was retained.');
      if (protocol === 'anthropic') {
        if (event.type === 'message_start') usage(event.message?.usage);
        if (event.type === 'content_block_start') blocks[event.index] = copy(event.content_block);
        if (event.type === 'content_block_delta') {
          const block = blocks[event.index], delta = event.delta ?? {};
          if (!block) failure('The model API returned an invalid content block.');
          if (delta.text) { block.text = (block.text ?? '') + delta.text; emit('delta', delta.text); }
          if (delta.thinking) { block.thinking = (block.thinking ?? '') + delta.thinking; emit('reasoning', delta.thinking); }
          if (delta.signature) block.signature = (block.signature ?? '') + delta.signature;
          if (delta.partial_json) block.partialJSON = (block.partialJSON ?? '') + delta.partial_json;
        }
        if (event.type === 'message_delta') { usage(event.usage); if (!['end_turn', 'tool_use', 'stop_sequence'].includes(event.delta?.stop_reason)) failure('The model stopped before completing its response.'); }
        if (event.type === 'message_stop') finished = true;
      } else if (protocol === 'openai-responses') {
        if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') emit('delta', event.delta);
        if (event.type === 'response.reasoning_summary_text.delta') emit('reasoning', event.delta);
        if (event.type === 'response.completed') {
          if (event.response?.status !== 'completed') failure('The model stopped before completing its response.');
          usage(event.response.usage); providerOutput = { protocol, items: copy(event.response.output ?? []) };
          for (const item of event.response.output ?? []) if (item.type === 'function_call') calls.set(item.call_id, { id: item.call_id, name: item.name, arguments: item.arguments });
          finished = true;
        }
      } else {
        const choice = event.choices?.find(c => c.index === 0) ?? event.choices?.[0], delta = choice?.delta ?? {};
        emit('delta', delta.content ?? delta.refusal); emit('reasoning', delta.reasoning_content ?? delta.reasoning ?? delta.thinking); usage(event.usage);
        for (const part of delta.tool_calls ?? []) {
          const index = part.index ?? 0, call = calls.get(index) ?? { id: randomUUID(), name: '', arguments: '' };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.arguments += part.function.arguments;
          calls.set(index, call);
        }
        if (choice?.finish_reason) { if (!['stop', 'tool_calls', 'end_turn'].includes(choice.finish_reason)) failure('The model stopped before completing its response.'); finished = true; }
      }
    }
    signal?.throwIfAborted();
    if (!finished) failure('The model API disconnected before completing this response. Partial output was retained.');
    for (const type of ['delta', 'reasoning']) publish(type, safeText(pendingText[type], connection.apiKey));
    if (protocol === 'anthropic') {
      for (const block of blocks) if (block?.type === 'tool_use') calls.set(block.id, { id: block.id, name: block.name, arguments: block.partialJSON || JSON.stringify(block.input ?? {}) });
      try { providerOutput = { protocol, content: blocks.filter(Boolean).map(({ partialJSON, ...block }) => block.type === 'tool_use' ? { ...block, input: JSON.parse(partialJSON || JSON.stringify(block.input ?? {})) } : block) }; }
      catch { failure('The configured model returned malformed tool arguments.'); }
    }
    const toolCalls = [...calls.values()].map(call => {
      let args; try { args = JSON.parse(call.arguments || '{}'); } catch { failure('The configured model returned malformed tool arguments.'); }
      if (typeof call.id !== 'string' || !call.id || call.id.length > 160 || !/^[A-Za-z0-9_.:-]+$/.test(call.id) || !request.tools.some(t => t.name === call.name) || !args || typeof args !== 'object' || Array.isArray(args)) failure('The configured model requested an unavailable tool or invalid arguments.');
      return { id: call.id, name: call.name, args };
    });
    // A broken/malicious server must not echo a header credential into history or the worker.
    return safeResult({ text, reasoning, toolCalls, tokensIn, tokensOut, streamed: true, ...(providerOutput ? { providerOutput } : {}) }, connection.apiKey);
  };
}

/** Include only already-serving local instances. Nothing here loads or switches a model. */
export function createBotModelSources({ providers, localInstances = () => [] }) {
  const localConnections = () => localInstances().map(instance => ({
    id: `native:${instance.id}`, name: `This Mac · ${instance.label || instance.apiModelId}`, kind: 'custom', protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${instance.port}/v1`, apiKey: instance.key || '',
    models: [{ id: instance.apiModelId, name: instance.label || instance.apiModelId, vision: instance.vision ?? null }],
  }));
  return {
    list() { return { connections: [...providers.list().connections, ...localConnections().map(({ apiKey, ...connection }) => connection)] }; },
    resolve(selection) {
      if (!selection?.connectionId?.startsWith('native:')) return providers.resolve(selection);
      const connection = localConnections().find(c => c.id === selection.connectionId), model = connection?.models.find(m => m.id === selection.modelId);
      if (!connection || !model) failure('This local model is no longer serving. Start it in Models and choose it for a new bot chat.');
      return { connection, model };
    },
  };
}
