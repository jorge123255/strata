/** Human-readable targets only. Never serialize arbitrary integration arguments. */
const maximum = 4000;
const credential = /((?:\b[A-Za-z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET)|--(?:api[-_]?key|access[-_]?token|token|password|secret))\s*(?:=|\s)\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;|&]+)/gi;

function urlTarget(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    if (!url.username && !url.password && !url.search && !url.hash) return value;
    // Query/fragment values may contain credentials under arbitrary names.
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return `URL details hidden: ${url.href}`;
  } catch { return undefined; }
}

function bounded(value, secrets) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim()) return undefined;
  let text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '\ufffd');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length > 3) text = text.split(secret).join('[redacted]');
  text = text.replace(credential, '$1[redacted]').replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[\w-]{8,}|oauth[_-]?[\w-]{16,})\b/g, '[redacted]');
  if (text.length <= maximum) return text;
  const suffix = '\n[truncated; request a shorter action before approving]';
  let prefix = text.slice(0, maximum - suffix.length);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}

export function botApprovalTarget(name, args, { secrets = [] } = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  let value;
  if (['read_file', 'list_files', 'write_file', 'host_read_file', 'host_list_files', 'host_write_file'].includes(name)) value = args.path ?? (name.endsWith('list_files') ? '.' : undefined);
  else if (name === 'run_command' && typeof args.command === 'string') {
    value = args.command.replace(/https?:\/\/[^\s"'<>]+/gi, url => urlTarget(url) ?? '[URL hidden]');
  } else if (name === 'browser_open' && typeof args.url === 'string') value = urlTarget(args.url);
  else if (name === 'browser_click' && typeof args.role === 'string' && typeof args.name === 'string') value = `${args.role}: ${args.name}`;
  else if (name === 'browser_type' && typeof args.label === 'string') value = `Field: ${args.label}`;
  else if (name === 'browser_key' && typeof args.key === 'string') value = `Key: ${args.key}`;
  return bounded(value, secrets);
}
