/** Public team conversation has its own journal; private bot transcripts are never copied into it. */
import { randomUUID } from 'node:crypto';
import { privateExtensionStore } from './bots-extension-store.mjs';

const fault = (status, message) => Object.assign(new Error(message), { status });
const copy = value => structuredClone(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const states = new Set(['queued', 'working', 'done', 'error', 'interrupted']);
const kinds = new Set(['message', 'assignment', 'report', 'status']);
const cursor = value => Number.isSafeInteger(value) && value >= 0;
const planId = value => typeof value === 'string' && /^tp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const planEvents = new Map([['blocked', 'interrupted'], ['awaiting_review', 'done']]);
// This is a host status marker, never a model's claim of completion. Existing
// state values stay compatible with clients that do not know plan events.
const validPlanEvent = message => message.planEvent === undefined || planEvents.has(message.planEvent) && message.kind === 'status' && planId(message.planId) && ['system', 'bot'].includes(message.author?.type) && (message.author.type !== 'bot' || id(message.author.botId)) && message.state === planEvents.get(message.planEvent);
const recoveryIds = ['retry', 'skip', 'different'];
function validRecovery(message) {
  const recovery = message?.recovery;
  if (recovery === undefined) return true;
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return false;
  if (Object.keys(recovery).some(key => !['jobId', 'runId', 'question', 'options', 'choice'].includes(key))) return false;
  if (!/^tj_[a-f0-9-]+$/.test(recovery.jobId) || !/^tr_[a-f0-9-]+$/.test(recovery.runId)) return false;
  if (typeof recovery.question !== 'string' || !recovery.question.trim() || recovery.question.length > 240) return false;
  if (recovery.choice !== undefined && !recoveryIds.includes(recovery.choice)) return false;
  if (!Array.isArray(recovery.options) || recovery.options.length !== recoveryIds.length) return false;
  return recovery.options.every((option, index) => option && option.id === recoveryIds[index] && typeof option.label === 'string' && option.label.trim() && option.label.length <= 80 && Object.keys(option).every(key => key === 'id' || key === 'label'));
}

export function createTeamChannels({ directory, now = Date.now, notify = () => {} }) {
  const storage = privateExtensionStore(directory, 'bot-team-channels.json', { version: 1, channels: [], receipts: [] });
  const channels = new Map(), receipts = new Map();
  const saved = storage.value;
  if (!Array.isArray(saved.channels) || saved.channels.length > 50 || !Array.isArray(saved.receipts) || saved.receipts.length > 20000) throw fault(503, 'Saved team channels could not be read. They were left unchanged.');
  for (const row of saved.channels) {
    if (!id(row?.teamId) || channels.has(row.teamId) || !Array.isArray(row.messages) || !cursor(row.nextSequence) || row.nextSequence < 1) throw fault(503, 'A saved team channel is invalid.');
    let previous = 0; const seen = new Set();
    for (const message of row.messages) {
      if (message.planId !== undefined && !planId(message.planId)) throw fault(503, 'A saved work-plan reference is invalid.');
      if (!validPlanEvent(message)) throw fault(503, 'A saved work-plan status event is invalid.');
      if (message.replyGroupId !== undefined && !id(message.replyGroupId)) throw fault(503, 'A saved team message is invalid.');
      if (!validRecovery(message)) throw fault(503, 'A saved recovery choice is invalid.');
      if (!id(message?.id) || seen.has(message.id) || message.teamId !== row.teamId || !cursor(message.sequence) || message.sequence <= previous || message.sequence >= row.nextSequence || !kinds.has(message.kind) || typeof message.content !== 'string' || message.content.length > 16000 || !['user', 'bot', 'system'].includes(message.author?.type) || typeof message.author.name !== 'string' || typeof message.createdAt !== 'string' || message.state && !states.has(message.state) || message.workMode !== undefined && !['chat', 'work'].includes(message.workMode)) throw fault(503, 'A saved team message is invalid.');
      previous = message.sequence; seen.add(message.id);
    }
    channels.set(row.teamId, copy(row));
  }
  for (const receipt of saved.receipts) {
    if (!id(receipt?.teamId) || !id(receipt.requestId) || typeof receipt.digest !== 'string' || !id(receipt.messageId) || !id(receipt.runId)) throw fault(503, 'A saved team delivery receipt is invalid.');
    const key = `${receipt.teamId}:${receipt.requestId}`; if (receipts.has(key)) throw fault(503, 'A saved team delivery receipt is duplicated.'); receipts.set(key, copy(receipt));
  }
  const value = () => ({ version: 1, channels: [...channels.values()], receipts: [...receipts.values()] });
  function save() {
    if (Buffer.byteLength(JSON.stringify(value())) > 28 * 1024 * 1024) throw fault(503, 'The team channel journal reached its size limit. Existing history was retained.');
    storage.save(value());
  }
  function append(teamId, input, receipt) {
    if (input.planId !== undefined && !planId(input.planId)) throw fault(400, 'Choose a valid work-plan reference.');
    if (input.replyGroupId !== undefined && !id(input.replyGroupId)) throw fault(400, 'Choose a valid reply group.');
    if (!validPlanEvent(input)) throw fault(400, 'Choose a valid host work-plan status event.');
    if (!validRecovery(input)) throw fault(400, 'A saved recovery choice is invalid.');
    const old = channels.get(teamId), row = old ?? { teamId, nextSequence: 1, messages: [] };
    if (row.messages.length >= 50000) throw fault(503, 'This team channel reached its history limit. Existing history was retained.');
    const message = { id: input.id ?? `tm_${randomUUID()}`, sequence: row.nextSequence, teamId, kind: input.kind ?? 'message', author: copy(input.author), content: String(input.content).slice(0, 16000), createdAt: new Date(now()).toISOString(), ...Object.fromEntries(['replyToId', 'recipientIds', 'runId', 'chatId', 'state', 'workMode', 'planId', 'planEvent', 'replyGroupId', 'recovery'].filter(key => input[key] !== undefined).map(key => [key, copy(input[key])])) };
    if (row.messages.some(item => item.id === message.id)) return copy(row.messages.find(item => item.id === message.id));
    const receiptKey = receipt ? `${teamId}:${receipt.requestId}` : undefined;
    if (receipt && (receipts.has(receiptKey) || receipts.size >= 20000)) throw fault(503, 'The team channel receipt is unavailable. Existing history was retained.');
    const next = { ...row, nextSequence: row.nextSequence + 1, messages: [...row.messages, message] }; channels.set(teamId, next);
    if (receipt) receipts.set(receiptKey, { ...copy(receipt), teamId, messageId: message.id });
    try { save(); } catch (error) { old ? channels.set(teamId, old) : channels.delete(teamId); if (receipt) receipts.delete(receiptKey); throw error; }
    notify('bots', { teamsChanged: true, teamChannelChanged: teamId }); return copy(message);
  }
  function setRecoveryChoice(teamId, messageId, choice) {
    if (!recoveryIds.includes(choice)) throw fault(400, 'A saved recovery choice is invalid.');
    const row = channels.get(teamId), index = row?.messages.findIndex(item => item.id === messageId) ?? -1;
    if (!row || index < 0 || !row.messages[index].recovery) throw fault(404, 'This choice is unavailable.');
    const message = copy(row.messages[index]);
    message.recovery = { ...message.recovery, choice };
    if (!validRecovery(message)) throw fault(400, 'A saved recovery choice is invalid.');
    const messages = row.messages.slice();
    messages[index] = message;
    const next = { ...row, messages }, old = row;
    channels.set(teamId, next);
    try { save(); } catch (error) { channels.set(teamId, old); throw error; }
    notify('bots', { teamsChanged: true, teamChannelChanged: teamId });
    return copy(message);
  }
  function snapshot(teamId, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['after', 'before'].includes(key)) || options.after !== undefined && !cursor(options.after) || options.before !== undefined && !cursor(options.before) || options.after !== undefined && options.before !== undefined) throw fault(400, 'Choose one valid team channel cursor.');
    const all = channels.get(teamId)?.messages ?? [];
    const filtered = all.filter(row => options.after === undefined || row.sequence > options.after).filter(row => options.before === undefined || row.sequence < options.before);
    const rows = options.after !== undefined ? filtered.slice(0, 100) : filtered.slice(-100);
    const hasMoreBefore = rows.length ? all.some(row => row.sequence < rows[0].sequence) : options.after !== undefined && all.some(row => row.sequence <= options.after);
    return { teamId, supported: true, messages: copy(rows), nextSequence: rows.at(-1)?.sequence ?? options.after ?? 0, hasMore: options.after !== undefined && filtered.length > rows.length, hasMoreBefore, ...(rows.length ? { firstSequence: rows[0].sequence } : {}) };
  }
  function preview(teamId) {
    const message = channels.get(teamId)?.messages.at(-1);
    if (!message) return undefined;
    if (!id(message.id) || !cursor(message.sequence) || message.sequence < 1 || !kinds.has(message.kind) || !['user', 'bot', 'system'].includes(message.author?.type)
      || typeof message.author.name !== 'string' || !message.author.name.trim() || message.author.name.length > 200 || message.author.name.includes('\0') || !message.author.name.isWellFormed()
      || message.author.type === 'bot' && !id(message.author.botId) || typeof message.createdAt !== 'string' || !Number.isFinite(Date.parse(message.createdAt))) return undefined;
    const publicAuthor = { type: message.author.type, name: message.author.name, ...(message.author.type === 'bot' ? { botId: message.author.botId } : {}) };
    // A roster caption is derived only from the public journal. Never consult a
    // bot's private chat, model checkpoint, memory or operational error detail.
    return { id: message.id, sequence: message.sequence, kind: message.kind, author: publicAuthor, content: Array.from(message.content.toWellFormed().replaceAll('\0', '')).slice(0, 280).join(''), createdAt: message.createdAt, ...(message.planEvent !== undefined ? { planId: message.planId, planEvent: message.planEvent } : {}) };
  }
  function latestSequence(teamId) {
    const row = channels.get(teamId);
    return row ? Math.max(0, row.nextSequence - 1) : 0;
  }
  function unreadCount(teamId, readSequence = 0) {
    const cursor = Number.isSafeInteger(readSequence) && readSequence >= 0 ? readSequence : 0;
    let count = 0;
    for (const message of channels.get(teamId)?.messages ?? []) if (message.sequence > cursor && message.author?.type !== 'user') count += 1;
    return count;
  }
  function summaryLine(teamId) {
    const message = channels.get(teamId)?.messages.at(-1);
    if (!message || typeof message.content !== 'string' || typeof message.createdAt !== 'string') return null;
    const authorName = typeof message.author?.name === 'string' ? message.author.name.replaceAll('\0', '').trim().slice(0, 80) : '';
    return { at: message.createdAt, preview: message.content.toWellFormed().replaceAll('\0', '').replace(/\s+/g, ' ').trim().slice(0, 140), authorName };
  }
  function notificationSources(teamId, after) {
    const row = channels.get(teamId), all = row?.messages ?? [];
    const selected = after === undefined ? all.slice(-100) : all.filter(message => message.sequence > after).slice(0, 100);
    return { id: teamId, latestSequence: row ? row.nextSequence - 1 : 0, messages: selected.map(message => ({ id: message.id, sequence: message.sequence, kind: message.kind, author: { type: message.author.type, ...(message.author.botId ? { botId: message.author.botId } : {}) }, state: message.state, createdAt: message.createdAt, ...(message.planEvent !== undefined ? { planId: message.planId, planEvent: message.planEvent } : {}) })) };
  }
  function discard(teamId) {
    const had = channels.has(teamId), old = channels.get(teamId);
    const removed = [...receipts].filter(([, receipt]) => receipt.teamId === teamId);
    if (had) channels.delete(teamId);
    for (const [key] of removed) receipts.delete(key);
    const restore = () => {
      if (had) channels.set(teamId, old); else channels.delete(teamId);
      for (const [key, receipt] of removed) receipts.set(key, receipt);
      if (had || removed.length) save();
    };
    try { if (had || removed.length) save(); }
    catch (error) { if (had) channels.set(teamId, old); for (const [key, receipt] of removed) receipts.set(key, receipt); throw error; }
    return had || removed.length ? restore : () => {};
  }
  return {
    append, appendAndRemember: append, discard, setRecoveryChoice, snapshot, preview, notificationSources, latestSequence, unreadCount, summaryLine,
    find: (teamId, messageId) => copy(channels.get(teamId)?.messages.find(row => row.id === messageId)),
    recent: (teamId, limit = 30) => copy((channels.get(teamId)?.messages ?? []).slice(-limit)),
    receipt: (teamId, requestId) => copy(receipts.get(`${teamId}:${requestId}`)),
  };
}
