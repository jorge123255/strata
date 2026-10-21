/** Merge reviewed endpoint aliases while retaining every public source identity. */
export function mergeMarketplaceCatalog(legacy, snapshot) {
  const result = legacy.map(entry => ({ ...structuredClone(entry), setupState: 'ready', phoneSignIn: entry.authTypes.includes('oauth'), sourcePluginIds: [], aliases: [entry.name] }));
  const legacyIds = new Set(legacy.map(entry => entry.id));
  for (const imported of snapshot.entries) {
    const existing = imported.url && result.find(entry => entry.url === imported.url && (legacyIds.has(entry.id)
      || entry.setupState === imported.setupState && JSON.stringify(entry.authTypes) === JSON.stringify(imported.authTypes)));
    if (existing) {
      existing.sourcePluginIds.push(...imported.sourcePluginIds);
      existing.aliases = [...new Set([...existing.aliases, ...(imported.aliases || [imported.name])])];
      if (!existing.sourceURL && imported.sourceURL) existing.sourceURL = imported.sourceURL;
    } else result.push(structuredClone(imported));
  }
  return result;
}
