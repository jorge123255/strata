import { useRef, useState } from 'react';
import { PaneCollapse, ShimmerText, StatusDot, TypingDots } from '../components/ChatMotion';
import { CuaBotAvatar, type CuaBotMood } from '../components/CuaBotAvatar';
import { FloatingMenu } from '../components/FloatingMenu';
import { Icon } from '../components/ui';
import { teamRosterLabel } from '../lib/bots';
import { cx } from '../lib/format';
import { tr } from '../lib/i18n';
import { href } from '../lib/router';
import { setNavOpen } from '../lib/store';
import type { SidebarBotStatus, SidebarBotRow, SidebarRoomRow } from '../lib/sidebar-presence';
import { SIDEBAR_SECTION_LIMIT, type GroupedSidebar, type SidebarLayout } from '../lib/sidebar-sections';

type PlacePatch = { sectionId?: string; pinned?: boolean; hidden?: boolean };

export function SidebarRoster({
  bots,
  rooms,
  layout,
  grouped,
  loading,
  error,
  activeBotId,
  activeRoomId,
  onRename,
  onToggle,
  onMove,
  onReorder,
  onAdd,
  onRemove,
  onPlace,
}: {
  bots: SidebarBotRow[];
  rooms: SidebarRoomRow[];
  layout: SidebarLayout;
  grouped: GroupedSidebar;
  loading: boolean;
  error: string;
  activeBotId: string | null;
  activeRoomId: string | null;
  onRename: (id: string, name: string) => void;
  onToggle: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onAdd: (name: string, id: string) => void;
  onRemove: (id: string) => void;
  onPlace: (item: { kind: 'bot' | 'room'; id: string }, patch: PlacePatch) => void;
}) {
  const [menu, setMenu] = useState<{ kind: 'section' | 'item'; id: string; itemKind?: 'bot' | 'room' } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [dropId, setDropId] = useState<string | null>(null);
  const full = layout.sections.length >= SIDEBAR_SECTION_LIMIT;
  function openMenu(next: NonNullable<typeof menu>, element: HTMLElement) {
    trigger.current = element;
    setMenu(next);
  }
  function closeMenu() { setMenu(null); trigger.current?.focus(); }
  function startRename(id: string, name: string) {
    setRenameValue(name);
    setRenaming(id);
    closeMenu();
  }
  function commitRename(id: string) {
    onRename(id, renameValue);
    setRenaming(null);
  }
  function createSection() {
    const used = new Set(layout.sections.map(section => section.name));
    let name = 'New section';
    for (let index = 2; used.has(name); index += 1) name = `New section ${index}`;
    const id = `sec_${Math.random().toString(36).slice(2, 10)}`;
    onAdd(name, id);
    setRenameValue(name);
    setRenaming(id);
  }
  const sectionMenu = menu?.kind === 'section' ? layout.sections.find(section => section.id === menu.id) : undefined;
  const itemMenu = menu?.kind === 'item' && menu.itemKind ? findPlaced(grouped, menu.itemKind, menu.id) : undefined;
  return <nav className="nav-sections" aria-label={tr('Bots and rooms')}>
    {grouped.sections.map(section => <section key={section.id} className="nav-section" data-drop={dropId === section.id || undefined} onDragOver={event => { event.preventDefault(); setDropId(section.id); }} onDragLeave={() => setDropId(current => current === section.id ? null : current)} onDrop={event => { event.preventDefault(); setDropId(null); const sourceId = event.dataTransfer.getData('text/plain'); if (sourceId) onReorder(sourceId, section.id); }}>
      <div className="nav-section__head">
        {renaming === section.id ? <form className="nav-section__rename" onSubmit={event => { event.preventDefault(); commitRename(section.id); }}><input className="st-input" aria-label={tr('Section name')} value={renameValue} maxLength={40} autoFocus onChange={event => setRenameValue(event.target.value)} onBlur={() => commitRename(section.id)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setRenaming(null); } }}/></form> : <button type="button" className="nav-section__toggle" draggable aria-expanded={!section.collapsed} title={tr('Drag to reorder')} onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', section.id); }} onClick={() => onToggle(section.id)}><Icon name="chevron" size={14} className={cx('ws__chev', !section.collapsed && 'is-open')}/><span>{section.name}</span></button>}
        <button type="button" className="st-btn st-btn--icon session-overflow" aria-label={tr('Actions for {0}', [section.name])} onClick={event => openMenu({ kind: 'section', id: section.id }, event.currentTarget)}><Icon name="ellipsis" size={16}/></button>
      </div>
      <PaneCollapse open={!section.collapsed}><div className="nav-roster" aria-label={section.name}>
        {section.items.map(item => item.kind === 'bot' ? <BotRow key={item.id} bot={bots.find(row => row.id === item.id)} pinned={item.pinned} current={activeBotId === item.id} onMenu={element => openMenu({ kind: 'item', id: item.id, itemKind: 'bot' }, element)}/> : <RoomRow key={item.id} room={rooms.find(row => row.id === item.id)} pinned={item.pinned} current={activeRoomId === item.id} onMenu={element => openMenu({ kind: 'item', id: item.id, itemKind: 'room' }, element)}/>)}
        {!section.items.length ? <p className="small muted nav-roster__empty">{tr(section.id === 'bots' ? 'No bots yet' : section.id === 'rooms' ? 'No rooms yet' : 'Nothing in this section')}</p> : null}
      </div></PaneCollapse>
    </section>)}
    {grouped.hidden.length ? <div className="nav-hidden">
      <button type="button" className="nav-section__toggle" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen(open => !open)}><Icon name="chevron" size={14} className={cx('ws__chev', hiddenOpen && 'is-open')}/><span>{tr('Hidden')}</span><span className="nav-roster__badge">{grouped.hidden.length}</span></button>
      <PaneCollapse open={hiddenOpen}><div className="nav-roster" aria-label={tr('Hidden')}>{grouped.hidden.map(item => item.kind === 'bot' ? <BotRow key={item.id} bot={bots.find(row => row.id === item.id)} pinned={item.pinned} current={activeBotId === item.id} onMenu={element => openMenu({ kind: 'item', id: item.id, itemKind: 'bot' }, element)}/> : <RoomRow key={item.id} room={rooms.find(row => row.id === item.id)} pinned={item.pinned} current={activeRoomId === item.id} onMenu={element => openMenu({ kind: 'item', id: item.id, itemKind: 'room' }, element)}/>)}</div></PaneCollapse>
    </div> : null}
    <button type="button" className="navitem nav-section__add" disabled={full} title={full ? tr('Twelve sections is the limit') : tr('New section')} onClick={createSection}><Icon name="plus" size={16}/><span className="navitem__text">{tr('New section')}</span></button>
    {loading && !bots.length && !rooms.length ? <p className="small muted nav-roster__empty" role="status">{tr('Loading bots…')}</p> : null}
    {error && !bots.length && !rooms.length ? <p className="small muted nav-roster__empty" role="status">{tr('Bots could not be loaded.')}</p> : null}
    {sectionMenu ? <FloatingMenu anchor={trigger.current} title={tr('Actions for {0}', [sectionMenu.name])} onClose={closeMenu}>
      <button type="button" role="menuitem" className="menu__item" onClick={() => startRename(sectionMenu.id, sectionMenu.name)}><Icon name="pencil"/>{tr('Rename')}</button>
      <button type="button" role="menuitem" className="menu__item" disabled={layout.sections[0]?.id === sectionMenu.id} onClick={() => { onMove(sectionMenu.id, -1); closeMenu(); }}>{tr('Move up')}</button>
      <button type="button" role="menuitem" className="menu__item" disabled={layout.sections.at(-1)?.id === sectionMenu.id} onClick={() => { onMove(sectionMenu.id, 1); closeMenu(); }}>{tr('Move down')}</button>
      {sectionMenu.id !== 'bots' && sectionMenu.id !== 'rooms' ? <button type="button" role="menuitem" className="menu__item menu__item--danger" onClick={() => { onRemove(sectionMenu.id); closeMenu(); }}><Icon name="trash"/>{tr('Remove section')}</button> : null}
    </FloatingMenu> : null}
    {itemMenu ? <FloatingMenu anchor={trigger.current} title={tr('Actions for {0}', [itemMenu.item.name])} onClose={closeMenu}>
      <button type="button" role="menuitem" className="menu__item" onClick={() => { onPlace(itemMenu.ref, { pinned: !itemMenu.item.pinned }); closeMenu(); }}><Icon name="pin"/>{tr(itemMenu.item.pinned ? 'Unpin' : 'Pin')}</button>
      <button type="button" role="menuitem" className="menu__item" onClick={() => { onPlace(itemMenu.ref, { hidden: !itemMenu.hidden }); closeMenu(); }}>{tr(itemMenu.hidden ? 'Show' : 'Hide')}</button>
      {layout.sections.filter(section => section.id !== itemMenu.sectionId).map(section => <button type="button" role="menuitem" className="menu__item" key={section.id} onClick={() => { onPlace(itemMenu.ref, { sectionId: section.id, hidden: false }); closeMenu(); }}>{tr('Move to {0}', [section.name])}</button>)}
    </FloatingMenu> : null}
  </nav>;
}

function findPlaced(grouped: GroupedSidebar, kind: 'bot' | 'room', id: string) {
  for (const section of grouped.sections) {
    const item = section.items.find(row => row.kind === kind && row.id === id);
    if (item) return { item, hidden: false, sectionId: section.id, ref: { kind, id } };
  }
  const item = grouped.hidden.find(row => row.kind === kind && row.id === id);
  if (!item) return undefined;
  return { item, hidden: true, sectionId: '', ref: { kind, id } };
}

function BotRow({ bot, pinned, current, onMenu }: { bot?: SidebarBotRow; pinned: boolean; current: boolean; onMenu: (element: HTMLElement) => void }) {
  if (!bot) return null;
  const unread = bot.unread > 99 ? '99+' : String(bot.unread);
  return <div className={cx('nav-roster__row', pinned && 'is-pinned')}>
    <a className="nav-roster__open" href={href('bots', bot.id)} aria-current={current ? 'page' : undefined} aria-label={tr(bot.unread ? '{0}, {1}, {2} unread' : '{0}, {1}', bot.unread ? [bot.name, bot.statusLine, unread] : [bot.name, bot.statusLine])} title={bot.statusLine} onClick={() => setNavOpen(false)} onContextMenu={event => { event.preventDefault(); onMenu(event.currentTarget); }}><span className="nav-roster__avatar" aria-hidden="true"><CuaBotAvatar config={bot.avatarConfig} name={bot.name} size={32} mood={moodFor(bot.status)} animated={false}/><StatusDot status={bot.status === 'error' ? 'attention' : bot.status}/></span><span className="nav-roster__copy"><span className="nav-roster__name"><span title={bot.name}>{bot.name}</span>{pinned ? <Icon name="pin" size={12}/> : null}</span><span className="nav-roster__sub">{bot.status === 'working' ? <ShimmerText text={bot.statusLine}/> : bot.statusLine}</span></span>{bot.unread > 0 ? <span className="nav-roster__badge" aria-hidden="true">{unread}</span> : null}</a>
    <button type="button" className="st-btn st-btn--icon session-overflow" aria-label={tr('Actions for {0}', [bot.name])} onClick={event => onMenu(event.currentTarget)}><Icon name="ellipsis" size={16}/></button>
  </div>;
}

function RoomRow({ room, pinned, current, onMenu }: { room?: SidebarRoomRow; pinned: boolean; current: boolean; onMenu: (element: HTMLElement) => void }) {
  if (!room) return null;
  const members = teamRosterLabel(room.memberCount);
  const detail = room.typing ? room.typingLabel : members;
  const unread = room.unread > 99 ? '99+' : String(room.unread);
  return <div className={cx('nav-roster__row', 'nav-roster__row--room', pinned && 'is-pinned')}>
    <a className="nav-roster__open" href={`#/bots/teams?team=${encodeURIComponent(room.id)}`} aria-current={current ? 'page' : undefined} aria-label={tr(room.unread ? '{0}, {1}, {2} unread' : '{0}, {1}', room.unread ? [room.name, detail, unread] : [room.name, detail])} title={room.lastMessage ? `${room.name}. ${room.lastMessage}` : room.name} onClick={() => setNavOpen(false)} onContextMenu={event => { event.preventDefault(); onMenu(event.currentTarget); }}><span className="nav-room-faces" aria-hidden="true">{room.faces.map(face => <CuaBotAvatar key={face.id} config={face.avatarConfig} name={face.name} size={22} animated={false}/>)}{room.extra > 0 ? <span className="nav-room-extra">+{room.extra}</span> : null}</span><span className="nav-roster__copy"><span className="nav-roster__name"><span title={room.name}>{room.name}</span>{pinned ? <Icon name="pin" size={12}/> : null}</span><span className={cx('nav-roster__sub', room.typing && 'is-typing')}>{room.typing ? <><TypingDots label={detail} hiddenLabel/><ShimmerText text={detail}/></> : detail}</span></span>{room.unread > 0 ? <span className="nav-roster__badge" aria-hidden="true">{unread}</span> : null}</a>
    <button type="button" className="st-btn st-btn--icon session-overflow" aria-label={tr('Actions for {0}', [room.name])} onClick={event => onMenu(event.currentTarget)}><Icon name="ellipsis" size={16}/></button>
  </div>;
}

function moodFor(status: SidebarBotStatus): CuaBotMood {
  return status;
}
