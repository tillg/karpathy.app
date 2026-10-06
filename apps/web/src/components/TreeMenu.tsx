import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon';

interface MenuGroup {
  label: string;
  items: { label: string; checked: boolean; select: () => void }[];
}

/**
 * An icon button in the tree header with a menu of radio groups (#122). `on` tints the button
 * (not at its default). `closeOnSelect`: one decision per visit (filter) or several (sort).
 */
export function TreeMenu({ icon, title, testId, on, groups, closeOnSelect }: { icon: string; title: string; testId: string; on: boolean; groups: MenuGroup[]; closeOnSelect: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitemradio]') ?? [])];
  useEffect(() => {
    if (open) (items().find((e) => e.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
  }, [open]);
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
    <div className="tmenu" ref={box}>
      <button className={`ib sm${on ? ' on' : ''}`} ref={trigger} title={title} aria-label={title} data-testid={testId}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon n={icon} size={18} />
      </button>
      {open && (
        <div className="menu tree-menu" role="menu" ref={menu} aria-label={title} onKeyDown={onMenuKey}>
          {groups.map((g, gi) => (
            <div key={g.label} role="group" aria-labelledby={`${id}-${gi}`}>
              {gi > 0 && <hr />}
              <div className="mh" id={`${id}-${gi}`} role="presentation">{g.label}</div>
              {g.items.map((it) => (
                <button key={it.label} className="mi" role="menuitemradio" aria-checked={it.checked} tabIndex={-1}
                  onClick={() => { it.select(); if (closeOnSelect) dismiss(); }}>
                  <span className="ck">{it.checked && <Icon n="checkmark" size={17} />}</span>
                  <span>{it.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
