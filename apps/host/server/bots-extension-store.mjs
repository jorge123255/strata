/** Private, versioned configuration for optional Bots extensions. */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { error, json, readBody } from './util.mjs';
import { isLocalCompanionRequest } from './companion-routes.mjs';

const extensionFaults = new WeakSet();
export const botExtensionFault = (status, message) => { const failure = Object.assign(new Error(message), { status }); extensionFaults.add(failure); return failure; };
export const isBotExtensionFault = failure => !!failure && typeof failure === 'object' && extensionFaults.has(failure);
export const extensionHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const extensionText = (value, max, label, required = false) => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || required && !value.trim()) throw botExtensionFault(400, `Enter a valid ${label}.`);
  return value.trim();
};
export function extensionKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw botExtensionFault(400, 'This configuration contains an unsupported field.');
}
export function extensionIds(value, label, max = 256) {
  if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(id))) throw botExtensionFault(400, `Choose valid ${label}.`);
  return [...new Set(value)];
}
export function privateExtensionStore(directory, name, initial) {
  const file = join(directory, name);
  const regular = () => { let stat; try { stat = lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw botExtensionFault(503, 'Saved Bots configuration is not a regular file. It was left unchanged.'); };
  regular();
  let value = structuredClone(initial);
  if (existsSync(file)) {
    try { if (lstatSync(file).size > 32 * 1024 * 1024) throw new Error(); value = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw botExtensionFault(503, 'Saved Bots configuration could not be read. It was left unchanged.'); }
    if (value?.version !== 1) throw botExtensionFault(503, 'This Bots configuration version is unavailable. It was left unchanged.');
  }
  return { value, save(next = value) {
    regular(); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); chmodSync(temp, 0o600); renameSync(temp, file); value = next; }
    finally { try { unlinkSync(temp); } catch {} }
  } };
}

/** Same exact-origin boundary as pairing and the existing Bots routes. */
export function createBotExtensionRoutes({ skills, mcp, port }) {
  return async (req, res, url) => {
    res.removeHeader('access-control-allow-origin'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    if (!isLocalCompanionRequest(req, typeof port === 'function' ? port() : port)) return error(res, 403, 'Open Bots in the Strata app on this Mac.');
    try {
      const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req, 256 * 1024).catch(() => { throw botExtensionFault(400, 'Enter valid JSON within the configuration size limit.'); }) : {};
      const deviceId = req.headers['x-strata-companion-device'];
      if (deviceId !== undefined && (typeof deviceId !== 'string' || !/^[a-f0-9]{32}$/.test(deviceId))) throw botExtensionFault(403, 'Invalid paired-device connector owner.');
      const result = await (url.pathname.startsWith('/api/bots/skills') ? skills : mcp).handle(req.method, url, body, { deviceId });
      return json(res, req.method === 'POST' && !/\/(assign|check|auth(?:\/(complete|cancel|open))?)$/.test(url.pathname) ? 201 : 200, result);
    } catch (failure) { return error(res, failure.status ?? 503, failure.status ? failure.message : 'This Bots connection is unavailable. Check its setup and try again.'); }
  };
}
