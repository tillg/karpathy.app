import type { Command } from '@karpathy/shared';

// Command palette and chips: pure helpers over the vault's command list (GET /vaults/:id/commands).

/** The partial command name while the composer holds `/` plus name characters only; else null. */
export function paletteQuery(text: string): string | null {
  const m = /^\/([\w.:-]*)$/.exec(text);
  return m ? m[1]! : null;
}

/** Case-insensitive; vault skills before app skills, within each group prefix matches first, then other matches, each A–Z. */
export function filterCommands(list: Command[], q: string): Command[] {
  const needle = q.toLowerCase();
  const rank = (c: Command) => (c.source === 'vault' ? 0 : 2) + (c.name.toLowerCase().startsWith(needle) ? 0 : 1);
  return list
    .filter((c) => c.name.toLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Recent names still in the list (newest first), then the rest A–Z, at most `n`. */
export function chipCommands(list: Command[], recent: string[], n = 4): Command[] {
  const byName = new Map(list.map((c) => [c.name, c]));
  const first = recent.map((r) => byName.get(r)).filter((c): c is Command => !!c);
  const rest = list.filter((c) => !first.includes(c)).sort((a, b) => a.name.localeCompare(b.name));
  return [...first, ...rest].slice(0, n);
}

const key = (vaultId: string) => `karpathy.recentCommands.${vaultId}`;

/** The commands this browser started last in the vault, newest first; [] without storage. */
export function recentCommands(vaultId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(vaultId)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function recordCommand(vaultId: string, name: string): void {
  try {
    localStorage.setItem(key(vaultId), JSON.stringify([name, ...recentCommands(vaultId).filter((x) => x !== name)].slice(0, 10)));
  } catch {
    // no storage: chips fall back to A–Z
  }
}
