/**
 * Per-vault lock (mvp §2.4 "Vault lock"). Shared holders: file saves and a running AI
 * turn, and opportunistically a background fetch. Exclusive holders: pull, commit, discard,
 * conflict resolution, clone, remove. Exclusive waiters block new shared holders (writer
 * preference), so a commit is never starved by a stream of saves.
 */
export type Release = () => void;
export type SharedLabel = 'save' | 'turn' | 'fetch';

interface Waiter {
  kind: 'shared' | 'exclusive';
  label: string;
  wake: () => void;
}

export class VaultLock {
  private shared = new Map<number, SharedLabel>();
  private exclusiveHeld = false;
  private queue: Waiter[] = [];
  private nextId = 0;
  private listeners = new Set<() => void>();

  /** 'turn' while an AI turn holds the lock, 'sync' while an exclusive op runs or waits. */
  get busy(): 'none' | 'turn' | 'sync' {
    if (this.exclusiveHeld) return 'sync';
    if ([...this.shared.values()].includes('turn')) return 'turn';
    if (this.queue.some((w) => w.kind === 'exclusive')) return 'sync';
    return 'none';
  }

  get isFree(): boolean {
    return !this.exclusiveHeld && this.shared.size === 0 && this.queue.length === 0;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  acquireShared(label: SharedLabel): Promise<Release> {
    return new Promise((resolve) => {
      const grant = () => resolve(this.grantShared(label));
      if (!this.exclusiveHeld && !this.queue.some((w) => w.kind === 'exclusive')) grant();
      else this.queue.push({ kind: 'shared', label, wake: grant });
    });
  }

  acquireExclusive(): Promise<Release> {
    return new Promise((resolve) => {
      const grant = () => resolve(this.grantExclusive());
      if (this.isFree) grant();
      else {
        this.queue.push({ kind: 'exclusive', label: 'sync', wake: grant });
        this.emit();
      }
    });
  }

  /**
   * Shared lock only if no exclusive op holds or waits for it, else null (background fetch).
   * A fetch doesn't change `busy`, so granting and releasing it alone notifies nobody.
   */
  tryShared(label: SharedLabel): Release | null {
    if (this.exclusiveHeld || this.queue.some((w) => w.kind === 'exclusive')) return null;
    return this.grantShared(label);
  }

  /** Exclusive lock only when immediately free (vault-open pull), else null. */
  tryExclusive(): Release | null {
    return this.isFree ? this.grantExclusive() : null;
  }

  async withShared<T>(label: SharedLabel, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireShared(label);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireExclusive();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Runs `fn` under the exclusive lock, then hands over to a shared holder without letting
   * another exclusive op in between (pull right before a turn, mvp §2.4).
   */
  async exclusiveThenShared(label: SharedLabel, fn: () => Promise<void>): Promise<Release> {
    const releaseEx = await this.acquireExclusive();
    try {
      await fn();
    } catch (e) {
      releaseEx();
      throw e;
    }
    // Downgrade: hold shared first, then drop exclusive so queued shared holders may join.
    const releaseShared = this.grantShared(label);
    this.exclusiveHeld = false;
    this.drain();
    return releaseShared;
  }

  private grantShared(label: SharedLabel): Release {
    const id = this.nextId++;
    this.shared.set(id, label);
    const quiet = label === 'fetch';
    if (!quiet) this.emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.shared.delete(id);
      if (!quiet || this.queue.length > 0) this.drain();
    };
  }

  private grantExclusive(): Release {
    this.exclusiveHeld = true;
    this.emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.exclusiveHeld = false;
      this.drain();
    };
  }

  private drain() {
    while (this.queue.length > 0 && !this.exclusiveHeld) {
      const head = this.queue[0]!;
      if (head.kind === 'exclusive') {
        if (this.shared.size > 0) break;
        this.queue.shift();
        head.wake();
        break;
      }
      this.queue.shift();
      head.wake();
    }
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
