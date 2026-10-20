/** A private per-bot volume and opt-in routines. Shared conversations remain the transcript authority. */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { nextRun as scheduledNext } from './tasks.mjs';
const fault = (status, message) => Object.assign(new Error(message), { status });
const copy = value => structuredClone(value);
const text = (value, max, label) => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw fault(400, `Enter valid ${label}.`); return value; };
const behaviors = ['allow','pre-approved','ask','hand-off'];
export function botRoutineNext(schedule, after = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!schedule || typeof schedule !== 'object') throw fault(400, 'Choose a routine schedule.');
  if (schedule.kind === 'every') {
    if (!Number.isInteger(schedule.minutes) || schedule.minutes < 1 || schedule.minutes > 10080) throw fault(400, 'Choose an interval from 1 to 10,080 minutes.');
    return new Date(after + schedule.minutes * 60000).toISOString();
  }
  if (!['daily','weekly'].includes(schedule.kind) || !Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23 || !Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59 || schedule.kind === 'weekly' && (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6)) throw fault(400, 'Choose a valid day and time.');
  return scheduledNext({ frequency: schedule.kind, at: `${String(schedule.hour).padStart(2,'0')}:${String(schedule.minute).padStart(2,'0')}`, weekday: schedule.weekday ?? 0, timeZone }, after);
}
export function createBotWork({ directory, requireBot, chats, createConversation, now = Date.now, notify = () => {}, tickMs = 15000 }) {
  const anchor = existsSync(directory) ? realpathSync(directory) : resolve(directory);
  const root = join(anchor, 'bot-volumes'), routines = new Map();
  let closed = false;
  function confined(file) {
    const rel = relative(anchor, file);
    if (isAbsolute(rel) || rel.startsWith('..')) throw fault(400, 'This bot file is outside its volume.');
    let parent = anchor;
    for (const part of rel.split('/')) {
      parent = join(parent, part);
      try { if (lstatSync(parent).isSymbolicLink()) throw fault(400, 'Bot volume links are not supported.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return file;
  }
  const folder = id => { requireBot(id); if (!/^bot_[a-f0-9-]+$/.test(id)) throw fault(400, 'Choose a valid bot.'); return confined(join(root, id)); };
  function atomic(file, content) {
    confined(file);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    confined(file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); chmodSync(file, 0o600); }
    finally { try { unlinkSync(temporary); } catch {} }
  }
  function pathOf(id, input, writing = false) {
    const path = text(input, 500, 'bot file path');
    if (!/^(outputs|memory|inbox)\//.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\\]/.test(part)) || path.split('/').length > 10) throw fault(400, 'Choose a file inside this bot’s outputs, memory or inbox.');
    const base = folder(id), file = resolve(base, path), rel = relative(base, file);
    if (isAbsolute(rel) || rel.startsWith('..')) throw fault(400, 'This bot file is outside its volume.');
    confined(file);
    if (!writing && !existsSync(file)) throw fault(404, 'This bot file is unavailable.');
    return file;
  }
  function metadata(id) {
    const file = confined(join(folder(id), 'work.json'));
    if (!existsSync(file)) return { rules: [] };
    try { const value = JSON.parse(readFileSync(file, 'utf8')); if (!Array.isArray(value.rules)) throw new Error(); return value; }
    catch { throw fault(503, 'This bot’s work settings could not be read. Their files were left unchanged.'); }
  }
  function files(id) {
    const base = folder(id), found = [];
    const visit = (path, depth = 0) => {
      confined(path);
      if (depth > 10 || !existsSync(path)) return;
      for (const item of readdirSync(path, { withFileTypes: true })) {
        if (found.length >= 1000) return;
        const full = join(path, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) visit(full, depth + 1);
        else if (item.isFile()) { const stat = lstatSync(full); found.push({ path: relative(base, full).replaceAll('\\','/'), name: item.name, size: stat.size, modified: stat.mtime.toISOString() }); }
      }
    };
    for (const name of ['outputs','memory','inbox']) visit(join(base, name));
    return found.sort((a,b) => b.modified.localeCompare(a.modified));
  }
  const routineFile = confined(join(root, 'routines.json'));
  const saveRoutines = () => { if (!routines.size && !existsSync(confined(routineFile))) return; atomic(routineFile, JSON.stringify([...routines.values()])); };
  if (existsSync(routineFile)) {
    let saved; try { saved = JSON.parse(readFileSync(routineFile,'utf8')); if (!Array.isArray(saved)) throw new Error(); } catch { throw fault(503, 'Saved bot routines could not be read. Their file was left unchanged.'); }
    for (const item of saved) {
      if (!item || typeof item.id !== 'string' || typeof item.botId !== 'string') throw fault(503, 'A saved bot routine is invalid.');
      const routine = { ...item };
      if (routine.state === 'running') { routine.state = 'interrupted'; routine.detail = 'Strata restarted while this routine was running. The previous run was not replayed.'; }
      if (routine.enabled) routine.nextRun = botRoutineNext(routine.schedule, now(), routine.timeZone);
      routines.set(routine.id, routine);
    }
  }
  function list(id) {
    const settings = metadata(id), entries = files(id), memoryPath = confined(join(folder(id), 'memory/MEMORY.md'));
    let memory = '';
    if (existsSync(memoryPath)) { if (lstatSync(memoryPath).size > 512000) throw fault(413, 'This bot memory file is too large.'); memory = readFileSync(memoryPath,'utf8').slice(0,128000); }
    return { memory, rules: copy(settings.rules), routines: [...routines.values()].filter(r => r.botId === id).map(copy), outputs: entries.filter(f => f.path.startsWith('outputs/')), files: entries };
  }
  function putFile(id, input) {
    const content = text(input?.content, 2 * 1024 * 1024, 'file content'), file = pathOf(id, input?.path, true);
    if (Buffer.byteLength(content) > 2 * 1024 * 1024 || input.path === 'memory/MEMORY.md' && content.length > 128000) throw fault(413, 'This bot file is too large.');
    atomic(file, content); notify('bots', { changed: id }); return { saved: input.path };
  }
  function getFile(id, path) { const file = pathOf(id, path); if (lstatSync(file).size > 2 * 1024 * 1024) throw fault(413, 'This bot file is too large to preview.'); return { text: readFileSync(file,'utf8') }; }
  function update(id, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['memory','rules'].includes(key))) throw fault(400, 'Choose memory or rules to update.');
    const old = metadata(id);
    if (patch.rules !== undefined) {
      if (!Array.isArray(patch.rules) || patch.rules.length > 100) throw fault(400, 'Add up to 100 bot rules.');
      old.rules = patch.rules.map(rule => {
        if (!rule || !behaviors.includes(rule.behavior)) throw fault(400, 'Choose a valid rule behavior.');
        return { id: text(rule.id || randomUUID(), 100, 'rule ID'), action: text(rule.action, 1000, 'rule action'), behavior: rule.behavior, ...(rule.actionClass ? { actionClass: text(rule.actionClass, 80, 'rule class') } : {}), locked: rule.locked === true, isBuiltIn: rule.isBuiltIn === true };
      });
    }
    if (patch.memory !== undefined) putFile(id, { path: 'memory/MEMORY.md', content: text(patch.memory, 128000, 'memory') });
    atomic(join(folder(id),'work.json'), JSON.stringify(old)); notify('bots', { changed: id }); return list(id);
  }
  function routine(id, routineId) { const row = routines.get(routineId); if (!row || row.botId !== id) throw fault(404, 'This bot routine is unavailable.'); requireBot(id); return row; }
  function putRoutine(id, input, routineId) {
    requireBot(id); const old = routineId ? routine(id, routineId) : null;
    if (old?.state === 'running') throw fault(409, 'Stop this routine’s conversation before changing its schedule.');
    const fields = { ...old, ...input }, title = text(fields.title, 120, 'routine title').trim(), prompt = text(fields.prompt, 12000, 'routine instructions').trim();
    if (!title || !prompt) throw fault(400, 'Give the routine a title and instructions.');
    const timeZone = fields.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { throw fault(400, 'Choose a valid time zone.'); }
    const next = botRoutineNext(fields.schedule, now(), timeZone), enabled = fields.enabled === true;
    const row = { id: old?.id ?? randomUUID(), botId: id, title, prompt, schedule: copy(fields.schedule), timeZone, enabled, notifyOnCompletion: fields.notifyOnCompletion === true, nextRun: enabled ? next : null, lastRun: old?.lastRun ?? null, state: 'idle', createdAt: old?.createdAt ?? new Date(now()).toISOString() };
    routines.set(row.id, row); saveRoutines(); notify('bots', { changed: id }); return copy(row);
  }
  function runRoutine(id, routineId) {
    if (closed) throw fault(503, 'Bot routines are closed.');
    const row = routine(id, routineId), bot = requireBot(id);
    if (bot.paused) throw fault(409, 'This bot is paused. Resume it before running a routine.');
    if (row.state === 'running' || (chats()?.list().conversations ?? []).some(c => c.preferences?.botId === id && c.active)) throw fault(409, 'This bot is already working.');
    row.lastRun = new Date(now()).toISOString(); row.nextRun = row.enabled ? botRoutineNext(row.schedule, now(), row.timeZone) : null;
    try { const result = createConversation(id); row.chatId = result.conversation.id; row.state = 'running'; chats().send(row.chatId, row.prompt); }
    catch (error) { row.state = 'error'; row.detail = error.message; saveRoutines(); throw error; }
    saveRoutines(); notify('bots', { changed: id }); return { routine: copy(row), conversation: chats().detail(row.chatId).conversation };
  }
  function removeRoutine(id, routineId) { const row = routine(id, routineId); if (row.state === 'running') throw fault(409, 'Stop its shared conversation before removing this routine.'); routines.delete(routineId); saveRoutines(); return { deleted: routineId }; }
  function tick() {
    if (closed) return;
    for (const row of routines.values()) {
      if (row.state === 'running' && row.chatId) {
        let chat; try { chat = chats()?.detail(row.chatId).conversation; } catch {}
        if (!chat) { row.state = 'interrupted'; row.detail = 'The shared conversation is unavailable.'; saveRoutines(); }
        if (chat && !chat.active) { row.state = chat.messages.at(-1)?.error ? 'error' : 'done'; row.detail = chat.messages.at(-1)?.error ?? null; saveRoutines(); if (row.notifyOnCompletion) notify('bots', { routineCompleted: copy(row) }); }
      }
      if (row.enabled && row.state !== 'running' && row.nextRun && Date.parse(row.nextRun) <= now()) {
        row.nextRun = botRoutineNext(row.schedule, now(), row.timeZone); saveRoutines();
        if (requireBot(row.botId).paused) continue;
        try { runRoutine(row.botId, row.id); } catch (error) { row.detail = error.message; saveRoutines(); }
      }
    }
  }
  const timer = tickMs > 0 ? setInterval(tick, tickMs) : null; timer?.unref();
  return { list, update, putFile, getFile, putRoutine, removeRoutine, runRoutine, tick,
    instructions(id) { if (!existsSync(folder(id))) return ''; const value = list(id); return [value.memory ? `Persistent memory for this bot:\n${value.memory}` : '', value.rules.length ? `Your owner’s standing action preferences (Strata’s permission mode still applies):\n${value.rules.map(rule => `${rule.behavior}: ${rule.action}`).join('\n')}` : '', 'Keep persistent notes in memory/MEMORY.md and finished text deliverables in outputs/ using the approved write_file tool. Strata retains these files in this bot’s private volume.'].filter(Boolean).join('\n\n'); },
    record(id, frame) { if (frame.type !== 'agent-tool' || frame.tool?.state !== 'done' || frame.tool?.name !== 'write_file' || typeof frame.tool.args?.content !== 'string') return; const path = frame.tool.args.path; if (path === 'memory/MEMORY.md' || typeof path === 'string' && path.startsWith('outputs/')) { try { putFile(id, { path, content: frame.tool.args.content }); } catch {} } },
    removed(id) { for (const routine of routines.values()) if (routine.botId === id) { routine.enabled = false; routine.nextRun = null; } saveRoutines(); },
    close() { closed = true; if (timer) clearInterval(timer); },
  };
}
