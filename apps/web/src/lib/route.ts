// Hash route `#/<vault>/<note path>`: the active vault and open note, so Back/Forward and reload
// work (issue #5). Never carries the token.

/** Admin mode (#150): `#admin` (the list, `''`) and `#admin/<section>`. Never matches a vault route, which starts with `#/`. */
export const ADMIN_SECTIONS = ['general', 'vaults', 'secrets', 'ai', 'usage', 'server'] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export interface Route { admin: AdminSection | '' | null; vault: string | null; path: string | null }

type VaultRoute = Pick<Route, 'vault' | 'path'>;

export function formatAdminRoute(section: AdminSection | ''): string {
  return section ? `#admin/${section}` : '#admin';
}

export function formatRoute(vault: string | null, path?: string | null): string {
  if (!vault) return '';
  const p = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
  return `#/${encodeURIComponent(vault)}${p}`;
}

export function parseRoute(hash: string): Route {
  const a = /^#admin(?:\/([^/]*))?$/.exec(hash);
  if (a) return { admin: ADMIN_SECTIONS.find((x) => x === a[1]) ?? (a[1] === undefined ? '' : 'general'), vault: null, path: null };
  const m = /^#\/([^/]+)(?:\/(.*))?$/.exec(hash);
  if (!m) return { admin: null, vault: null, path: null };
  try {
    return { admin: null, vault: decodeURIComponent(m[1]!), path: m[2] ? m[2].split('/').map(decodeURIComponent).join('/') : null };
  } catch {
    return { admin: null, vault: null, path: null };
  }
}

/** What a history entry remembers (#139): the file open before it in the same vault, for the back arrow. */
export interface RouteState { prev: string | null }

/**
 * The state for the entry going from `from` to `to`. A push remembers `from`'s file when it is in the same
 * vault; a replace (outline jump, move into own folder) keeps what the replaced entry remembered.
 */
export function routeState(from: VaultRoute, to: VaultRoute, replace: boolean, cur: RouteState | null): RouteState | null {
  if (!to.path) return null;
  if (replace) return { prev: cur?.prev ?? null };
  return { prev: from.vault === to.vault && from.path ? from.path : null };
}
