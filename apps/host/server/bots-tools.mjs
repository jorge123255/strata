/** Host-owned bot tools. The model account never selects or grants a computer. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './agent/browser-probe.mjs';
import { agentEnvironment } from './agent/harness-runtime.mjs';

const fail = message => { throw new Error(message); };
const text = value => ({ content: [{ type: 'text', text: String(value) }] });
const image = buffer => ({ content: [{ type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' }] });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = description => ({ type: 'string', description });
const num = description => ({ type: 'number', description });
const tool = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: schema(properties, required) });
const coding = [
  tool('read_file', 'Read a UTF-8 file inside the selected workspace.', { path: str('Workspace-relative file path') }, ['path']),
  tool('list_files', 'List one directory inside the selected workspace.', { path: str('Workspace-relative directory, defaults to .') }),
  tool('write_file', 'Replace or create a UTF-8 file inside the selected workspace. Requires permission in Manual mode.', { path: str('Workspace-relative file path'), content: str('Complete file content') }, ['path', 'content']),
  tool('run_command', 'Run a shell command in the selected workspace. Requires permission in Manual mode; unavailable in Plan mode.', { command: str('Shell command'), timeoutSeconds: num('Maximum 120 seconds; default 30') }, ['command']),
];
const computer = [
  tool('browser_open', 'Open a URL in this bot’s separate browser. Returns a screenshot and visible page text.', { url: str('HTTP or HTTPS URL') }, ['url']),
  tool('browser_snapshot', 'Capture this bot’s browser and visible page text.'),
  tool('browser_click', 'Click a unique element in this bot’s browser using its visible label.', { role: str('Accessible role, such as button or link'), name: str('Exact visible accessible name') }, ['role', 'name']),
  tool('browser_type', 'Fill a labeled field in this bot’s browser.', { label: str('Exact visible field label'), text: str('Field value') }, ['label', 'text']),
  tool('browser_key', 'Press a key in this bot’s browser, such as Enter or Tab.', { key: str('Playwright key name') }, ['key']),
  tool('computer_screenshot', 'Capture the Mac’s main display. Requires Screen Recording permission and bot approval.'),
  tool('computer_click', 'Click an absolute coordinate on the Mac’s main display. Requires Accessibility permission and bot approval.', { x: num('Display x coordinate'), y: num('Display y coordinate') }, ['x', 'y']),
  tool('computer_type', 'Type text into the focused Mac app. Requires Accessibility permission and bot approval.', { text: str('Text to type') }, ['text']),
  tool('computer_key', 'Press a Mac key or shortcut, such as Return or Command+L.', { key: str('Key or shortcut') }, ['key']),
];

export async function botWorkspacePath(workspace, input = '.', { writing = false } = {}) {
  if (typeof input !== 'string' || input.length > 4000 || input.includes('\0')) fail('Enter a valid workspace path.');
  const root = await realpath(workspace), target = resolve(root, input);
  const within = value => { const rel = relative(root, value); return !rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'); };
  if (!within(target)) fail('This file is outside the bot’s workspace.');
  let actual = target;
  try { actual = await realpath(target); }
  catch (error) {
    if (!writing || error.code !== 'ENOENT') throw error;
    let parent = dirname(target);
    while (true) {
      try { const resolved = await realpath(parent); if (!within(resolved)) fail('This file points outside the bot’s workspace.'); break; }
      catch (failure) { if (failure.code !== 'ENOENT') throw failure; const next = dirname(parent); if (next === parent) throw failure; parent = next; }
    }
    // A dangling symlink must never be followed by a write.
    try { if ((await lstat(target)).isSymbolicLink()) fail('Choose a regular file inside the bot’s workspace.'); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  }
  if (!within(actual)) fail('This file points outside the bot’s workspace.');
  return actual;
}

/** A bounded process group belonging only to this tool call. */
export function runBotProcess(command, args, { cwd, signal, timeout = 30_000, maxBytes = 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) return reject(new Error('The bot was stopped.'));
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', bytes = 0, forced = null, stopping = null;
    const kill = () => {
      if (stopping) return stopping;
      try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM'); } catch {}
      stopping = new Promise(done => setTimeout(() => {
        // The leader may already have exited while a descendant is still alive.
        try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
        done();
      }, 1000));
      return stopping;
    };
    const abort = () => { forced = 'The bot was stopped.'; kill(); };
    const timer = setTimeout(() => { forced = 'The command exceeded its time limit.'; kill(); }, timeout); timer.unref?.();
    const collect = field => chunk => { bytes += chunk.length; if (bytes <= maxBytes) { if (field === 'out') output += chunk; else errors += chunk; } else if (!forced) { forced = 'The command produced too much output.'; kill(); } };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', async code => { cleanup(); if (stopping) await stopping; if (forced) reject(new Error(forced)); else resolveResult({ code, stdout: output, stderr: errors }); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function createBotTools({ directory, browserProbe = findBrowser, processRunner = runBotProcess, browserFactory, platform = process.platform, browserHeadless = false, acquireDesktopLease } = {}) {
  const browsers = new Map(), leases = new Map(), inFlight = new Map(), desktopClaims = new Map(), finishing = new Map();
  let helperPromise = null;
  function definitions(bot) {
    const chosen = [...(bot.capabilities !== 'computer' ? coding : []), ...(bot.capabilities !== 'code' ? computer : [])];
    return bot.policy === 'plan' ? chosen.filter(t => ['read_file', 'list_files', 'browser_snapshot'].includes(t.name)) : chosen;
  }
  async function pageFor(bot) {
    if (browsers.has(bot.id)) return browsers.get(bot.id);
    const found = browserProbe();
    if (!found.found) fail('Install Chrome, Edge or Chromium to use this bot’s browser.');
    const create = async () => {
      const { chromium } = await import('playwright-core');
      const browser = await chromium.launch({ executablePath: found.path, headless: browserHeadless });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      return { browser, context, page, close: () => browser.close() };
    };
    const pending = (browserFactory ?? create)();
    browsers.set(bot.id, pending);
    try { return await pending; } catch (error) { browsers.delete(bot.id); throw error; }
  }
  async function browserResult(page) {
    const content = (await page.locator('body').innerText({ timeout: 10000 })).slice(0, 24000);
    const screenshot = await page.screenshot({ type: 'png', timeout: 10000 });
    return { content: [{ type: 'text', text: `${page.url()}\n${content}` }, ...image(screenshot).content] };
  }
  async function helper(signal) {
    if (platform !== 'darwin') fail('Desktop input is supported on macOS. This bot can still use its browser.');
    const bundled = fileURLToPath(new URL('./bots-computer', import.meta.url));
    if (existsSync(bundled)) return bundled;
    if (!helperPromise) helperPromise = (async () => {
      const source = fileURLToPath(new URL('./bots-computer.swift', import.meta.url));
      const hash = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 16);
      const folder = join(directory, 'bot-tools'), executable = join(folder, `computer-${hash}`);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      if (!existsSync(executable)) {
        const result = await processRunner('/usr/bin/swiftc', [source, '-o', executable], { signal, timeout: 120000 });
        if (result.code !== 0) fail('Desktop controls could not be prepared. Install Xcode Command Line Tools, or use the packaged Mac app.');
      }
      return executable;
    })().catch(error => { helperPromise = null; throw error; });
    return helperPromise;
  }
  async function executeOne({ bot, chatId, name, args = {}, toolCallId, signal, onFrame = () => {}, requestPermission }) {
    if (!definitions(bot).some(t => t.name === name)) fail('This tool is not enabled for this bot’s capabilities or permission mode.');
    if (bot.execution.kind !== 'local') fail('This execution computer is not configured.');
    if (signal?.aborted) fail('The bot was stopped.');
    const id = toolCallId ?? `tool_${randomUUID()}`, started = Date.now();
    const requireRunning = () => { if (signal?.aborted) fail('The bot was stopped.'); };
    const card = { id, name, args, preview: name.replaceAll('_', ' '), effect: 'Bot tool', scope: 'connected' };
    const emit = (state, result) => onFrame({ type: 'agent-tool', tool: { ...card, state, ...(result ? { result } : {}), durationMs: Date.now() - started } });
    const readOnly = ['read_file', 'list_files', 'browser_snapshot'].includes(name);
    if (!readOnly && bot.policy !== 'bypass') {
      if (bot.policy === 'plan' || !await requestPermission({ id, name, args, reason: `Allow ${name.replaceAll('_', ' ')} on ${bot.name}’s computer?` })) { emit('denied', 'The action was not allowed.'); return { ...text('The action was not allowed. Do not retry it.'), isError: true }; }
    }
    requireRunning();
    const resource = name.startsWith('computer_') ? 'desktop' : name.startsWith('browser_') ? `browser:${bot.id}` : null;
    if (resource && leases.has(resource) && leases.get(resource) !== chatId) fail('Another bot conversation is using this computer. Wait for it to finish.');
    if (resource) leases.set(resource, chatId);
    emit('running');
    try {
      if (resource === 'desktop' && acquireDesktopLease) {
        // A remote worker needs a cross-process desktop lease. Acquire it only
        // after approval and share the claim across this turn's desktop calls.
        let claim = desktopClaims.get(chatId);
        if (!claim) {
          claim = Promise.resolve().then(() => acquireDesktopLease({ bot, chatId, signal }));
          desktopClaims.set(chatId, claim);
        }
        try { await claim; }
        catch (error) {
          if (desktopClaims.get(chatId) === claim) desktopClaims.delete(chatId);
          if (leases.get(resource) === chatId) leases.delete(resource);
          throw error;
        }
        requireRunning();
      }
      let result;
      if (name === 'read_file') {
        const file = await botWorkspacePath(bot.workspace, args.path);
        if ((await stat(file)).size > 1024 * 1024) fail('This file is too large. Read a smaller file.');
        result = text(await readFile(file, 'utf8'));
      } else if (name === 'list_files') {
        const folder = await botWorkspacePath(bot.workspace, args.path ?? '.');
        const entries = await readdir(folder, { withFileTypes: true });
        result = text(entries.slice(0, 1000).map(e => `${e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'link' : 'file'}\t${e.name}`).join('\n'));
      } else if (name === 'write_file') {
        if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 2 * 1024 * 1024) fail('Write a UTF-8 file of at most 2 MB.');
        const file = await botWorkspacePath(bot.workspace, args.path, { writing: true });
        if (signal?.aborted) fail('The bot was stopped.');
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.strata-${randomUUID()}.tmp`;
        let mode = 0o644; try { mode = (await stat(file)).mode & 0o777; } catch {}
        try { await writeFile(tmp, args.content, { mode }); if (signal?.aborted) fail('The bot was stopped.'); await rename(tmp, file); } finally { await rm(tmp, { force: true }).catch(() => {}); }
        result = text(`Saved ${relative(bot.workspace, file)}`);
      } else if (name === 'run_command') {
        if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 32000) fail('Enter a command of at most 32,000 characters.');
        const timeout = Math.min(120, Math.max(1, Number(args.timeoutSeconds) || 30)) * 1000;
        const run = await processRunner(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', args.command] : ['-c', args.command], { cwd: bot.workspace, signal, timeout, env: agentEnvironment(process.env) });
        result = { ...text(`Exit ${run.code}\n${run.stdout}${run.stderr ? `\n${run.stderr}` : ''}`), isError: run.code !== 0 };
      } else if (name.startsWith('browser_')) {
        if (bot.policy === 'plan' && !browsers.has(bot.id)) fail('Plan can inspect an existing bot browser. Open it in Manual mode first.');
        const { page } = await pageFor(bot);
        let closing;
        const abort = () => {
          const owned = browsers.get(bot.id); browsers.delete(bot.id);
          closing = owned ? Promise.resolve(owned).then(handle => handle.close()).catch(() => {}) : Promise.resolve();
        };
        signal?.addEventListener('abort', abort, { once: true });
        try {
          if (signal?.aborted) { abort(); requireRunning(); }
          if (name === 'browser_open') {
            const url = new URL(args.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Open an HTTP or HTTPS page without credentials in its address.');
            requireRunning(); await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } else if (name === 'browser_click') { requireRunning(); await page.getByRole(args.role, { name: args.name, exact: true }).click({ timeout: 10000 }); }
          else if (name === 'browser_type') { requireRunning(); await page.getByLabel(args.label, { exact: true }).fill(args.text, { timeout: 10000 }); }
          else if (name === 'browser_key') { requireRunning(); await page.keyboard.press(args.key); }
          requireRunning(); result = await browserResult(page); requireRunning();
        } finally { signal?.removeEventListener('abort', abort); await closing; }
      } else if (name.startsWith('computer_')) {
        const executable = await helper(signal);
        requireRunning();
        const operation = name.slice('computer_'.length);
        const folder = await mkdtemp(join(tmpdir(), 'strata-bot-screen-'));
        try {
          const output = join(folder, 'screen.png');
          const input = operation === 'screenshot' ? { path: output } : args;
          const run = await processRunner(executable, [operation, JSON.stringify(input)], { signal, timeout: 15000 });
          if (run.code !== 0) fail(run.stderr.trim() || 'The Mac could not perform this computer action.');
          result = operation === 'screenshot' ? image(await readFile(output)) : text(run.stdout || 'Computer action completed.');
        } finally { await rm(folder, { force: true, recursive: true }); }
      }
      if (!result) fail('Unknown bot tool.');
      const summary = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 24000) || 'Captured a screenshot.';
      emit(result.isError ? 'error' : 'done', summary);
      return result;
    } catch (error) { emit('error', error.message); throw error; }
    // Ownership lasts for the turn. Another chat must not click between this
    // bot's screenshot and its next input action.
  }
  function execute(args) {
    const pending = executeOne(args);
    if (!inFlight.has(args.chatId)) inFlight.set(args.chatId, new Set());
    const calls = inFlight.get(args.chatId); calls.add(pending);
    pending.finally(() => { calls.delete(pending); if (!calls.size) inFlight.delete(args.chatId); }).catch(() => {});
    return pending;
  }
  function finish(chatId) {
    if (finishing.has(chatId)) return finishing.get(chatId);
    const pending = (async () => {
      await Promise.allSettled([...(inFlight.get(chatId) ?? [])]);
      const claim = desktopClaims.get(chatId);
      if (claim) {
        const release = await claim;
        await release(); // Failed release keeps ownership and is surfaced to cleanup quarantine.
        if (desktopClaims.get(chatId) === claim) desktopClaims.delete(chatId);
      }
      for (const [resource, owner] of leases) if (owner === chatId) leases.delete(resource);
    })();
    finishing.set(chatId, pending);
    pending.finally(() => { if (finishing.get(chatId) === pending) finishing.delete(chatId); }).catch(() => {});
    return pending;
  }
  return { definitions, execute, finish, async close() {
    await Promise.allSettled([...browsers.values()].map(async pending => (await pending).close()));
    await Promise.allSettled([...inFlight.values()].flatMap(calls => [...calls]));
    const released = await Promise.allSettled([...new Set([...desktopClaims.keys(), ...leases.values()])].map(finish));
    browsers.clear();
    const failed = released.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    leases.clear();
  } };
}
