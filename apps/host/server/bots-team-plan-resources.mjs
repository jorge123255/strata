/** Private scheduling identities from saved execution settings, never model hints. */
import { realpathSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';

function canonicalFolder(value) {
  let parent = resolve(value), suffix = [];
  for (;;) {
    try { return join(realpathSync(parent), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(basename(parent)); parent = next;
    }
  }
}

export function teamPlanResourceKey(bot) {
  // SSH aliases/users do not prove distinct physical folders. Until a worker
  // supplies an independently bound filesystem identity, serialize that unknown
  // resource domain instead of treating two aliases as isolated working copies.
  if (bot.execution?.kind === 'ssh') return 'remote:unverified-filesystem';
  if (bot.execution?.kind !== 'local') return 'execution:unverified-filesystem';
  if (bot.computerMode === 'cua' && !bot.hostFolder) return `computer:${bot.computerOwnerId ?? bot.id}`;
  return `local:${canonicalFolder(bot.computerMode === 'cua' ? bot.hostFolder.path : bot.workspace)}`;
}

export function teamPlanResourcesOverlap(left, right) {
  if (left === right) return true;
  if (!left?.startsWith('local:') || !right?.startsWith('local:')) return false;
  const a = left.slice(6), b = right.slice(6);
  return a.startsWith(b.endsWith('/') ? b : `${b}/`) || b.startsWith(a.endsWith('/') ? a : `${a}/`);
}
