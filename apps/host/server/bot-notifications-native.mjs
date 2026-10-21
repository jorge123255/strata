/** Only the signed Strata shell owns the native notification identity and permission prompt. */
export function createNativeNotifications({ env = process.env, fetcher = fetch } = {}) {
  let base, token;
  function setBridge(value = {}) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url ?? '') || typeof value.token !== 'string' || value.token.length < 16) throw new Error('Invalid native notification bridge.');
    base = value.url; token = value.token;
  }
  if (env.STRATA_SHELL_BRIDGE && env.STRATA_SHELL_TOKEN) { try { setBridge({ url: env.STRATA_SHELL_BRIDGE, token: env.STRATA_SHELL_TOKEN }); } catch {} }
  const unavailable = () => ({ available: false, authorization: 'unavailable', detail: 'Native notifications require the Strata Mac app to be open.' });
  async function call(path, method = 'GET', body) {
    if (!base) return unavailable();
    try {
      const response = await fetcher(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(path === '/notifications/permission' ? 65000 : 15000), redirect: 'error' });
      const result = await response.json();
      if (!response.ok) return { ...unavailable(), detail: 'The Strata notification service is unavailable. Try reopening the Mac app.' };
      if (path === '/notifications/deliver' || path === '/notifications/test') return { delivered: result.delivered === true, handled: result.handled === true || result.suppressed === true, ...(typeof result.detail === 'string' ? { detail: result.detail.slice(0, 300) } : {}) };
      if (path === '/notifications/open') return { destination: result.destination ?? null };
      if (path === '/notifications/context') return { saved: result.saved === true || result.ok === true || result.updated === true };
      if (result.available !== true || !['not-determined', 'denied', 'authorized'].includes(result.authorization)) return unavailable();
      return { available: true, authorization: result.authorization, detail: typeof result.detail === 'string' ? result.detail.slice(0, 300) : '' };
    } catch { return unavailable(); }
  }
  return { setBridge, status: () => call('/notifications/status'), permission: () => call('/notifications/permission', 'POST'), test: sound => call('/notifications/test', 'POST', { sound }), open: () => call('/notifications/open', 'POST'), context: value => call('/notifications/context', 'POST', value), deliver: value => call('/notifications/deliver', 'POST', value) };
}
