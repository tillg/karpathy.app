import { relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';

const DEBOUNCE_MS = 300;

/**
 * Watches a vault root (`.git/` excluded) and reports changed vault-relative paths,
 * debounced. Catches AI, human and pull writes alike, since all hit the same volume.
 */
export class VaultWatcher {
  private w: FSWatcher;
  private pending = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly root: string,
    onChange: (paths: string[]) => void | Promise<void>,
    /** Every raw event at once, undebounced (the search index marks the path stale). */
    onEvent?: (path: string) => void,
  ) {
    this.w = watch(root, {
      ignoreInitial: true,
      ignored: (p: string) => {
        const rel = relative(root, p);
        return rel === '.git' || rel.startsWith(`.git${sep}`) || rel.includes(`${sep}.git${sep}`) || rel.endsWith(`${sep}.git`);
      },
    });
    this.w.on('all', (event, p) => {
      onEvent?.(relative(this.root, p).split(sep).join('/'));
      if (event === 'addDir' || event === 'unlinkDir') return;
      this.pending.add(relative(this.root, p).split(sep).join('/'));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const paths = [...this.pending];
        this.pending.clear();
        void onChange(paths);
      }, DEBOUNCE_MS);
    });
  }

  async close() {
    clearTimeout(this.timer);
    await this.w.close();
  }
}
