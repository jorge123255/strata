import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/lib/sidebar-sections.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, write: false, format: 'esm', platform: 'node' });
const sections = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

const ada = { kind: 'bot', id: 'ada', name: 'Ada', updatedAt: '2026-10-02T00:00:00.000Z' };
const bea = { kind: 'bot', id: 'bea', name: 'Bea', updatedAt: '2026-10-10T00:00:00.000Z' };
const cal = { kind: 'bot', id: 'cal', name: 'Cal', updatedAt: '2026-10-01T00:00:00.000Z' };
const release = { kind: 'room', id: 'release', name: 'Release', updatedAt: '2026-10-09T00:00:00.000Z' };
const quiet = { kind: 'room', id: 'quiet', name: 'Quiet', updatedAt: '2026-10-03T00:00:00.000Z' };
const catalog = [ada, bea, cal, release, quiet];

test('a new layout opens Bots and Rooms and keeps workspace chats collapsed', () => {
  const layout = sections.defaultSidebarLayout();
  assert.deepEqual(layout.sections.map(section => section.name), ['Bots', 'Rooms']);
  assert.deepEqual(layout.sections.map(section => section.id), ['bots', 'rooms']);
  assert.equal(layout.sections.every(section => section.collapsed === false), true);
  assert.deepEqual(layout.placements, []);
  assert.equal(layout.chatsCollapsed, true);
});

test('unplaced bots and rooms land in the default sections, pinned first, with hidden kept apart', () => {
  const layout = sections.placeItem(sections.placeItem(sections.defaultSidebarLayout(), ada, { pinned: true }), cal, { hidden: true });
  const before = structuredClone({ layout, catalog });
  const grouped = sections.groupSidebar(layout, catalog);
  assert.deepEqual(grouped.sections.map(section => [section.id, section.items.map(item => item.id)]), [
    ['bots', ['ada', 'bea']],
    ['rooms', ['release', 'quiet']],
  ]);
  assert.equal(grouped.sections[0].items[0].pinned, true);
  assert.equal(grouped.sections[0].items[1].pinned, false);
  assert.deepEqual(grouped.hidden.map(item => item.id), ['cal']);
  assert.deepEqual({ layout, catalog }, before);
});

test('renaming, reordering and moving keep membership with the section', () => {
  let layout = sections.renameSection(sections.defaultSidebarLayout(), 'rooms', '  Studios  ');
  layout = sections.addSection(layout, 'Favorites', 'favorites');
  layout = sections.placeItem(layout, bea, { sectionId: 'favorites', pinned: true });
  layout = sections.moveSection(layout, 'rooms', -1);
  const grouped = sections.groupSidebar(layout, catalog);
  assert.deepEqual(grouped.sections.map(section => [section.name, section.items.map(item => item.id)]), [
    ['Studios', ['release', 'quiet']],
    ['Bots', ['ada', 'cal']],
    ['Favorites', ['bea']],
  ]);
  assert.equal(grouped.sections[2].items[0].pinned, true);
  const reordered = sections.reorderSections(layout, 'favorites', 'rooms');
  assert.deepEqual(sections.groupSidebar(reordered, catalog).sections.map(section => section.id), ['favorites', 'rooms', 'bots']);
  assert.equal(sections.reorderSections(layout, 'rooms', 'rooms'), layout);
});

test('removing a custom section returns its bots and rooms to the default sections', () => {
  let layout = sections.addSection(sections.defaultSidebarLayout(), 'Favorites', 'favorites');
  layout = sections.placeItem(layout, bea, { sectionId: 'favorites' });
  layout = sections.placeItem(layout, quiet, { sectionId: 'favorites', hidden: true });
  layout = sections.removeSection(layout, 'favorites');
  const grouped = sections.groupSidebar(layout, catalog);
  assert.equal(grouped.sections.some(section => section.id === 'favorites'), false);
  assert.deepEqual(grouped.sections.find(section => section.id === 'bots').items.map(item => item.id), ['bea', 'ada', 'cal']);
  assert.deepEqual(grouped.hidden.map(item => item.id), ['quiet']);
  assert.equal(sections.removeSection(layout, 'bots'), layout);
});

test('a blank rename, a full list and an unknown destination leave the layout unchanged', () => {
  const layout = sections.defaultSidebarLayout();
  assert.equal(sections.renameSection(layout, 'bots', '   '), layout);
  assert.equal(sections.placeItem(layout, ada, { sectionId: 'missing' }).placements[0].sectionId, 'bots');
  let full = layout;
  for (let index = 0; index < 10; index += 1) full = sections.addSection(full, `Extra ${index}`, `extra-${index}`);
  assert.equal(full.sections.length, 12);
  assert.equal(sections.addSection(full, 'One more', 'extra-more'), full);
  assert.equal(sections.moveSection(layout, 'bots', -1), layout);
});

test('saved layout JSON survives a round trip and repairs garbage', () => {
  const storage = memoryStorage();
  let layout = sections.renameSection(sections.defaultSidebarLayout(), 'bots', 'Helpers');
  layout = sections.setChatsCollapsed(layout, false);
  layout = sections.placeItem(layout, ada, { pinned: true, sectionId: 'rooms' });
  sections.saveSidebarLayout(storage, layout);
  assert.deepEqual(sections.loadSidebarLayout(storage), layout);
  storage.setItem(sections.SIDEBAR_LAYOUT_KEY, '{');
  assert.deepEqual(sections.loadSidebarLayout(storage), sections.defaultSidebarLayout());
  storage.setItem(sections.SIDEBAR_LAYOUT_KEY, JSON.stringify({
    chatsCollapsed: false,
    sections: [{ id: 'rooms', name: '  Circles  ', collapsed: true }, { id: 'rooms', name: 'Duplicate', collapsed: false }, { id: 'nope', name: '   ' }],
    placements: [{ kind: 'bot', id: 'ada', sectionId: 'gone', pinned: true, hidden: false }, { kind: 'nope', id: 'x' }, { kind: 'bot', id: 'ada', sectionId: 'rooms', pinned: false, hidden: true }],
  }));
  const repaired = sections.loadSidebarLayout(storage);
  assert.deepEqual(repaired.sections.map(section => [section.id, section.name, section.collapsed]), [
    ['rooms', 'Circles', true],
    ['bots', 'Bots', false],
  ]);
  assert.equal(repaired.chatsCollapsed, false);
  assert.deepEqual(repaired.placements, [{ kind: 'bot', id: 'ada', sectionId: 'rooms', pinned: false, hidden: true }]);
  const grouped = sections.groupSidebar(repaired, catalog);
  assert.deepEqual(grouped.sections.find(section => section.id === 'rooms').items.map(item => item.id), ['release', 'quiet']);
  assert.deepEqual(grouped.hidden.map(item => item.id), ['ada']);
});

test('a search keeps only matching rows and opens their sections', () => {
  let layout = sections.toggleSection(sections.defaultSidebarLayout(), 'bots');
  layout = sections.placeItem(layout, cal, { hidden: true });
  const grouped = sections.groupSidebar(layout, catalog);
  assert.equal(grouped.sections[0].collapsed, true);
  const found = sections.filterSidebarGroups(grouped, '  ada  ');
  assert.deepEqual(found.sections.map(section => [section.name, section.collapsed, section.items.map(item => item.name)]), [
    ['Bots', false, ['Ada']],
  ]);
  assert.deepEqual(found.hidden, []);
  const hidden = sections.filterSidebarGroups(grouped, 'cal');
  assert.deepEqual(hidden.sections, []);
  assert.deepEqual(hidden.hidden.map(item => item.name), ['Cal']);
  assert.equal(sections.filterSidebarGroups(grouped, '   '), grouped);
});
