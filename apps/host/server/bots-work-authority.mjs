/** A recovery receipt binds authority, never credentials or native checkpoints. */
import { createHash } from 'node:crypto';

const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, ordered(value[key])])) : value;

export function botWorkAuthorityFingerprint(bot) {
  const extensions = structuredClone(bot.extensionSnapshots ?? {});
  if (extensions.mcp) {
    // A new explicit continuation has a new run ID. Connection revisions,
    // OAuth epochs, exact tools and team identity must still match.
    delete extensions.mcp.revision;
    for (const connection of extensions.mcp.assignments?.connections ?? []) delete connection.teamRunId;
  }
  const scope = Object.fromEntries(['id', 'provider', 'model', 'effort', 'modelSource', 'modelDestination', 'providerSettings', 'instructions', 'policy', 'capabilities', 'execution', 'computerMode', 'workspace', 'sharedComputer', 'computerOwnerId', 'hostFolder', 'hostFolderBinding', 'hostFolderRevision', 'hostFolderOwnerId', 'hostFolderRemoteIdentity'].map(key => [key, bot[key]]));
  return createHash('sha256').update(JSON.stringify(ordered({ ...scope, extensions }))).digest('hex');
}
