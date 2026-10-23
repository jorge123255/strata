#!/usr/bin/env node
/**
 * Stage the four pieces a clean checkout does not contain, and name anything
 * that must not be put in the app.
 *
 *   Node       official nodejs.org build for the target, via fetch-node.sh (SHA-256 checked there)
 *   Harness    pinned Strata.app.tar.gz on the GitHub release, or STRATA_HARNESS_SRC / STRATA_HARNESS_DIR / a donor app
 *   Engine     one pinned release package for this target (Mac: Metal), or STRATA_ENGINE_SRC / a donor app
 *   Host deps  npm ci --omit=dev --omit=optional --ignore-scripts from apps/host/package-lock.json
 *
 * Personal credentials, private keys, and VPN files are refused.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const exists = existsSync;
export const MIN_NODE_BYTES = 8 * 1024 * 1024;
export const RELEASE_TAG = 'v0.2.3';
export const RELEASE_BASE = `https://github.com/Niko1221/Strata/releases/download/${RELEASE_TAG}/`;
export const APP_ARCHIVE = {
  name: 'Strata.app.tar.gz',
  sha256: '5f46de4e93cc97e95457b69299c1687943eb19ed7fea4d1bbf487aa6974d100e',
  harnessPrefix: 'Strata.app/Contents/Resources/harness',
};

/** SHA-256 values are the v0.2.3 release SHA256SUMS.txt lines, not recomputed from a local copy. */
export const ENGINE_ASSETS = {
  'darwin-arm64': {
    metal: asset('strata-engine-0.1.48-macos-arm64-metal.tar.gz', '7c99e5099de20685ff3a5d67ce24df23046b9804ecb68ca47c8e2169ba1961a5', 'macos-arm64'),
  },
  'linux-x64': {
    cuda13: asset('strata-engine-0.1.48-linux-x86_64-cuda-cuda13.tar.gz', '3e11a82e325cf4968a1734446e8945d7918a5657e964c6c5d2c262aa59258f57', 'linux-x86_64'),
    cuda12: asset('strata-engine-0.1.48-linux-x86_64-cuda-cuda12.tar.gz', 'c4caf94be52a4bf1fe7a55fccb3ae064312481df1b9216f6e518cacab3dc2400', 'linux-x86_64'),
    'hip-rx9070': asset('strata-engine-0.1.48-linux-x86_64-hip-rx9070.tar.gz', '5101b5aa440494fbf7461bfb8dd969877bd05aa2a6076d266324440ff5a33bbf', 'linux-x86_64'),
    'hip-rx7900': asset('strata-engine-0.1.48-linux-x86_64-hip-rx7900.tar.gz', '13bcf38c3ebef5261e7a99c6ce67b66a16e2c6a518586d7e96672c0f72178cfa', 'linux-x86_64'),
    'hip-rx6000': asset('strata-engine-0.1.48-linux-x86_64-hip-rx6000.tar.gz', '85400a94c2f05620a19c0403879898ab327f87b69f87755824c4fe589ed8739f', 'linux-x86_64'),
    'hip-halo': asset('strata-engine-0.1.48-linux-x86_64-hip-halo.tar.gz', 'f1a9a2a63112f7f357029e2bbd7e8e47f3d94000c2f9fd5af241217a8f3c4207', 'linux-x86_64'),
    sycl: asset('strata-engine-0.1.48-linux-x86_64-sycl.tar.gz', 'b77c61446f3e2a4fa3ee1edfeaa8bc1f49ef2d34ba01d4e11c8541d039ed5676', 'linux-x86_64'),
  },
  'win-x64': {
    cuda13: asset('strata-engine-0.1.48-windows-x86_64-cuda-cuda13.tar.gz', '1e1611b0977d984bd7d8e79591a1ba1a7e550a2f4a66bfa45744a77308a71b95', 'windows-x86_64'),
    cuda12: asset('strata-engine-0.1.48-windows-x86_64-cuda-cuda12.tar.gz', '77c3d57015c146c0f7f2969db88617be9e0a1539516ed9d2d9218a3f0bb09231', 'windows-x86_64'),
    'hip-rx9070': asset('strata-engine-0.1.48-windows-x86_64-hip-rx9070.tar.gz', '1eb6faf4b074e67aa31c2acbc37cf2bc31b121bc4a145b0a06f0f13fbf3334d7', 'windows-x86_64'),
    'hip-rdna3': asset('strata-engine-0.1.48-windows-x86_64-hip-rdna3.tar.gz', '7ec85ed2131fb223ffa10118ef92d86eeaffb6f4653cb2f27ae9d53f458dbf72', 'windows-x86_64'),
    'hip-rdna2': asset('strata-engine-0.1.48-windows-x86_64-hip-rdna2.tar.gz', 'a7499ad48dd40bb2d4d3ff05a72310aff3c5264f5ba41b130506856d8f346bef', 'windows-x86_64'),
  },
};

function asset(name, sha256, platform) {
  return { name, sha256, platform };
}

const FORBIDDEN_BASENAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', '.npmrc', '.netrc',
  'id_rsa', 'id_rsa.pub', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ed25519.pub',
  'feed-key.json', 'tauri-updater.key', 'credentials.json', 'secrets.json', 'wg0.conf',
]);
const FORBIDDEN_EXT = new Set(['.ovpn', '.p12', '.pfx', '.p8', '.vpn', '.wg']);
const FORBIDDEN_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.vpn', 'wireguard', 'openvpn']);
const PRIVATE_KEY = /-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;
const TEXT_EXT = new Set(['.txt', '.json', '.yml', '.yaml', '.conf', '.env', '.pem', '.key']);

export const HOST_PRODUCTION_NPM_ARGS = ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'];
export const HOST_DEV_NPM_ARGS = ['ci', '--no-audit', '--no-fund'];

export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function hostNodeTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') throw new Error('The macOS app is Apple Silicon only. There is no Intel engine.');
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32' && (arch === 'x64' || arch === 'ia32')) return 'win-x64';
  throw new Error(`This build machine (${platform} ${arch}) is not a desktop target.`);
}

export function platformForTarget(target) {
  return { 'darwin-arm64': 'macos-arm64', 'linux-x64': 'linux-x86_64', 'linux-arm64': 'linux-aarch64', 'win-x64': 'windows-x86_64' }[target] ?? null;
}

export function defaultEngineVariant(target) {
  const table = ENGINE_ASSETS[target];
  if (!table) return null;
  const names = Object.keys(table);
  return names.length === 1 ? names[0] : null;
}

export function engineReleaseAsset(target, variant = defaultEngineVariant(target)) {
  const table = ENGINE_ASSETS[target];
  if (!table) throw new Error(`No published engine package is recorded for ${target}.`);
  if (!variant) throw new Error(`Set STRATA_ENGINE_VARIANT to one of: ${Object.keys(table).join(', ')}. Each installer carries one engine.`);
  const found = table[variant];
  if (!found) throw new Error(`Unknown engine variant ${variant} for ${target}. Choose one of: ${Object.keys(table).join(', ')}.`);
  return found;
}

export function engineFolderName(manifest) {
  const variant = manifest.variant ? `-${manifest.variant}` : '';
  return `${manifest.version}-${manifest.platform}-${manifest.backend}${variant}`;
}

export function isForbiddenRelative(rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  if (parts.some(part => FORBIDDEN_DIRS.has(part.toLowerCase()))) return true;
  const base = (parts.at(-1) ?? '').toLowerCase();
  if (!base) return false;
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.') && base !== '.env.example') return true;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
  return FORBIDDEN_EXT.has(ext);
}

function looksLikePrivateKey(path) {
  let text = '';
  try { text = readFileSync(path, 'utf8').slice(0, 1_000_000); } catch { return false; }
  return PRIVATE_KEY.test(text);
}

function shouldReadForKey(rel, size) {
  if (size > 256 * 1024) return false;
  if (rel.split('/').includes('node_modules')) return false;
  if (rel.includes('python/lib/')) return false;
  const base = rel.split('/').at(-1) ?? '';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')).toLowerCase() : '';
  if (ext === '.pem' || ext === '.key') return true;
  return TEXT_EXT.has(ext) || ext === '';
}

/** Relative paths that must not be copied. Symlinks that leave the tree count. */
export function findBundleSecrets(root) {
  if (!existsSync(root)) return [];
  const hits = [];
  const rootReal = resolve(root);
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (isForbiddenRelative(rel)) { hits.push(rel); continue; }
      if (entry.isSymbolicLink()) {
        let real = '';
        try { real = realpathSync(abs); } catch { real = ''; }
        if (!real) {
          if (!rel.includes('node_modules/.bin/')) hits.push(`${rel} (broken symlink)`);
          continue;
        }
        const escaped = relative(rootReal, real);
        if (escaped.startsWith('..') || isAbsolute(escaped)) hits.push(`${rel} (symlink leaves the source)`);
        continue;
      }
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.isFile()) continue;
      const size = statSync(abs).size;
      const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase() : '';
      if ((ext === '.pem' || ext === '.key' || shouldReadForKey(rel, size)) && looksLikePrivateKey(abs)) hits.push(rel);
    }
  };
  walk(root);
  return hits;
}

export function assertBundleClean(root) {
  const hits = findBundleSecrets(root);
  if (!hits.length) return;
  throw new Error(['Refusing to stage credentials, keys, or VPN files:', ...hits.map(hit => `  ${hit}`)].join('\n'));
}

/** Replace dest with a real-file copy of source. An unsafe source is left untouched. */
export function stageCleanTree(dest, source) {
  assertBundleClean(source);
  const keep = existsSync(join(dest, '.gitignore')) ? readFileSync(join(dest, '.gitignore')) : null;
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(source, dest, {
    recursive: true, dereference: true, filter(path) {
      const rel = relative(source, path);
      if (!rel) return true;
      const posix = rel.split(sep).join('/');
      if (posix.split('/').includes('.git')) return false;
      return !isForbiddenRelative(posix);
    },
  });
  if (keep) writeFileSync(join(dest, '.gitignore'), keep);
  assertBundleClean(dest);
}

export function sha256File(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let read = 0;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

export function downloadVerified({ url, sha256, cacheDir, spawn = spawnSync }) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`A download needs a recorded SHA-256: ${url}`);
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, sha256);
  if (!existsSync(cached) || sha256File(cached) !== sha256) {
    const partial = `${cached}.partial`;
    rmSync(partial, { force: true });
    const result = spawn('curl', ['-fL', '--retry', '3', '--retry-delay', '2', '-o', partial, url], { stdio: 'inherit' });
    if (!result || result.status !== 0) throw new Error(`Download failed (${result?.status ?? 'curl missing'}): ${url}`);
    const got = sha256File(partial);
    if (got !== sha256) {
      rmSync(partial, { force: true });
      throw new Error(`REFUSING ${url}: SHA-256 ${got}, recorded ${sha256}`);
    }
    rmSync(cached, { force: true });
    renameSync(partial, cached);
  }
  return cached;
}

export function extractArchive(archive, dest, prefix = '') {
  mkdirSync(dest, { recursive: true });
  const result = spawnSync('python3', [join(here, 'extract-archive.py'), archive, dest, prefix], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'extract failed').trim());
  return dest;
}

export function findEnginePackages(root) {
  if (!root || !existsSync(root)) return [];
  const hasManifest = dir => {
    try { return statSync(join(dir, 'engine-component.json')).isFile(); } catch { return false; }
  };
  if (hasManifest(root)) return [root];
  const found = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue;
    const dir = join(root, name);
    try {
      if (statSync(dir).isDirectory() && hasManifest(dir)) found.push(dir);
    } catch { /* gone */ }
  }
  return found;
}

export function readEngineManifest(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'engine-component.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (!manifest || manifest.id !== 'strata-engine' || typeof manifest.entrypoint !== 'string' || !Array.isArray(manifest.files)) {
    throw new Error(`Not an engine package: ${dir}`);
  }
  return manifest;
}

export function stageEnginePackage(packageDir, bundleRoot, { expectedPlatform } = {}) {
  const manifest = readEngineManifest(packageDir);
  if (expectedPlatform && manifest.platform !== expectedPlatform) {
    throw new Error(`This engine is ${manifest.platform}; this build needs ${expectedPlatform}.`);
  }
  const name = engineFolderName(manifest);
  if (!/^[\w.+-]+$/.test(name)) throw new Error(`Engine folder name is not plain: ${name}`);
  mkdirSync(bundleRoot, { recursive: true });
  stageCleanTree(join(bundleRoot, name), packageDir);
  for (const entry of readdirSync(bundleRoot)) {
    if (entry === '.gitignore' || entry === name) continue;
    rmSync(join(bundleRoot, entry), { recursive: true, force: true });
  }
  const entrypoint = join(bundleRoot, name, manifest.entrypoint);
  if (existsSync(entrypoint) && process.platform !== 'win32') chmodSync(entrypoint, 0o755);
  return { name, dest: join(bundleRoot, name), manifest };
}

export function stageEngineArchive(archive, bundleRoot, options = {}) {
  const tmp = join(tmpdir(), `strata-engine-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    extractArchive(archive, tmp);
    const packages = findEnginePackages(tmp);
    if (packages.length !== 1) throw new Error(`Expected one engine package in ${archive}, found ${packages.length}.`);
    return stageEnginePackage(packages[0], bundleRoot, options);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function harnessIsReady(dir) {
  if (!dir || !existsSync(dir)) return false;
  const bin = existsSync(join(dir, 'lib/bin.js')) || existsSync(join(dir, 'apps/cli/lib/bin.js'));
  return bin && existsSync(join(dir, 'node_modules'));
}

export function stageHarnessArchive(archive, dest) {
  const tmp = join(tmpdir(), `strata-harness-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    extractArchive(archive, tmp, APP_ARCHIVE.harnessPrefix);
    const extracted = join(tmp, ...APP_ARCHIVE.harnessPrefix.split('/'));
    if (!harnessIsReady(extracted)) throw new Error('The app archive has no harness (lib/bin.js and node_modules).');
    stageCleanTree(dest, extracted);
    return dest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function stageHostDeps({ hostDir, outDir, spawn = spawnSync, refresh = false, npm = npmCommand() }) {
  const pkgPath = join(hostDir, 'package.json');
  const lockPath = join(hostDir, 'package-lock.json');
  if (!existsSync(lockPath)) throw new Error(`Host lockfile missing: ${lockPath}`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  mkdirSync(outDir, { recursive: true });
  copyFileSync(pkgPath, join(outDir, 'package.json'));
  copyFileSync(lockPath, join(outDir, 'package-lock.json'));
  const stamp = createHash('sha256').update(readFileSync(lockPath)).update('\0').update(HOST_PRODUCTION_NPM_ARGS.join(' ')).digest('hex');
  const stampPath = join(outDir, '.install-stamp');
  const names = Object.keys(pkg.dependencies ?? {});
  const present = names.every(name => existsSync(join(outDir, 'node_modules', ...name.split('/'), 'package.json')));
  const vite = existsSync(join(outDir, 'node_modules/vite/package.json'));
  if (!refresh && existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === stamp && present && !vite) {
    return { action: 'kept', outDir, source: lockPath };
  }
  const result = spawn(npm, HOST_PRODUCTION_NPM_ARGS, { cwd: outDir, stdio: 'inherit', shell: false, env: process.env });
  if (!result || result.status !== 0) throw new Error(`npm ci --omit=dev failed in ${outDir} (${result?.status ?? 'npm missing'}).`);
  const missing = names.filter(name => !existsSync(join(outDir, 'node_modules', ...name.split('/'), 'package.json')));
  if (missing.length) throw new Error(`npm ci finished but these production dependencies are missing: ${missing.join(', ')}`);
  writeFileSync(stampPath, `${stamp}\n`);
  return { action: 'installed', outDir, source: lockPath, args: HOST_PRODUCTION_NPM_ARGS };
}

export function ensureHostDevDependencies({ hostDir, spawn = spawnSync, refresh = false, npm = npmCommand() }) {
  const lockPath = join(hostDir, 'package-lock.json');
  if (!existsSync(lockPath)) throw new Error(`Host lockfile missing: ${lockPath}`);
  const stamp = `${sha256File(lockPath)}\n${HOST_DEV_NPM_ARGS.join(' ')}`;
  const stampPath = join(hostDir, 'node_modules/.strata-dev-stamp');
  if (!refresh && existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === stamp.trim() && existsSync(join(hostDir, 'node_modules/vite/package.json'))) {
    return { action: 'kept', hostDir };
  }
  const result = spawn(npm, HOST_DEV_NPM_ARGS, { cwd: hostDir, stdio: 'inherit', shell: false, env: process.env });
  if (!result || result.status !== 0) throw new Error(`npm ci failed in ${hostDir} (${result?.status ?? 'npm missing'}). The UI build needs the host's dev dependencies.`);
  mkdirSync(dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, `${stamp}\n`);
  return { action: 'installed', hostDir };
}

function plainRelative(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.startsWith('/') || filePath.startsWith('\\') || /^[a-zA-Z]:/.test(filePath)) return null;
  const parts = filePath.split(/[\\/]/);
  if (parts.some(part => !part || part === '..' || part === '.')) return null;
  return parts.join('/');
}

/**
 * Problems that mean the folder cannot be a runnable app resource root.
 * `packaged` also requires the host server and the built UI, which Tauri copies
 * from apps/host rather than from the staged resources directory.
 */
export function bundleProblems(root, { mode = 'packaged', packageJson, minNodeBytes = MIN_NODE_BYTES, requireNode = true, requireHarness = true, requireEngine = true, requireHost = true } = {}) {
  const problems = [];
  if (!existsSync(root)) {
    problems.push(`resource folder does not exist: ${root}`);
    return problems;
  }
  if (requireNode) {
    const candidates = ['node/node', 'node/node.exe'].map(relPath => join(root, relPath)).filter(path => existsSync(path));
    if (!candidates.length) problems.push('bundled Node runtime is missing (expected node/node or node/node.exe)');
    else {
      const nodePath = candidates[0];
      const info = statSync(nodePath);
      if (info.size < minNodeBytes) problems.push(`bundled Node runtime is too small to be the official binary (${info.size} bytes at ${nodePath})`);
      else if (process.platform !== 'win32' && nodePath.endsWith(`${sep}node`) && (info.mode & 0o111) === 0) problems.push('bundled Node runtime is not executable');
    }
  }
  if (requireHarness) {
    const bin = existsSync(join(root, 'harness/lib/bin.js')) || existsSync(join(root, 'harness/apps/cli/lib/bin.js'));
    if (!bin) problems.push('harness is missing (expected harness/lib/bin.js)');
    if (!existsSync(join(root, 'harness/node_modules'))) problems.push('harness node_modules is missing');
  }
  if (requireEngine) {
    const packages = findEnginePackages(join(root, 'engine-bundle'));
    if (!packages.length) problems.push('engine files are missing (expected engine-bundle/<package>/engine-component.json and the files it lists)');
    for (const dir of packages) {
      let manifest;
      try { manifest = readEngineManifest(dir); } catch (error) { problems.push(error.message); continue; }
      const entry = plainRelative(manifest.entrypoint);
      if (!entry || !existsSync(join(dir, entry))) problems.push(`engine entrypoint is missing: ${manifest.entrypoint}`);
      for (const file of manifest.files) {
        const relPath = plainRelative(file?.path);
        if (!relPath) { problems.push(`engine manifest has an unsafe path: ${file?.path}`); continue; }
        const path = join(dir, relPath);
        if (!existsSync(path)) problems.push(`engine file is missing: ${relPath}`);
        else if (statSync(path).size !== file.bytes) problems.push(`engine file size does not match its manifest: ${relPath}`);
      }
    }
  }
  if (requireHost) {
    if (!packageJson || !existsSync(packageJson)) problems.push(`host package.json is missing (${packageJson})`);
    else {
      const pkg = JSON.parse(readFileSync(packageJson, 'utf8'));
      const names = Object.keys(pkg.dependencies ?? {});
      if (!existsSync(join(root, 'host/node_modules'))) problems.push('host production dependencies are missing (expected host/node_modules from npm ci --omit=dev)');
      for (const name of names) {
        if (!existsSync(join(root, 'host/node_modules', ...name.split('/'), 'package.json'))) problems.push(`host production dependency is missing from host/node_modules: ${name}`);
      }
      for (const name of Object.keys(pkg.devDependencies ?? {})) {
        if (existsSync(join(root, 'host/node_modules', ...name.split('/'), 'package.json'))) problems.push(`development dependency must not be bundled: ${name}`);
      }
    }
  }
  if (mode === 'packaged') {
    if (!existsSync(join(root, 'host/server/index.mjs'))) problems.push('the App Host entry is missing (expected host/server/index.mjs)');
    if (!existsSync(join(root, 'host/dist'))) problems.push('the built UI is missing (expected host/dist)');
  }
  for (const hit of findBundleSecrets(root)) problems.push(`refusing to bundle a credential, key, or VPN file: ${hit}`);
  return problems;
}

export function findStrataApps(bundleDir) {
  const macos = join(bundleDir, 'macos');
  if (!existsSync(macos)) return [];
  return readdirSync(macos).filter(name => name.endsWith('.app')).map(name => join(macos, name));
}
