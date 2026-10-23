import { useCallback, useMemo, useState } from 'react';
import {
  addSection,
  groupSidebar,
  loadSidebarLayout,
  moveSection,
  placeItem,
  removeSection,
  renameSection,
  reorderSections,
  saveSidebarLayout,
  setChatsCollapsed,
  toggleSection,
  type SidebarCatalogItem,
  type SidebarLayout,
} from './sidebar-sections';

function storage(): Pick<Storage, 'getItem' | 'setItem'> {
  return localStorage;
}

/** Section names, order and membership. Saved on this computer until the host keeps them. */
export function useSidebarLayout(items: SidebarCatalogItem[]) {
  const [layout, setLayout] = useState<SidebarLayout>(() => loadSidebarLayout(storage()));
  const commit = useCallback((update: (current: SidebarLayout) => SidebarLayout) => {
    setLayout(current => {
      const next = update(current);
      try { saveSidebarLayout(storage(), next); } catch { /* A full disk keeps the change for this visit. */ }
      return next;
    });
  }, []);
  const grouped = useMemo(() => groupSidebar(layout, items), [layout, items]);
  return {
    layout,
    grouped,
    rename: (id: string, name: string) => commit(current => renameSection(current, id, name)),
    toggle: (id: string) => commit(current => toggleSection(current, id)),
    move: (id: string, direction: -1 | 1) => commit(current => moveSection(current, id, direction)),
    reorder: (sourceId: string, targetId: string) => commit(current => reorderSections(current, sourceId, targetId)),
    add: (name: string, id: string) => commit(current => addSection(current, name, id)),
    remove: (id: string) => commit(current => removeSection(current, id)),
    place: (item: { kind: 'bot' | 'room'; id: string }, patch: { sectionId?: string; pinned?: boolean; hidden?: boolean }) => commit(current => placeItem(current, item, patch)),
    setChatsCollapsed: (collapsed: boolean) => commit(current => setChatsCollapsed(current, collapsed)),
  };
}
