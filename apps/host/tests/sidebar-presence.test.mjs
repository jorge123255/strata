import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/lib/sidebar-presence.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, write: false, format: 'esm', platform: 'node' });
const presence = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const limits = { maxParallel: 2, maxDepth: 2, maxHops: 8, maxTurns: 24, maxDurationMs: 600000 };
function bot(id, name, extra = {}) {
  return { id, name, paused: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra };
}
function chat(id, botId, extra = {}) {
  return {
    id,
    updatedAt: '2026-10-02T00:00:00.000Z',
    title: id,
    active: false,
    messages: [{ id: 'm', role: 'user', content: 'hello', at: '2026-10-02T00:00:00.000Z' }],
    preferences: { botId },
    ...extra,
  };
}
function team(id, name, memberIds, extra = {}) {
  return { id, name, memberIds, coordinatorId: memberIds[0], enabled: true, limits, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra };
}

test('placeholder bot status comes from the bot and its own chats', () => {
  const bots = [
    bot('ada', 'Ada'),
    bot('bea', 'Bea', { paused: true }),
    bot('cal', 'Cal'),
    bot('dee', 'Dee'),
  ];
  const sessions = [
    chat('ada-chat', 'ada', { active: true, lastReadAt: '2026-10-03T00:00:00.000Z', messages: [{ id: 'm', role: 'user', content: 'the release notes', at: '2026-10-02T00:00:00.000Z' }] }),
    chat('cal-chat', 'cal', { messages: [{ id: 'm', role: 'assistant', content: 'nope', at: '2026-10-02T00:00:00.000Z', error: 'failed' }] }),
    chat('bea-chat', 'bea', { active: true, lastReadAt: '2026-10-03T00:00:00.000Z', messages: [{ id: 'm', role: 'user', content: 'ignored while paused', at: '2026-10-02T00:00:00.000Z' }] }),
  ];
  const rows = presence.sidebarRoster({ bots, teams: [], sessions }).bots;
  assert.deepEqual(rows.map(row => [row.id, row.status, row.statusLine, row.unread]), [
    ['ada', 'working', 'Working on the release notes', 0],
    ['bea', 'paused', 'Paused', 0],
    ['cal', 'error', 'Error', 1],
    ['dee', 'idle', 'Idle', 0],
  ]);
});

test('unread counts personal chats and skips the one on screen and team work', () => {
  const bots = [bot('ada', 'Ada')];
  const sessions = [
    chat('old', 'ada', { updatedAt: '2026-10-03T00:00:00.000Z', lastReadAt: '2026-10-01T00:00:00.000Z' }),
    chat('open', 'ada', { updatedAt: '2026-10-04T00:00:00.000Z' }),
    chat('team', 'ada', { preferences: { botId: 'ada', teamId: 'release' }, messages: [{ id: 'm', role: 'user', content: 'room', at: '2026-10-02T00:00:00.000Z' }] }),
    chat('read', 'ada', { updatedAt: '2026-10-02T00:00:00.000Z', lastReadAt: '2026-10-05T00:00:00.000Z' }),
  ];
  const row = presence.sidebarRoster({ bots, teams: [], sessions, activeSession: 'open' }).bots[0];
  assert.equal(row.unread, 1);
  assert.equal(row.status, 'idle');
});

test('host live fields replace the placeholder bot status and unread count', () => {
  const bots = [bot('ada', 'Ada', { paused: true, status: 'working', workingOn: 'the homepage', unread: 4 })];
  const sessions = [chat('ada-chat', 'ada')];
  const row = presence.sidebarRoster({ bots, teams: [], sessions }).bots[0];
  assert.deepEqual({ status: row.status, statusLine: row.statusLine, unread: row.unread }, {
    status: 'working',
    statusLine: 'Working on the homepage',
    unread: 4,
  });
  const explicit = presence.sidebarRoster({ bots: [bot('ada', 'Ada', { statusLine: 'Working on a custom line', unread: 0 })], teams: [], sessions }).bots[0];
  assert.equal(explicit.statusLine, 'Working on a custom line');
  assert.equal(explicit.unread, 0);
});

test('a room shows three faces then +N, the member count, the last line and typing', () => {
  const bots = ['ada', 'bea', 'cal', 'dee', 'eve'].map(id => bot(id, id[0].toUpperCase() + id.slice(1)));
  const release = team('release', 'Release', bots.map(item => item.id), {
    channelPreview: { id: 'p', sequence: 1, kind: 'message', author: { type: 'bot', name: 'Ada' }, content: 'Notes are ready', createdAt: '2026-10-08T00:00:00.000Z' },
  });
  const runs = [{ teamId: 'release', state: 'running', rootBotId: 'bea' }];
  const sessions = [chat('room-chat', 'ada', { active: true, preferences: { botId: 'cal', teamId: 'release' } })];
  const before = structuredClone({ bots, release, runs, sessions });
  const row = presence.sidebarRoster({ bots, teams: [release], runs, sessions }).rooms[0];
  assert.equal(row.memberCount, 5);
  assert.deepEqual(row.faces.map(face => face.id), ['ada', 'bea', 'cal']);
  assert.equal(row.extra, 2);
  assert.equal(row.lastMessage, 'Ada: Notes are ready');
  assert.equal(row.typing, true);
  assert.equal(row.typingLabel, 'Bea and Cal are typing…');
  assert.deepEqual({ bots, release, runs, sessions }, before);
});

test('host live room fields replace member count, unread, typing and the last line', () => {
  const bots = [bot('ada', 'Ada'), bot('bea', 'Bea')];
  const quiet = team('quiet', 'Quiet', ['ada', 'bea'], {
    memberCount: 12,
    unread: 3,
    typing: true,
    typingNames: ['Ada', 'Bea', 'Cal'],
    lastMessage: 'Shipped',
  });
  const row = presence.sidebarRoster({
    bots,
    teams: [quiet],
    runs: [{ teamId: 'quiet', state: 'completed', rootBotId: 'ada' }],
    sessions: [],
  }).rooms[0];
  assert.equal(row.memberCount, 12);
  assert.equal(row.unread, 3);
  assert.deepEqual(row.faces.map(face => face.name), ['Ada', 'Bea']);
  assert.equal(row.extra, 10);
  assert.equal(row.typing, true);
  assert.equal(row.typingLabel, 'Ada and 2 more are typing…');
  assert.equal(row.lastMessage, 'Shipped');
});

test('a room without a reply stays quiet and counts unread team chats', () => {
  const bots = [bot('ada', 'Ada')];
  const quiet = team('quiet', 'Quiet', ['ada']);
  const sessions = [chat('room', 'ada', {
    preferences: { botId: 'ada', teamId: 'quiet' },
    updatedAt: '2026-10-04T00:00:00.000Z',
    lastReadAt: '2026-10-01T00:00:00.000Z',
  })];
  const row = presence.sidebarRoster({ bots, teams: [quiet], runs: [{ teamId: 'quiet', state: 'queued', rootBotId: 'ada' }], sessions }).rooms[0];
  assert.equal(row.memberCount, 1);
  assert.equal(row.extra, 0);
  assert.equal(row.typing, false);
  assert.equal(row.typingLabel, '');
  assert.equal(row.unread, 1);
  assert.equal(row.lastMessage, undefined);
});

test('the summary document replaces derived status, unread, member count, typing and the last line', () => {
  const bots = ['ada', 'bea', 'cal', 'dee', 'eve'].map(id => bot(id, id[0].toUpperCase() + id.slice(1)));
  const release = team('release', 'Release', bots.map(item => item.id));
  const sessions = [chat('ada-chat', 'ada'), chat('room', 'ada', { preferences: { botId: 'ada', teamId: 'release' } })];
  const derived = presence.sidebarRoster({ bots, teams: [release], sessions });
  const summary = presence.parseSidebarSummary({
    bots: [
      { id: 'ada', name: 'Ada', status: 'working', unreadCount: 2 },
      { id: 'bea', name: 'Bea', status: 'idle', unreadCount: 0 },
      { id: 'gus', name: 'Gus', status: 'error', unreadCount: 1 },
    ],
    rooms: [{
      id: 'release',
      name: 'Release',
      memberCount: 5,
      unreadCount: 4,
      lastMessage: { at: '2026-10-08T00:00:00.000Z', preview: 'All clear', authorName: 'Bea' },
      working: [
        { botId: 'bea', name: 'Bea', state: 'working' },
        { botId: 'cal', name: 'Cal', state: 'queued' },
      ],
    }, {
      id: 'quiet',
      name: 'Quiet',
      memberCount: 2,
      unreadCount: 0,
      lastMessage: null,
      working: [{ botId: 'ada', name: 'Ada', state: 'queued' }],
    }],
  });
  const rows = presence.applySidebarSummary(derived, summary, { bots, teams: [release] });
  const ada = rows.bots.find(row => row.id === 'ada');
  assert.equal(ada.status, 'working');
  assert.equal(ada.statusLine, 'Working');
  assert.equal(ada.unread, 2);
  assert.equal(rows.bots.find(row => row.id === 'gus').statusLine, 'Error');
  const room = rows.rooms.find(row => row.id === 'release');
  assert.equal(room.memberCount, 5);
  assert.equal(room.unread, 4);
  assert.deepEqual(room.faces.map(face => face.id), ['ada', 'bea', 'cal']);
  assert.equal(room.extra, 2);
  assert.equal(room.typingLabel, 'Bea is typing…');
  assert.equal(room.lastMessage, 'Bea: All clear');
  const quiet = rows.rooms.find(row => row.id === 'quiet');
  assert.equal(quiet.typing, false);
  assert.equal(quiet.memberCount, 2);
  assert.equal(quiet.extra, 2);
  assert.equal(quiet.lastMessage, undefined);
});

test('a paused bot stays paused when the summary says idle, and a bad summary is ignored', () => {
  const bots = [bot('ada', 'Ada', { paused: true })];
  const derived = presence.sidebarRoster({ bots, teams: [], sessions: [] });
  const summary = presence.parseSidebarSummary({ bots: [{ id: 'ada', name: 'Ada', status: 'idle', unreadCount: 3 }], rooms: [] });
  const row = presence.applySidebarSummary(derived, summary, { bots, teams: [] }).bots[0];
  assert.equal(row.status, 'paused');
  assert.equal(row.statusLine, 'Paused');
  assert.equal(row.unread, 3);
  const cleared = presence.clearSummaryUnread(summary, 'bot', 'ada');
  assert.equal(cleared.bots[0].unreadCount, 0);
  assert.equal(summary.bots[0].unreadCount, 3);
  assert.equal(presence.parseSidebarSummary({ bots: [{ id: 'ada', name: 'Ada', status: 'asleep', unreadCount: 0 }], rooms: [] }), null);
  assert.equal(presence.parseSidebarSummary(null), null);
  const open = presence.openedSidebarRead(presence.applySidebarSummary(derived, summary, { bots, teams: [] }), { kind: 'bot', id: 'ada' });
  assert.equal(open.bots[0].unread, 0);
  assert.equal(presence.applySidebarSummary(derived, summary, { bots, teams: [] }).bots[0].unread, 3);
});

test('a host summary keeps empty captions and large unread counts', () => {
  const parsed = presence.parseSidebarSummary({
    rooms: [{
      id: 'team_release',
      name: 'Release',
      memberCount: 2,
      unreadCount: 100001,
      lastMessage: { at: '2026-10-08T00:00:00.000Z', preview: '', authorName: '' },
      working: [{ botId: 'bot_bea', name: 'Unavailable teammate', state: 'queued', runId: 'run_1', jobId: 'job_1' }],
      extra: true,
    }, {
      id: 'team_notes',
      name: 'Notes',
      memberCount: 1,
      unreadCount: 0,
      lastMessage: { at: '2026-10-08T01:00:00.000Z', preview: 'All clear', authorName: '' },
      working: [],
    }],
    bots: [{ id: 'bot_ada', name: 'Ada', status: 'idle', unreadCount: 0, paused: true }],
  });
  assert.equal(parsed.rooms[0].unreadCount, 100001);
  assert.equal(parsed.rooms[0].lastMessage.preview, '');
  assert.equal(parsed.rooms[0].lastMessage.authorName, '');
  assert.equal(parsed.rooms[0].working[0].name, 'Unavailable teammate');
  assert.equal(parsed.rooms[0].working[0].runId, undefined);
  const bots = [bot('bot_ada', 'Ada'), bot('bot_bea', 'Bea')];
  const teams = [team('team_release', 'Release', ['bot_ada', 'bot_bea']), team('team_notes', 'Notes', ['bot_ada'])];
  const rows = presence.applySidebarSummary(presence.sidebarRoster({ bots, teams, sessions: [] }), parsed, { bots, teams });
  assert.equal(rows.rooms.find(row => row.id === 'team_release').unread, 100001);
  assert.equal(rows.rooms.find(row => row.id === 'team_release').lastMessage, undefined);
  assert.equal(rows.rooms.find(row => row.id === 'team_release').typing, false);
  assert.equal(rows.rooms.find(row => row.id === 'team_notes').lastMessage, 'All clear');
});

test('a message.partial frame does not change unread or the last line', () => {
  const current = presence.parseSidebarSummary({
    bots: [{ id: 'bot_ada', name: 'Ada', status: 'idle', unreadCount: 1 }],
    rooms: [{
      id: 'team_release',
      name: 'Release',
      memberCount: 2,
      unreadCount: 1,
      lastMessage: { at: '2026-10-08T00:00:00.000Z', preview: 'Ship the small fix', authorName: 'Ada' },
      working: [],
    }],
  });
  const partial = { messageId: 'tm_job', botId: 'bot_bea', seq: 2, text: 'Ship the', delta: 'the', done: false };
  assert.equal(presence.sidebarStreamSummary(current, 'message.partial', partial), current);
  assert.equal(presence.sidebarStreamSummary(current, 'message.partial', { ...partial, text: 'Ship the fix today', delta: ' fix today', done: true, unreadCount: 9 }), current);
  assert.equal(presence.sidebarStreamSummary(null, 'message.partial', partial), null);
  assert.equal(presence.parseSidebarSummary(partial), null);
  assert.equal(presence.sidebarStreamSummary(current, 'bot-summary', partial), current);
  const finished = presence.sidebarStreamSummary(current, 'bot-summary', {
    bots: current.bots,
    rooms: [{
      ...current.rooms[0],
      unreadCount: 2,
      lastMessage: { at: '2026-10-08T02:00:00.000Z', preview: 'Ship the fix today', authorName: 'Bea' },
    }],
  });
  assert.notEqual(finished, current);
  assert.equal(finished.rooms[0].unreadCount, 2);
  assert.equal(finished.rooms[0].lastMessage.preview, 'Ship the fix today');
  assert.equal(current.rooms[0].unreadCount, 1);
});
