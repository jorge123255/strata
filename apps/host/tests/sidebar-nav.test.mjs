import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the sidebar still opens chat dialogs from a closed menu and lists bots and rooms first', async () => {
  const side = await readFile(new URL('../src/app/Sidebar.tsx', import.meta.url), 'utf8');
  assert.match(side, /SidebarRoster/);
  assert.match(side, /useSidebarRoster/);
  assert.match(side, /nav__tools/);
  assert.match(side, /Chats/);
  for (const opener of ['setRenameId(menuId)', 'setDeleteId(menuId)', 'setRecentOpen(true)', 'setRemoveWorkspaceId(w.id)', 'setRenameWsId(w.id)', 'setQuitOpen(true)']) {
    assert.ok(side.includes(`setNavOpen(false); ${opener}`), opener);
  }
  const bots = await readFile(new URL('../src/screens/Bots.tsx', import.meta.url), 'utf8');
  assert.match(bots, /location\.query\.get\('new'\) === 'room'/);
  assert.match(bots, /markSidebarRead/);
  const hook = await readFile(new URL('../src/lib/use-sidebar-roster.ts', import.meta.url), 'utf8');
  assert.match(hook, /\/api\/bots\/summary\/stream/);
  assert.match(hook, /parseSidebarSummary/);
  assert.match(hook, /sidebarStreamSummary/);
  assert.match(hook, /message\.partial/);
  assert.match(hook, /status === 404/);
  const roster = await readFile(new URL('../src/app/SidebarRoster.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/styles/workspace.css', import.meta.url), 'utf8');
  assert.match(roster, /teamRosterLabel\(room\.memberCount\)/);
  assert.match(roster, /title=\{bot\.name\}/);
  assert.match(roster, /title=\{room\.name\}/);
  assert.doesNotMatch(roster, /nav-roster__meta/);
  assert.match(css, /\.nav-roster__row:hover > \.session-overflow/);
  assert.match(css, /\.nav-roster__row:focus-within > \.session-overflow/);
});
