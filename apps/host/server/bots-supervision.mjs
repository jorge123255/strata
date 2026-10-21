/** Read-only supervision. Display state is never authority to approve or run work. */
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const urgency = { approval: 0, error: 1, working: 2, thinking: 3, completed: 4 };

export function botSupervisionSnapshot({ bots, conversations, pendingCount, now = Date.now() }) {
  const profiles = new Map(bots.map(bot => [bot.id, bot]));
  const sessions = [];
  for (const chat of conversations) {
    const botId = chat.preferences?.botId, bot = profiles.get(botId);
    if (!bot || !validId(chat.id) || !validId(botId)) continue;
    const messages = Array.isArray(chat.messages) ? chat.messages : [], last = messages.at(-1);
    // Only the runtime's still-pending requests count. Historical proposed cards
    // and old tool calls must never turn into new approval requests.
    const waiting = chat.active ? pendingCount(chat.id) : 0;
    const tools = last?.role === 'assistant' && Array.isArray(last.tools) ? last.tools : [];
    const currentTool = chat.active ? tools.findLast(tool => tool.live === true && ['running', 'approved'].includes(tool.state)) : undefined;
    const updated = Date.parse(chat.updatedAt), recent = Number.isFinite(updated) && updated <= now + 60_000 && now - updated <= 24 * 60 * 60_000;
    let state;
    if (waiting) state = 'approval';
    else if (chat.active) state = currentTool ? 'working' : 'thinking';
    else if (last?.role === 'assistant' && last.error && recent) state = 'error';
    else if (last?.role === 'assistant' && !last.error && !last.cancelled && !last.streaming && recent && (last.hasContent === true || last.hasCompletedTool === true)) state = 'completed';
    else continue;
    sessions.push({ id: chat.id, botId, name: clean(chat.preferences?.botName || bot.name, 120), title: clean(chat.title, 300), state,
      approvalCount: waiting, ...(currentTool ? { toolName: clean(currentTool.name, 120) } : {}),
      ...(clean(chat.preferences?.botComputer, 120) ? { computerName: clean(chat.preferences.botComputer, 120) } : {}),
      ...(validId(chat.preferences?.teamId) ? { teamId: chat.preferences.teamId } : {}),
      ...(validId(chat.preferences?.parentChatId) ? { parentChatId: chat.preferences.parentChatId } : {}),
      ...(Number.isFinite(updated) ? { updatedAt: new Date(updated).toISOString() } : {}) });
  }
  sessions.sort((a, b) => urgency[a.state] - urgency[b.state] || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  const counts = { waiting: 0, working: 0, completed: 0, errors: 0 };
  for (const row of sessions) {
    if (row.state === 'approval') counts.waiting++;
    else if (['working', 'thinking'].includes(row.state)) counts.working++;
    else if (row.state === 'completed') counts.completed++;
    else counts.errors++;
  }
  return { supported: true, sessions: sessions.slice(0, 200), counts, hasMore: sessions.length > 200, updatedAt: new Date(now).toISOString() };
}
