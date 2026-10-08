/**
 * Commit reminder (mvp §2.4): shown once the changed-files count exceeds the threshold. After a
 * dismissal it comes back only when the count reaches twice the threshold; after the second
 * dismissal it stays away. Dropping to the threshold or below (e.g. after a commit) resets it.
 */
export type Dismissed = 0 | 1 | 2;

export function reminderDue(count: number, threshold: number, dismissed: Dismissed): { show: boolean; dismissed: Dismissed } {
  if (count <= threshold) return { show: false, dismissed: 0 };
  if (dismissed === 0) return { show: true, dismissed };
  if (dismissed === 1 && count >= 2 * threshold) return { show: true, dismissed };
  return { show: false, dismissed };
}

/** The `dismissed` level after the user closes the reminder at `count`. */
export function dismissReminder(count: number, threshold: number): Dismissed {
  return count >= 2 * threshold ? 2 : 1;
}

/** What the reminder counts: changed files outside `Input/` (waiting sources are pending work, not unsaved results). */
export function reminderCount(status: { changedCount: number; inputChangedCount: number } | null): number {
  return status ? status.changedCount - status.inputChangedCount : 0;
}
