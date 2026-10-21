/** Parse common MCP configuration shapes locally; importing never starts a program. */
export interface BotConnectionDraft { name: string; transport: 'stdio'|'http'; url: string; command: string; args: string[]; env?: Record<string,string>; apiKey?: string; botIds: string[]; enabledToolIds: string[] }
export function parseBotConnectionImport(text: string): BotConnectionDraft[] {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Paste an MCP configuration object.');
  const entries = value.mcpServers ?? (value.transport || value.url || value.command ? { [value.name || 'Imported connection']: value } : value);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Use an object with one entry per server.');
  return Object.entries(entries).map(([name, raw]) => {
    const row = raw as Record<string,unknown>;
    if (!row || typeof row !== 'object' || Array.isArray(row) || (!row.url && !row.command)) throw new Error(`Enter a server URL or program for ${name}.`);
    if (row.args !== undefined && (!Array.isArray(row.args) || row.args.some(arg=>typeof arg!=='string'))) throw new Error('Program arguments must be a list of strings.');
    if (row.env !== undefined && (!row.env || typeof row.env !== 'object' || Array.isArray(row.env) || Object.values(row.env).some(item=>typeof item!=='string'))) throw new Error('Environment values must be strings.');
    if (row.url && row.env !== undefined) throw new Error('Program environment does not apply to an HTTP server. Use a bearer API key for HTTP authentication.');
    if (!row.url && row.headers !== undefined) throw new Error('Use program environment for this local connection. Bearer authentication applies to HTTP servers.');
    let apiKey: string | undefined;
    if (row.headers !== undefined) {
      if (!row.headers || typeof row.headers !== 'object' || Array.isArray(row.headers)) throw new Error('Use a bearer Authorization header for this connection.');
      const headers=Object.entries(row.headers);
      if (headers.length!==1 || headers[0][0].toLowerCase()!=='authorization' || typeof headers[0][1]!=='string' || !/^Bearer\s+\S+$/i.test(headers[0][1])) throw new Error('This import uses unsupported headers. Add a server URL and bearer API key instead.');
      apiKey=String(headers[0][1]).replace(/^Bearer\s+/i,'');
    }
    if (row.oauth || row.auth) throw new Error('OAuth setup is not supported here yet. Use a bearer API key connection.');
    return { name, transport: row.url ? 'http' : 'stdio', url: String(row.url ?? ''), command: String(row.command ?? ''), args: row.args as string[] ?? [], ...(row.env ? { env: row.env as Record<string,string> } : {}), ...(apiKey ? {apiKey} : {}), botIds: [], enabledToolIds: [] };
  });
}

/** Only HTTPS account sign-in URLs may leave the connector manager. */
export function connectorAuthorizationURL(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
/** Cancel only the exact pending browser flow this device actually reviewed. */
export function connectorAuthorizationState(value: unknown): string | null {
  const safe = connectorAuthorizationURL(value);
  if (!safe) return null;
  const states = new URL(safe).searchParams.getAll('state');
  return states.length === 1 && /^[a-f0-9]{64}$/.test(states[0]) ? states[0] : null;
}
/** Team access grants apply only to team work, not members' private conversations. */
export function connectorInScope(connection: {botIds:string[];teamIds?:string[]}, scope: string): boolean {
  if (scope.startsWith('bot:')) return connection.botIds.includes(scope.slice(4));
  if (scope.startsWith('team:')) return connection.teamIds?.includes(scope.slice(5)) === true;
  return true;
}
