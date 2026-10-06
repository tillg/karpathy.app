import type { FileEntry } from '@karpathy/shared';

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
  /** Under sort by `changed`: the file's Last-changed date, or a folder's newest one inside it. */
  date?: number;
}

/** Tree sort and filter (#122). */
export interface TreeSort {
  by: 'name' | 'changed';
  dir: 'asc' | 'desc';
}
export type TreeFilter = 'any' | 'ai' | 'human';
export interface TreeSortFilter {
  sort: TreeSort;
  filter: TreeFilter;
}
export const DEFAULT_SORT: TreeSort = { by: 'name', dir: 'asc' };

/** Whether the tree depends on the listing's dates (sorted by Last changed, or filtered by author). */
export function usesDates(v: TreeSortFilter): boolean {
  return v.sort.by === 'changed' || v.filter !== 'any';
}

/** The date "Last changed" means under `filter`: by anyone, by the AI, or by a person. */
export function dateOf(e: FileEntry, filter: TreeFilter): number | undefined {
  return filter === 'any' ? e.modified : e[filter];
}

/**
 * Nests a flat listing; folders first, then files, each in `sort` order. A filter other than `any`
 * keeps only files with that author's date, and the folders on their way.
 */
export function buildTree(entries: FileEntry[], sort: TreeSort = DEFAULT_SORT, filter: TreeFilter = 'any'): TreeNode[] {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  const dirOf = (path: string): TreeNode => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const i = path.lastIndexOf('/');
    const node: TreeNode = { name: path.slice(i + 1), path, dir: true, children: [] };
    dirOf(i < 0 ? '' : path.slice(0, i)).children.push(node);
    dirs.set(path, node);
    return node;
  };
  const byDate = sort.by === 'changed';
  for (const e of entries) {
    // Under a filter, folders exist only on the way to a kept file.
    if (filter !== 'any' && (e.type === 'dir' || dateOf(e, filter) === undefined)) continue;
    if (e.type === 'dir') dirOf(e.path);
    else {
      const i = e.path.lastIndexOf('/');
      const date = byDate ? dateOf(e, filter) : undefined;
      dirOf(i < 0 ? '' : e.path.slice(0, i)).children.push({ name: e.path.slice(i + 1), path: e.path, dir: false, children: [], ...(date !== undefined ? { date } : {}) });
    }
  }
  const sign = sort.dir === 'desc' ? -1 : 1;
  const compare = (a: TreeNode, b: TreeNode): number => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (!byDate) return sign * a.name.localeCompare(b.name);
    // Undated last in both directions; ties by name A → Z.
    if (a.date === undefined || b.date === undefined) return a.date === b.date ? a.name.localeCompare(b.name) : a.date === undefined ? 1 : -1;
    return a.date === b.date ? a.name.localeCompare(b.name) : sign * (a.date - b.date);
  };
  const order = (n: TreeNode) => {
    n.children.forEach(order);
    if (n.dir && byDate) {
      // A folder's rank: the newest date anywhere inside it.
      const dates = n.children.flatMap((c) => (c.date === undefined ? [] : [c.date]));
      if (dates.length) n.date = Math.max(...dates);
    }
    n.children.sort(compare);
  };
  order(root);
  return root.children;
}

/** The folders above a path, outermost first (`a/b/c.md` → `a`, `a/b`). */
export function ancestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

// Expanded folders per vault (#53): everything starts collapsed; the user's choice survives
// tab switches and reloads.
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const expandedKey = (vault: string) => `karpathy.tree:${vault}`;

export function loadExpanded(s: Store, vault: string): Set<string> {
  try {
    const v = JSON.parse(s.getItem(expandedKey(vault)) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveExpanded(s: Store, vault: string, expanded: Set<string>) {
  try { s.setItem(expandedKey(vault), JSON.stringify([...expanded])); } catch { /* quota / private mode: best effort */ }
}

// Sort and filter per browser, for all vaults (#122); anything unreadable means the defaults.
const SORT_KEY = 'karpathy.treeSort';
const FILTER_KEY = 'karpathy.treeFilter';

export function loadSortFilter(s: Store): TreeSortFilter {
  let sort = DEFAULT_SORT;
  let filter: TreeFilter = 'any';
  try {
    const v = JSON.parse(s.getItem(SORT_KEY) ?? 'null') as Partial<TreeSort> | null;
    if ((v?.by === 'name' || v?.by === 'changed') && (v.dir === 'asc' || v.dir === 'desc')) sort = { by: v.by, dir: v.dir };
  } catch { /* broken or denied: default */ }
  try {
    const f = s.getItem(FILTER_KEY);
    if (f === 'ai' || f === 'human') filter = f;
  } catch { /* denied: default */ }
  return { sort, filter };
}

export function saveSortFilter(s: Store, v: TreeSortFilter) {
  try {
    s.setItem(SORT_KEY, JSON.stringify(v.sort));
    s.setItem(FILTER_KEY, v.filter);
  } catch { /* quota / private mode: best effort */ }
}
