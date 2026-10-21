/** Runtime bridge inventory shared by source staging and its focused fixture. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, sep, dirname, basename } from 'node:path';

export function companionRuntimeFiles(source) {
  const root = lstatSync(source);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The companion source must be a regular directory.');
  const files = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.name.endsWith('.mjs') && !['package.json', 'qr.swift'].includes(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`The companion runtime source must be a regular file: ${entry.name}`);
    files.push(entry.name);
  }
  for (const required of ['bridge.mjs', 'index.mjs', 'package.json', 'qr.swift']) if (!files.includes(required)) throw new Error(`The companion runtime source is incomplete: ${required}`);
  return files.sort();
}

/** This destination is generated staging, never the installed application. */
export function stageCompanionRuntime(source, staged) {
  const sourceRoot = lstatSync(source);
  if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink()) throw new Error('The companion source must be a regular directory.');
  let nearest = resolve(staged), missing = [];
  for (;;) {
    try {
      const entry = lstatSync(nearest);
      if (nearest === resolve(staged) && entry.isSymbolicLink()) throw new Error('The companion staging destination must be a regular directory.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(basename(nearest)); const parent = dirname(nearest); if (parent === nearest) throw error; nearest = parent;
    }
  }
  const sourcePath = realpathSync(source), stagedPath = resolve(realpathSync(nearest), ...missing);
  if (sourcePath === stagedPath || sourcePath.startsWith(stagedPath + sep) || stagedPath.startsWith(sourcePath + sep)) throw new Error('Companion source and generated staging must be separate directories.');
  source = sourcePath; staged = stagedPath;
  const files = companionRuntimeFiles(source);
  if (existsSync(staged)) {
    const root = lstatSync(staged);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The companion staging destination must be a regular directory.');
  } else mkdirSync(staged, { recursive: true });
  // Preserve the tracked staging marker; it is repository metadata, not runtime.
  // A stage otherwise projects the runtime exactly, so retired modules cannot survive
  // from an earlier build. Remove the generated QR helper too, so swiftc
  // cannot follow a stale link or hard link when rebuilding it on Mac.
  for (const entry of readdirSync(staged, { withFileTypes: true })) {
    if (entry.name === '.gitignore') {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('The companion staging marker must be a regular file.');
      continue;
    }
    if (files.includes(entry.name)) continue;
    rmSync(join(staged, entry.name), { recursive: true, force: true });
  }
  for (const name of files) {
    const target = join(staged, name);
    let existing; try { existing = lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) rmSync(target, { recursive: true, force: true });
    copyFileSync(join(source, name), target);
  }
  return files;
}
