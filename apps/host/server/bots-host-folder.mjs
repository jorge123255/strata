/** Explicit file-only access from an isolated bot to one owner-selected host folder. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./bots-host-folder.py', import.meta.url));
const limit = 2 * 1024 * 1024;
const fault = (status, message) => Object.assign(new Error(message), { status });
const stopped = () => Object.assign(new Error('The bot was stopped.'), { name: 'AbortError' });
const result = text => ({ content: [{ type: 'text', text }] });
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fault(400, 'Choose valid host folder settings or arguments.');
};
export function normalizeBotHostFolder(input) {
  if (input === null || input === undefined) return null;
  keys(input, ['path', 'access']);
  if (typeof input.path !== 'string' || !input.path || Buffer.byteLength(input.path) > 4000 || /[\u0000-\u001f\u007f]/.test(input.path) || !isAbsolute(input.path) || normalize(input.path) === '/') throw fault(400, 'Choose a specific absolute host folder, not the filesystem root.');
  if (!['read', 'read-write'].includes(input.access)) throw fault(400, 'Choose read-only or read-write host folder access.');
  return { path: input.path, access: input.access };
}
function executionScope(execution) {
  if (execution?.kind === 'local') return ['local'];
  if (execution?.kind === 'ssh' && typeof execution.host === 'string' && (execution.user === undefined || typeof execution.user === 'string')) return ['ssh', execution.host, execution.user ?? '', execution.port ?? null];
  throw fault(409, 'This host folder belongs to an unavailable execution computer.');
}
function validBinding(value) { return value && typeof value.device === 'string' && /^\d+$/.test(value.device) && typeof value.inode === 'string' && /^\d+$/.test(value.inode); }
function authorityKey(value) {
  if (!value || !value.grant || !validBinding(value.binding) || typeof value.ownerId !== 'string' || !value.ownerId || typeof value.revision !== 'string' || !value.revision) throw fault(409, 'Select the host folder again before using it in a new chat.');
  const grant = normalizeBotHostFolder(value.grant), scope = executionScope(value.execution);
  if (scope[0] === 'ssh' && !/^[a-f0-9]{64}$/.test(value.remoteIdentity ?? '')) throw fault(409, 'Check this remote host folder again before using it.');
  return JSON.stringify([grant.path, grant.access, value.binding.device, value.binding.inode, value.ownerId, value.revision, scope, value.remoteIdentity ?? null]);
}
export function botHostFolderAuthority(bot) {
  if (!bot?.hostFolder) return null;
  return { grant: structuredClone(bot.hostFolder), binding: structuredClone(bot.hostFolderBinding), execution: structuredClone(bot.execution), ownerId: bot.hostFolderOwnerId ?? bot.computerOwnerId ?? bot.id, revision: bot.hostFolderRevision, ...(bot.hostFolderRemoteIdentity ? { remoteIdentity: bot.hostFolderRemoteIdentity } : {}) };
}
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise((resolve, reject) => {
    const abort = () => reject(stopped()); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** The helper uses directory descriptors and O_NOFOLLOW, including the atomic rename. */
export function runBotHostFolderOperation(input, { python = 'python3', signal, authorize = async () => true, timeoutMs = 30000, spawnProcess = spawn } = {}) {
  if (signal?.aborted) return Promise.reject(stopped());
  if (process.platform === 'win32') return Promise.reject(fault(503, 'Scoped host folders require a Mac or Linux execution computer.'));
  const request = JSON.stringify(input);
  if (Buffer.byteLength(request) > 16 * 1024 * 1024) return Promise.reject(fault(400, 'This host folder request is too large.'));
  return new Promise((resolve, reject) => {
    const child = spawnProcess(python, ['-I', '-B', helper], { shell: false, detached: true, env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', bytes = 0, received, failure, ready = 0, done = false, force, grace;
    const kill = () => { if (done) return; try { process.kill(-child.pid, 'SIGTERM'); } catch {} force ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 250); force.unref?.(); };
    const fail = error => { if (done) return; failure ??= error; kill(); };
    const deny = error => { if (done) return; failure ??= error; child.stdin.end(`${JSON.stringify({ authorized: false })}\n`); grace ??= setTimeout(kill, 250); grace.unref?.(); };
    const abort = () => deny(stopped());
    const timer = setTimeout(() => deny(fault(504, 'The host folder request timed out.')), timeoutMs); timer.unref?.();
    child.stdin.on('error', () => {}); child.stdout.setEncoding('utf8');
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) fail(fault(503, 'The host folder helper returned too much output.')); });
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk); buffer += chunk;
      if (bytes > 8 * 1024 * 1024) return fail(fault(503, 'The host folder helper returned too much output.'));
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let value; try { value = JSON.parse(line); } catch { fail(fault(503, 'The host folder helper returned invalid data.')); continue; }
        if (value.ready === true && input.operation !== 'validate' && (ready === 0 && value.phase === 'access' || ready === 1 && input.operation === 'host_write_file' && value.phase === 'commit')) {
          ready++;
          Promise.resolve().then(() => authorize()).then(allowed => {
            if (allowed !== true) throw fault(403, 'Host folder access was revoked.');
            if (!done && !failure && !signal?.aborted) child.stdin[ready === 1 && input.operation === 'host_write_file' ? 'write' : 'end'](`${JSON.stringify({ authorized: true })}\n`);
          }).catch(deny);
        } else if (value.error && typeof value.error === 'string') failure ??= fault(409, value.error);
        else if (Object.hasOwn(value, 'result') && received === undefined) received = value.result;
        else fail(fault(503, 'The host folder helper returned an unexpected response.'));
      }
    });
    const cleanup = () => { done = true; clearTimeout(timer); clearTimeout(force); clearTimeout(grace); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { cleanup(); reject(fault(503, 'The host folder helper could not start. A supported Python 3 is required on the execution computer.')); });
    child.once('close', code => { cleanup(); if (failure) reject(failure); else if (code !== 0 || received === undefined || buffer.trim() || input.operation !== 'validate' && ready !== (input.operation === 'host_write_file' ? 2 : 1)) reject(fault(503, 'The host folder helper did not confirm the operation.')); else resolve(received); });
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.write(`${request}\n`);
    if (input.operation === 'validate') child.stdin.end();
    if (signal?.aborted) abort();
  });
}

const definitions = [
  { name: 'host_list_files', description: 'List one folder inside the owner-granted host folder. This is file access on the execution host, not a guest mount or host shell.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Grant-relative directory; default .' } }, additionalProperties: false } },
  { name: 'host_read_file', description: 'Read a UTF-8 text file, at most 1 MB, inside the owner-granted host folder.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Grant-relative file path' } }, required: ['path'], additionalProperties: false } },
  { name: 'host_write_file', description: 'Atomically create or replace a UTF-8 text file, at most 2 MB, inside the owner-granted read-write host folder. Requires permission in Manual mode; unavailable in Plan mode.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Grant-relative file path' }, content: { type: 'string', description: 'Complete UTF-8 file content' } }, required: ['path', 'content'], additionalProperties: false } },
];
export function createBotHostFolderTools({ python = 'python3', currentGrant = () => null, remoteSSH, operation = runBotHostFolderOperation } = {}) {
  const inFlight = new Map(), uncertain = new Map(), chatScopes = new Map(); let closed = false;
  const cleanupFailure = error => error?.cleanupUnconfirmed || error?.code === 'ssh_cleanup_unconfirmed';
  const owns = name => definitions.some(tool => tool.name === name);
  const tools = bot => bot?.computerMode !== 'cua' || !bot.hostFolder ? [] : structuredClone(definitions.filter(tool => tool.name !== 'host_write_file' || bot.hostFolder.access === 'read-write' && bot.policy !== 'plan'));
  async function validate(input, { execution = { kind: 'local' }, expectedIdentity, signal } = {}) {
    const grant = normalizeBotHostFolder(input); if (!grant) return null;
    const scope = executionScope(execution);
    const value = scope[0] === 'local' ? await operation({ operation: 'validate', grant }, { python, signal }) : await remote(execution, { operation: 'validate', grant, ...(expectedIdentity ? { expectedIdentity } : {}) }, { signal });
    if (!value || !validBinding(value.binding) || value.access !== grant.access || typeof value.path !== 'string' || !normalizeBotHostFolder({ path: value.path, access: value.access }) || scope[0] === 'ssh' && !/^[a-f0-9]{64}$/.test(value.remoteIdentity ?? '')) throw fault(503, 'The execution computer could not verify this host folder.');
    return value;
  }
  function remote(execution, payload, options) {
    if (typeof remoteSSH?.hostFolder !== 'function') throw fault(503, 'Prepare the updated Bots worker on this SSH computer before granting a host folder.');
    return remoteSSH.hostFolder(execution, payload, options);
  }
  async function executeOne(name, args, context) {
    const scope = JSON.stringify(executionScope(context.bot.execution));
    const unknown = [...uncertain.values()].find(value => JSON.stringify(executionScope(value.execution)) === scope);
    if (unknown) throw unknown.error;
    if (!owns(name) || !tools(context.bot).some(tool => tool.name === name)) throw fault(403, 'This host folder tool is not enabled for this bot or permission mode.');
    keys(args, name === 'host_write_file' ? ['path', 'content'] : ['path']);
    if (name !== 'host_list_files' && typeof args.path !== 'string') throw fault(400, 'Choose a relative host file path.');
    if (name === 'host_write_file' && (typeof args.content !== 'string' || Buffer.byteLength(args.content) > limit)) throw fault(400, 'Write a UTF-8 text file of at most 2 MB.');
    const snapshot = botHostFolderAuthority(context.bot), expected = authorityKey(snapshot);
    const assertAuthority = async () => {
      if (context.signal?.aborted) throw stopped(); context.assertLive?.();
      const current = await abortable(Promise.resolve(currentGrant(context.bot)), context.signal);
      if (!current || authorityKey(current) !== expected) throw fault(403, 'Host folder access changed or was revoked. Start a new chat after reviewing its settings.');
      if (context.signal?.aborted) throw stopped(); context.assertLive?.();
      return true;
    };
    await assertAuthority();
    const id = context.toolCallId || `host_folder_${randomUUID()}`, started = Date.now();
    const card = { id, name, args, preview: name.replaceAll('_', ' '), effect: name === 'host_write_file' ? 'Write granted host file' : 'Read granted host folder', scope: 'connected' };
    const emit = (state, text) => context.onFrame?.({ type: 'agent-tool', tool: { ...card, state, ...(text ? { result: text.slice(0, 24000) } : {}), durationMs: Date.now() - started } });
    try {
      if (name === 'host_write_file' && context.bot.policy !== 'bypass') {
        const allowed = await abortable(Promise.resolve(context.requestPermission?.({ id, name, args, reason: `Write ${args.path} inside the granted host folder ${snapshot.grant.path}?` })), context.signal);
        await assertAuthority();
        if (allowed !== true) { emit('denied', 'The host file write was not allowed.'); return { ...result('The host file write was not allowed. Do not retry it.'), isError: true }; }
      }
      await assertAuthority(); emit('running');
      const input = { operation: name, grant: snapshot.grant, binding: snapshot.binding, args };
      const value = snapshot.execution.kind === 'local'
        ? await operation(input, { python, signal: context.signal, authorize: assertAuthority })
        : await remote(snapshot.execution, { ...input, expectedIdentity: snapshot.remoteIdentity }, { signal: context.signal, authorize: assertAuthority });
      await assertAuthority();
      if (!value || typeof value.text !== 'string') throw fault(503, 'The execution computer did not confirm host folder access.');
      emit('done', value.text); return result(value.text);
    } catch (error) { emit('error', error.message); throw error; }
  }
  function execute(name, args, context) {
    if (closed) return Promise.reject(fault(503, 'Host folder tools are closed.'));
    const controller = new AbortController(), abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true }); if (context.signal?.aborted) abort();
    const entry = { controller, execution: structuredClone(context.bot.execution), remoteIdentity: context.bot.hostFolderRemoteIdentity, ownerId: context.bot.hostFolderOwnerId ?? context.bot.computerOwnerId ?? context.bot.id, promise: null };
    const chatId = context.chatId; chatScopes.set(chatId, JSON.stringify(executionScope(context.bot.execution))); if (!inFlight.has(chatId)) inFlight.set(chatId, new Set());
    const calls = inFlight.get(chatId); calls.add(entry);
    entry.promise = Promise.resolve().then(() => executeOne(name, args, { ...context, signal: controller.signal }));
    entry.promise.catch(error => { if (cleanupFailure(error) && ![...uncertain.values()].some(value => JSON.stringify(executionScope(value.execution)) === JSON.stringify(executionScope(entry.execution)))) uncertain.set(chatId, { ownerId: entry.ownerId, execution: entry.execution, remoteIdentity: entry.remoteIdentity, error }); });
    entry.promise.finally(() => { context.signal?.removeEventListener('abort', abort); calls.delete(entry); if (!calls.size) inFlight.delete(chatId); }).catch(() => {});
    return entry.promise;
  }
  async function revoke(ownerId) {
    const owned = [...inFlight.values()].flatMap(calls => [...calls]).filter(entry => entry.ownerId === ownerId);
    for (const entry of owned) entry.controller.abort();
    await Promise.allSettled(owned.map(entry => entry.promise));
    const failure = [...uncertain.values()].find(value => value.ownerId === ownerId); if (failure) throw failure.error;
  }
  function recover(execution, status) {
    const scope = JSON.stringify(executionScope(execution));
    const matching = value => JSON.stringify(executionScope(value.execution)) === scope;
    if ([...inFlight.values()].some(calls => [...calls].some(matching))) throw fault(409, 'Finish this execution computer’s host folder actions before checking cleanup.');
    const records = [...uncertain.entries()].filter(([, value]) => matching(value));
    if (!records.length) return { recovered: 0 };
    if (execution.kind === 'local') {
      if (records.length) throw fault(503, 'Local host folder cleanup remains unconfirmed. Close Strata after its work stops before trying again.');
      return { recovered: 0 };
    }
    if (status?.available !== true || status?.prepared !== true || status?.activeRuns !== 0 || !/^[a-f0-9]{64}$/.test(status?.identity ?? '')) throw fault(409, 'The exact SSH computer must report ready and idle before host folder cleanup can be recovered.');
    if (records.some(([, value]) => value.remoteIdentity !== status.identity)) throw fault(409, 'This SSH alias reaches a different computer or account. Its previous host folder cleanup remains unconfirmed.');
    for (const [chatId] of records) uncertain.delete(chatId);
    return { recovered: records.length };
  }
  return { owns, tools, definitions: tools, validate, execute, revoke, recover,
    async finish(chatId) { await Promise.allSettled([...(inFlight.get(chatId) ?? [])].map(entry => entry.promise)); const failure = uncertain.get(chatId) ?? [...uncertain.values()].find(value => JSON.stringify(executionScope(value.execution)) === chatScopes.get(chatId)); if (failure) throw failure.error; chatScopes.delete(chatId); },
    async close() { closed = true; const entries = [...inFlight.values()].flatMap(calls => [...calls]); for (const entry of entries) entry.controller.abort(); await Promise.allSettled(entries.map(entry => entry.promise)); if (uncertain.size) throw uncertain.values().next().value.error; } };
}
