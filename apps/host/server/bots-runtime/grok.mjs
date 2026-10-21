/** Native Grok model discovery. No prompt, account document, or native session is opened. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { killOwned } from './process.mjs';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,249}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const unavailable = () => new Error('Could not load the native Grok model catalog. Sign in with grok login on the execution computer and refresh.');

/** Parse only the public listing, never return arbitrary CLI stdout or stderr. */
export function grokCatalog(output) {
  if (typeof output !== 'string') throw unavailable();
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (/^(?:You are not logged in|Not logged in|Please (?:log|sign) in)\b/im.test(text)) return { models: [], authState: 'signed_out' };
  const listing = /^Available models:\s*$/m.exec(text);
  if (!listing) throw unavailable();
  const defaultId = /^Default model:\s*(\S+)\s*$/m.exec(text)?.[1];
  const seen = new Set(), models = [];
  for (const line of text.slice(listing.index + listing[0].length).split('\n')) {
    const match = /^\s+[-*]\s+(\S+?)(?:\s+\(default\))?\s*$/.exec(line);
    if (!match || !MODEL.test(match[1]) || seen.has(match[1])) continue;
    const id = match[1]; seen.add(id);
    models.push({ id, name: id, efforts: [], ...(id === defaultId || /\(default\)\s*$/.test(line) ? { isDefault: true } : {}) });
    if (models.length >= 500) break;
  }
  if (!models.length) throw unavailable();
  return { models, authState: /^You are logged in\b/m.test(text) ? 'signed_in' : 'unverified' };
}

/** The cache also contains native credentials. Only whitelisted info fields may leave this function. */
export function grokModelMetadata(document, verifiedModels) {
  const cache = document?.models;
  const source = Array.isArray(cache) ? cache : cache && typeof cache === 'object' ? Object.entries(cache).map(([id, row]) => ({ ...row, cacheId: id })) : [];
  const metadata = new Map();
  for (const entry of source.slice(0, 500)) {
    const info = entry?.info ?? entry;
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
    const id = info.id ?? entry.cacheId;
    if (typeof id !== 'string' || !MODEL.test(id)) continue;
    const efforts = [...new Set((Array.isArray(info.reasoning_efforts) ? info.reasoning_efforts : []).flatMap(value => {
      const level = typeof value === 'string' ? value : value?.id ?? value?.value;
      return typeof level === 'string' && EFFORT.test(level) ? [level] : [];
    }))].slice(0, 32);
    const marked = (Array.isArray(info.reasoning_efforts) ? info.reasoning_efforts : []).find(value => value?.default === true);
    const defaultEffort = info.reasoning_effort ?? marked?.id ?? marked?.value;
    const name = typeof info.name === 'string' && info.name.trim() && !/[\x00-\x1f\x7f]/.test(info.name) ? info.name.trim().slice(0, 250) : id;
    metadata.set(id, { name, efforts, ...(efforts.includes(defaultEffort) ? { defaultEffort } : {}) });
  }
  // A stale cache cannot add models which the installed CLI did not advertise for this account.
  return verifiedModels.map(row => ({ ...row, ...metadata.get(row.id) }));
}

async function readMetadata(env, rows) {
  const home = env.GROK_HOME || join(env.HOME || homedir(), '.grok');
  if (!isAbsolute(home)) return rows;
  let handle;
  try {
    handle = await open(join(home, 'models_cache.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return rows;
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 2 * 1024 * 1024) return rows;
    return grokModelMetadata(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), rows);
  } catch { return rows; }
  finally { await handle?.close(); }
}

export async function grokModels(command, { env = process.env, signal, spawnProcess = spawn, timeoutMs = 8000 } = {}) {
  signal?.throwIfAborted();
  const child = spawnProcess(command, ['models'], { cwd: homedir(), env: { ...env, NO_COLOR: '1', CLICOLOR: '0' }, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
  let output = '', failed = false, timer;
  const abort = () => { failed = true; void killOwned(child); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const code = await new Promise(resolve => {
      timer = setTimeout(abort, timeoutMs); timer.unref();
      child.stdout.on('data', chunk => { output = (output + chunk).slice(0, 2 * 1024 * 1024 + 1); if (output.length > 2 * 1024 * 1024) abort(); });
      child.once('error', () => { failed = true; resolve(-1); }); child.once('close', resolve);
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    if (failed || code !== 0) throw unavailable();
    const catalog = grokCatalog(output);
    return { ...catalog, models: await readMetadata(env, catalog.models) };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await killOwned(child); }
}
