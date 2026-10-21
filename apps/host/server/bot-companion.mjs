/** Optional native Mac companion. This surface can display and navigate, never execute. */
import { timingSafeEqual } from 'node:crypto';
import { normalizeBotAvatar } from './bots.mjs';
import { isLocalCompanionRequest } from './companion-routes.mjs';
import { error, json, readBody } from './util.mjs';

const fault = (status, message) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const display = value => value === 'main' || typeof value === 'string' && /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const states = new Set(['approval', 'error', 'working', 'thinking', 'completed']);
const unavailable = () => ({ available: false, detail: 'Update and open the Strata Mac app to use the bot companion.' });
// Bound UTF-8 bytes, not just UTF-16 code units. JSON escaping is bounded again below.
const text = (value, limit) => {
  let result = '', bytes = 0;
  for (const character of (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) break;
    result += character; bytes += size;
  }
  return result;
};

export function companionSettings(input) {
  if (!object(input) || !Object.keys(input).length || Object.keys(input).some(key => !['enabled', 'screen'].includes(key))
    || Object.hasOwn(input, 'enabled') && typeof input.enabled !== 'boolean'
    || Object.hasOwn(input, 'screen') && !display(input.screen)) throw fault(400, 'Choose valid bot companion settings.');
  return { ...input };
}

/** Re-project the already bounded supervision data. No profile credentials or transcript fields cross this boundary. */
export function companionSnapshot(snapshot, profiles) {
  if (!object(snapshot) || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > 200 || !object(snapshot.counts)
    || ['waiting', 'working', 'completed', 'errors'].some(key => !count(snapshot.counts[key])) || !Number.isFinite(Date.parse(snapshot.updatedAt))) throw fault(503, 'Bot activity is temporarily unavailable.');
  const known = new Map(profiles.map(bot => [bot.id, bot]));
  const sessions = [];
  for (const row of snapshot.sessions) {
    const bot = known.get(row.botId);
    if (!bot || !id(row.id) || !id(row.botId) || !states.has(row.state) || !count(row.approvalCount)) continue;
    let avatarConfig;
    try { avatarConfig = normalizeBotAvatar(bot.avatarConfig); }
    catch { const sum = Array.from(bot.name ?? '').reduce((total, character) => total + character.codePointAt(0), 0); avatarConfig = { color: ['violet', 'orange', 'sky', 'cloud', 'slate', 'graphite'][sum % 6], eyes: 'star', ears: 'scalloped' }; }
    const toolName = text(row.toolName, 64), computerName = text(row.computerName, 64);
    sessions.push({ id: row.id, botId: row.botId, name: text(row.name, 64) || text(bot.name, 64) || 'Bot', title: text(row.title, 120) || 'Conversation', state: row.state,
      approvalCount: row.approvalCount, avatarConfig,
      ...(toolName ? { toolName } : {}),
      ...(computerName ? { computerName } : {}),
      ...(typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)) ? { updatedAt: new Date(row.updatedAt).toISOString() } : {}),
    });
    if (sessions.length === 6) break;
  }
  const result = { supported: true, sessions, counts: Object.fromEntries(['waiting', 'working', 'completed', 'errors'].map(key => [key, snapshot.counts[key]])),
    hasMore: snapshot.hasMore === true || snapshot.sessions.length > sessions.length, updatedAt: new Date(snapshot.updatedAt).toISOString() };
  while (Buffer.byteLength(JSON.stringify(result)) > 8192 && sessions.length) { sessions.pop(); result.hasMore = true; }
  if (Buffer.byteLength(JSON.stringify(result)) > 8192) throw fault(503, 'Bot activity is temporarily unavailable.');
  return result;
}

async function boundedJSON(response) {
  if (!response.body) throw new Error('Invalid native status.');
  if (Number(response.headers.get('content-length') ?? 0) > 16384) { await response.body.cancel(); throw new Error('Invalid native status.'); }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) throw new Error('Native status is too large.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function publicStatus(input) {
  if (!object(input) || input.available !== true || !object(input.settings) || typeof input.settings.enabled !== 'boolean' || !display(input.settings.screen)
    || !Array.isArray(input.screens) || input.screens.length > 32 || input.screens.some(screen => !object(screen) || screen.id === 'main' || !display(screen.id) || typeof screen.name !== 'string')
    || new Set(input.screens.map(screen => screen.id)).size !== input.screens.length || typeof input.visible !== 'boolean' || typeof input.expanded !== 'boolean') return unavailable();
  return { available: true, settings: { enabled: input.settings.enabled, screen: input.settings.screen }, screens: input.screens.map(screen => ({ id: screen.id, name: text(screen.name, 120) })),
    visible: input.visible, expanded: input.expanded, ...(typeof input.stale === 'boolean' ? { stale: input.stale } : {}), ...(typeof input.detail === 'string' ? { detail: text(input.detail, 300) } : {}) };
}

export function createNativeBotCompanion({ env = process.env, fetcher = fetch } = {}) {
  const base = env.STRATA_SHELL_BRIDGE, token = env.STRATA_SHELL_TOKEN;
  let ready = false;
  try { ready = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(base ?? '') && !!new URL(base).port && typeof token === 'string' && token.length >= 16; } catch { /* A malformed bridge is unavailable, never an app-start failure. */ }
  async function call(path, body) {
    if (!ready) return unavailable();
    try {
      const response = await fetcher(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); return unavailable(); }
      return publicStatus(await boundedJSON(response));
    } catch { return unavailable(); }
  }
  return { status: () => call('/companion/status'), settings: input => call('/companion/settings', companionSettings(input)) };
}

export function createBotCompanionRoutes({ bots, port, env = process.env, native = createNativeBotCompanion({ env }) }) {
  // Separate from the shutdown/bridge credentials; exists only for this host launch.
  const feedToken = typeof env.STRATA_COMPANION_FEED_TOKEN === 'string' && /^[a-f0-9]{32,128}$/.test(env.STRATA_COMPANION_FEED_TOKEN) ? env.STRATA_COMPANION_FEED_TOKEN : '';
  return async (req, res, url) => {
    res.removeHeader('access-control-allow-origin'); res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    if (!isLocalCompanionRequest(req, typeof port === 'function' ? port() : port)) return error(res, 403, 'Open companion settings in Strata on this Mac.');
    try {
      if (url.pathname === '/api/bots/companion/snapshot') {
        const supplied = req.headers['x-strata-companion'];
        if (!feedToken || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== feedToken.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(feedToken))) return error(res, 401, 'Native companion authorization required.');
        if (req.method !== 'GET' || url.search || req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') return error(res, 405, 'The companion activity feed is read-only.');
        return json(res, 200, companionSnapshot(bots.supervision(), bots.supervisionProfiles()));
      }
      if (url.pathname === '/api/bots/companion' && req.method === 'GET' && !url.search) return json(res, 200, await native.status());
      if (url.pathname === '/api/bots/companion/settings' && req.method === 'POST' && !url.search) {
        let input;
        try { input = companionSettings(await readBody(req, 1024)); } catch { throw fault(400, 'Choose valid bot companion settings.'); }
        const status = await native.settings(input);
        if (!status.available) return error(res, 503, unavailable().detail);
        return json(res, 200, status);
      }
      return error(res, 405, 'Unknown bot companion action.');
    } catch (cause) { return error(res, cause.status ?? 503, cause.status ? cause.message : 'The bot companion is temporarily unavailable.'); }
  };
}
