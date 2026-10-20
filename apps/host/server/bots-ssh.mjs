/** Private worker over the user's system SSH transport. No model credentials or local tools cross it. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SSH_BOTS_COMMAND } from './bots-ssh-bootstrap.mjs';
import { killOwned, redact, abortError } from './bots-runtime/process.mjs';

const MAX_FRAME = 16 * 1024 * 1024;
const fault = (code, message) => Object.assign(new Error(message), { code, status: code.endsWith('_cleanup_unconfirmed') ? 503 : 502, ...(code === 'cua_cleanup_unconfirmed' ? { cleanupUnconfirmed: true } : {}) });
export function normalizeBotSSH(execution) {
  if (execution?.kind !== 'ssh') throw fault('ssh_settings', 'Choose an SSH execution computer.');
  const host = String(execution.host ?? ''), user = execution.user ? String(execution.user) : '', port = execution.port ?? null;
  if (!/^[A-Za-z0-9][A-Za-z0-9.:[\]_-]{0,252}$/.test(host) || user && !/^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,127}$/.test(user) || port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw fault('ssh_settings', 'Enter a valid SSH host, optional user and port separately.');
  return { kind: 'ssh', host, user, ...(port !== null ? { port } : {}) };
}
export const botSSHTarget = execution => createHash('sha256').update(JSON.stringify(normalizeBotSSH(execution))).digest('hex');
export function botSSHArguments(execution) {
  const { host, user, port } = normalizeBotSSH(execution);
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=12', '-o', 'ConnectionAttempts=1', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'PermitLocalCommand=no', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', ...(port ? ['-p', String(port)] : []), ...(user ? ['-l', user] : []), '--', host, SSH_BOTS_COMMAND];
}
const assetNames = ['bots-runtime/index.mjs', 'bots-runtime/process.mjs', 'bots-runtime/tool-bridge.mjs', 'bots-runtime/mcp-stdio.mjs', 'bots-runtime/ssh-worker.mjs', 'bots-runtime/cua-qemu-prepare.py', 'bots-tools.mjs', 'bots-models.mjs', 'bots-cua.mjs', 'bots-cua.py', 'bots-computer.swift', 'agent/browser-probe.mjs', 'agent/harness-runtime.mjs', 'external-env.mjs', 'powershell-utf8.mjs'];
export async function botSSHBundle({ readAsset = name => readFile(new URL(name, import.meta.url)) } = {}) {
  const assets = {};
  for (const name of assetNames) assets[`server/${name}`] = Buffer.from(await readAsset(name));
  const dependencies = { '@anthropic-ai/claude-agent-sdk': '0.3.304', 'playwright-core': '1.63.0' };
  assets['package.json'] = Buffer.from(await readAsset('bots-runtime/worker-package/package.json'));
  assets['package-lock.json'] = Buffer.from(await readAsset('bots-runtime/worker-package/package-lock.json'));
  const files = Object.entries(assets).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]);
  const hash = createHash('sha256').update(JSON.stringify({ files, dependencies })).digest('hex');
  return { hash, files, dependencies, assets: Object.fromEntries(Object.entries(assets).map(([name, value]) => [name, value.toString('base64')])) };
}
function sshFailure(stderr) {
  if (/host key verification failed|remote host identification has changed|no .*host key is known/i.test(stderr)) return fault('ssh_host_key', 'This SSH host key is unknown or changed. Verify it with your system SSH client before using Bots.');
  if (/permission denied|authentication failed|too many authentication/i.test(stderr)) return fault('ssh_auth', 'SSH key authentication failed for this execution account. Check the saved host and user.');
  if (/node[^\n]*(?:not found|no such file)/i.test(stderr)) return fault('ssh_node', 'Install Node.js 24.12 or newer on this SSH computer before preparing Bots.');
  return fault('ssh_connection', 'The SSH connection ended. The remote worker is revoking its actions and cleaning up; no turn will be replayed automatically.');
}
export function createRemoteBotSSH({ sshPath = '/usr/bin/ssh', spawnProcess = spawn, bundle = botSSHBundle, managementTimeoutMs = 600_000, runTimeoutMs = 30 * 60_000, cleanupTimeoutMs = 20_000, heartbeatMs = 2000, leaseMs = 12_000, leaseCleanupGraceMs = 4000 } = {}) {
  const active = new Set(); let closed = false;
  async function call(action, execution, payload = {}, options = {}) {
    if (closed) throw fault('ssh_closed', 'Remote Bots is closed.');
    normalizeBotSSH(execution); options.signal?.throwIfAborted();
    const content = await bundle(); options.signal?.throwIfAborted();
    const request = { action, hash: content.hash, files: content.files, dependencies: content.dependencies,
      ...(action === 'prepare' ? { assets: content.assets, installBrowser: options.installBrowser === true } : {}), ...payload };
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_FRAME) throw fault('ssh_request_limit', 'This bot history is too large for one SSH turn. Start a new bot chat.');
    const child = spawnProcess(sshPath, botSSHArguments(execution), { shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const requestController = new AbortController();
    const owner = { child, abort: null, ended: null }; active.add(owner);
    let buffer = '', stderr = '', bytes = 0, terminal, failure, beforeStartFailure = false, cleanupConfirmed = false, cancelled = false, stopping = false, done = false;
    let timer, heartbeat, cleanupTimer, resolveEnd;
    owner.ended = new Promise(resolve => { resolveEnd = resolve; });
    const transportEnded = new Promise(resolve => { child.once('close', code => resolve(code)); child.once('error', () => resolve(-1)); });
    const send = value => { if (done || child.stdin.destroyed) return false; const text = JSON.stringify(value); if (Buffer.byteLength(text) > MAX_FRAME) throw fault('ssh_protocol_limit', 'Remote Bots returned a response that is too large.'); child.stdin.write(`${text}\n`); return true; };
    const cancel = () => {
      if (stopping) return; stopping = true; cancelled = true; requestController.abort();
      try { send({ type: 'cancel' }); } catch { /* disconnect cleanup below */ }
      cleanupTimer = setTimeout(() => { if (!cleanupConfirmed) failure = fault('ssh_cleanup_unconfirmed', 'Could not confirm that the remote bot stopped. Its heartbeat lease expires automatically; check the SSH computer before starting another turn.'); void killOwned(child); }, cleanupTimeoutMs);
    };
    owner.abort = cancel; options.signal?.addEventListener('abort', cancel, { once: true });
    const requests = new Set();
    function requestFromWorker(message) {
      if (stopping || done || options.signal?.aborted) return;
      const task = (async () => {
        try {
          let value;
          if (message.type === 'permission') {
            if (typeof options.requestPermission !== 'function') value = false;
            else value = await options.requestPermission({ ...message.value, reason: `${message.value?.reason ?? 'Allow this bot action?'}\nSSH computer: ${execution.host}${execution.user ? ` (${execution.user})` : ''}` }, requestController.signal);
          } else if (message.type === 'requestModel') {
            if (typeof options.modelRequest !== 'function') throw new Error('This configured model is unavailable from the Mac host.');
            value = await options.modelRequest(message.value, requestController.signal);
          }
          if (!stopping && !done && !options.signal?.aborted) send({ type: 'reply', id: message.id, value });
        } catch (error) { if (!stopping && !done) send({ type: 'reply', id: message.id, error: redact(error) }); }
      })();
      requests.add(task); task.finally(() => requests.delete(task)).catch(() => {});
    }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64_000); });
    child.stdout.on('data', chunk => {
      if (done) return; bytes += Buffer.byteLength(chunk); buffer += chunk;
      if (buffer.length > MAX_FRAME || bytes > 256 * 1024 * 1024) { failure = fault('ssh_protocol_limit', 'The remote Bots stream exceeded its size limit.'); cancel(); return; }
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
        let message; try { message = JSON.parse(line); } catch { failure = fault('ssh_protocol', 'The SSH computer returned an invalid Bots protocol message.'); cancel(); continue; }
        if (message.type === 'cleanup') { cleanupConfirmed = message.confirmed === true; if (cleanupConfirmed) clearTimeout(cleanupTimer); }
        else if (message.type === 'result') terminal = message.value;
        else if (message.type === 'failure') { failure = fault(message.code ?? 'ssh_worker', redact(message.message)); beforeStartFailure = message.beforeStart === true; }
        else if (!stopping && !options.signal?.aborted) {
          try {
            let result;
            if (message.type === 'frame') result = options.onFrame?.(message.value);
            else if (message.type === 'identity') result = options.onIdentity?.(message.value);
            else if (message.type === 'checkpoint') result = options.onCheckpoint?.(message.value);
            else if (message.type === 'permission' || message.type === 'requestModel') requestFromWorker(message);
            if (result && typeof result.then === 'function') result.catch(error => { failure = fault('ssh_projection', redact(error)); cancel(); });
          } catch (error) { failure = fault(error.code ?? 'ssh_projection', redact(error)); cancel(); }
        }
      }
    });
    timer = setTimeout(() => { failure = fault('ssh_timeout', 'The remote Bots request exceeded its time limit.'); cancel(); }, action === 'run' ? runTimeoutMs : managementTimeoutMs);
    if (action === 'run' || action === 'computer') heartbeat = setInterval(() => { if (!stopping) { try { send({ type: 'heartbeat' }); } catch { cancel(); } } }, heartbeatMs);
    try {
      send(request);
      // EOF is a cancellation signal for the turn worker. Management requests consume one JSON line.
      if (action === 'probe') child.stdin.end();
      if (options.signal?.aborted) cancel();
      const exitCode = await transportEnded;
      done = true; requestController.abort();
      if ((action === 'run' || action === 'computer') && !cleanupConfirmed && !beforeStartFailure && terminal?.available !== false) {
        // A severed channel cannot deliver an ACK. Wait through the worker's lease and cleanup bound;
        // retain an explicit unconfirmed error rather than reporting a successful Stop.
        if (!stopping) await new Promise(resolve => setTimeout(resolve, leaseMs + leaseCleanupGraceMs));
        throw fault('ssh_cleanup_unconfirmed', 'The SSH connection ended without a cleanup acknowledgement. The remote worker’s heartbeat lease has expired; verify that computer before starting another turn.');
      }
      if (failure) throw failure;
      if (action === 'run' && terminal?.available === false) throw fault('ssh_unprepared', terminal.detail ?? 'Prepare Bots on this SSH computer first.');
      if (cancelled || terminal?.cancelled) throw abortError();
      if (exitCode !== 0 || terminal === undefined) throw sshFailure(stderr);
      if (terminal?.error) throw fault('ssh_provider', redact(terminal.error));
      return terminal;
    } finally {
      done = true; requestController.abort(); clearTimeout(timer); clearTimeout(cleanupTimer); clearInterval(heartbeat); options.signal?.removeEventListener('abort', cancel);
      try { await killOwned(child); }
      catch { throw fault('ssh_cleanup_unconfirmed', 'The local SSH process group did not stop. Check the execution computer before starting another turn.'); }
      finally { active.delete(owner); resolveEnd(); }
    }
  }
  const client = {
    probe(execution, options) { return call('probe', execution, {}, options); },
    prepare(execution, options) { return call('prepare', execution, {}, options); },
    cua(execution, operation, payload = {}, options = {}) {
      if (!['probe', 'prepare', 'start', 'state', 'control', 'stop'].includes(operation)) throw fault('ssh_cua_action', 'Choose a supported isolated computer action.');
      const safe = structuredClone(payload); if (safe.bot) { delete safe.bot.providerSettings; delete safe.bot.modelSource; }
      return call('computer', execution, { input: { ...safe, operation } }, options);
    },
    async run(input) {
      const execution = normalizeBotSSH(input.bot.execution), target = botSSHTarget(execution);
      if (input.checkpoint && input.checkpoint.remoteTarget !== target) throw fault('ssh_session_target', 'This chat belongs to a different execution computer. Start a new bot chat.');
      const bot = structuredClone(input.bot);
      // Model credentials stay on their owning computer. Configured inference is requested through RPC.
      if (bot.providerSettings) bot.providerSettings = bot.providerSettings.baseURL ? { baseURL: bot.providerSettings.baseURL } : undefined;
      let remoteIdentity = input.checkpoint?.remoteIdentity;
      const wrap = value => ({ remoteTarget: target, remoteIdentity, remoteCheckpoint: value });
      const result = await call('run', execution, { input: { bot, sessionId: input.sessionId, message: input.message, history: input.history ?? [], checkpoint: input.checkpoint?.remoteCheckpoint, expectedIdentity: remoteIdentity } }, {
        ...input, onIdentity: value => { if (!/^[a-f0-9]{64}$/.test(value ?? '') || remoteIdentity && value !== remoteIdentity) throw fault('ssh_session_identity', 'The SSH execution computer or account changed. Start a new bot chat.'); remoteIdentity = value; }, onCheckpoint: checkpoint => input.onCheckpoint?.(wrap(checkpoint)),
      });
      const checkpoint = result.checkpoint ? wrap(result.checkpoint) : null;
      input.onFrame?.({ type: 'done', tokensIn: result.tokensIn ?? 0, tokensOut: result.tokensOut ?? 0, checkpoint });
      return { ...result, checkpoint };
    },
    async close() { closed = true; const runs = [...active]; for (const owner of runs) owner.abort(); await Promise.allSettled(runs.map(owner => owner.ended)); },
  };
  return client;
}
