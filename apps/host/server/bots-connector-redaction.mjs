/** Remove known credentials from untrusted MCP inventories and results before history/provider use. */
export function redactBotConnectorValue(value, credentials) {
  // MCP text commonly contains JSON.stringify output. Match that representation too, so
  // quotes, backslashes and line breaks do not turn a known credential into an escape bypass.
  const secrets = [...new Set(credentials.filter(secret => typeof secret === 'string' && secret).flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  const pattern = secrets.length ? new RegExp(secrets.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
  const redact = text => pattern ? text.replace(pattern, () => '[redacted]') : text;
  const visit = (input, depth) => {
    if (typeof input === 'string') return redact(input);
    if (depth > 100) throw new Error('Connector result nesting limit exceeded.');
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [redact(key), visit(item, depth + 1)]));
    return input;
  };
  return visit(value, 0);
}
