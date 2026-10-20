/** Optional CUA execution. Provider accounts remain on the execution host;
 * every exposed tool is executed inside this bot's owned CUA Space. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, statfs } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBotProcess } from './bots-tools.mjs';

export const CUA_VERSION = '0.5.0';
export const CUA_IMAGE = 'ghcr.io/trycua/linux:24.04';
const text = value => ({ content: [{ type: 'text', text: String(value) }] });
const property = description => ({ type: 'string', description });
const number = description => ({ type: 'number', description });
const tool = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const reading = new Set(['read_file', 'list_files', 'browser_snapshot', 'computer_screenshot']);
const coding = [
  tool('read_file', 'Read a UTF-8 file inside this bot’s CUA sandbox workspace.', { path: property('Workspace-relative file path') }, ['path']),
  tool('list_files', 'List a directory inside this bot’s CUA sandbox workspace.', { path: property('Workspace-relative directory, default .') }),
  tool('write_file', 'Write a UTF-8 file inside this bot’s CUA sandbox workspace.', { path: property('Workspace-relative file path'), content: property('Complete file content') }, ['path', 'content']),
  tool('run_command', 'Run a shell command inside this bot’s CUA sandbox workspace, never on the execution host.', { command: property('Shell command'), timeoutSeconds: number('Maximum 120 seconds; default 30') }, ['command']),
];
const computer = [
  tool('browser_open', 'Open an HTTP or HTTPS address in the CUA sandbox desktop browser.', { url: property('HTTP or HTTPS URL') }, ['url']),
  tool('browser_snapshot', 'Capture the CUA sandbox desktop. Use its image pixel coordinates for clicks.'),
  tool('browser_click', 'Click an image pixel coordinate inside the CUA sandbox browser.', { x: number('Screenshot image pixel x'), y: number('Screenshot image pixel y') }, ['x', 'y']),
  tool('browser_type', 'Type into the focused field inside the CUA sandbox browser.', { text: property('Text to type') }, ['text']),
  tool('browser_key', 'Press a key or shortcut inside the CUA sandbox browser.', { key: property('Key or shortcut, such as Enter or Control+L') }, ['key']),
  tool('computer_screenshot', 'Capture this bot’s CUA sandbox desktop.'),
  tool('computer_click', 'Click an image pixel coordinate inside this bot’s CUA sandbox.', { x: number('Screenshot image pixel x'), y: number('Screenshot image pixel y') }, ['x', 'y']),
  tool('computer_type', 'Type into the focused app inside this bot’s CUA sandbox.', { text: property('Text to type') }, ['text']),
  tool('computer_key', 'Press a key or shortcut inside this bot’s CUA sandbox.', { key: property('Key or shortcut, such as Enter or Control+L') }, ['key']),
];
export const cuaSandboxName = bot => `strata-bot-${createHash('sha256').update(String(bot?.id ?? '')).digest('hex').slice(0, 24)}`;
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const fail = message => { throw new Error(message); };

/** One request per helper. A cancelled guest command must acknowledge cleanup
 * before its client can finish; a dead client is never treated as that proof. */
export function runCUABridge(python, helper, payload, { signal, env, timeout = 150000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('The bot was stopped.'));
    const child = spawn(python, ['-I', helper], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', errors = '', cancelled = false, settled = false, forceTimer;
    const end = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { if (cancelled) return; cancelled = true; child.kill('SIGTERM'); forceTimer = setTimeout(() => { child.kill('SIGKILL'); }, 15000); forceTimer.unref?.(); };
    const timer = setTimeout(abort, timeout); timer.unref?.();
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 16 * 1024 * 1024) abort(); });
    child.stderr.on('data', chunk => { if (errors.length < 2000) errors += chunk; });
    child.on('error', error => end(error));
    child.on('close', code => {
      let result; try { result = JSON.parse(output); } catch {}
      if (cancelled) {
        const error = new Error(result?.cleanupConfirmed === true ? 'The bot was stopped.' : 'CUA could not confirm that the sandbox command stopped. Check the computer before continuing.');
        if (result?.cleanupConfirmed !== true) { error.cleanupUnconfirmed = true; error.code = 'cua_cleanup_unconfirmed'; }
        return end(error);
      }
      if (code !== 0 || !result || result.error) { const error = new Error(result?.error || 'The CUA helper could not complete this operation. Prepare the CUA runtime and try again.'); if (result?.cleanupConfirmed === false) { error.cleanupUnconfirmed = true; error.code = 'cua_cleanup_unconfirmed'; } return end(error); }
      end(null, result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

export function createBotCUATools({ directory, processRunner = runBotProcess, bridge = runCUABridge, python = 'python3', platform = process.platform, pythonCandidates } = {}) {
  if (!directory) fail('A private CUA state directory is required.');
  const root = join(directory, 'cua-runtime'), venv = join(root, 'venv'), executable = join(venv, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const helper = fileURLToPath(new URL('./bots-cua.py', import.meta.url));
  const qemuPrepare = fileURLToPath(new URL('./bots-runtime/cua-qemu-prepare.py', import.meta.url));
  const inFlight = new Map(), leases = new Map(), uncertain = new Set();
  let preparing = null;
  const environment = () => ({ PATH: join(root, 'home', '.cua', 'bin') + delimiter + (process.env.PATH ?? '/usr/bin:/bin'), HOME: join(root, 'home'), CUA_HOME: join(root, 'home', '.cua'), LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', CUA_SPACES_AGENT_CREDENTIALS_HOME: 'none', CUA_SPACES_TELEPORT_HOME: join(root, 'teleport'), CUA_DEFAULT_ON: 'local' });
  const checkBot = bot => { if (!bot?.id || bot.computerMode !== 'cua' || bot.execution?.kind !== 'local') fail('Choose this execution computer’s CUA sandbox.'); };
  async function request(operation, { bot, signal, ...args } = {}) {
    if (bot) checkBot(bot);
    if (!await exists(executable)) fail('Prepare CUA on this execution computer first.');
    if (signal?.aborted) fail('The bot was stopped.');
    const parameters = {};
    for (const key of ['action', 'x', 'y', 'text', 'key', 'name', 'args', 'start']) if (Object.hasOwn(args, key)) parameters[key] = args[key];
    return bridge(executable, helper, { ...parameters, operation, directory: root, image: CUA_IMAGE, ...(bot ? { sandbox: cuaSandboxName(bot) } : {}) }, { signal, env: environment(), timeout: operation === 'start' ? 600000 : operation === 'prepare' ? 300000 : 150000 });
  }
  async function probe(options = {}) {
    if (!await exists(executable)) return { available: false, prepared: false, detail: `Prepare CUA ${CUA_VERSION} on this computer to enable isolated computers. No sandbox has been started.` };
    const result = await request('probe', options); return { ...result, prepared: true };
  }
  async function prepare({ signal } = {}) {
    if (preparing) return preparing;
    preparing = (async () => {
      await mkdir(join(root, 'home'), { recursive: true, mode: 0o700 });
      // The app's hardened Python cannot load a separately signed SDK dylib.
      // Reuse a working private venv; on macOS create one from an existing
      // independent Python without changing the app signature or installing
      // a system interpreter. A failed venv is retained for diagnosis.
      const versionArgs = ['-I', '-c', 'import cua, importlib.metadata; print(importlib.metadata.version("cua"))'];
      const inspect = async (command, args) => {
        try { return await processRunner(command, args, { signal, timeout: 15000, env: environment() }); }
        catch (error) { if (signal?.aborted) throw error; return null; }
      };
      const version = await exists(executable) ? await inspect(executable, versionArgs) : null;
      const installed = version?.code === 0 && version.stdout.trim() === CUA_VERSION;
      let creator = python;
      if (platform === 'darwin' && !installed) {
        creator = null;
        const candidates = pythonCandidates ?? ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/Library/Frameworks/Python.framework/Versions/Current/bin/python3'];
        for (const candidate of candidates) {
          if (!await exists(candidate)) continue;
          const check = await inspect(candidate, ['-I', '-c', 'import sys,venv; sys.exit(0 if (3,10) <= sys.version_info[:2] < (4,0) else 1)']);
          if (check?.code === 0) { creator = candidate; break; }
        }
        if (!creator) fail('CUA on this Mac needs an existing independent Python 3.10 or later with venv support. Strata’s signed Python cannot load the separately signed CUA library. No system software or app signatures were changed.');
        if (await exists(venv)) await rename(venv, `${venv}-unavailable-${Date.now()}-${randomUUID()}`);
      }
      if (!await exists(executable)) {
        const disk = await statfs(root); if (Number(disk.bavail) * Number(disk.bsize) < 512 * 1024 * 1024) fail('CUA needs at least 512 MB of free disk space to prepare its private SDK. Choose a remote computer or free disk space.');
        const make = await processRunner(creator, ['-B', '-m', 'venv', venv], { signal, timeout: 120000, env: environment() }); if (make.code !== 0) fail('Python 3 with venv support is required to prepare CUA.');
      }
      if (!installed) {
        const install = await processRunner(executable, ['-I', '-m', 'pip', '--isolated', 'install', '--index-url', 'https://pypi.org/simple', '--disable-pip-version-check', '--no-cache-dir', '--only-binary=:all:', `cua==${CUA_VERSION}`], { signal, timeout: 300000, maxBytes: 2 * 1024 * 1024, env: environment() });
        if (install.code !== 0) fail(`The private CUA ${CUA_VERSION} SDK could not be installed. This computer needs a supported Python and platform wheel.`);
        const imported = await processRunner(executable, versionArgs, { signal, timeout: 15000, env: environment() });
        if (imported.code !== 0 || imported.stdout.trim() !== CUA_VERSION) fail('The private CUA SDK could not load with this Python interpreter. No app signatures or system permissions were changed.');
      }
      if (platform === 'linux') {
        const result = await processRunner(executable, ['-I', qemuPrepare, join(root, 'home', '.cua')], { signal, timeout: 420000, maxBytes: 2 * 1024 * 1024, env: environment() });
        if (result.code !== 0) { let detail; try { detail = JSON.parse(result.stdout).error; } catch {} fail(detail || 'The private QEMU runtime could not be prepared. No system packages were installed.'); }
      }
      return request('prepare', { signal });
    })().finally(() => { preparing = null; });
    return preparing;
  }
  const definitions = bot => {
    const selected = [...(bot.capabilities !== 'computer' ? coding : []), ...(bot.capabilities !== 'code' ? computer : [])];
    return bot.policy === 'plan' ? selected.filter(t => reading.has(t.name)) : selected;
  };
  const state = options => request('state', options);
  const start = options => request('start', options);
  const stop = async options => { const result = await request('stop', options); if (result.stopped === true && result.cleanupConfirmed === true) { const owner = leases.get(options.bot.id); if (owner) uncertain.delete(owner); leases.delete(options.bot.id); } return result; };
  const control = options => {
    if (!['click', 'type', 'key'].includes(options?.action)) fail('Choose a supported CUA computer action.');
    return request('control', options);
  };
  async function executeOne(options) {
    const { bot, chatId, name, args = {}, toolCallId = `tool_${randomUUID()}`, signal, requestPermission, onFrame = () => {} } = options;
    checkBot(bot); if (uncertain.has(chatId)) { const error = new Error('CUA cleanup was not confirmed. Stop the CUA computer before continuing.'); error.cleanupUnconfirmed = true; error.code = 'cua_cleanup_unconfirmed'; throw error; }
    if (!definitions(bot).some(t => t.name === name)) fail('This tool is not available in this bot’s capability or permission mode.');
    if (signal?.aborted) fail('The bot was stopped.');
    if (!await exists(executable)) fail('Prepare CUA on this execution computer first.');
    const begun = Date.now(), card = { id: toolCallId, name, args, preview: name.replaceAll('_', ' '), effect: 'CUA sandbox', scope: 'connected' };
    const emit = (state, result) => onFrame({ type: 'agent-tool', tool: { ...card, state, ...(result ? { result } : {}), durationMs: Date.now() - begun } });
    if (!reading.has(name) && bot.policy !== 'bypass') {
      if (bot.policy === 'plan' || !await requestPermission?.({ id: toolCallId, name, args, reason: `Allow ${name.replaceAll('_', ' ')} inside ${bot.name}’s CUA sandbox?` })) { emit('denied', 'The action was not allowed.'); return { ...text('The action was not allowed. Do not retry it.'), isError: true }; }
    }
    if (signal?.aborted) fail('The bot was stopped.');
    const owner = leases.get(bot.id); if (owner && owner !== chatId) fail('Another conversation is using this bot’s CUA computer. Wait for it to finish.');
    leases.set(bot.id, chatId); emit('running');
    try {
      // Inspecting a stopped computer must not create or resume it. Every
      // mutating tool has already crossed the application approval boundary.
      const result = await request('tool', { bot, signal, name, args, start: !reading.has(name) && bot.policy !== 'plan' });
      if (signal?.aborted) fail('The bot was stopped.');
      const summary = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 24000) || 'Captured the CUA computer.';
      emit(result.isError ? 'error' : 'done', summary); return result;
    } catch (error) { if (error.cleanupUnconfirmed) { uncertain.add(chatId); error.code = 'cua_cleanup_unconfirmed'; } emit('error', error.message); throw error; }
  }
  function execute(options) {
    const pending = executeOne(options); if (!inFlight.has(options.chatId)) inFlight.set(options.chatId, new Set()); const calls = inFlight.get(options.chatId); calls.add(pending);
    pending.finally(() => { calls.delete(pending); if (!calls.size) inFlight.delete(options.chatId); }).catch(() => {}); return pending;
  }
  async function finish(chatId) { await Promise.allSettled([...(inFlight.get(chatId) ?? [])]); if (uncertain.has(chatId)) { const error = new Error('CUA could not confirm that all owned sandbox commands stopped.'); error.cleanupUnconfirmed = true; error.code = 'cua_cleanup_unconfirmed'; throw error; } for (const [id, owner] of leases) if (owner === chatId) leases.delete(id); }
  return { definitions, execute, finish, probe, prepare, start, state, control, stop, async close() { await Promise.allSettled([...inFlight.values()].flatMap(calls => [...calls])); if (uncertain.size) { const error = new Error('CUA command cleanup could not be confirmed.'); error.cleanupUnconfirmed = true; error.code = 'cua_cleanup_unconfirmed'; throw error; } leases.clear(); } };
}
