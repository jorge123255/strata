import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export const abortError = () => Object.assign(new Error('Bot stopped.'), { name: 'AbortError' });
export function redact(value, secrets = []) {
  let text = String(value?.message ?? value ?? 'Provider failed.');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length > 3) text = text.split(secret).join('[redacted]');
  return text.replace(/(Bearer\s+)[\w.\-]+/gi, '$1[redacted]').replace(/\b(?:sk-[\w\-]{8,}|oauth[_-]?[\w-]{16,})\b/g, '[redacted]').slice(0, 2000);
}
export async function findExecutable(name, env = process.env) {
  // Finder launches have a different PATH from the user's shell. Prefer standard user CLI installs
  // so a stale Homebrew copy cannot shadow the CLI/account the user just installed.
  const dirs = [join(homedir(), '.local/bin'), join(homedir(), '.grok/bin'), join(homedir(), '.kimi-code/bin'), ...String(env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const path of isAbsolute(name) ? [name] : dirs.filter(Boolean).map(dir => join(dir, name))) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch { /* next candidate */ }
  }
  return null;
}
const stopping = new WeakMap();
export function killOwned(child) {
  if (stopping.has(child)) return stopping.get(child);
  const hasGroup = Boolean(child.pid) && process.platform !== 'win32';
  const alive = () => { if (!hasGroup) return child.exitCode === null && child.signalCode === null; try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  const stop = signal => { if (hasGroup) { try { process.kill(-child.pid, signal); return; } catch { /* gone */ } } if (child.exitCode === null && child.signalCode === null) { try { child.kill(signal); } catch { /* gone */ } } };
  // The group remains ours when its leader exits. A child that ignores TERM must still receive KILL.
  const result = (async () => {
    if (!alive()) return;
    stop('SIGTERM'); const began = Date.now(); let escalated = false;
    while (alive()) {
      if (!escalated && Date.now() - began >= 1000) { stop('SIGKILL'); escalated = true; }
      if (Date.now() - began >= 3000) throw new Error('The owned provider process group did not exit after Stop.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })();
  // Signal handlers may initiate shutdown before the owner awaits close(). Retain rejection for close().
  result.catch(() => {}); stopping.set(child, result); return result;
}
/** Owns one process group. Never attaches to a user's existing provider process. */
export function jsonRpcProcess({ command, args, cwd, env, signal, onNotification, onRequest, onClose, spawnProcess = spawn, timeoutMs = 60_000 }) {
  signal?.throwIfAborted();
  const child = spawnProcess(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  const pending = new Map(); let nextId = 0, buffer = '', stderr = '', closed = false;
  const write = message => { if (closed || child.stdin.destroyed) throw new Error('Provider process disconnected.'); child.stdin.write(`${JSON.stringify(message)}\n`); };
  const fail = error => { if (closed) return; closed = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); onClose?.(error); };
  child.on('error', error => fail(new Error(error.code === 'ENOENT' ? 'Provider CLI is not installed.' : redact(error))));
  child.on('close', (code, sig) => fail(signal?.aborted ? abortError() : new Error(`Provider process exited (${sig ?? code ?? 'unknown'}).${stderr ? ` ${redact(stderr)}` : ''}`)));
  child.stdin.on('error', error => fail(new Error(redact(error))));
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) { fail(new Error('Provider protocol frame exceeded the size limit.')); killOwned(child); return; }
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && !message.method) {
        const p = pending.get(message.id); if (!p) continue;
        pending.delete(message.id); clearTimeout(p.timer);
        message.error ? p.reject(Object.assign(new Error(redact(message.error.message)), { code: message.error.code })) : p.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        Promise.resolve().then(() => { if (closed || signal?.aborted) return; return onRequest?.(message, api); }).catch(error => { try { api.reject(message.id, redact(error)); } catch { /* disconnected */ } });
      } else if (message.method) {
        try { onNotification?.(message); } catch (error) { fail(error); killOwned(child); }
      }
    }
  });
  const abort = () => { fail(abortError()); killOwned(child); };
  signal?.addEventListener('abort', abort, { once: true });
  const api = {
    request(method, params, deadline = timeoutMs) { return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, deadline); timer.unref();
      pending.set(id, { resolve, reject, timer });
      try { write({ jsonrpc: '2.0', id, method, params }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    }); },
    notify(method, params) { write({ jsonrpc: '2.0', method, params }); },
    respond(id, result) { write({ jsonrpc: '2.0', id, result }); },
    reject(id, message) { write({ jsonrpc: '2.0', id, error: { code: -32601, message } }); },
    async close() { signal?.removeEventListener('abort', abort); fail(abortError()); await killOwned(child); },
  };
  return api;
}
export async function executableVersion(command, env) {
  return await new Promise(resolve => {
    const child = spawn(command, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
    let output = ''; const timer = setTimeout(() => { killOwned(child); resolve(null); }, 3000); timer.unref();
    child.stdout.on('data', chunk => { output = (output + chunk).slice(0, 200); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? output.trim() : null); });
  });
}
/** Ask the native CLI for a public status object; never read its credential document. */
export async function executableJsonStatus(command, args, env) {
  return await new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
    let output = '', settled = false;
    const finish = async result => { if (settled) return; settled = true; clearTimeout(timer); try { await killOwned(child); } catch { /* status remains unknown */ } resolve(result); };
    const timer = setTimeout(() => { void finish(null); }, 4000); timer.unref();
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 64_000) void finish(null); });
    child.on('error', () => { void finish(null); });
    child.on('close', () => { let parsed = null; try { parsed = JSON.parse(output); } catch { /* unknown status */ } void finish(parsed); });
  });
}
