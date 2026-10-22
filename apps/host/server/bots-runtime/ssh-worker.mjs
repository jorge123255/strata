/** One SSH channel owns one remote turn, its tools and all provider children. */
import { mkdir, access, open, lstat, readFile, readdir, writeFile, rename, unlink, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { createBotRuntime, normalizeTools } from './index.mjs';
import { botExecutionInstructions, createBotTools } from '../bots-tools.mjs';
import { findBrowser } from '../agent/browser-probe.mjs';
import { redact } from './process.mjs';
import { createCreatedCommandTools } from './created-tools.mjs';
import { createBotActionJournal, botActionTurnIdentity } from '../bots-action-journal.mjs';

const text = message => ({ content: [{ type: 'text', text: message }], isError: true });
const identity = () => createHash('sha256').update(JSON.stringify([hostname(), process.getuid?.(), homedir()])).digest('hex');
const cuaKey = bot => `cua_${createHash('sha256').update(String(bot.computerOwnerId ?? bot.id)).digest('hex')}`;
const cuaMarker = (directory, bot) => join(directory, 'uncertain', `${cuaKey(bot)}.json`);
async function requireCUACleanup(directory, bot) {
  try { await lstat(cuaMarker(directory, bot)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Object.assign(new Error('This bot’s CUA command cleanup is unconfirmed. Stop its isolated computer before continuing.'), { code: 'cua_cleanup_unconfirmed', cleanupUnconfirmed: true });
}
async function markCUAUncertain(directory, bot) {
  await mkdir(join(directory, 'uncertain'), { recursive: true, mode: 0o700 });
  await writeFile(cuaMarker(directory, bot), JSON.stringify({ at: new Date().toISOString() }), { mode: 0o600 });
}
async function clearCUAUncertain(directory, bot) { await rm(cuaMarker(directory, bot), { force: true }); }
async function cleanupSteps(steps, cua, initialFailure) {
  let confirmed = true, guestConfirmed = !(cua && initialFailure?.cleanupUnconfirmed), failure = initialFailure;
  for (const step of steps) {
    try { await step(); }
    catch (error) { if (cua && error.cleanupUnconfirmed) guestConfirmed = false; else confirmed = false; failure = error; }
  }
  return { confirmed, guestConfirmed, failure };
}
export async function activeRemoteRuns(directory) {
  const folder = join(directory, 'runs'); let files;
  try { files = await readdir(folder); } catch (error) { if (error.code === 'ENOENT') return 0; return null; }
  if (files.length > 10_000) return null;
  let count = 0;
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    try {
      const path = join(folder, name), s = await lstat(path); if (!s.isFile() || s.isSymbolicLink() || s.size > 4096) return null;
      const row = JSON.parse(await readFile(path, 'utf8')); if (!Number.isInteger(row.pid) || row.pid < 1) return null;
      try { process.kill(row.pid, 0); count++; } catch (error) { if (error.code !== 'ESRCH') count++; }
    } catch { return null; }
  }
  return count;
}
export async function acquireComputerLease(directory, { key = 'computer', processExists = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } } } = {}) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(key)) throw new Error('Invalid remote computer lease.');
  const folder = join(directory, 'leases'); await mkdir(folder, { recursive: true, mode: 0o700 });
  const parent = await lstat(folder); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('The remote computer lease directory is not private.');
  const path = join(folder, `${key}.lock`), nonce = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600), owner = { pid: process.pid, nonce };
      await file.writeFile(JSON.stringify(owner)); const original = await file.stat(); await file.close();
      return async () => { try { const current = await lstat(path); if (current.ino === original.ino && JSON.parse(await readFile(path, 'utf8')).nonce === nonce) await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const original = await lstat(path); if (!original.isFile() || original.isSymbolicLink() || original.size > 4096) throw new Error('The remote computer lease must be repaired before use.');
      let previous; try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Another remote worker is acquiring this computer. Try again shortly.'); }
      if (!Number.isInteger(previous.pid) || previous.pid < 1 || typeof previous.nonce !== 'string' || processExists(previous.pid)) throw new Error('Another Bots worker is using this execution computer. Wait for it to finish.');
      const current = await lstat(path); const value = JSON.parse(await readFile(path, 'utf8'));
      if (current.ino !== original.ino || value.nonce !== previous.nonce || processExists(previous.pid)) continue;
      const stale = `${path}.stale-${randomUUID()}`; await rename(path, stale); await rm(stale, { force: true });
    }
  }
  throw new Error('Another Bots worker is acquiring this execution computer. Try again shortly.');
}
async function browserInfo() {
  const installed = findBrowser(); if (installed.found) return installed;
  try { const { chromium } = await import('playwright-core'); const path = chromium.executablePath(); await access(path); return { found: true, name: 'Chromium', path }; } catch { return { found: false, name: null, path: null }; }
}
export async function probeWorker({ directory }) {
  const runtime = createBotRuntime({ stateDir: join(directory, 'runtime') });
  let cua;
  try { const factory = (await import('../bots-cua.mjs')).createBotCUATools({ directory }); try { cua = await factory.probe(); } finally { await factory.close(); } } catch { cua = { available: false, detail: 'CUA is not prepared on this account.' }; }
  try { return { platform: process.platform, nodeVersion: process.versions.node, identity: identity(), activeRuns: await activeRemoteRuns(directory), providers: await runtime.providers(), browser: await browserInfo(), cua, desktop: { supported: process.platform === 'darwin', detail: process.platform === 'darwin' ? 'Desktop control requires Screen Recording and Accessibility permission for the remote account.' : 'Native desktop controls currently require macOS. Coding and a headless browser run on this computer.' }, detail: 'The private Bots worker is ready. Provider accounts belong to this SSH account.' }; }
  finally { await runtime.close(); }
}
export async function startWorker(input, options = {}) {
  try { return await startWorkerTurn(input, options); }
  catch (error) { options.send({ type: 'cleanup', confirmed: true }); options.send({ type: 'failure', code: error.code === 'cua_cleanup_unconfirmed' ? error.code : 'ssh_worker_setup', message: redact(error) }); options.reader.close(); }
}
async function startWorkerTurn(input, { reader, send, directory, leaseMs = 12000, toolFactory = createBotTools, cuaFactory, runtimeFactory = createBotRuntime } = {}) {
  if (!input?.bot || !input?.sessionId || input.bot.execution?.kind !== 'ssh') throw new Error('A remote bot and conversation are required.');
  const suppliedScope = input.harnessActionScope;
  if (suppliedScope !== undefined && (!suppliedScope || Object.keys(suppliedScope).some(key => !['turnId', 'authority'].includes(key)) || !/^[a-f0-9]{64}$/.test(suppliedScope.turnId ?? '') || !/^[a-f0-9]{64}$/.test(suppliedScope.authority ?? ''))) throw new Error('The action recovery scope is invalid.');

  if (input.bot.teamConversationOnly !== undefined && typeof input.bot.teamConversationOnly !== 'boolean') throw new Error('The team conversation mode is invalid.');
  // This flag is frozen by the owning host job. A conversation invitation must
  // not reconstruct local tools or acquire/clean up an unrelated CUA desktop.
  const conversationOnly = input.bot.teamConversationOnly === true;
  if (input.bot.providerSettings?.apiKey) throw new Error('Provider credentials cannot be transferred to a remote Bots worker.');
  const remoteIdentity = identity();
  if (input.expectedIdentity && input.expectedIdentity !== remoteIdentity) throw new Error('The SSH alias now reaches a different computer or account. Start a new bot chat.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Guests are exclusive for their turn. Direct host work acquires the physical
  // desktop only if it actually uses a computer tool; code and each bot's
  // browser remain independent, including shared-team work on this account.
  const release = !conversationOnly && input.bot.computerMode === 'cua' ? await acquireComputerLease(directory, { key: cuaKey(input.bot) }) : null;
  if (!conversationOnly && input.bot.computerMode === 'cua') { try { await requireCUACleanup(directory, input.bot); } catch (error) { await release(); throw error; } }
  const runs = join(directory, 'runs'); await mkdir(runs, { recursive: true, mode: 0o700 });
  const nonce = randomUUID(), record = join(runs, `${process.pid}-${nonce}.json`);
  await writeFile(record, JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  send({ type: 'identity', value: remoteIdentity });
  const controller = new AbortController(), pending = new Map(), inFlight = new Set();
  let revoked = false, stopping = false, next = 0, lastBeat = Date.now(), cleanupConfirmed = false;
  const signal = controller.signal;
  const write = value => { if (!revoked || ['result', 'failure', 'cleanup'].includes(value.type)) send(value); };
  const ask = (kind, value) => {
    if (revoked || signal.aborted) return Promise.reject(new Error('The remote bot was stopped.'));
    const id = `remote_${++next}`;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); write({ type: kind, id, value }); });
  };
  const abort = () => { if (stopping) return; stopping = true; revoked = true; controller.abort(); for (const p of pending.values()) p.reject(new Error('The remote bot was stopped.')); pending.clear(); };
  const onLine = line => {
    let message; try { message = JSON.parse(line); } catch { abort(); return; }
    if (message.type === 'heartbeat') { lastBeat = Date.now(); return; }
    if (message.type === 'cancel') { abort(); return; }
    if (revoked || message.type !== 'reply') return;
    const p = pending.get(message.id); if (!p) return; pending.delete(message.id);
    message.error ? p.reject(new Error(redact(message.error))) : p.resolve(message.value);
  };
  reader.on('line', onLine); reader.once('close', abort);
  process.once('SIGHUP', abort); process.once('SIGTERM', abort);
  const lease = setInterval(() => { if (Date.now() - lastBeat > leaseMs) abort(); }, Math.min(1000, leaseMs / 3));
  let tools, runtime;
  const bot = { ...input.bot, execution: { kind: 'local' }, providerSettings: input.bot.providerSettings?.baseURL ? { baseURL: input.bot.providerSettings.baseURL } : undefined };
  const emit = frame => write({ type: 'frame', value: frame });
  const mirroredComputerReceipt = value => !(input.hostTools ?? []).some(tool => tool.name === value.toolName);
  const journal = createBotActionJournal({ directory: join(directory, 'action-receipts'), onRecord: value => { if (mirroredComputerReceipt(value)) write({ type: 'harness-action', value: { ...value, executionScopeProof: createHash('sha256').update(JSON.stringify([input.sessionId, suppliedScope?.turnId ?? botActionTurnIdentity({ messages: input.history ?? [] }, input.message), suppliedScope?.authority ?? createHash('sha256').update(JSON.stringify(input.bot)).digest('hex')])).digest('hex') } }); } });
  const actionScope = { chatId: input.sessionId, turnId: suppliedScope?.turnId ?? botActionTurnIdentity({ messages: input.history ?? [] }, input.message), authority: suppliedScope?.authority ?? createHash('sha256').update(JSON.stringify(input.bot)).digest('hex'), signal, origin: 'ssh-worker' };
  let failure, result;
  try {
    for (const receipt of journal.summary(input.sessionId).actions.filter(mirroredComputerReceipt)) write({ type: 'harness-action', value: receipt });
    if (!conversationOnly) {
      const browser = await browserInfo();
      const createTools = bot.computerMode === 'cua' ? cuaFactory ?? (await import('../bots-cua.mjs')).createBotCUATools : toolFactory;
      tools = createTools({ directory, browserProbe: () => browser, browserHeadless: process.platform === 'linux' || !process.env.DISPLAY && process.platform !== 'darwin', ...(bot.computerMode === 'cua' ? {} : { acquireDesktopLease: () => acquireComputerLease(directory) }) });
      if ((input.hostTools ?? []).some(tool => tool.name === 'authorize_created_tool')) tools = createCreatedCommandTools(tools, { authorize: (args, options) => ask('requestHostTool', { name: 'authorize_created_tool', args, toolCallId: options.toolCallId }) });
    }
    runtime = runtimeFactory({ stateDir: join(directory, 'runtime') });
    signal.throwIfAborted();
    const allow = async request => { signal.throwIfAborted(); if (conversationOnly) return false; const approved = await ask('permission', request); signal.throwIfAborted(); return approved === true; };
    const hostTools = normalizeTools(input.hostTools ?? []);
    const localDefinitions = conversationOnly ? [] : tools.definitions(bot).filter(tool => bot.computerMode === 'cua' || process.platform === 'darwin' || !tool.name.startsWith('computer_'));
    if (hostTools.length > 32 || hostTools.some(tool => localDefinitions.some(local => local.name === tool.name))) throw new Error('The host tool catalog is invalid.');
    // Describe the actual worker catalog, including this platform's desktop
    // filter, rather than the host Mac's catalog. Conversation-only turns must
    // keep their existing tool-less computer boundary.
    const executionInstructions = conversationOnly ? '' : botExecutionInstructions(bot, localDefinitions);
    const runtimeBot = executionInstructions ? { ...bot, instructions: [bot.instructions, executionInstructions].filter(Boolean).join('\n\n') } : bot;
    const hostNames = new Set(hostTools.map(tool => tool.name));
    const execute = (name, args, toolCallId) => {
      signal.throwIfAborted();
      if (conversationOnly && !hostNames.has(name)) return Promise.reject(new Error('A team conversation cannot use local or computer tools.'));
      let started = false, denied = false;
      const toolFrame = frame => { if (frame.type === 'agent-tool') { if (frame.tool?.state === 'running') started = true; if (frame.tool?.state === 'denied') denied = true; } emit(frame); };
      const promise = journal.execute({ ...actionScope, name, args, toolCallId, noEffect: () => !hostNames.has(name) && denied && !started }, () => hostNames.has(name) ? ask('requestHostTool', { name, args, toolCallId }) : tools.execute({ bot, chatId: input.sessionId, name, args, toolCallId, signal, onFrame: toolFrame, requestPermission: allow, toolDefinitions: localDefinitions }));
      inFlight.add(promise); promise.finally(() => inFlight.delete(promise)).catch(() => {}); return promise;
    };
    result = await runtime.run({ bot: runtimeBot, sessionId: input.sessionId, message: input.message, history: input.history ?? [], checkpoint: conversationOnly ? null : input.checkpoint, signal, onFrame: frame => { if (frame.type !== 'done' && frame.type !== 'error') emit(frame); },
      tools: [...localDefinitions, ...hostTools], executeTool: execute, requestPermission: allow,
      modelRequest: payload => ask('requestModel', payload), onCheckpoint: checkpoint => { if (!conversationOnly) write({ type: 'checkpoint', value: checkpoint }); } });
  } catch (error) { failure = error; }
  finally {
    const wasCancelled = signal.aborted;
    abort();
    const cleanup = await cleanupSteps([
      () => runtime?.close(), () => Promise.allSettled([...inFlight]), () => tools?.finish?.(input.sessionId), () => tools?.close(),
    ], !conversationOnly && bot.computerMode === 'cua', failure);
    cleanupConfirmed = cleanup.confirmed; failure = cleanup.failure;
    if (!cleanup.guestConfirmed) { try { await markCUAUncertain(directory, bot); } catch { cleanupConfirmed = false; } }
    const released = await cleanupSteps([() => release?.(), async () => { if (JSON.parse(await readFile(record, 'utf8')).nonce === nonce) await unlink(record); }], false);
    if (!released.confirmed) { cleanupConfirmed = false; failure = released.failure; }
    clearInterval(lease); reader.removeListener('line', onLine); reader.removeListener('close', abort); process.removeListener('SIGHUP', abort); process.removeListener('SIGTERM', abort);
    write({ type: 'cleanup', confirmed: cleanupConfirmed, guestCleanupConfirmed: cleanup.guestConfirmed });
    if (!cleanupConfirmed) write({ type: 'failure', code: 'ssh_cleanup_unconfirmed', message: 'The remote worker could not confirm that all of its processes stopped.' });
    else if (!cleanup.guestConfirmed) write({ type: 'failure', code: 'cua_cleanup_unconfirmed', message: 'CUA could not confirm that all sandbox commands stopped. Stop this bot’s isolated computer before continuing.' });
    else if (failure && !wasCancelled) write({ type: 'failure', code: 'ssh_provider', message: redact(failure) });
    else write({ type: 'result', value: { ...(result ?? {}), cancelled: wasCancelled, cleanupConfirmed: true } });
    reader.close();
  }
}

/** A viewer/setup/control request uses the same channel lease, but never starts an inference provider. */
export async function computerOperation(payload, { reader, send, directory, leaseMs = 12000, cuaFactory } = {}) {
  const controller = new AbortController(), signal = controller.signal;
  let lastBeat = Date.now(), factory, release, record, nonce, failure, value, cleanupConfirmed = false;
  const abort = () => controller.abort();
  const line = data => { try { const message = JSON.parse(data); if (message.type === 'heartbeat') lastBeat = Date.now(); else if (message.type === 'cancel') abort(); } catch { abort(); } };
  reader.on('line', line); reader.once('close', abort); process.once('SIGTERM', abort); process.once('SIGHUP', abort);
  const lease = setInterval(() => { if (Date.now() - lastBeat > leaseMs) abort(); }, Math.min(1000, leaseMs / 3));
  try {
    if (!['probe', 'prepare', 'start', 'state', 'control', 'stop'].includes(payload?.operation)) throw new Error('Choose a supported isolated computer action.');
    const bot = payload.bot ? { ...payload.bot, execution: { kind: 'local' } } : undefined;
    if (['start', 'control', 'stop'].includes(payload.operation)) {
      if (!bot?.id) throw new Error('Choose an isolated computer bot.');
      release = await acquireComputerLease(directory, { key: cuaKey(bot) });
      if (payload.operation !== 'stop') await requireCUACleanup(directory, bot);
    }
    if (!['probe', 'state'].includes(payload.operation)) {
      const folder = join(directory, 'runs'); await mkdir(folder, { recursive: true, mode: 0o700 }); nonce = randomUUID(); record = join(folder, `${process.pid}-${nonce}.json`); await writeFile(record, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600, flag: 'wx' });
    }
    const create = cuaFactory ?? (await import('../bots-cua.mjs')).createBotCUATools;
    factory = create({ directory }); signal.throwIfAborted();
    value = await factory[payload.operation]({ ...payload, bot, signal }); signal.throwIfAborted();
  } catch (error) { failure = error; }
  finally {
    const cancelled = signal.aborted; abort();
    const cleanup = await cleanupSteps([() => factory?.close()], true, failure);
    cleanupConfirmed = cleanup.confirmed; failure = cleanup.failure;
    if (!cleanup.guestConfirmed && payload.bot?.id) { try { await markCUAUncertain(directory, payload.bot); } catch { cleanupConfirmed = false; } }
    else if (cleanupConfirmed && !failure && !cancelled && payload.operation === 'stop' && value?.stopped === true && value?.cleanupConfirmed === true) { try { await clearCUAUncertain(directory, payload.bot); } catch (error) { cleanupConfirmed = false; failure = error; } }
    const released = await cleanupSteps([() => release?.(), async () => { if (record && JSON.parse(await readFile(record, 'utf8')).nonce === nonce) await unlink(record); }], false);
    if (!released.confirmed) { cleanupConfirmed = false; failure = released.failure; }
    clearInterval(lease); reader.removeListener('line', line); reader.removeListener('close', abort); process.removeListener('SIGTERM', abort); process.removeListener('SIGHUP', abort);
    send({ type: 'cleanup', confirmed: cleanupConfirmed, guestCleanupConfirmed: cleanup.guestConfirmed });
    if (!cleanupConfirmed) send({ type: 'failure', code: 'ssh_cleanup_unconfirmed', message: 'Could not confirm that the isolated computer operation stopped.' });
    else if (!cleanup.guestConfirmed) send({ type: 'failure', code: 'cua_cleanup_unconfirmed', message: 'CUA could not confirm that all sandbox commands stopped. Stop this bot’s isolated computer before continuing.' });
    else if (failure && !cancelled) send({ type: 'failure', code: 'ssh_cua', message: redact(failure) });
    else send({ type: 'result', value: cancelled ? { cancelled: true } : value });
    reader.close();
  }
}
