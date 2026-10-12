// Hash route `#/<vault>/<note path>`: the active vault and open note, so Back/Forward and reload
// work (issue #5). Never carries the token.

export interface Route { vault: string | null; path: string | null }

export function formatRoute(vault: string | null, path?: string | null): string {
  if (!vault) return '';
  const p = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
  return `#/${encodeURIComponent(vault)}${p}`;
}

export function parseRoute(hash: string): Route {
  const m = /^#\/([^/]+)(?:\/(.*))?$/.exec(hash);
  if (!m) return { vault: null, path: null };
  try {
    return { vault: decodeURIComponent(m[1]!), path: m[2] ? m[2].split('/').map(decodeURIComponent).join('/') : null };
  } catch {
    return { vault: null, path: null };
  }
}

/** What a history entry remembers (#139): the file open before it in the same vault, for the back arrow. */
export interface RouteState { prev: string | null }

/**
 * The state for the entry going from `from` to `to`. A push remembers `from`'s file when it is in the same
 * vault; a replace (outline jump, move into own folder) keeps what the replaced entry remembered.
 */
export function routeState(from: Route, to: Route, replace: boolean, cur: RouteState | null): RouteState | null {
  if (!to.path) return null;
  if (replace) return { prev: cur?.prev ?? null };
  return { prev: from.vault === to.vault && from.path ? from.path : null };
}
