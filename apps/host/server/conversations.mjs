/** The Mac and its paired phones share these exact chat IDs and projected messages. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const fault = (status, message) => Object.assign(new Error(message), { status });
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(id);
const copy = value => structuredClone(value);
const writableModes = new Set(['manual', 'plan', 'bypass', 'auto', 'accept-edits']);
const plainSession = session => {
  if (!session || !validId(session.id) || typeof session.title !== 'string' || !Array.isArray(session.messages)
      || session.messages.some(m => !m || !validId(m.id) || !['user', 'assistant', 'system'].includes(m.role) || typeof m.content !== 'string')) throw fault(400, 'The conversation is invalid.');
  const { active, status, revision, ...saved } = copy(session);
  return saved;
};

export function createConversations({ directory, enabled = () => true, notify = () => {}, defaultWorkspace = () => '', validateSelection = () => {},
  execute = async () => {}, stop = async () => {}, approve = async () => {}, pending = () => [], now = () => new Date().toISOString(), clock = Date.now } = {}) {
  const file = join(directory, 'conversations.json');
  let existingCatalog = existsSync(file);
  const available = () => existingCatalog || enabled();
  const requireAvailable = () => { if (!available()) throw fault(409, 'Enable Pair iPhone on the Mac to share conversations.'); };
  const entries = new Map(), deleted = new Set(), turns = new Map();
  let diskTimer = null, eventTimer = null;
  const changed = new Set();
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    for (const id of saved.deleted ?? []) if (validId(id)) deleted.add(id);
    for (const record of saved.conversations ?? []) {
      const session = plainSession(record.session);
      if (deleted.has(session.id)) continue;
      // A host restart is not a live turn. Retain all partial output with an honest end state.
      session.messages = session.messages.map(m => m.streaming ? { ...m, streaming: false, error: m.error ?? 'Response interrupted when Strata restarted. Continue this conversation to go on.' } : m);
      entries.set(session.id, { session, revision: Number(record.revision) || 1, status: null });
    }
  } catch (e) { if (e.code !== 'ENOENT') throw fault(503, 'Saved conversations could not be read. They have been left unchanged.'); }
  function flush() {
    clearTimeout(diskTimer); diskTimer = null;
    if (!available()) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, deleted: [...deleted], conversations: [...entries.values()].map(({ session, revision }) => ({ session, revision })) }), { mode: 0o600 });
      chmodSync(tmp, 0o600); renameSync(tmp, file); existingCatalog = true;
    } finally { try { unlinkSync(tmp); } catch {} }
  }
  const view = record => ({ ...copy(record.session), revision: record.revision, active: turns.has(record.session.id), status: record.status });
  // Roster/list clients need display metadata, not every transcript, tool result
  // and Thinking block. Keep this separate from the exact full-history view.
  function summaryView(record) {
    const session = record.session, preferences = session.preferences ?? {};
    const result = { id: session.id, title: session.title.slice(0, 500), updatedAt: session.updatedAt,
      revision: record.revision, active: turns.has(session.id), status: record.status };
    for (const [key, max] of [['createdAt', 80], ['workspace', 4000]]) if (typeof session[key] === 'string') result[key] = session[key].slice(0, max);
    for (const [output, key, max] of [['mode', 'mode', 40], ['botName', 'botName', 200], ['computerName', 'botComputer', 300], ['botModelName', 'botModel', 300]]) {
      const value = preferences[key] ?? session[output];
      if (typeof value === 'string') result[output] = value.slice(0, max);
    }
    for (const key of ['botId', 'teamId', 'teamRunId', 'parentChatId']) {
      const value = preferences[key] ?? session[key];
      if (validId(value)) result[key] = value;
    }
    const avatar = preferences.botAvatar ?? session.botAvatar;
    if (typeof avatar === 'string' && avatar.length <= 32) result.botAvatar = avatar;
    const face = preferences.botAvatarConfig ?? session.botAvatarConfig;
    if (face !== undefined) result.botAvatarConfig = face && typeof face === 'object' && !Array.isArray(face)
      && Object.keys(face).every(key => ['color', 'eyes', 'ears', 'kind', 'shape'].includes(key))
      && Object.values(face).every(value => typeof value === 'string' && value.length <= 100) ? copy(face) : null;
    const effort = preferences.botEffort ?? session.botEffort;
    if (typeof effort === 'string' && /^[A-Za-z0-9_-]{0,40}$/.test(effort)) result.botEffort = effort;
    const computerMode = preferences.botComputerMode ?? session.computerMode;
    if (['host', 'cua'].includes(computerMode)) result.computerMode = computerMode;
    const model = session.modelName ?? session.messages.findLast(message => typeof message.model === 'string')?.model;
    if (typeof model === 'string') result.modelName = model.slice(0, 300);
    const last = session.messages.findLast(message => typeof message.content === 'string' && message.content.trim());
    result.preview = last?.content.slice(0, 300) ?? '';
    return result;
  }
  const inboxListeners = new Set();
  function publish() {
    clearTimeout(eventTimer); eventTimer = null;
    const touched = changed.size > 0;
    for (const id of changed) notify('conversation', entries.has(id) ? { conversation: view(entries.get(id)) } : { deleted: id });
    changed.clear();
    if (!touched) return;
    for (const listener of inboxListeners) { try { listener(); } catch { /* A sidebar listener cannot stop a chat. */ } }
  }
  function touch(id, immediate = false) {
    const record = entries.get(id);
    if (record) record.revision += 1;
    changed.add(id);
    if (immediate) { flush(); publish(); }
    else {
      if (!diskTimer) { diskTimer = setTimeout(() => { try { flush(); } catch {} }, 250); diskTimer.unref?.(); }
      if (!eventTimer) { eventTimer = setTimeout(publish, 150); eventTimer.unref?.(); }
    }
  }
  function requireRecord(id) {
    requireAvailable();
    const record = entries.get(id);
    if (!record) throw fault(404, 'This conversation is no longer on the Mac.');
    return record;
  }
  function detail(id) {
    const record = requireRecord(id);
    return { conversation: view(record), pending: pending(id).map(p => {
      const id = p.callId ?? p.id;
      const card = record.session.messages.flatMap(m => m.tools ?? []).find(t => t.id === id);
      return { id, name: typeof p.tool === 'string' ? p.tool : p.tool?.name ?? card?.name ?? 'Tool', args: {}, preview: p.reason ?? '', effect: '', scope: 'connected', ...card, state: 'proposed', live: true };
    }) };
  }
  function list(options = {}) {
    if (!available()) return { available: false, conversations: [], activeChatId: null };
    const conversations = [...entries.values()].map(options?.summary === true ? summaryView : view).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { available: true, conversations, activeChatId: conversations.find(s => s.active)?.id ?? null };
  }
  function identitiesForBot(botId) {
    if (!available()) return [];
    return [...entries.values()].filter(({ session }) => session.preferences?.botId === botId)
      .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt)).map(({ session }) => session.id);
  }
  // Reconciliation needs identities and terminal state, never message content or Thinking.
  function notificationSources() {
    return [...entries.values()].map(({ session }) => ({ id: session.id, createdAt: session.createdAt, preferences: Object.fromEntries(['botId', 'teamId'].filter(key => session.preferences?.[key] !== undefined).map(key => [key, session.preferences[key]])), messages: session.messages.filter(message => message.role === 'assistant' && !message.local && !message.timeSkipId).map(message => ({ id: message.id, role: message.role, streaming: message.streaming === true, hasContent: !!message.content?.trim(), ...(message.cancelled ? { cancelled: true } : {}), ...(message.error ? { error: true } : {}), at: message.at })) }));
  }
  function sidebarInbox() {
    if (!available()) return [];
    const rows = [];
    for (const { session } of entries.values()) {
      const botId = session.preferences?.botId;
      if (!botId || session.preferences?.teamId) continue;
      const messages = [];
      for (const message of session.messages) {
        if (message.role !== 'assistant' || message.local || message.timeSkipId) continue;
        messages.push({ id: message.id, at: message.at, hasContent: !!message.content?.trim(), error: !!message.error, streaming: message.streaming === true });
      }
      rows.push({ id: session.id, botId, active: turns.has(session.id), messages });
    }
    return rows;
  }
  // Supervision polls need only a compact last-turn status. Do not deep-copy
  // transcripts, reasoning, command arguments or output on every activity poll.
  function supervisionSources() {
    return [...entries.values()].filter(({ session }) => session.preferences?.botId).map(({ session }) => {
      const last = session.messages.at(-1);
      const tools = last?.role === 'assistant' ? last.tools ?? [] : [];
      const currentTool = tools.findLast(tool => tool.live === true && ['running', 'approved'].includes(tool.state));
      return { id: session.id, title: session.title, updatedAt: session.updatedAt, active: turns.has(session.id),
        preferences: Object.fromEntries(['botId', 'botName', 'botComputer', 'teamId', 'parentChatId'].filter(key => session.preferences?.[key] !== undefined).map(key => [key, session.preferences[key]])),
        messages: last ? [{ role: last.role, hasContent: !!last.content?.trim(), hasCompletedTool: tools.some(tool => tool.state === 'done'), error: !!last.error, cancelled: !!last.cancelled, streaming: !!last.streaming,
          tools: currentTool ? [{ name: currentTool.name, state: currentTool.state, live: true }] : [] }] : [] };
    });
  }
  function sync(items) {
    if (!available()) return { results: [], ...list() };
    if (!Array.isArray(items)) throw fault(400, 'A conversation list is required.');
    const results = [];
    for (const item of items) {
      const session = plainSession(item.session ?? item);
      if (deleted.has(session.id)) { results.push({ id: session.id, deleted: true }); continue; }
      const existing = entries.get(session.id);
      if (!existing) {
        entries.set(session.id, { session, revision: 0, status: null }); touch(session.id);
      } else if (!turns.has(session.id) && Number.isInteger(item.baseRevision) && item.baseRevision === existing.revision) {
        // Compare-and-swap: a stale renderer can never replace phone messages or newer tool activity.
        if (existing.session.preferences?.botId) {
          // Bot ownership is a host record. Renderer preferences cannot turn a bot
          // transcript into an ordinary model chat or adopt another bot's identity.
          session.workspace = existing.session.workspace;
          session.preferences = copy(existing.session.preferences);
        }
        existing.session = session; touch(session.id);
      }
      results.push({ conversation: view(entries.get(session.id)) });
    }
    flush(); publish();
    return { results, ...list() };
  }
  function create(selection = {}, bot = null) {
    requireAvailable();
    validateSelection(selection);
    const at = now(), id = `s_${randomUUID()}`;
    const session = { id, title: 'New conversation', defaultTitle: true, createdAt: at, updatedAt: at,
      messages: [], workspace: bot?.workspace ?? defaultWorkspace(), tokensIn: 0, tokensOut: 0,
      preferences: { mode: bot?.policy ?? 'manual', ...(bot ? { botId: bot.id, botName: bot.name, botComputerMode: bot.computerMode ?? 'host', botEffort: bot.effort ?? '', ...(bot.teamContext ? Object.fromEntries(['teamId', 'teamRunId', 'parentChatId'].filter(key => typeof bot.teamContext[key] === 'string').map(key => [key, bot.teamContext[key]])) : {}), ...(bot.avatarConfig ? { botAvatarConfig: copy(bot.avatarConfig) } : {}), ...(bot.avatar ? { botAvatar: bot.avatar } : {}), ...(bot.computerLabel ? { botComputer: bot.computerLabel } : {}), ...(bot.modelLabel ? { botModel: bot.modelLabel } : {}) } : {}), ...(selection.remoteModel ? { remoteModel: copy(selection.remoteModel) } : {}), ...(selection.nativeModelId ? { nativeModelId: selection.nativeModelId } : {}) } };
    entries.set(id, { session, revision: 0, status: null }); touch(id, true);
    return detail(id);
  }
  function begin(id, message, { userMessageId = `m_${randomUUID()}`, assistantMessageId = `m_${randomUUID()}`, shown, preferences, workspace, controller = new AbortController() } = {}) {
    const record = requireRecord(id);
    if (turns.has(id)) throw fault(409, 'This conversation is already working. You can follow its activity or stop it first.');
    if (!validId(userMessageId) || !validId(assistantMessageId)) throw fault(400, 'Message IDs are invalid.');
    const session = record.session, at = now();
    if (preferences) session.preferences = { ...session.preferences, ...copy(preferences) };
    if (workspace) session.workspace = workspace;
    if (!session.messages.some(m => m.id === userMessageId)) session.messages.push({ id: userMessageId, role: 'user', content: shown ?? message, at });
    if (!session.messages.some(m => m.id === assistantMessageId)) session.messages.push({ id: assistantMessageId, role: 'assistant', content: '', streaming: true, at });
    if (session.defaultTitle || session.title === 'New conversation') { session.title = message.length > 48 ? message.slice(0, 47).trimEnd() + '…' : message; session.defaultTitle = false; }
    session.updatedAt = at;
    turns.set(id, { assistantMessageId, executing: true, started: clock(), controller }); record.status = 'Starting…'; touch(id, true);
    return detail(id);
  }
  function record(id, frame) {
    if (!available()) return;
    const entry = entries.get(id), turn = turns.get(id);
    if (!entry || !turn || !frame || typeof frame.type !== 'string') return;
    const session = entry.session;
    let reply = session.messages.find(m => m.id === turn.assistantMessageId);
    if (!reply) return;
    const finishReasoning = () => {
      if (reply.reasoningStartedAt !== undefined && reply.reasoningMs === undefined) {
        reply.reasoningMs = Math.max(0, clock() - reply.reasoningStartedAt);
      }
    };
    const mergeTool = tool => {
      if (!tool || typeof tool.id !== 'string') return;
      const old = reply.tools?.find(t => t.id === tool.id);
      const next = { ...old, ...copy(tool), live: true };
      reply.tools = old ? reply.tools.map(t => t.id === tool.id ? next : t) : [...(reply.tools ?? []), next];
    };
    switch (frame.type) {
      case 'start': for (const key of ['requestId', 'model', 'contextMax', 'demo', 'remoteModel']) if (frame[key] !== undefined) reply[key] = frame[key]; break;
      case 'queued': if (frame.requestId) reply.requestId = frame.requestId; break;
      case 'status': entry.status = frame.status?.text ?? frame.text ?? frame.status?.line ?? null; break;
      case 'delta': {
        const text = String(frame.text ?? '');
        if (text) finishReasoning();
        reply.content += text;
        if (reply.blocks) { const tail = reply.blocks.at(-1); if (tail?.kind === 'text') tail.text += text; else reply.blocks.push({ kind: 'text', text }); }
        break;
      }
      case 'reasoning': {
        const text = String(frame.text ?? '');
        if (text && reply.reasoningStartedAt === undefined) reply.reasoningStartedAt = clock();
        reply.reasoning = (reply.reasoning ?? '') + text;
        break;
      }
      case 'agent-tool': mergeTool(frame.tool); break;
      case 'native-tool': {
        const event = frame.event;
        if (event?.id) mergeTool({ id: event.id, name: event.name ?? reply.tools?.find(t => t.id === event.id)?.name ?? 'Connected tool', args: event.arguments ?? {}, preview: 'Connected tool', effect: '', scope: 'connected', state: event.event === 'result' ? event.ok ? 'done' : 'error' : 'running', ...(event.text !== undefined ? { result: event.text } : {}), durationMs: event.ms });
        break;
      }
      case 'tool': mergeTool({ ...frame.tool, state: 'proposed' }); break;
      case 'agent': if (frame.agent?.id) session.agents = [...(session.agents ?? []).filter(a => a.id !== frame.agent.id), copy(frame.agent)]; break;
      case 'activity-group': {
        if (!frame.id) break;
        const group = { kind: 'group', ...copy(frame) }; delete group.type;
        const index = (reply.blocks ?? []).findIndex(g => g.kind === 'group' && g.id === frame.id);
        reply.blocks = index >= 0 ? reply.blocks.map((g, i) => i === index ? group : g) : [...(reply.blocks ?? (reply.content ? [{ kind: 'text', text: reply.content }] : [])), group]; break;
      }
      case 'deliverable': if (frame.path) reply.deliverables = [...(reply.deliverables ?? []).filter(d => d.path !== frame.path), copy(frame)]; break;
      case 'artifacts': if (Array.isArray(frame.artifacts)) reply.artifacts = copy(frame.artifacts); break;
      case 'skills-used': if (Array.isArray(frame.skills)) reply.skills = copy(frame.skills); break;
      case 'plan': if (frame.event === 'proposed' && frame.plan?.id) reply.planId = frame.plan.id; break;
      case 'queued-message': if (frame.state === 'delivered' && typeof frame.message?.text === 'string') {
        reply.streaming = false;
        const at = now(); turn.assistantMessageId = `m_${randomUUID()}`;
        session.messages.push({ id: frame.message.id ?? `m_${randomUUID()}`, role: 'user', content: frame.message.text, at }, { id: turn.assistantMessageId, role: 'assistant', content: '', streaming: true, at });
        break;
      }
      case 'stats': if (typeof frame.tokensOut === 'number') reply.tokens = frame.tokensOut; if (typeof frame.tps === 'number') reply.tps = frame.tps; break;
      case 'notice': entry.status = String(frame.message ?? ''); break;
      case 'error': finishReasoning(); reply.error = String(frame.message ?? 'The reply failed.'); reply.streaming = false; entry.status = null; turns.delete(id); break;
      case 'pause': {
        const recovery = frame.recovery;
        if (!recovery || recovery.kind !== 'paused' || typeof recovery.text !== 'string' || !recovery.text.trim()) break;
        const text = recovery.text.trim();
        const options = Array.isArray(recovery.options) ? recovery.options.filter(option => option && option.id === 'continue' && typeof option.label === 'string' && option.label.trim()).map(option => ({ id: 'continue', label: option.label.trim() })) : [];
        if (!options.length) break;
        reply.recovery = { kind: 'paused', text, question: typeof recovery.question === 'string' && recovery.question.trim() ? recovery.question.trim() : 'Keep going?', options: options.slice(0, 1) };
        if (!reply.content.includes(text)) reply.content = reply.content ? `${reply.content}\n${text}` : text;
        break;
      }
      case 'done':
        finishReasoning();
        if (frame.cancelled === true) reply.cancelled = true;
        reply.streaming = false; reply.durationMs = Number(frame.durationMs ?? clock() - turn.started);
        for (const [field, value] of [['tokens', frame.tokensOut], ['inputTokens', frame.tokensIn], ['tps', frame.tps], ['ttftMs', frame.ttftMs], ['contextUsed', frame.contextTokens]]) if (typeof value === 'number') reply[field] = value;
        reply.usageSource = frame.usageSource ?? 'unavailable';
        session.tokensIn = (session.tokensIn ?? 0) + Number(frame.tokensIn ?? 0); session.tokensOut = (session.tokensOut ?? 0) + Number(frame.tokensOut ?? 0);
        entry.status = null; turns.delete(id); break;
      default: return;
    }
    session.updatedAt = now(); touch(id, frame.type === 'done' || frame.type === 'error' || frame.type === 'pause');
  }
  function finish(id, error) {
    const turn = turns.get(id); if (!turn) return;
    record(id, error ? { type: 'error', message: error } : { type: 'done' });
  }
  function capture(id) {
    const turn = turns.get(id);
    if (!turn) return null;
    const current = () => turns.get(id) === turn;
    return { current, record: frame => { if (current()) record(id, frame); }, finish: error => { if (current()) finish(id, error); } };
  }
  function send(id, message) {
    if (typeof message !== 'string' || !message.trim() || message.length > 100_000) throw fault(400, 'Write a message of up to 100,000 characters.');
    const entry = requireRecord(id), before = copy(entry.session);
    validateSelection({ chatId: id, botId: before.preferences?.botId, remoteModel: before.preferences?.remoteModel, nativeModelId: before.preferences?.nativeModelId });
    begin(id, message.trim());
    const turn = turns.get(id), session = copy(entry.session);
    turn.executing = false;
    const mode = writableModes.has(session.preferences?.mode) ? session.preferences.mode : 'manual';
    const captured = capture(id);
    void Promise.resolve().then(() => {
      if (turn.controller.signal.aborted || turns.get(id) !== turn) return;
      turn.executing = true;
      return execute({ session: before, message: message.trim(), mode, signal: turn.controller.signal, capture: captured, onFrame: frame => { if (turns.get(id) === turn) record(id, frame); } });
    })
      .then(result => { if (turns.get(id) === turn && !result?.detached) finish(id); }, e => { if (turns.get(id) === turn) finish(id, e.message ?? 'The Mac could not continue this conversation.'); });
    return detail(id);
  }
  async function stopTurn(id) {
    requireRecord(id);
    const queued = turns.get(id);
    if (queued && !queued.executing) { queued.controller.abort(); finish(id); return detail(id); }
    const result = await stop(id);
    if (!result?.stopped && !result?.pending && queued && turns.get(id) === queued) { queued.controller.abort(); finish(id); }
    return detail(id);
  }
  function choose(id, messageId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'choice') || input.choice !== 'continue') throw fault(400, 'Choose continue.');
    const entry = requireRecord(id);
    const message = entry.session.messages.find(row => row.id === messageId);
    const recovery = message?.recovery;
    if (!recovery || recovery.kind !== 'paused' || !Array.isArray(recovery.options) || !recovery.options.some(option => option?.id === 'continue')) throw fault(404, 'This choice is unavailable.');
    if (turns.has(id)) throw fault(409, 'This conversation is already working. You can follow its activity or stop it first.');
    if (recovery.choice === 'continue') return detail(id);
    message.recovery = { ...recovery, choice: 'continue' };
    touch(id, true);
    try { return send(id, 'Continue'); }
    catch (error) { delete message.recovery.choice; touch(id, true); throw error; }
  }
  async function approval(id, toolId, decision) {
    requireRecord(id);
    if (!validId(toolId) || !['approve', 'deny'].includes(decision)) throw fault(400, 'Choose approve or deny for this tool.');
    await approve({ chatId: id, callId: toolId, decision });
    return detail(id);
  }
  function preferences(id, patch) {
    const entry = requireRecord(id);
    if (entry.session.preferences?.botId) throw fault(409, 'Edit this bot’s profile to change its provider or permissions.');
    const allowed = ['mode', 'thinking', 'thinkingBudget', 'useTools', 'agent', 'remoteModel', 'nativeModelId', 'access'];
    const next = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => allowed.includes(key)));
    if (next.mode && !writableModes.has(next.mode)) throw fault(400, 'Choose a valid chat mode.');
    entry.session.preferences = { ...entry.session.preferences, ...copy(next) }; touch(id, true); return detail(id);
  }
  function remove(id) {
    requireRecord(id); if (turns.has(id)) throw fault(409, 'Stop this conversation before deleting it.');
    entries.delete(id); deleted.add(id); touch(id, true); return { deleted: id };
  }
  return { list, identitiesForBot, detail, notificationSources, supervisionSources, sidebarInbox, subscribeInbox: listener => { inboxListeners.add(listener); return () => inboxListeners.delete(listener); }, sync, create, createForBot: bot => create({}, bot), begin, record, finish, send, choose, stop: stopTurn, approval, preferences, remove,
    available, capture, has: id => entries.has(id), botId: id => entries.get(id)?.session.preferences?.botId ?? null, isRunning: id => turns.has(id), close() { for (const turn of turns.values()) turn.controller.abort(); flush(); publish(); } };
}
