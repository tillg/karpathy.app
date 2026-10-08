import { useEffect, useState } from 'react';
import { isListKind, isPropertyName, type Edit, type Frontmatter, type Prop } from '../lib/frontmatter';
import type { FieldRule, Violation } from '../lib/schema';
import type { PropsView } from '../store';
import { Icon } from './Icon';
import { Linked } from './Linked';

/** Today in the user's time zone, as YYYY-MM-DD. */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Phone keyboard: no capitals or corrections for names and tags; Enter says "done". */
const KEYS = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, enterKeyHint: 'done' } as const;

/** A text input that commits on blur and on Enter (one change = one edit = one undo step), not per keystroke. */
function TextField({ value, numeric, disabled, label, describedBy, onCommit }: {
  value: string; numeric?: boolean; disabled: boolean; label: string; describedBy?: string; onCommit(v: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <input type="text" className="props-input" value={draft} disabled={disabled} aria-label={label} aria-describedby={describedBy}
      inputMode={numeric ? 'decimal' : undefined} {...KEYS} spellCheck={numeric ? false : undefined}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
  );
}

/** The 8 best note names for `q`: name prefix first, then substring. */
function suggest(names: string[], q: string, taken: unknown[]): string[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const free = names.filter((n) => !taken.some((x) => String(x).replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '').toLowerCase() === n.toLowerCase()));
  const pre = free.filter((n) => n.toLowerCase().startsWith(t));
  const sub = free.filter((n) => !n.toLowerCase().startsWith(t) && n.toLowerCase().includes(t));
  return [...pre, ...sub].slice(0, 8);
}

/** Adds a list item: Enter adds the typed text and keeps the field for the next one; link lists suggest note names. */
function AddField({ p, names, disabled, onAdd }: { p: Prop; names: string[]; disabled: boolean; onAdd(item: string): void }) {
  const [draft, setDraft] = useState('');
  const hits = p.kind === 'links' ? suggest(names, draft, p.value as unknown[]) : [];
  const add = (item: string) => { if (item.trim()) onAdd(item.trim()); setDraft(''); };
  return (
    <span className="props-add">
      <input type="text" className="props-input props-add-input" value={draft} disabled={disabled} placeholder="Add…" aria-label={`Add to ${p.key}`} {...KEYS}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }} />
      {hits.length > 0 && (
        <span className="props-sugg" role="listbox" aria-label="Notes">
          {hits.map((n) => (
            <button key={n} role="option" aria-selected={false} data-testid="props-suggestion" onMouseDown={(e) => e.preventDefault()} onClick={() => add(n)}>{n}</button>
          ))}
        </span>
      )}
    </span>
  );
}

function Field({ p, rule, names, disabled, describedBy, onEdit, onYaml }: {
  p: Prop; rule?: FieldRule; names: string[]; disabled: boolean; describedBy?: string; onEdit(e: Edit): void; onYaml(): void;
}) {
  const set = (value: string | number | boolean) => onEdit({ op: 'set', key: p.key, value });
  const v = p.value;
  const label = p.key;
  switch (p.kind) {
    case 'raw':
      return (
        <span className="props-raw">
          <span className="props-rawtext">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
          <button className="link" onClick={onYaml}>Edit in YAML</button>
        </span>
      );
    case 'enum': {
      const values = rule?.values ?? [];
      const cur = v === null ? '' : String(v);
      return (
        <select className="props-input" value={cur} disabled={disabled} aria-label={label} aria-describedby={describedBy} onChange={(e) => set(e.target.value)}>
          {/* A value outside the list stays an option, so opening the picker never loses it. */}
          {!values.includes(cur) && <option value={cur}>{cur || '—'}</option>}
          {values.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      );
    }
    case 'date':
      return (
        <span className="props-date">
          <input type="date" className="props-input" value={typeof v === 'string' ? v : ''} disabled={disabled} aria-label={label} aria-describedby={describedBy}
            onChange={(e) => { if (e.target.value) set(e.target.value); }} />
          <button className="props-btn" disabled={disabled} onClick={() => set(today())}>Today</button>
        </span>
      );
    case 'boolean':
      return <input type="checkbox" className="switch" checked={v === true} disabled={disabled} aria-label={label} aria-describedby={describedBy} onChange={() => set(v !== true)} />;
    case 'number':
      return <TextField value={v === null ? '' : String(v)} numeric disabled={disabled} label={label} describedBy={describedBy}
        onCommit={(x) => set(String(Number(x.trim())) === x.trim() ? Number(x.trim()) : x)} />; // `007`, `1.10` stay as typed
    case 'list':
    case 'links': {
      const items = Array.isArray(v) ? v : [];
      return (
        <span className="props-chips" aria-describedby={describedBy}>
          {items.map((item, i) => (
            <span className="chip" key={i}>
              <span className="chip-label">{p.kind === 'links' ? <Linked text={String(item)} bare /> : String(item)}</span>
              <button className="chip-x" aria-label={`Remove ${String(item)}`} disabled={disabled} onClick={() => onEdit({ op: 'remove', key: p.key, index: i })}><Icon n="xmark" size={12} /></button>
            </span>
          ))}
          <AddField p={p} names={names} disabled={disabled} onAdd={(item) => onEdit({ op: 'add', key: p.key, item })} />
        </span>
      );
    }
    default:
      return <TextField value={v === null ? '' : String(v)} disabled={disabled} label={label} describedBy={describedBy} onCommit={set} />;
  }
}

/** "+ Property": the schema's missing keys are offered, any other plain key can be typed. */
function AddProperty({ fm, rules, offered, disabled, onEdit, toast }: {
  fm: Pick<Frontmatter, 'props'>; rules: Record<string, FieldRule>; offered: string[]; disabled: boolean; onEdit(e: Edit): void; toast(text: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const add = () => {
    const k = key.trim();
    if (!k) return;
    if (!isPropertyName(k)) { toast(`“${k}” can’t be a property name: letters, digits, spaces, - and _ only`); return; }
    if (fm.props.some((p) => p.key === k)) { toast(`“${k}” is already there`); return; }
    // A starting value by the rule's kind; an enum gets none (the app never picks a value).
    const kind = rules[k]?.kind;
    onEdit({ op: 'addKey', key: k, value: kind && isListKind(kind) ? [] : kind === 'date' ? today() : '' });
    setKey('');
    setOpen(false);
  };
  if (!open) return <button className="props-addbtn" data-testid="props-add" disabled={disabled} onClick={() => setOpen(true)}>+ Property</button>;
  return (
    <div className="props-row props-addrow">
      <input type="text" className="props-input" data-testid="props-add-key" list="props-add-keys" value={key} autoFocus placeholder="Property name" aria-label="New property" {...KEYS}
        onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') setOpen(false); }} />
      <datalist id="props-add-keys">{offered.map((k) => <option key={k} value={k} />)}</datalist>
      <button className="props-btn" onClick={add}>Add</button>
    </div>
  );
}

/** The note's properties as a form (#82), in Write mode between the title and the text. */
export function PropertiesPanel({ fm, rules, names, violations, view, disabled, onView, onEdit, onYaml, toast }: {
  fm: Pick<Frontmatter, 'props' | 'error'>;
  rules: Record<string, FieldRule>;
  /** The vault's note names, for link suggestions. */
  names: string[];
  violations: Violation[];
  view: Exclude<PropsView, 'yaml'>;
  disabled: boolean;
  onView(v: PropsView): void;
  onEdit(e: Edit): void;
  /** Show the YAML lines for this note only. */
  onYaml(): void;
  toast(text: string): void;
}) {
  const open = view === 'open';
  return (
    <section className="props-form" data-testid="props" aria-label="Properties">
      <div className="props-head">
        <button className="props-toggle" aria-expanded={open} onClick={() => onView(open ? 'closed' : 'open')}>
          <Icon n={open ? 'chevron_down' : 'chevron_right'} size={14} />
          <span>Properties</span>
          <span className="props-count">{fm.props.length}</span>
          {violations.length > 0 && <span className="props-warn">⚠ {violations.length}</span>}
        </button>
        <span className="sp" />
        <button className="props-yaml" aria-pressed={false} data-testid="props-yaml" onClick={() => onView('yaml')}>YAML</button>
      </div>
      {open && fm.props.map((p) => {
        const flags = violations.filter((x) => x.key === p.key);
        const id = flags.length ? `props-v-${p.key}` : undefined;
        return (
          <div className="props-row" data-testid="props-row" data-key={p.key} key={p.key}>
            <span className="props-key">{p.key}</span>
            <span className="props-val">
              <Field p={p} rule={rules[p.key]} names={names} disabled={disabled} describedBy={id} onEdit={onEdit} onYaml={onYaml} />
              {flags.length > 0 && <span className="props-violation" id={id} role="status" data-testid="props-violation">{flags.map((f) => f.message).join(' · ')}</span>}
            </span>
          </div>
        );
      })}
      {open && violations.filter((x) => !fm.props.some((p) => p.key === x.key)).map((x) => (
        <div className="props-row" data-testid="props-missing" data-key={x.key} key={`missing-${x.key}`}>
          <span className="props-key">{x.key}</span>
          <span className="props-violation" role="status" data-testid="props-violation">{x.message}</span>
        </div>
      ))}
      {open && <AddProperty fm={fm} rules={rules} offered={Object.keys(rules).filter((k) => !fm.props.some((p) => p.key === k))}
        disabled={disabled} onEdit={onEdit} toast={toast} />}
    </section>
  );
}
