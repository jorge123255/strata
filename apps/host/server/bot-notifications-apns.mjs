/** Optional direct APNs delivery. Provider material stays in the local server configuration. */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { connect } from 'node:http2';
import { isAbsolute, join } from 'node:path';

export const APNS_TOPIC = 'com.strata.companion.ios';
const origins = Object.freeze({ sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' });
const invalidReasons = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

export function notificationPayload(event, journalId, sound = true) {
  return { aps: { alert: { title: event.title, body: event.body }, ...(sound ? { sound: 'default' } : {}), 'thread-id': `strata-${event.destination.type}-${createHash('sha256').update(event.destination.id).digest('hex').slice(0, 24)}`, category: 'STRATA_BOT_UPDATE' }, eventId: event.id, journalId, destination: { ...event.destination } };
}

export function postApns(origin, path, headers, bytes, { timeoutMs = 10000, connectClient = connect } = {}) {
  return new Promise((resolve, reject) => {
    let session, request, timer, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); request?.removeAllListeners('data'); request?.on('error', () => {}); session?.on('error', () => {}); session?.destroy(); error ? reject(error) : resolve(value); };
    timer = setTimeout(() => finish(new Error('APNs delivery timed out.')), timeoutMs);
    try {
      session = connectClient(origin, { rejectUnauthorized: true });
      session.once('error', error => finish(error));
      request = session.request({ ':method': 'POST', ':path': path, ...headers, 'content-length': String(bytes.length) });
      let status = 0, text = '';
      request.setEncoding('utf8');
      request.on('response', value => { status = Number(value[':status']); });
      request.on('data', value => { text += value; if (text.length > 8192) finish(new Error('APNs returned an oversized response.')); });
      request.once('error', error => finish(error));
      request.once('end', () => finish(null, { status, body: text }));
      request.end(bytes);
    } catch (error) { finish(error); }
  });
}

function readProviderFile(path) {
  const descriptor = openSync(path, 'r');
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error();
    const bytes = Buffer.alloc(4097), size = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (size > 4096) throw new Error();
    return JSON.parse(bytes.subarray(0, size).toString('utf8'));
  } finally { closeSync(descriptor); }
}
export function createApnsSender({ directory, env = process.env, readConfig = readProviderFile, readKey = path => readFileSync(path, 'utf8'), post = postApns, now = Date.now } = {}) {
  let configuration = null, token = null;
  let detail = 'Push delivery is not configured on this Strata computer. Notifications work while the iPhone app is active.';
  let supplied = [env.STRATA_APNS_TEAM_ID, env.STRATA_APNS_KEY_ID, env.STRATA_APNS_KEY_PATH];
  if (!supplied.some(Boolean) && (directory || env.STRATA_APNS_CONFIG_PATH)) {
    try {
      const config = readConfig(env.STRATA_APNS_CONFIG_PATH || join(directory, 'apns-provider.json'));
      if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length !== 3 || Object.keys(config).some(key => !['teamId', 'keyId', 'keyPath'].includes(key))) throw new Error();
      supplied = [config.teamId, config.keyId, config.keyPath];
    } catch (error) {
      if (error.code !== 'ENOENT') { supplied = [null, null, null]; detail = 'Apple push configuration is incomplete or could not be read. Check the local APNs provider settings.'; }
    }
  }
  if (supplied.some(Boolean)) {
    try {
      if (!/^[A-Z0-9]{10}$/.test(supplied[0] ?? '') || !/^[A-Z0-9]{10}$/.test(supplied[1] ?? '') || typeof supplied[2] !== 'string' || !isAbsolute(supplied[2]) || supplied[2].length > 4096 || supplied[2].includes('\0')) throw new Error();
      const key = createPrivateKey(readKey(supplied[2]));
      if (key.asymmetricKeyType !== 'ec' || !['prime256v1', 'P-256'].includes(key.asymmetricKeyDetails?.namedCurve)) throw new Error();
      configuration = { teamId: supplied[0], keyId: supplied[1], key };
      detail = 'This Strata computer is configured for Apple push delivery. The iPhone must also register with an eligible signed app.';
    } catch { detail = 'Apple push configuration is incomplete or could not be read. Check the local APNs provider settings.'; }
  }
  const status = () => ({ configured: configuration !== null, detail });
  function authorization() {
    const current = now();
    if (token && current >= token.at && current - token.at < 50 * 60000) return token.value;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: configuration.keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: configuration.teamId, iat: Math.floor(current / 1000) })).toString('base64url');
    const input = `${header}.${claims}`;
    const signature = sign('sha256', Buffer.from(input), { key: configuration.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    token = { at: current, value: `${input}.${signature}` }; return token.value;
  }
  return { status, async send(registration, event, journalId, sound, canSend = () => true) {
    if (!configuration) return { ok: false, invalidToken: false, status: 0 };
    if (!/^[a-f0-9]{32,256}$/.test(registration.token) || !Object.hasOwn(origins, registration.environment)) throw new Error('Invalid Apple push registration.');
    const bytes = Buffer.from(JSON.stringify(notificationPayload(event, journalId, sound)));
    if (bytes.length > 4096) throw new Error('Apple push payload exceeded its size limit.');
    const headers = { authorization: `bearer ${authorization()}`, 'apns-topic': APNS_TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(now() / 1000) + 3600), 'apns-collapse-id': `strata-${createHash('sha256').update(event.id).digest('hex').slice(0, 40)}`, 'content-type': 'application/json' };
    if (!canSend()) return { ok: false, invalidToken: false, status: 0 };
    const response = await post(origins[registration.environment], `/3/device/${registration.token}`, headers, bytes);
    let reason; try { reason = JSON.parse(response.body).reason; } catch {}
    return { ok: response.status === 200, invalidToken: response.status === 410 || invalidReasons.has(reason), status: response.status };
  } };
}
