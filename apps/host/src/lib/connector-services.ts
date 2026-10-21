import type { BotConnectorCatalogEntry } from './bots';
/** The host owns each preset. The first advertised method is its trusted default. */
export function connectorServiceAction(entry: BotConnectorCatalogEntry): 'oauth' | 'key' | 'account' | 'advanced' | 'setup' {
  if (entry.setupState !== undefined && entry.setupState !== 'ready') return 'setup';
  if (!entry.url) return 'advanced';
  if (!connectorServiceLink(entry.url) || !Array.isArray(entry.authTypes) || !entry.authTypes.length || entry.authTypes.some(method => !['none', 'bearer', 'oauth'].includes(method))) return 'setup';
  if (entry.authTypes[0] === 'oauth') return 'oauth';
  if (entry.authTypes[0] === 'bearer') return 'key';
  return 'account';
}

/** Public setup links cannot smuggle credentials or template variables into a browser. */
export function connectorServiceLink(value: unknown): string | null {
  if (typeof value !== 'string' || /[<>{}]|%(?:7b|7d|3c|3e)/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if ([...url.searchParams.keys()].some(key => /^(?:api[_-]?key|key|token|access[_-]?token|secret|client[_-]?secret|password|authorization|code|signature)$/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

/** A directory listing alone is not enough to invent a service endpoint or login method. */
export function connectorConfigurationURL(entry: BotConnectorCatalogEntry): string | null {
  if (entry.setupState !== 'configuration' || entry.transport !== 'http' || !Array.isArray(entry.authTypes) || !entry.authTypes.length || entry.authTypes.some(method => !['none', 'bearer', 'oauth'].includes(method))) return null;
  const url = connectorServiceLink(entry.url);
  return url && !new URL(url).hash ? url : null;
}

export function connectorSetupLabel(entry: BotConnectorCatalogEntry): string {
  return entry.setupState === 'configuration' ? 'Setup needed' : entry.setupState === 'managed' ? 'Managed service' : entry.setupState === 'unavailable' ? 'Details unavailable' : 'Setup details';
}

/** Local service marks keep the account browser private and work offline. */
export function connectorServiceIdentity(service = '', name?: string): {mark:string;color:string;background:string;initials?:string} {
  if (service === 'github') return { mark: 'github', color: '#eff2f8', background: '#29303b' };
  if (service === 'linear' || service === 'linear-readonly') return { mark: 'linear', color: '#a6a4ff', background: '#29264f' };
  if (service === 'notion') return { mark: 'notion', color: '#f3f2ee', background: '#30302e' };
  if (service === 'atlassian') return { mark: 'atlassian', color: '#70adff', background: '#17385b' };
  if (service === 'slack') return { mark: 'slack', color: '#f4eaf8', background: '#38263c' };
  if (service === 'asana') return { mark: 'asana', color: '#ff9a9e', background: '#4d2836' };
  if (service && service !== 'custom-http' && !service.includes('://')) {
    const palettes = [['#b4c9ff','#27334e'],['#d2b3fa','#3c294c'],['#a6dbca','#203e37'],['#fac292','#4b3327'],['#ecb8d9','#462e40'],['#afd5eb','#243c49']];
    let hash = 0; for (const letter of service) hash = ((hash << 5) - hash + letter.charCodeAt(0)) | 0;
    const [color,background] = palettes[Math.abs(hash) % palettes.length], words = (name || service).match(/[a-z0-9]+/gi) || [];
    return {mark:'initials',color,background,initials:words.slice(0,2).map(word=>word[0]).join('').toUpperCase() || 'S'};
  }
  return { mark: 'custom', color: 'var(--st-accent)', background: 'var(--st-accent-tint)' };
}
