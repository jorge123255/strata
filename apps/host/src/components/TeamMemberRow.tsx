import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CuaBotAvatar } from './CuaBotAvatar';
import { Btn, Dialog, Icon } from './ui';
import { DELETED_BOT_NAME } from '../lib/team-members';
import type { Bot } from '../lib/bots';

export function TeamMemberRow({ botId, name, missing, detail, avatarConfig, size = 34, disabled, onRemove, children }: {
  botId: string; name: string; missing: boolean; detail: string; avatarConfig?: Bot['avatarConfig']; size?: number; disabled?: boolean; onRemove: () => void; children?: ReactNode;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = missing ? DELETED_BOT_NAME : name;
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
    const onPointer = (event: PointerEvent) => { if (event.target instanceof Node && menuRef.current?.contains(event.target)) return; close(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onPointer); window.removeEventListener('scroll', close, true); };
  }, [menu]);
  function openConfirm() { setMenu(null); setConfirm(true); }
  return <div className="team-member-row" data-bot-id={botId} data-missing={missing || undefined} onContextMenu={event => { if (disabled || missing) return; event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>
    <CuaBotAvatar name={label} config={avatarConfig} size={size}/>
    <span><strong>{label}</strong><small>{detail}</small>{children}</span>
    {missing ? <button type="button" className="team-member-remove" aria-label={`Remove ${DELETED_BOT_NAME}`} disabled={disabled} onClick={() => { if (!disabled) onRemove(); }}>Remove</button> : <button type="button" className="team-member-x" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => { if (!disabled) openConfirm(); }}><Icon name="x" size={14}/></button>}
    {menu ? createPortal(<div ref={menuRef} className="team-member-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 48) }}><button type="button" role="menuitem" onClick={openConfirm}>Remove</button></div>, document.body) : null}
    <Dialog open={confirm} title={`Remove ${label} from this team?`} compact onClose={() => setConfirm(false)} actions={<><Btn onClick={() => setConfirm(false)}>Cancel</Btn><Btn variant="danger" onClick={() => { setConfirm(false); onRemove(); }}>Remove</Btn></>}>
      <p>Remove {label} from this team. Earlier messages stay in the room.</p>
    </Dialog>
  </div>;
}
