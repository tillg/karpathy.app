import { INPUT_DIR, type Command } from '@karpathy/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { ancestors, buildTree, dateOf, DEFAULT_SORT, inputCount, loadExpanded, saveExpanded, type TreeFilter, type TreeNode, type TreeSort } from '../lib/tree';
import { useApp } from '../store';
import { Icon } from './Icon';
import { TreeMenu } from './TreeMenu';

/** How each tree filter reads in the menu, the chip and the empty tree (#122). */
const FILTERS: Record<TreeFilter, { menu: string; chip: string; icon: string; empty: string }> = {
  any: { menu: 'Anyone', chip: '', icon: '', empty: '' },
  ai: { menu: 'AI', chip: 'Changed by AI', icon: 'sparkles', empty: 'No notes changed by the AI yet.' },
  human: { menu: 'Human', chip: 'Changed by human', icon: 'person', empty: 'No notes changed by a human yet.' },
};

export function FileTree() {
  const { files, note, openNote, newNote, readOnly, usable, online, activeId, sortFilter, setSortFilter, status, conflict, ingestNow, commandsNonce } = useApp();
  const { sort, filter } = sortFilter;
  // The queue length counts every item, whatever the filter shows; the Input row stays visible under a filter.
  const queued = useMemo(() => inputCount(buildTree(files)), [files]);
  // The Ingest button needs the vault's `ingest` skill (#131).
  const [commands, setCommands] = useState<{ vault: string; list: Command[] } | null>(null);
  useEffect(() => {
    if (!activeId || !usable || !queued) return;
    api.commands(activeId).then((list) => setCommands({ vault: activeId, list })).catch(() => undefined);
  }, [activeId, usable, queued > 0, commandsNonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const canIngest = commands?.vault === activeId && commands.list.some((c) => c.name === 'ingest');
  const [ingesting, setIngesting] = useState(false);
  const ingestBlocked = !online ? 'Offline' : conflict ? 'The vault is in conflict' : status?.busy === 'turn' ? 'The AI is working in this vault' : ingesting ? 'Starting…' : null;
  const ingest = () => {
    setIngesting(true);
    void ingestNow().finally(() => setIngesting(false));
  };
  const tree = useMemo(() => {
    const t = buildTree(files, sort, filter);
    return queued && !t.some((n) => n.dir && n.name === INPUT_DIR) ? [{ name: INPUT_DIR, path: INPUT_DIR, dir: true, children: [] }, ...t] : t;
  }, [files, sort, filter, queued]);
  const setSort = (s: TreeSort) => setSortFilter({ sort: s, filter });
  const setFilter = (f: TreeFilter) => setSortFilter({ sort, filter: f });
  const byName = sort.by === 'name';
  // Direction labels follow the criterion: A → Z / Z → A, or Newest first / Oldest first.
  const [up, down] = byName ? ['A → Z', 'Z → A'] : ['Oldest first', 'Newest first'];
  // Folders start collapsed; what the user opens is kept per vault (#53).
  const [exp, setExp] = useState(() => ({ vault: activeId, set: activeId ? loadExpanded(localStorage, activeId) : new Set<string>() }));
  if (exp.vault !== activeId) setExp({ vault: activeId, set: activeId ? loadExpanded(localStorage, activeId) : new Set() });
  const expanded = exp.set;
  const update = (fn: (s: Set<string>) => void) => setExp((e) => {
    const set = new Set(e.set);
    fn(set);
    if (e.vault) saveExpanded(localStorage, e.vault, set);
    return { vault: e.vault, set };
  });
  const toggle = (p: string) => update((s) => { if (s.has(p)) s.delete(p); else s.add(p); });
  // The open note's folders open with it, unless the filter hides the note.
  const notePath = note?.path;
  const noteShown = !notePath || filter === 'any' || files.some((f) => f.path === notePath && dateOf(f, filter) !== undefined);
  useEffect(() => {
    if (notePath && noteShown && ancestors(notePath).some((a) => !exp.set.has(a))) update((s) => ancestors(notePath).forEach((a) => s.add(a)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePath, exp.vault, noteShown]);
  // ...and its row scrolls into view when the open note changes (#100), after the folders rendered open.
  const selRef = useRef<HTMLButtonElement | null>(null);
  const scrolledTo = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!notePath || !selRef.current || scrolledTo.current === notePath) return;
    scrolledTo.current = notePath;
    selRef.current.scrollIntoView({ block: 'nearest' });
  });

  const create = () => {
    const dir = note?.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/') + 1) : '';
    const name = prompt('New note (path inside the vault)', `${dir}Untitled.md`);
    if (!name?.trim()) return;
    const path = name.trim().replace(/^\/+/, '');
    // A trailing `/` goes to the server as typed, which rejects it with a readable message.
    void newNote(/\.[a-z0-9]+$/i.test(path) || path.endsWith('/') ? path : `${path}.md`);
  };

  const render = (nodes: TreeNode[], depth: number) => nodes.map((n) => {
    const row = (
      <button
        ref={note?.path === n.path ? selRef : undefined}
        className={`trow${n.dir ? ' dir' : ''}${note?.path === n.path ? ' sel' : ''}`}
        style={{ paddingLeft: 10 + depth * 16 }}
        data-testid="tree-item" data-path={n.path} data-type={n.dir ? 'dir' : 'file'}
        aria-expanded={n.dir ? expanded.has(n.path) : undefined} aria-current={note?.path === n.path ? 'page' : undefined}
        onClick={() => (n.dir ? toggle(n.path) : void openNote(n.path))}
      >
        {n.dir
          ? <span className="tw"><Icon n={expanded.has(n.path) ? 'chevron_down' : 'chevron_right'} size={12} /></span>
          : <span className="tw" />}
        <span className="ic"><Icon n={n.dir ? 'folder' : /\.md$/i.test(n.name) ? 'doc_text' : 'doc'} size={18} /></span>
        <span className="nm">{n.dir ? n.name : n.name.replace(/\.md$/i, '')}</span>
        {n.path === INPUT_DIR && queued > 0 && (
          <span className="input-badge" data-testid="input-badge" aria-label={`${queued} sources waiting to be ingested`}
            title={canIngest ? undefined : 'Add an `ingest` skill to `.agents/skills/` to ingest from here'}>{queued}</span>
        )}
      </button>
    );
    return (
      <div key={n.path}>
        {n.path === INPUT_DIR && queued > 0 && canIngest
          ? (
            <div className="trow-act">
              {row}
              <button className="btn sm g" data-testid="ingest-now" disabled={!!ingestBlocked} title={ingestBlocked ?? 'Ingest the queued sources in a new chat'}
                onClick={ingest}>Ingest</button>
            </div>
          )
          : row}
        {n.dir && expanded.has(n.path) && render(n.children, depth + 1)}
      </div>
    );
  });

  return (
    <div className="tree">
      <div className="gh">Notes
        <span className="gh-tools">
          <TreeMenu icon="arrow_up_arrow_down" title="Sort" testId="tree-sort" closeOnSelect={false}
            on={sort.by !== DEFAULT_SORT.by || sort.dir !== DEFAULT_SORT.dir}
            groups={[
              {
                label: 'Sort by',
                items: [
                  // Picking a criterion sets its natural direction: A → Z, newest first.
                  { label: 'Name', checked: byName, select: () => setSort({ by: 'name', dir: 'asc' }) },
                  { label: 'Last changed', checked: !byName, select: () => setSort({ by: 'changed', dir: 'desc' }) },
                ],
              },
              {
                label: 'Order',
                // Each criterion lists its natural direction first.
                items: (byName ? (['asc', 'desc'] as const) : (['desc', 'asc'] as const)).map((dir) => ({
                  label: dir === 'asc' ? up : down,
                  checked: sort.dir === dir,
                  select: () => setSort({ by: sort.by, dir }),
                })),
              },
            ]} />
          <TreeMenu icon="funnel" title="Filter" testId="tree-filter" closeOnSelect on={filter !== 'any'}
            groups={[{
              label: 'Changed by',
              items: (['any', 'ai', 'human'] as const).map((f) => ({ label: FILTERS[f].menu, checked: filter === f, select: () => setFilter(f) })),
            }]} />
          <button className="ib sm" title="New note" data-testid="new-note" onClick={create} disabled={readOnly || !usable}><Icon n="square_pencil" size={19} /></button>
        </span>
      </div>
      {filter !== 'any' && (
        <div className="tree-chip" data-testid="tree-filter-chip">
          <Icon n={FILTERS[filter].icon} size={15} />
          <span>{FILTERS[filter].chip}</span>
          <button className="ib sm" aria-label="Clear filter" title="Clear filter" onClick={() => setFilter('any')}><Icon n="xmark" size={14} /></button>
        </div>
      )}
      {tree.length
        ? render(tree, 0)
        : <div className="empty">{!usable ? '' : filter !== 'any' && files.length ? FILTERS[filter].empty : online ? 'This vault is empty.' : 'Offline — the file list is not cached yet.'}</div>}
    </div>
  );
}
