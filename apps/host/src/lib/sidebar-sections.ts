/** Local sidebar sections. Names, order and membership stay on this computer. */

export const SIDEBAR_LAYOUT_KEY = 'strata.sidebar-sections.v1';
export const SIDEBAR_SECTION_LIMIT = 12;

export interface SidebarSection {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface SidebarPlacement {
  kind: 'bot' | 'room';
  id: string;
  sectionId: string;
  pinned: boolean;
  hidden: boolean;
}

export interface SidebarLayout {
  sections: SidebarSection[];
  placements: SidebarPlacement[];
  /** Workspace chats sit under Chats. They start collapsed. */
  chatsCollapsed: boolean;
}

export interface SidebarCatalogItem {
  kind: 'bot' | 'room';
  id: string;
  name: string;
  updatedAt: string;
}

export interface SidebarPlacedItem extends SidebarCatalogItem {
  pinned: boolean;
}

export interface SidebarGroup extends SidebarSection {
  items: SidebarPlacedItem[];
}

export interface GroupedSidebar {
  sections: SidebarGroup[];
  hidden: SidebarPlacedItem[];
}

export interface SidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const ID = /^[A-Za-z0-9_-]{1,120}$/;

export function defaultSidebarLayout(): SidebarLayout {
  return {
    sections: [
      { id: 'bots', name: 'Bots', collapsed: false },
      { id: 'rooms', name: 'Rooms', collapsed: false },
    ],
    placements: [],
    chatsCollapsed: true,
  };
}

function defaultSectionId(kind: 'bot' | 'room'): string {
  return kind === 'room' ? 'rooms' : 'bots';
}

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 40);
}

export function parseSidebarLayout(raw: unknown): SidebarLayout {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const seen = new Set<string>();
  const sections: SidebarSection[] = [];
  if (Array.isArray(source.sections)) {
    for (const row of source.sections) {
      if (!row || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const id = typeof record.id === 'string' && ID.test(record.id) ? record.id : '';
      if (!id || seen.has(id)) continue;
      const fallback = id === 'bots' ? 'Bots' : id === 'rooms' ? 'Rooms' : '';
      const name = typeof record.name === 'string' ? cleanName(record.name) : '';
      if (!name && !fallback) continue;
      seen.add(id);
      sections.push({ id, name: name || fallback, collapsed: record.collapsed === true });
    }
  }
  if (!seen.has('bots')) sections.push({ id: 'bots', name: 'Bots', collapsed: false });
  if (!seen.has('rooms')) sections.push({ id: 'rooms', name: 'Rooms', collapsed: false });
  const placements: SidebarPlacement[] = [];
  const placed = new Map<string, number>();
  if (Array.isArray(source.placements)) {
    for (const row of source.placements) {
      if (!row || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      if (record.kind !== 'bot' && record.kind !== 'room') continue;
      if (typeof record.id !== 'string' || !ID.test(record.id)) continue;
      const key = `${record.kind}:${record.id}`;
      const placement: SidebarPlacement = {
        kind: record.kind,
        id: record.id,
        sectionId: typeof record.sectionId === 'string' && ID.test(record.sectionId) ? record.sectionId : defaultSectionId(record.kind),
        pinned: record.pinned === true,
        hidden: record.hidden === true,
      };
      const index = placed.get(key);
      if (index === undefined) {
        placed.set(key, placements.length);
        placements.push(placement);
      } else placements[index] = placement;
    }
  }
  return { sections, placements, chatsCollapsed: source.chatsCollapsed !== false };
}

export function loadSidebarLayout(storage: Pick<SidebarStorage, 'getItem'>): SidebarLayout {
  try {
    return parseSidebarLayout(JSON.parse(storage.getItem(SIDEBAR_LAYOUT_KEY) ?? ''));
  } catch {
    return defaultSidebarLayout();
  }
}

export function saveSidebarLayout(storage: Pick<SidebarStorage, 'setItem'>, layout: SidebarLayout): void {
  storage.setItem(SIDEBAR_LAYOUT_KEY, JSON.stringify(parseSidebarLayout(layout)));
}

export function renameSection(layout: SidebarLayout, id: string, name: string): SidebarLayout {
  const clean = cleanName(name);
  if (!clean || !layout.sections.some(section => section.id === id)) return layout;
  return { ...layout, sections: layout.sections.map(section => section.id === id ? { ...section, name: clean } : section) };
}

export function toggleSection(layout: SidebarLayout, id: string): SidebarLayout {
  if (!layout.sections.some(section => section.id === id)) return layout;
  return { ...layout, sections: layout.sections.map(section => section.id === id ? { ...section, collapsed: !section.collapsed } : section) };
}

export function moveSection(layout: SidebarLayout, id: string, direction: -1 | 1): SidebarLayout {
  const index = layout.sections.findIndex(section => section.id === id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= layout.sections.length) return layout;
  const sections = layout.sections.slice();
  const [row] = sections.splice(index, 1);
  sections.splice(next, 0, row!);
  return { ...layout, sections };
}

/** Drop a section onto another one. The dragged section takes that place. */
export function reorderSections(layout: SidebarLayout, sourceId: string, targetId: string): SidebarLayout {
  if (sourceId === targetId) return layout;
  const sections = layout.sections.slice();
  const from = sections.findIndex(section => section.id === sourceId);
  const to = sections.findIndex(section => section.id === targetId);
  if (from < 0 || to < 0) return layout;
  const [row] = sections.splice(from, 1);
  sections.splice(to, 0, row!);
  return { ...layout, sections };
}

export function addSection(layout: SidebarLayout, name: string, id: string): SidebarLayout {
  const clean = cleanName(name);
  if (!clean || !ID.test(id) || layout.sections.length >= SIDEBAR_SECTION_LIMIT || layout.sections.some(section => section.id === id)) return layout;
  return { ...layout, sections: [...layout.sections, { id, name: clean, collapsed: false }] };
}

export function removeSection(layout: SidebarLayout, id: string): SidebarLayout {
  if (id === 'bots' || id === 'rooms' || !layout.sections.some(section => section.id === id)) return layout;
  return {
    ...layout,
    sections: layout.sections.filter(section => section.id !== id),
    placements: layout.placements.map(placement => placement.sectionId === id ? { ...placement, sectionId: defaultSectionId(placement.kind) } : placement),
  };
}

export function placeItem(layout: SidebarLayout, item: { kind: 'bot' | 'room'; id: string }, patch: { sectionId?: string; pinned?: boolean; hidden?: boolean }): SidebarLayout {
  const existing = layout.placements.find(row => row.kind === item.kind && row.id === item.id);
  const requested = patch.sectionId && layout.sections.some(section => section.id === patch.sectionId) ? patch.sectionId : undefined;
  const placement: SidebarPlacement = {
    kind: item.kind,
    id: item.id,
    sectionId: requested ?? existing?.sectionId ?? defaultSectionId(item.kind),
    pinned: patch.pinned ?? existing?.pinned ?? false,
    hidden: patch.hidden ?? existing?.hidden ?? false,
  };
  return { ...layout, placements: [...layout.placements.filter(row => !(row.kind === item.kind && row.id === item.id)), placement] };
}

export function setChatsCollapsed(layout: SidebarLayout, collapsed: boolean): SidebarLayout {
  if (layout.chatsCollapsed === collapsed) return layout;
  return { ...layout, chatsCollapsed: collapsed };
}

function stamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function groupSidebar(layout: SidebarLayout, items: SidebarCatalogItem[]): GroupedSidebar {
  const placed = items.map(item => {
    const placement = layout.placements.find(row => row.kind === item.kind && row.id === item.id);
    const sectionId = placement && layout.sections.some(section => section.id === placement.sectionId) ? placement.sectionId : defaultSectionId(item.kind);
    return { ...item, pinned: placement?.pinned === true, hidden: placement?.hidden === true, sectionId };
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || stamp(b.updatedAt) - stamp(a.updatedAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    sections: layout.sections.map(section => ({
      ...section,
      items: placed.filter(item => !item.hidden && item.sectionId === section.id).map(item => ({ kind: item.kind, id: item.id, name: item.name, updatedAt: item.updatedAt, pinned: item.pinned })),
    })),
    hidden: placed.filter(item => item.hidden).map(item => ({ kind: item.kind, id: item.id, name: item.name, updatedAt: item.updatedAt, pinned: item.pinned })),
  };
}

export function filterSidebarGroups(grouped: GroupedSidebar, query: string): GroupedSidebar {
  const needle = query.trim().toLowerCase();
  if (!needle) return grouped;
  const matches = (item: SidebarPlacedItem) => item.name.toLowerCase().includes(needle);
  return {
    sections: grouped.sections.flatMap(section => {
      const items = section.items.filter(matches);
      return items.length ? [{ ...section, collapsed: false, items }] : [];
    }),
    hidden: grouped.hidden.filter(matches),
  };
}
