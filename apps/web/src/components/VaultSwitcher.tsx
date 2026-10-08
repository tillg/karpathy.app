import { useEffect, useId, useRef, useState } from 'react';
import { useApp } from '../store';
import { brandName } from '../lib/brand';
import { Icon } from './Icon';

/** Brand + active vault; opens a menu to switch vaults or manage them (ARIA menu button, issue #43). */
export function VaultSwitcher({ compact }: { compact?: boolean }) {
  const { vaults, active, setActiveId, setAdminOpen } = useApp();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const headId = useId();
  /** Which item gets focus when the menu opens (ArrowUp on the trigger opens on the last one). */
  const openAt = useRef<'first' | 'last'>('first');
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
  useEffect(() => {
    if (!open) return;
    const all = items();
    all[openAt.current === 'last' ? all.length - 1 : 0]?.focus();
  }, [open]);

  /** Closes the menu; focus goes back to the trigger (before the item unmounts, so dialogs opened from here return to it). */
  const dismiss = () => { trigger.current?.focus(); setOpen(false); };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't also close the overlay sidebar
      dismiss();
    } else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className={`vswitch${compact ? ' compact' : ''}`} ref={box}>
      <button className="brand" ref={trigger} data-testid="vault-switcher" onClick={() => { openAt.current = 'first'; setOpen(!open); }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          openAt.current = e.key === 'ArrowUp' ? 'last' : 'first';
          if (open) items()[openAt.current === 'last' ? items().length - 1 : 0]?.focus();
          else setOpen(true);
        }}
        aria-haspopup="menu" aria-expanded={open}>
        {!compact && <img src="/icon-192.png" alt="" />}
        <div>
          {!compact && <b>{brandName(import.meta.env.VITE_STACK)}</b>}
          <small>{active ? `${active.name} · ${active.branch}` : 'No vault'} <Icon n="chevron_down" size={11} /></small>
        </div>
      </button>
      {open && (
        <div className="menu" role="menu" ref={menu} aria-labelledby={headId} onKeyDown={onMenuKey}>
          <div className="mh" id={headId} role="presentation">Vaults · GitHub repos</div>
          {vaults?.map((v) => (
            <button key={v.id} className="mi" role="menuitem" tabIndex={-1} data-testid="vault-option" data-vault={v.id}
              onClick={() => { dismiss(); void setActiveId(v.id); }}>
              <span className="ck">{v.id === active?.id && <Icon n="checkmark" size={17} />}</span>
              <span>{v.name}<small>{v.repo}{v.state !== 'ready' ? ` · ${v.state}` : ''}</small></span>
            </button>
          ))}
          <hr />
          <button className="mi" role="menuitem" tabIndex={-1} data-testid="manage-vaults" onClick={() => { dismiss(); setAdminOpen('vaults'); }}>
            <span className="ck"><Icon n="rectangle_stack" size={17} /></span><span>Manage vaults…<small>Add / configure GitHub repos</small></span>
          </button>
        </div>
      )}
    </div>
  );
}
