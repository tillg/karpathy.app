import { describe, expect, it } from 'vitest';
import { dismissReminder, reminderCount, reminderDue } from './reminder';

describe('commit reminder', () => {
  it('stays hidden up to the threshold', () => {
    expect(reminderDue(4, 4, 0).show).toBe(false);
    expect(reminderDue(0, 4, 0).show).toBe(false);
  });

  it('shows once the count exceeds the threshold', () => {
    expect(reminderDue(5, 4, 0)).toEqual({ show: true, dismissed: 0 });
  });

  it('after dismissal reappears only at twice the threshold', () => {
    const d = dismissReminder(5, 4);
    expect(d).toBe(1);
    expect(reminderDue(6, 4, d).show).toBe(false);
    expect(reminderDue(7, 4, d).show).toBe(false);
    expect(reminderDue(8, 4, d).show).toBe(true);
  });

  it('stays away after the second dismissal', () => {
    const d = dismissReminder(8, 4);
    expect(d).toBe(2);
    expect(reminderDue(20, 4, d).show).toBe(false);
  });

  it('resets when the count drops to the threshold (e.g. after a commit)', () => {
    expect(reminderDue(0, 4, 2)).toEqual({ show: false, dismissed: 0 });
    expect(reminderDue(5, 4, 0).show).toBe(true);
  });

  it('3 changes under Input/ + 2 elsewhere with threshold 4 → no reminder', () => {
    expect(reminderCount({ changedCount: 5, inputChangedCount: 3 })).toBe(2);
    expect(reminderDue(reminderCount({ changedCount: 5, inputChangedCount: 3 }), 4, 0).show).toBe(false);
    expect(reminderCount(null)).toBe(0);
  });
});
