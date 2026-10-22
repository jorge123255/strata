/** Private action receipts. They prevent replay of an exact call, not business-level exactly-once effects. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { BOT_TOOL_NO_EFFECT } from './bots-runtime/tool-outcome.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, ordered(value[key])])) : value;
const fail = (message, code = 'harness_action_receipt') => Object.assign(new Error(message), { status: 409, code });
const ID = /^ba_[a-f0-9]{64}$/, HEX = /^[a-f0-9]{64}$/, STATES = ['pending', 'succeeded', 'error', 'interrupted', 'uncertain', 'reviewed'];
const unresolved = state => ['pending', 'uncertain', 'interrupted'].includes(state);
// Exact host-owned read implementations only; never infer safety from an MCP name/prefix.
const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'browser_snapshot', 'computer_screenshot', 'check_created_tool', 'authorize_created_tool', 'list_created_tools', 'read_created_tool', 'list_skills', 'read_skill', 'search_tools', 'list_teammates', 'list_subagents', 'read_team_message', 'read_team_results', 'read_team_work', 'host_list_files', 'host_read_file']);
const readOnly = name => READ_ONLY_TOOLS.has(name);
const actionGuardKey = row => hash([row.origin, row.scopeHash, row.authorityHash, row.turnHash, row.actionHash]);
const toolLabel = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : `tool_${hash(String(value)).slice(0, 16)}`;
const incarnationCache = new Map();
function processIncarnation(pid) {
  const cached = incarnationCache.get(pid);
  if (cached && (pid === process.pid || Date.now() - cached.at < 1000)) return cached.value;
  let value = null;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), started = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
      value = hash([readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), started]);
    } else if (process.platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4096, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } });
      if (result.status === 0 && result.stdout.trim()) value = hash(result.stdout.trim());
    }
  } catch {}
  if (incarnationCache.size > 512) incarnationCache.clear();
  incarnationCache.set(pid, { at: Date.now(), value }); return value;
}
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const uncertainAdvice = 'This action may have changed the outside world. Do not retry it automatically; inspect its conversation and receipt first.';
const message = 'This exact tool call already has a durable receipt. Inspect its conversation and receipt before making a new request. It was not executed again.';
const replay = () => ({ content: [{ type: 'text', text: message }], isError: true });
function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw fail('The bot action receipt directory is not private. Its files were left unchanged.');
}
function syncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) { if (process.platform !== 'win32' || !['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function readRow(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192 || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw fail('A bot action receipt is unavailable. Its file was left unchanged.');
  const row = JSON.parse(readFileSync(path, 'utf8'));
  const allowed = row?.origin === 'ssh-worker-mirror' ? ['version', 'id', 'chatId', 'toolName', 'state', 'revision', 'proof', 'startedAt', 'updatedAt', 'origin', 'readOnly'] : ['version', 'id', 'chatId', 'scopeHash', 'authorityHash', 'turnHash', 'callHash', 'actionHash', 'toolName', 'state', 'revision', 'startedAt', 'updatedAt', 'ownerPid', 'ownerNonce', 'ownerIncarnation', 'origin'];
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !allowed.includes(key))) throw fail('A bot action receipt has unknown fields. Its file was left unchanged.');
  if (row?.version !== 1 || !ID.test(row.id) || typeof row.chatId !== 'string' || row.chatId.length > 200 || !/^[A-Za-z0-9_.:-]{1,120}$/.test(row.toolName) || !STATES.includes(row.state) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isFinite(row.startedAt) || !Number.isFinite(row.updatedAt)) throw fail('A bot action receipt is invalid. Its file was left unchanged.');
  if (row.origin === 'ssh-worker-mirror') {
    if (!HEX.test(row.proof) || row.readOnly !== true) throw fail('An SSH action receipt is invalid. Its file was left unchanged.');
  } else if (!['local', 'ssh-worker'].includes(row.origin) || !['scopeHash', 'authorityHash', 'turnHash', 'callHash', 'actionHash'].every(key => HEX.test(row[key])) || !Number.isInteger(row.ownerPid) || row.ownerPid < 1 || typeof row.ownerNonce !== 'string' || row.ownerIncarnation !== undefined && row.ownerIncarnation !== null && !HEX.test(row.ownerIncarnation)) throw fail('A bot action receipt is invalid. Its file was left unchanged.');
  return row;
}

export function botActionTurnIdentity(session, message, liveSession) {
  // Conversations passes the pre-send history; its persisted streaming assistant identifies this turn.
  const assistant = [...(liveSession?.messages ?? [])].reverse().find(row => row.role === 'assistant' && row.streaming === true && typeof row.id === 'string');
  return hash(assistant ? ['assistant', assistant.id] : ['history-boundary', (session.messages ?? []).map(row => [row.id ?? null, row.role, row.at ?? null]), String(message ?? '')]);
}

export function createBotActionJournal({ directory, now = Date.now, retention = 1000, processExists = processAlive, processIdentity = processIncarnation, onRecord = () => {} } = {}) {
  const inFlight = new Map(), ownerNonce = randomUUID();
  const keep = Math.max(0, Math.min(10000, Number.isInteger(retention) ? retention : 1000));
  const pathFor = (id, remote = false) => join(directory, `${remote ? 'remote_' : ''}${id}.json`);
  let unavailable = false, settledSincePrune = 0, uncertainActions;
  function uncertaintyIndex() {
    if (!uncertainActions) {
      uncertainActions = new Set();
      for (const row of rows()) if (row.origin !== 'ssh-worker-mirror' && !readOnly(row.toolName) && (['uncertain', 'interrupted', 'reviewed'].includes(effective(row).state) || row.state === 'pending' && row.ownerNonce !== ownerNonce)) uncertainActions.add(actionGuardKey(row));
    }
    return uncertainActions;
  }
  function effective(row) {
    // A live peer worker's pending receipt is not our crashed work. Never mutate owner files at startup.
    if (row.origin === 'ssh-worker-mirror' || row.state !== 'pending') return row;
    if (!processExists(row.ownerPid)) return { ...row, state: 'uncertain' };
    const current = row.ownerIncarnation ? processIdentity(row.ownerPid) : null;
    return current && current !== row.ownerIncarnation ? { ...row, state: 'uncertain' } : row;
  }
  function view(raw) {
    const row = effective(raw);
    const result = { id: row.id, chatId: row.chatId, toolName: row.toolName, state: row.state, revision: row.revision, startedAt: row.startedAt, updatedAt: row.updatedAt, origin: row.origin === 'ssh-worker-mirror' ? 'ssh-worker' : row.origin, readOnly: row.origin === 'ssh-worker-mirror' };
    return { ...result, proof: row.origin === 'ssh-worker-mirror' ? row.proof : hash(result) };
  }
  function write(row, { exclusive = false, remote = false } = {}) {
    privateDirectory(directory);
    const destination = pathFor(row.id, remote), temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(exclusive ? destination : temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(row)); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (!exclusive) renameSync(temporary, destination);
      syncDirectory(directory);
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
    onRecord(view(row));
  }
  function rows() {
    if (!existsSync(directory)) return [];
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077)) { unavailable = true; return []; }
    const result = [];
    for (const name of readdirSync(directory)) {
      if (!/^(?:remote_)?ba_[a-f0-9]{64}\.json$/.test(name)) continue;
      try { result.push(readRow(join(directory, name))); } catch { unavailable = true; }
    }
    return result;
  }
  function prune() {
    // Batch retention scans, not durable reservations/outcomes. At the default
    // 1000 settled receipts this admits at most31 additional local settlements
    // between scans; unresolved receipts are never eviction candidates.
    if (keep >= 64 && ++settledSincePrune < 32) return;
    settledSincePrune = 0;
    // Most libraries stay below retention. Avoid reopening every receipt on every settled action.
    if (readdirSync(directory).filter(name => /^(?:remote_)?ba_[a-f0-9]{64}\.json$/.test(name)).length <= keep) return;
    const candidates = rows().filter(row => !unresolved(effective(row).state)).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
    // Bound settled history. Uncertain/interrupted/live receipts never expire;
    // deduplication of older settled calls is limited to this retained window.
    for (const row of candidates.slice(keep)) {
      const path = pathFor(row.id, row.origin === 'ssh-worker-mirror');
      const current = lookup(row.id, row.origin === 'ssh-worker-mirror');
      if (current && current.revision === row.revision && !unresolved(effective(current).state)) { unlinkSync(path); uncertainActions?.delete(actionGuardKey(current)); }
    }
  }
  function lookup(id, remote = false) {
    const path = pathFor(id, remote);
    if (!existsSync(path)) return null;
    try { return readRow(path); } catch { throw fail('This exact action has an unreadable receipt. It cannot be executed again.'); }
  }
  function execute({ chatId, authority, turnId, toolCallId, name, args = {}, signal, assertLive = () => {}, noEffect = () => false, origin = 'local' }, dispatch) {
    if (typeof chatId !== 'string' || !chatId || chatId.length > 200 || typeof turnId !== 'string' || !turnId || turnId.length > 512 || typeof authority !== 'string' || !HEX.test(authority) || !['local', 'ssh-worker'].includes(origin)) return Promise.reject(fail('The action recovery scope is unavailable.'));
    // Missing provider IDs are intentionally anonymous. They have no cross-restart deduplication claim.
    const callId = typeof toolCallId === 'string' && toolCallId.length <= 200 ? toolCallId : `anonymous_${randomUUID()}`;
    const id = `ba_${hash([origin, chatId, turnId, callId])}`, actionHash = hash(ordered([name, args])), current = inFlight.get(id);
    if (current) return current.authority !== authority || current.actionHash !== actionHash ? Promise.reject(fail('This tool identity already belongs to a different action or authority.', 'harness_action_conflict')) : current.promise;
    let old;
    try { old = lookup(id); } catch (error) { return Promise.reject(error); }
    if (old) {
      if (old.authorityHash !== authority || old.actionHash !== actionHash) return Promise.reject(fail('This tool identity already belongs to a different action or authority.', 'harness_action_conflict'));
      return Promise.resolve(replay());
    }
    const row = { version: 1, id, chatId, scopeHash: hash(chatId), authorityHash: authority, turnHash: hash(turnId), callHash: hash(callId), actionHash, toolName: toolLabel(name), state: 'pending', revision: 1, startedAt: now(), updatedAt: now(), ownerPid: process.pid, ownerNonce, ownerIncarnation: processIdentity(process.pid), origin };
    if (!readOnly(name) && uncertaintyIndex().has(actionGuardKey(row))) return Promise.reject(fail('This same action has an uncertain receipt in the current turn. Do not retry it automatically. Inspect its conversation and make a new explicit request after checking what happened.', 'harness_action_uncertain'));
    let resolvePromise, rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    inFlight.set(id, { authority, actionHash, promise });
    void (async () => {
      let dispatched = false;
      try {
        signal?.throwIfAborted(); assertLive();
        try { write(row, { exclusive: true }); }
        catch (error) { if (error.code === 'EEXIST') { const raced = lookup(id); if (raced?.authorityHash !== authority || raced?.actionHash !== actionHash) throw fail('This tool identity already belongs to a different action or authority.', 'harness_action_conflict'); return replay(); } throw error; }
        signal?.throwIfAborted(); assertLive(); dispatched = true;
        const value = await dispatch();
        let confirmedNoEffect = readOnly(name) || value?.[BOT_TOOL_NO_EFFECT] === true;
        try { confirmedNoEffect ||= noEffect() === true; } catch {}
        row.state = value?.isError && confirmedNoEffect ? 'error' : signal?.aborted ? 'interrupted' : value?.isError ? 'uncertain' : 'succeeded';
        if (['uncertain', 'interrupted'].includes(row.state) && !readOnly(name)) uncertaintyIndex().add(actionGuardKey(row));
        row.revision++; row.updatedAt = now(); write(row); prune();
        return row.state === 'uncertain' && Array.isArray(value?.content) ? { ...value, content: [...value.content, { type: 'text', text: uncertainAdvice }] } : value;
      } catch (error) {
        // A thrown callback can have failed after changing the outside world. Never assume rollback.
        if (existsSync(pathFor(id)) && lookup(id)?.ownerNonce === ownerNonce) {
          row.state = readOnly(name) ? 'error' : dispatched ? signal?.aborted ? 'interrupted' : 'uncertain' : 'interrupted'; row.revision++; row.updatedAt = now();
          if (!readOnly(name)) uncertaintyIndex().add(actionGuardKey(row));
          if (dispatched && !readOnly(name)) { try { error.message = `${error.message ?? 'The tool failed.'} ${uncertainAdvice}`; } catch {} }
          try { write(row); } catch { /* the durable pending receipt still forbids replay */ }
        }
        throw error;
      }
    })().then(resolvePromise, rejectPromise).finally(() => inFlight.delete(id));
    return promise;
  }
  function summary(chatId, { limit = 200 } = {}) {
    unavailable = false;
    const all = rows().filter(row => !chatId || row.chatId === chatId).map(view).sort((a, b) => Number(['uncertain', 'interrupted'].includes(b.state)) - Number(['uncertain', 'interrupted'].includes(a.state)) || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
    const counts = Object.fromEntries(STATES.map(state => [state, all.filter(row => row.state === state).length]));
    const visible = all;
    const size = Math.max(0, Math.min(200, Number.isInteger(limit) ? limit : 200));
    return { available: !unavailable, counts, actions: visible.slice(0, size), hasMore: visible.length > size };
  }
  function review(id, input) {
    if (!ID.test(id) || !input || Object.keys(input).some(key => !['expectedRevision', 'expectedProof', 'decision'].includes(key)) || input.decision !== 'acknowledge' || !Number.isSafeInteger(input.expectedRevision) || !HEX.test(input.expectedProof ?? '')) throw fail('Review this exact action receipt before acknowledging it.');
    const row = lookup(id);
    if (!row) { if (lookup(id, true)) throw fail('SSH worker receipts are read-only here. Acknowledgement cannot clear remote uncertainty or computer cleanup.'); throw fail('This action receipt is unavailable.'); }
    const publicRow = view(row);
    if (publicRow.revision !== input.expectedRevision || publicRow.proof !== input.expectedProof || !['uncertain', 'interrupted'].includes(publicRow.state)) throw fail('This action receipt changed or is still running. Read it again before acknowledging it.');
    row.state = 'reviewed'; row.revision++; row.updatedAt = now(); write(row); prune();
    return { acknowledged: true, action: view(row), resumed: false, retried: false };
  }
  function observeRemote(value, chatId) {
    if (!value || value.chatId !== chatId || !ID.test(value.id ?? '') || !STATES.includes(value.state) || !HEX.test(value.proof ?? '') || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isFinite(value.startedAt) || !Number.isFinite(value.updatedAt)) throw fail('The SSH worker returned an invalid action receipt.');
    const old = lookup(value.id, true);
    if (old && old.revision > value.revision) return;
    const row = { version: 1, id: value.id, chatId, toolName: toolLabel(value.toolName), state: value.state, revision: value.revision, proof: value.proof, startedAt: value.startedAt, updatedAt: value.updatedAt, origin: 'ssh-worker-mirror', readOnly: true };
    write(row, { remote: true }); prune();
  }
  function markRemoteUncertain(chatId) {
    for (const row of rows()) if (row.origin === 'ssh-worker-mirror' && row.chatId === chatId && row.state === 'pending') {
      row.state = 'uncertain'; row.revision++; row.updatedAt = now();
      // Host projections may mark a lost reply uncertain, but never assert remote completion.
      row.proof = hash([row.id, row.revision, row.state]); write(row, { remote: true });
    }
  }
  return { execute, summary, review, observeRemote, markRemoteUncertain };
}
