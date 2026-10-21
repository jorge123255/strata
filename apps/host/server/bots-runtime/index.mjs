import { randomUUID, createHash } from 'node:crypto';
import { stat, lstat, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { findExecutable, executableVersion, executableJsonStatus, jsonRpcProcess, killOwned, redact, abortError } from './process.mjs';
import { startToolBridge, toolResult } from './tool-bridge.mjs';
import { devinStatus, devinModels, runDevin } from './devin.mjs';

const PROVIDERS = [
  { id: 'claude', name: 'Claude Code', transport: 'Claude Agent SDK / installed CLI', loginCommand: 'claude auth login', models: ['sonnet', 'opus', 'haiku'] },
  { id: 'codex', name: 'Codex', transport: 'Codex app-server', loginCommand: 'codex login', models: [] },
  { id: 'grok', name: 'Grok', transport: 'Grok ACP', loginCommand: 'grok login', models: [] },
  { id: 'kimi', name: 'Kimi', transport: 'Kimi ACP', loginCommand: 'kimi login', models: [] },
  { id: 'ollama', name: 'Ollama Cloud', transport: 'Ollama HTTPS / signed-in local daemon', loginCommand: 'ollama signin', models: [] },
  { id: 'devin', name: 'Devin CLI', transport: 'Devin ACP', loginCommand: 'devin auth login', models: [] },
];
const safeId = value => String(value ?? '').replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 150) || randomUUID();
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); promise.catch(() => {}); return { promise, resolve, reject }; };
const textResult = value => toolResult(value).content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
const toolCard = (id, name, args, state, result) => ({ type: 'agent-tool', tool: { id, name, args, state, preview: name, effect: 'Uses a bot tool.', scope: 'connected', ...(result === undefined ? {} : { result }) } });
function historyContent(message) {
  const content = String(message.content ?? '');
  const recorded = (message.tools ?? []).filter(tool => ['done', 'error', 'denied'].includes(tool.state)).slice(-20).map(tool =>
    `${tool.name} [${tool.state}] ${JSON.stringify(tool.args ?? {}).slice(0, 4000)}\n${String(tool.result ?? '').slice(0, 20_000)}`);
  return recorded.length ? `${content}\n\nRecorded tool activity from this message (already completed; do not replay):\n${recorded.join('\n\n')}` : content;
}
export function normalizeTools(tools = []) {
  const seen = new Set(); return tools.map(t => {
    const f = t.function ?? t; const name = String(f.name ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || seen.has(name)) throw new Error('Bot tools must have unique, simple names.');
    seen.add(name); return { name, description: String(f.description ?? name), inputSchema: f.inputSchema ?? f.parameters ?? { type: 'object', properties: {} } };
  });
}
/** Explicit provider adapters. Credentials stay in native CLI homes or the private host environment. */
export function createBotRuntime(options = {}) {
  const env = options.env ?? process.env, fetcher = options.fetch ?? globalThis.fetch;
  const active = new Set(); let closed = false;
  let providersCache, providersCachedAt = 0;
  const executable = async id => options.commands?.[id] ?? await findExecutable(id === 'ollama' ? 'ollama' : id, env);
  const catalogs = new Map();
  async function models(provider, signal) {
    if (!['claude', 'codex', 'grok', 'kimi', 'ollama', 'devin', 'configured'].includes(provider)) throw new Error('Choose a supported bot provider.');
    const cached = catalogs.get(provider);
    if (!signal && cached && Date.now() - cached.at < 15000) return structuredClone(await cached.value);
    const value = (async () => {
      if (options.catalogs?.[provider]) return { provider, models: structuredClone(await options.catalogs[provider]()) };
      if (provider === 'devin') {
        const command = await executable(provider);
        if (!command) return { provider, models: [], detail: 'Install Devin CLI and sign in on the execution computer.' };
        try { return { provider, models: await devinModels(command, { stateDir: options.stateDir, env, signal, spawnProcess: options.spawnProcess, timeoutMs: options.catalogTimeoutMs }), detail: 'Verified Devin model variants. Separate effort options are checked against the selected native session before a prompt.' }; }
        catch (error) { return { provider, models: [], detail: `Could not verify the Devin model catalog. ${redact(error)}` }; }
      }
      if (!['claude', 'codex'].includes(provider)) return { provider, models: [], detail: 'No verified effort catalog is available for this provider. Use Provider default.' };
      const command = await executable(provider);
      if (!command) return { provider, models: [], detail: 'Install and sign in to this provider on the execution computer.' };
      const cwd = join(options.stateDir ?? join(homedir(), '.strata/bots-runtime'), 'catalog'); await mkdir(cwd, { recursive: true, mode: 0o700 });
      signal?.throwIfAborted();
      const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, options.catalogTimeoutMs ?? 10000);
      signal?.addEventListener('abort', abort, { once: true });
      const rows = [];
      try {
        if (provider === 'codex') {
          const rpc = jsonRpcProcess({ command, args: ['app-server', '--listen', 'stdio://'], cwd, env, signal: controller.signal, spawnProcess: options.spawnProcess, timeoutMs: 8000,
            onRequest(message, process) { process.reject(message.id, 'Catalog discovery does not execute tools or approve actions.'); } });
          try {
            await rpc.request('initialize', { clientInfo: { name: 'strata', version: '0.2.1' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized', {});
            let cursor;
            for (let page = 0; page < 5; page++) { const response = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }); rows.push(...(response.data ?? []).map(row => ({ id: row.model ?? row.id, name: row.displayName ?? row.model ?? row.id, efforts: (row.supportedReasoningEfforts ?? []).map(item => item.reasoningEffort), ...(row.defaultReasoningEffort ? { defaultEffort: row.defaultReasoningEffort } : {}), ...(row.isDefault ? { isDefault: true } : {}) }))); cursor = response.nextCursor; if (!cursor) break; }
          } finally { await rpc.close(); }
        } else {
          const auth = await executableJsonStatus(command, ['auth', 'status', '--json'], env);
          if (auth?.loggedIn === false) return { provider, models: [], detail: 'Sign in to Claude Code to load its model and effort options.' };
          const sdk = options.claudeSdk ?? await import('@anthropic-ai/claude-agent-sdk');
          const children = new Set(); let query;
          // An open input stream permits control requests without submitting a model prompt.
          const input = (async function* () { await new Promise(resolve => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener('abort', resolve, { once: true }); }); })();
          try {
            query = sdk.query({ prompt: input, options: { cwd, pathToClaudeCodeExecutable: command, abortController: controller, tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, env,
              canUseTool: async () => ({ behavior: 'deny', message: 'Catalog discovery cannot execute tools.' }),
              spawnClaudeCodeProcess(plan) { const child = (options.spawnProcess ?? spawn)(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); children.add(child); return child; } } });
            rows.push(...(await query.supportedModels()).map(row => ({ id: row.value, name: row.displayName, efforts: row.supportsEffort ? row.supportedEffortLevels ?? [] : [], ...(row.resolvedModel ? { resolvedId: row.resolvedModel } : {}) })));
          } finally { controller.abort(); query?.close(); await Promise.all([...children].map(killOwned)); }
        }
        return { provider, models: rows.filter(row => typeof row.id === 'string' && row.id.length <= 250).slice(0, 500).map(row => ({ ...row, name: String(row.name ?? row.id).slice(0, 250), efforts: [...new Set(row.efforts.filter(level => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level)))] })) };
      } catch (error) { return { provider, models: [], detail: `Could not verify this provider’s model options. Use Provider default. ${redact(error)}` }; }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
    })();
    catalogs.set(provider, { at: Date.now(), value }); return structuredClone(await value);
  }
  async function providers() {
    if (providersCache && Date.now() - providersCachedAt < (options.providerCacheMs ?? 30_000)) return structuredClone(await providersCache);
    providersCachedAt = Date.now();
    providersCache = Promise.all(PROVIDERS.map(async provider => {
      const command = await executable(provider.id);
      const hasKey = provider.id === 'ollama' && Boolean(env.OLLAMA_API_KEY);
      const claudeStatus = provider.id === 'claude' && command ? await executableJsonStatus(command, ['auth', 'status', '--json'], env) : null;
      const devinAuth = provider.id === 'devin' && command ? await devinStatus(command, { stateDir: options.stateDir, env, spawnProcess: options.spawnProcess }).catch(() => 'unverified') : null;
      let daemon = false, models = provider.models;
      if (provider.id === 'ollama' && !hasKey) {
        try {
          const response = await fetcher('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
          if (response.ok) { daemon = true; const body = await response.json(); models = (body.models ?? []).map(m => m.name).filter(n => typeof n === 'string' && /(?:cloud|remote)/i.test(n)); }
        } catch { /* daemon unavailable */ }
      }
      return { ...provider, models, installed: Boolean(command), ready: provider.id === 'ollama' ? hasKey || daemon : provider.id === 'devin' ? Boolean(command) && devinAuth === 'signed_in' : Boolean(command) && claudeStatus?.loggedIn !== false,
        version: command ? await executableVersion(command, env) : null,
        auth: { state: devinAuth ?? (claudeStatus?.loggedIn === false ? 'signed_out' : claudeStatus?.loggedIn === true ? 'signed_in' : hasKey ? 'configured' : daemon ? 'daemon' : 'unverified'), help: provider.id === 'ollama' ? 'Use OLLAMA_API_KEY on the Mac host, or sign in to the local Ollama daemon. Cloud requests run on Ollama servers.' : `Uses the installed CLI account on this Mac. Sign in with ${provider.loginCommand}, then refresh providers. Account and model access are checked when a turn runs.` },
        catalogSource: models.length ? 'suggested' : 'provider-default', supports: { code: true, computer: true, thinking: 'when-provider-emits', execution: ['local'] } };
    }));
    try { return structuredClone(await providersCache); } catch (error) { providersCache = null; throw error; }
  }
  async function run(input) {
    if (closed) throw new Error('Bots runtime is closed.');
    if (input.bot?.execution?.kind === 'ssh') {
      if (!options.remoteSSH) throw new Error('SSH Bots transport is not configured. Prepare the execution computer first.');
      return await options.remoteSSH.run(input);
    }
    const { message, history = [], onFrame = () => {}, requestPermission, executeTool, onCheckpoint = () => {} } = input;
    let bot = input.bot;
    if (!PROVIDERS.some(p => p.id === bot?.provider) && bot?.provider !== 'configured') throw new Error('Choose a supported bot provider.');
    if ((bot.execution?.kind ?? 'local') !== 'local') throw new Error('This bot provider currently executes on this Mac. An inference API connection does not grant SSH or sandbox execution.');
    if (bot.computerMode === 'cua') {
      // Provider accounts remain on their owning host. Their brain process gets a private control cwd;
      // every coding/browser/computer action still uses the caller's original sandbox-bound tools.
      const workspace = join(options.stateDir ?? join(homedir(), '.strata/bots-runtime'), 'cua-provider-workspaces', safeId(bot.id));
      await mkdir(workspace, { recursive: true, mode: 0o700 }); const privateFolder = await lstat(workspace); if (!privateFolder.isDirectory() || privateFolder.isSymbolicLink()) throw new Error('The isolated computer provider folder is not private.'); bot = { ...bot, workspace };
    }
    if (!isAbsolute(bot.workspace ?? '') || !(await stat(bot.workspace)).isDirectory()) throw new Error('Choose an existing absolute workspace folder.');
    const tools = normalizeTools(input.tools);
    input.signal?.throwIfAborted();
    if (bot.effort && !['grok', 'kimi', 'devin'].includes(bot.provider)) {
      const catalog = await models(bot.provider, input.signal), selected = catalog.models.find(row => row.id === bot.model || row.resolvedId === bot.model || !bot.model && row.isDefault);
      input.signal?.throwIfAborted();
      if (!selected?.efforts.includes(bot.effort)) throw new Error('This model’s selected effort could not be verified on its execution computer. Choose Provider default or refresh the model catalog.');
    }
    const controller = new AbortController(), abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort(); active.add(controller);
    const signal = controller.signal, started = Date.now();
    const secrets = [bot.providerSettings?.apiKey, env.OLLAMA_API_KEY].filter(Boolean);
    const emit = frame => { if (!signal.aborted) onFrame(frame); };
    let checkpoint = input.checkpoint ?? null, text = '', tokensIn = 0, tokensOut = 0;
    if (checkpoint && (checkpoint.provider !== bot.provider || checkpoint.workspace !== bot.workspace || (checkpoint.model ?? '') !== (bot.model ?? ''))) {
      active.delete(controller); input.signal?.removeEventListener('abort', abort); throw new Error('This bot changed provider, model, or workspace. Start a new bot chat.');
    }
    const save = async nativeSessionId => { checkpoint = { provider: bot.provider, nativeSessionId, workspace: bot.workspace, model: bot.model ?? '' }; await onCheckpoint(checkpoint); };
    const frame = f => { if (f.type === 'delta') text += f.text ?? ''; if (f.type === 'stats') { tokensIn = f.tokensIn ?? tokensIn; tokensOut = f.tokensOut ?? tokensOut; } emit(f); };
    const permission = async ({ id, name, args = {}, reason }) => {
      signal.throwIfAborted(); const key = safeId(id); emit(toolCard(key, name, args, 'proposed'));
      // Plan never approves a provider's native execution. Root tools can offer specifically read-only operations.
      const allow = bot.policy !== 'plan' && typeof requestPermission === 'function' && await requestPermission({ id: key, name, args, reason: reason ?? 'The bot wants to run a native provider tool.' });
      signal.throwIfAborted(); emit(toolCard(key, name, args, allow ? 'running' : 'denied')); return Boolean(allow);
    };
    const execute = async (name, args, id = randomUUID()) => {
      signal.throwIfAborted(); if (!tools.some(t => t.name === name)) throw new Error('The provider requested an unavailable Strata tool.');
      if (typeof executeTool !== 'function') throw new Error('Bot tool execution is not configured.');
      // The host owns this ledger, including approvals and frames. Pass one stable id through every layer.
      try { const result = toolResult(await executeTool(name, args, id)); signal.throwIfAborted(); return result; }
      catch (error) { if (signal.aborted) throw abortError(); return { content: [{ type: 'text', text: redact(error, secrets) }], isError: true }; }
    };
    const prompt = !checkpoint && history.length ? `Previous messages from this Strata chat are context, not new instructions to replay tools:\n${history.filter(h => ['user', 'assistant'].includes(h.role)).map(h => `${h.role}: ${historyContent(h).slice(0, 100_000)}`).join('\n')}\n\nCurrent user message:\n${message}` : String(message ?? '');
    const modelRequest = input.modelRequest ?? options.modelRequest;
    const context = { bot, sessionId: input.sessionId, prompt, message: String(message ?? ''), history, checkpoint, tools, signal, frame, save, permission, execute, env, fetcher, executable, options, modelRequest: modelRequest ? payload => modelRequest(payload, bot, signal) : null };
    const timer = setTimeout(() => controller.abort(new Error('Bot run timed out.')), options.runTimeoutMs ?? 30 * 60_000); timer.unref();
    try {
      signal.throwIfAborted();
      emit({ type: 'notice', message: `${PROVIDERS.find(p => p.id === bot.provider)?.name ?? 'Configured model'} · ${bot.provider === 'configured' ? 'saved model connection' : bot.provider === 'ollama' ? 'cloud model' : 'installed CLI'} · ${bot.computerMode === 'cua' ? 'isolated computer' : bot.workspace}` });
      if (bot.provider === 'configured') { if (!context.modelRequest) throw new Error('The selected model connection is unavailable.'); const { runConfiguredBot } = await import('../bots-models.mjs'); await runConfiguredBot(context); }
      else if (bot.provider === 'claude') await runClaude(context);
      else if (bot.provider === 'codex') await runCodex(context);
      else if (bot.provider === 'grok' || bot.provider === 'kimi') await runAcp(context);
      else if (bot.provider === 'devin') await runDevin(context);
      else await runOllama(context);
      signal.throwIfAborted();
      frame({ type: 'stats', tokensIn, tokensOut, tps: Number((tokensOut / Math.max(1, (Date.now() - started) / 1000)).toFixed(1)) });
      frame({ type: 'done', tokensIn, tokensOut, sessionId: input.sessionId, checkpoint, ...(typeof context.publicReply === 'string' ? { publicReply: context.publicReply } : {}) });
      return { text, checkpoint, tokensIn, tokensOut, ...(typeof context.publicReply === 'string' ? { publicReply: context.publicReply } : {}) };
    } catch (error) { const safe = signal.aborted ? abortError() : new Error(redact(error, secrets)); emit({ type: 'error', message: safe.message }); throw safe; }
    finally { clearTimeout(timer); active.delete(controller); input.signal?.removeEventListener('abort', abort); }
  }
  return { providers, models, run, async close() { closed = true; for (const controller of active) controller.abort(); active.clear(); await options.remoteSSH?.close(); } };
}

async function runClaude(c) {
  const command = await c.executable('claude'); if (!command) throw new Error('Install Claude Code and sign in on this Mac first.');
  c.signal.throwIfAborted();
  const sdk = c.options.claudeSdk ?? await import('@anthropic-ai/claude-agent-sdk');
  c.signal.throwIfAborted();
  const bridge = c.tools.length ? await startToolBridge({ tools: c.tools, executeTool: c.execute, signal: c.signal }) : null;
  const children = new Set();
  const abortController = new AbortController(), abort = () => { abortController.abort(); for (const child of children) void killOwned(child); }; c.signal.addEventListener('abort', abort, { once: true });
  let query, sawText = false, sawThinking = false, resultSeen = false;
  try {
    c.signal.throwIfAborted();
    query = sdk.query({ prompt: c.prompt, options: {
      cwd: c.bot.workspace, pathToClaudeCodeExecutable: command, model: c.bot.model || undefined,
      ...(c.bot.effort ? { effort: c.bot.effort } : {}),
      abortController, resume: c.checkpoint?.nativeSessionId || undefined,
      // Built-ins are disabled: all file, shell, and computer effects go through the Strata tool ledger and gate.
      tools: [], settingSources: [], strictMcpConfig: true, permissionMode: 'default',
      allowedTools: [],
      mcpServers: bridge ? { strata: { command: bridge.command, args: bridge.args, env: bridge.env } } : {},
      systemPrompt: { type: 'preset', preset: 'claude_code', append: `${c.bot.instructions ?? ''}\nUse the provided Strata tools for coding and computer control. All actions are controlled by Strata's selected policy.` },
      includePartialMessages: true,
      canUseTool: async (name, args, context) => name.startsWith('mcp__strata__')
        ? { behavior: 'allow', updatedInput: args }
        : { behavior: 'deny', message: 'Use the provided Strata tools.' },
      env: { ...c.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'strata/0.2.1' },
      spawnClaudeCodeProcess(plan) {
        c.signal.throwIfAborted();
        const child = (c.options.spawnProcess ?? spawn)(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
        children.add(child); if (c.signal.aborted) void killOwned(child); return child;
      },
    } });
    for await (const event of query) {
      c.signal.throwIfAborted();
      if (event.session_id && c.checkpoint?.nativeSessionId !== event.session_id) { await c.save(event.session_id); c.checkpoint = { ...c.checkpoint, nativeSessionId: event.session_id }; }
      if (event.type === 'stream_event') {
        const delta = event.event?.delta;
        if (delta?.type === 'text_delta') { sawText = true; c.frame({ type: 'delta', text: delta.text }); }
        if (delta?.type === 'thinking_delta') { sawThinking = true; c.frame({ type: 'reasoning', text: delta.thinking }); }
      }
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text' && !sawText) c.frame({ type: 'delta', text: block.text });
          if (block.type === 'thinking' && !sawThinking) c.frame({ type: 'reasoning', text: block.thinking });
        }
        sawText = false; sawThinking = false;
      }
      if (event.type === 'result') {
        resultSeen = true; c.frame({ type: 'stats', tokensIn: event.usage?.input_tokens ?? 0, tokensOut: event.usage?.output_tokens ?? 0 });
        if (event.is_error || event.subtype !== 'success') throw new Error(event.errors?.join('\n') ?? event.result ?? 'Claude Code turn failed.');
      }
    }
    if (!resultSeen) throw new Error('Claude Code ended without a turn result.');
  } finally { c.signal.removeEventListener('abort', abort); try { await query?.close?.(); } finally { try { await Promise.all([...children].map(killOwned)); } finally { await bridge?.close(); } } }
}

async function runCodex(c) {
  const command = await c.executable('codex'); if (!command) throw new Error('Install Codex and sign in on this Mac first.');
  const completed = deferred(); let threadId, turnId, prompting = false, streamed = new Set();
  // Keep the full progress stream in the linked conversation. Public team
  // reports use the provider's terminal answer when its phase is available.
  // Older models omit phase, so their existing publication path is unchanged.
  const finalMessages = new Map();
  const pendingNotifications = [];
  function notification({ method, params: p = {} }) {
      if (threadId && p.threadId && p.threadId !== threadId) return;
      if (turnId && p.turnId && p.turnId !== turnId) return;
      if (method === 'item/agentMessage/delta') { streamed.add(p.itemId); c.frame({ type: 'delta', text: p.delta ?? '' }); }
      else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') c.frame({ type: 'reasoning', text: p.delta ?? '' });
      else if (method === 'thread/tokenUsage/updated') { const u = p.tokenUsage?.last ?? p.tokenUsage?.total ?? {}; c.frame({ type: 'stats', tokensIn: u.inputTokens ?? 0, tokensOut: u.outputTokens ?? 0 }); }
      else if (method === 'item/started' || method === 'item/completed') {
        const item = p.item ?? {}, done = method === 'item/completed';
        if (done && item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.id === 'string' && typeof item.text === 'string') {
          finalMessages.set(item.id, item.text);
          c.publicReply = [...finalMessages.values()].join('\n\n');
        }
        if (done && item.type === 'agentMessage' && !streamed.has(item.id)) { streamed.add(item.id); c.frame({ type: 'delta', text: item.text ?? '' }); }
        else if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)) c.frame(toolCard(safeId(item.id), item.tool ?? item.type, item.command ? { command: item.command } : item.arguments ?? {}, done ? item.status === 'failed' ? 'error' : 'done' : 'running', done ? item.aggregatedOutput ?? item.result ?? '' : undefined));
      } else if (method === 'turn/completed') { const turn = p.turn ?? {}; if (turn.id && turn.id !== turnId) return; turn.status === 'completed' ? completed.resolve() : completed.reject(new Error(turn.error?.message ?? `Codex turn ${turn.status ?? 'failed'}.`)); }
      else if (method === 'error' && !p.willRetry) completed.reject(new Error(p.error?.message ?? 'Codex failed.'));
  }
  const rpc = jsonRpcProcess({ command, args: ['app-server', '--listen', 'stdio://'], cwd: c.bot.workspace, env: c.env, signal: c.signal, spawnProcess: c.options.spawnProcess,
    onNotification(message) {
      if (!prompting) return;
      // A single stdout chunk can contain the turn/start response and several
      // notifications before its awaiting continuation runs. Bind the turn ID
      // before accepting any of those notifications, including final text.
      if (!turnId) {
        if (pendingNotifications.length >= 10000) throw new Error('Codex sent too many notifications before its turn identity was confirmed.');
        pendingNotifications.push(message); return;
      }
      notification(message);
    },
    async onRequest({ id, method, params: p = {} }, process) {
      if (method === 'item/tool/call') {
        const result = await c.execute(p.tool, p.arguments ?? {}, safeId(p.callId));
        process.respond(id, { success: !result.isError, contentItems: result.content.flatMap(item => item.type === 'image' ? [{ type: 'inputImage', imageUrl: `data:${item.mimeType};base64,${item.data}` }] : item.type === 'text' ? [{ type: 'inputText', text: item.text }] : []) }); return;
      }
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval'].includes(method)) {
        c.frame(toolCard(`codex_${id}`, method.includes('fileChange') || method.includes('Patch') ? 'Codex file change' : 'Codex command', p, 'denied', 'Use the provided Strata tools so the host can enforce the selected policy.'));
        process.respond(id, { decision: ['execCommandApproval', 'applyPatchApproval'].includes(method) ? 'denied' : 'decline' }); return;
      }
      // Broader filesystem/network grants, arbitrary elicitation, credential refresh and UI dialogs fail closed.
      if (method === 'item/permissions/requestApproval') { process.respond(id, { permissions: {}, scope: 'turn' }); return; }
      if (method === 'mcpServer/elicitation/request') { process.respond(id, { action: 'decline' }); return; }
      if (method === 'item/tool/requestUserInput') { process.respond(id, { answers: {} }); return; }
      process.reject(id, 'This request is not supported by Strata.');
    }, onClose: error => completed.reject(error),
  });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'strata-bots', title: 'Strata Bots', version: '0.2.1' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized', {});
    // An empty mcp_servers table is deep-merged with the user's config. Enumerate resolved names and
    // explicitly disable each one instead. Never expose the config, which can contain private values.
    const resolved = await rpc.request('config/read', { includeLayers: false, cwd: c.bot.workspace });
    if (!resolved?.config || typeof resolved.config !== 'object') throw new Error('Codex could not confirm its isolated tool configuration.');
    const mcpServers = Object.fromEntries(Object.keys(resolved.config.mcp_servers ?? {}).map(name => [name, { enabled: false }]));
    const params = { cwd: c.bot.workspace, model: c.bot.model || undefined, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', developerInstructions: `${c.bot.instructions ?? ''}\nUse Strata dynamic tools for all coding and computer actions. Native execution and external MCP tools are disabled.`, config: { mcp_servers: mcpServers, web_search: 'disabled', features: { shell_tool: false, multi_agent: false, multi_agent_v2: false, apps: false, in_app_browser: false, hooks: false, plugins: false, skill_mcp_dependency_install: false, skip_host_skill_discovery: true } } };
    const session = c.checkpoint?.nativeSessionId
      ? await rpc.request('thread/resume', { ...params, threadId: c.checkpoint.nativeSessionId })
      : await rpc.request('thread/start', { ...params, ephemeral: false, dynamicTools: c.tools.map(t => ({ ...t, type: 'function' })) });
    threadId = session.thread?.id; if (!threadId) throw new Error('Codex returned no thread id.'); await c.save(threadId);
    const inventory = await rpc.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' });
    if (!Array.isArray(inventory?.data) || inventory.nextCursor || inventory.data.some(server => Object.keys(server.tools ?? {}).length > 0)) throw new Error('Codex still exposes inherited MCP tools. The bot was stopped before sending your message.');
    prompting = true;
    const turn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: c.prompt }], model: c.bot.model || undefined, ...(c.bot.effort ? { effort: c.bot.effort } : {}) });
    turnId = turn.turn?.id;
    if (typeof turnId !== 'string' || !turnId) throw new Error('Codex returned no turn id.');
    for (const message of pendingNotifications.splice(0)) notification(message);
    await completed.promise;
  } finally { await rpc.close(); }
}

export function acpArguments(provider, bot, profile) {
  const model = bot.model ? ['-m', bot.model] : [];
  // Never use --always-approve, -y, --auto or bypassPermissions on the user's computer.
  return provider === 'grok' ? ['--permission-mode', 'default', 'agent', '--no-leader', ...(profile ? ['--agent-profile', profile] : []), ...model, 'stdio'] : [...model, ...(profile ? ['--agent-file', profile] : []), 'acp'];
}
/** Non-empty allowlists exclude every native shell/file/subagent tool, including user-configured ones. */
export function acpProfile(bot) {
  return `---\nname: strata-bot\ndescription: Strata bot with host-owned tool permissions\ntools:\n  - mcp__strata__*\nsubagents: []\ninjectDefaultTools: false\ndiscoverSkills: false\n---\nYou are ${String(bot.name ?? 'a Strata bot').replace(/[\r\n]/g, ' ')}.\n${bot.instructions ?? ''}\nUse only the supplied Strata tools. Strata owns permissions, files, commands, browser and computer actions.\n`;
}
async function runAcp(c) {
  const command = await c.executable(c.bot.provider); if (!command) throw new Error(`Install ${c.bot.provider} and sign in on this Mac first.`);
  const bridge = c.tools.length ? await startToolBridge({ tools: c.tools, executeTool: c.execute, signal: c.signal }) : null;
  const profileText = acpProfile(c.bot), profileDir = join(c.options.stateDir ?? join(homedir(), '.strata/bots-runtime'), 'profiles');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const profile = join(profileDir, `${c.bot.provider}-${createHash('sha256').update(profileText).digest('hex').slice(0, 24)}.md`);
  await writeFile(profile, profileText, { mode: 0o600 });
  const terminated = deferred(); let sessionId, projecting = false;
  const rpc = jsonRpcProcess({ command, args: acpArguments(c.bot.provider, c.bot, profile), cwd: c.bot.workspace, env: { ...c.env, ...(bridge?.env ?? {}) }, signal: c.signal, spawnProcess: c.options.spawnProcess,
    onNotification({ method, params: p = {} }) {
      if (!projecting || method !== 'session/update' || (sessionId && p.sessionId && p.sessionId !== sessionId)) return;
      const u = p.update ?? {};
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) c.frame({ type: 'delta', text: u.content.text });
      else if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.text) c.frame({ type: 'reasoning', text: u.content.text });
      // The strict profile only advertises Strata MCP calls. Their cards/results come from the host's
      // executeTool ledger; projecting ACP's second copy would duplicate history on Mac and iPhone.
      else if (u.sessionUpdate === 'usage_update') c.frame({ type: 'stats', tokensIn: u.used ?? u.inputTokens ?? 0, tokensOut: u.outputTokens ?? 0 });
    },
    async onRequest({ id, method, params: p = {} }, process) {
      if (method !== 'session/request_permission') { process.reject(id, 'Strata does not expose direct filesystem or terminal RPC; use its MCP tools.'); return; }
      // The profile excludes built-ins. Acknowledging a Strata MCP transport request is not permission
      // to execute it: the host's executeTool broker is the sole action/approval owner.
      const title = String(p.toolCall?.title ?? '');
      const known = c.tools.some(tool => title === tool.name || title.includes(`mcp__strata__${tool.name}`) || title.includes(`strata__${tool.name}`) || title.includes(`strata: ${tool.name}`) || title.includes(`strata.${tool.name}`));
      // ACP classifies MCP tools by their effect (including edit/read/execute), so kind is not identity.
      const allow = known;
      if (!allow) c.frame(toolCard(safeId(`${c.bot.provider}_${id}`), title || 'Unexpected provider tool', p.toolCall?.rawInput ?? {}, 'denied', 'Use the provided Strata tools.'));
      const choice = (p.options ?? []).find(o => o.kind === (allow ? 'allow_once' : 'reject_once'));
      process.respond(id, { outcome: choice ? { outcome: 'selected', optionId: choice.optionId } : { outcome: 'cancelled' } });
    }, onClose: error => terminated.reject(error),
  });
  try {
    const init = await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'strata', version: '0.2.1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    let configOptions;
    if (c.checkpoint?.nativeSessionId) {
      if (!init.agentCapabilities?.loadSession) throw new Error(`${c.bot.provider} does not support restoring native sessions. Start a new chat; your Strata history is preserved.`);
      sessionId = c.checkpoint.nativeSessionId; const loaded = await rpc.request('session/load', { sessionId, cwd: c.bot.workspace, mcpServers: bridge ? [bridge.acp] : [] }); configOptions = loaded.configOptions;
    } else { const session = await rpc.request('session/new', { cwd: c.bot.workspace, mcpServers: bridge ? [bridge.acp] : [] }); sessionId = session.sessionId; configOptions = session.configOptions; }
    if (!sessionId) throw new Error(`${c.bot.provider} returned no ACP session id.`); await c.save(sessionId);
    if (c.bot.effort) {
      const option = configOptions?.find(option => option.category === 'thought_level');
      const values = option?.options?.flatMap(item => Array.isArray(item.options) ? item.options : [item]) ?? [];
      if (!option || !values.some(item => item.value === c.bot.effort)) throw new Error('This ACP model did not advertise the selected effort. Choose Provider default.');
      const result = await rpc.request('session/set_config_option', { sessionId, configId: option.id, value: c.bot.effort });
      if (result.configOptions?.find(item => item.id === option.id)?.currentValue !== c.bot.effort) throw new Error('The ACP provider did not confirm the selected effort. No model prompt was sent.');
    }
    projecting = true;
    const result = await Promise.race([rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${c.bot.instructions ? `Bot instructions:\n${c.bot.instructions}\n\n` : ''}${c.prompt}` }] }, c.options.runTimeoutMs ?? 30 * 60_000), terminated.promise]);
    if (result.stopReason && result.stopReason !== 'end_turn') throw new Error(`${c.bot.provider} stopped: ${result.stopReason}`);
    if (result.usage) c.frame({ type: 'stats', tokensIn: result.usage.inputTokens ?? 0, tokensOut: result.usage.outputTokens ?? 0 });
  } finally { projecting = false; try { await rpc.close(); } finally { await bridge?.close(); } }
}

export async function* readSse(body) {
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 8 * 1024 * 1024) throw new Error('Ollama stream frame exceeded the size limit.');
    for (let match; (match = /\r?\n\r?\n/.exec(buffer));) {
      const packet = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      const data = packet.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue; yield JSON.parse(data);
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim(); if (tail.startsWith('data:') && tail.slice(5).trim() !== '[DONE]') yield JSON.parse(tail.slice(5).trim());
}
async function runOllama(c) {
  const key = c.bot.providerSettings?.apiKey || c.env.OLLAMA_API_KEY;
  const base = new URL(c.bot.providerSettings?.baseURL || (key ? 'https://ollama.com/v1/' : 'http://127.0.0.1:11434/v1/'));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) throw new Error('Use HTTPS for Ollama Cloud, or the local Ollama daemon.');
  if (base.username || base.password || base.search || base.hash) throw new Error('Ollama endpoint must not contain credentials, a query, or a fragment.');
  if (!loopback && !key) throw new Error('Set OLLAMA_API_KEY on the Mac host to use Ollama Cloud.');
  if (!c.bot.model) throw new Error('Choose an Ollama Cloud model.');
  if (!key && !/(?:cloud|remote)/i.test(c.bot.model)) throw new Error('Choose the cloud model alias installed in your signed-in local Ollama daemon. Local Maya and Strata models remain separate.');
  const model = loopback ? c.bot.model : c.bot.model.replace(/(?::cloud|-cloud)$/, '');
  const endpoint = new URL('chat/completions', `${base.href.replace(/\/$/, '')}/`);
  const messages = [{ role: 'system', content: c.bot.instructions || 'You are a Strata bot. Use the provided tools for coding and computer tasks.' }, ...c.history.filter(h => ['user', 'assistant'].includes(h.role)).map(h => ({ role: h.role, content: historyContent(h) })), { role: 'user', content: c.message }];
  // Ollama is stateless; Strata owns history, tool results, and retry decisions. Never automatically replay a mutation.
  let totalIn = 0, totalOut = 0;
  for (let round = 0; round < 32; round++) {
    c.signal.throwIfAborted();
    const response = await c.fetcher(endpoint, { method: 'POST', signal: c.signal, redirect: 'error', headers: { 'Content-Type': 'application/json', ...(!loopback && key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, messages, ...(c.tools.length ? { tools: c.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}) }) });
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${response.status === 401 || response.status === 403 ? 'Sign in or configure the host API key.' : 'The request failed. Check the model and endpoint.'}`);
    if (!response.body) throw new Error('Ollama returned no response stream.');
    const calls = new Map(); let content = '', finish = null;
    for await (const event of readSse(response.body)) {
      if (event.error) throw new Error(event.error.message ?? 'Ollama stream failed.');
      const choice = event.choices?.[0], delta = choice?.delta ?? {};
      if (delta.content) { content += delta.content; c.frame({ type: 'delta', text: delta.content }); }
      if (delta.reasoning || delta.reasoning_content || delta.thinking) c.frame({ type: 'reasoning', text: delta.reasoning ?? delta.reasoning_content ?? delta.thinking });
      for (const part of delta.tool_calls ?? []) { const call = calls.get(part.index ?? 0) ?? { id: part.id ?? randomUUID(), type: 'function', function: { name: '', arguments: '' } }; if (part.id) call.id = part.id; if (part.function?.name) call.function.name += part.function.name; if (part.function?.arguments) call.function.arguments += part.function.arguments; calls.set(part.index ?? 0, call); }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (event.usage) { totalIn += event.usage.prompt_tokens ?? 0; totalOut += event.usage.completion_tokens ?? 0; c.frame({ type: 'stats', tokensIn: totalIn, tokensOut: totalOut }); }
    }
    if (!finish) throw new Error('Ollama stream ended before a completion marker.');
    if (!calls.size) { if (!['stop', 'end_turn'].includes(finish)) throw new Error(`Ollama stopped: ${finish}.`); await c.save(null); return; }
    messages.push({ role: 'assistant', content, tool_calls: [...calls.values()] });
    for (const call of calls.values()) {
      let args; try { args = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('Ollama returned malformed tool arguments.'); }
      const result = await c.execute(call.function.name, args, safeId(call.id));
      messages.push({ role: 'tool', tool_call_id: call.id, content: textResult(result) });
      const images = result.content.filter(item => item.type === 'image');
      if (images.length) messages.push({ role: 'user', content: [{ type: 'text', text: `Images returned by ${call.function.name}:` }, ...images.map(item => ({ type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.data}` } }))] });
    }
  }
  throw new Error('The bot reached its 32-step limit. Continue in this chat to proceed.');
}
