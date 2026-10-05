import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

// No wildcard and no HEIC, JPEG first: iOS then converts HEIC library photos to JPEG (architecture F9, F10).
const CHOOSE_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,application/pdf';

/**
 * The **+** button: Take photo (the camera on a phone, the file picker elsewhere) or Choose file.
 * `testid` names the button; its menu entries are `attach-photo` and `attach-choose`.
 */
export function AttachButton({ testid, multiple, disabled, up, onFiles }: {
  testid: string;
  multiple?: boolean;
  disabled?: boolean;
  /** Opens the menu above the button (the chat composer sits at the bottom). */
  up?: boolean;
  onFiles(files: File[], fromCamera: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const picked = (e: React.ChangeEvent<HTMLInputElement>, fromCamera: boolean) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = ''; // the same file again is a new pick
    setOpen(false);
    if (files.length) onFiles(files, fromCamera);
  };
  return (
    <div className="attach" ref={box}>
      <button className={`ib${open ? ' on' : ''}`} title="Attach photo or file" aria-haspopup="menu" aria-expanded={open}
        data-testid={testid} disabled={disabled} onClick={() => setOpen(!open)}><Icon n="plus" /></button>
      {open && (
        <div className={`menu attach-menu${up ? ' up' : ''}`} role="menu">
          <label className="mi" role="menuitem" data-testid="attach-photo">
            <span className="ck"><Icon n="camera" size={17} /></span><span>Take photo</span>
            <input type="file" hidden accept="image/jpeg" capture="environment" onChange={(e) => picked(e, true)} />
          </label>
          <label className="mi" role="menuitem" data-testid="attach-choose">
            <span className="ck"><Icon n="photo_on_rectangle" size={17} /></span><span>Choose file<small>Photo or PDF</small></span>
            <input type="file" hidden accept={CHOOSE_ACCEPT} multiple={multiple} onChange={(e) => picked(e, false)} />
          </label>
        </div>
      )}
    </div>
  );
}
