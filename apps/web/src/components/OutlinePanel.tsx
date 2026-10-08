import { useEffect, useMemo, useRef } from 'react';
import type { OutlineItem } from '../lib/outline';

/** Words, characters and reading time of the body, or of the selection. */
export interface NoteInfo { words: number; chars: number; minutes: number; selection: boolean }

const n = (x: number) => x.toLocaleString();

/**
 * The note's outline (#79): a bottom sheet on the phone, a floating panel at the top right of the note pane
 * otherwise. Escape closes it; the sheet also on a scrim or grabber tap, the panel on a tap outside when
 * `closeOutside` (tablet).
 */
export function OutlinePanel({ variant, items, info, current, closeOutside, onJump, onClose }: {
  variant: 'sheet' | 'panel';
  items: OutlineItem[];
  info: NoteInfo;
  /** Index of the current section's heading, -1 for none. */
  current: number;
  closeOutside: boolean;
  onJump(line: number): void;
  onClose(): void;
}) {
  const min = Math.min(...items.map((i) => i.level));
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const jump = useRef(onJump);
  jump.current = onJump;

  // The current item stays in view inside the list (only the list scrolls, never the panes around it).
  useEffect(() => {
    const l = list.current;
    const el = l?.querySelector<HTMLElement>('[aria-current]');
    if (!l || !el) return;
    if (el.offsetTop < l.scrollTop) l.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = el.offsetTop + el.offsetHeight - l.clientHeight;
  }, [current]);

  // The modal sheet takes focus: the current item, else the first one.
  useEffect(() => {
    if (variant !== 'sheet') return;
    (list.current?.querySelector<HTMLElement>('[aria-current]') ?? list.current?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }, [variant]);

  // On `document`, so it runs before Shell's window handler, which then skips the prevented Escape.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close.current(); } };
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!box.current?.contains(t) && !t.closest?.('#outline-button')) close.current();
    };
    document.addEventListener('keydown', key);
    if (closeOutside) document.addEventListener('pointerdown', down);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', down); };
  }, [closeOutside]);

  // A long note has thousands of headings: the list re-renders only when they or the current one change.
  const listed = useMemo(() => (items.length ? (
    <ol className="outline-list" ref={list}>
      {items.map((it, i) => (
        <li key={`${it.line}`}>
          <button className="outline-item" data-testid="outline-item" data-line={it.line} data-level={it.level}
            aria-current={i === current ? 'location' : undefined}
            style={{ paddingLeft: 16 + 12 * Math.min(5, it.level - min) }} onClick={() => jump.current(it.line)}>{it.text}</button>
        </li>
      ))}
    </ol>
  ) : <p className="empty">No headings</p>), [items, current, min]);

  return (
    <>
      {variant === 'sheet' && <div className="outline-scrim" data-testid="outline-scrim" onClick={onClose} />}
      <div ref={box} className={`outline ${variant}`} role="dialog" aria-modal={variant === 'sheet'} aria-label="Outline" data-testid="outline">
        {variant === 'sheet' && <button className="grabber" aria-label="Close outline" onClick={onClose}><span /></button>}
        {listed}
        <p className="note-info" data-testid="note-info">
          {info.selection
            ? `Selection: ${n(info.words)} words · ${n(info.chars)} characters`
            : `${n(info.words)} words · ${n(info.chars)} characters · ~${n(info.minutes)} min read`}
        </p>
      </div>
    </>
  );
}
