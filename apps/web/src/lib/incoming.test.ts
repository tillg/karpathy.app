import { describe, expect, it } from 'vitest';
import type { VaultStatus } from '@karpathy/shared';
import { incomingView } from './incoming';

const st = (over: Partial<VaultStatus> = {}): VaultStatus => ({
  state: 'ready', changedCount: 0, inputChangedCount: 0, unpushedCount: 0, incomingCount: 2, incomingPaths: ['a.md', 'b.md'], busy: 'none', conflictPaths: [], ...over,
});

describe('incomingView', () => {
  it('shown when ready with a count, disabled during a turn or sync, wording and tab badge', () => {
    expect(incomingView(st(), false)).toMatchObject({ show: true, disabled: false, label: 'Pull 2 incoming changes from GitHub', title: '2 files changed on GitHub. Tap to pull.', moreCount: 0 });
    expect(incomingView(st({ incomingCount: 1, incomingPaths: ['a.md'] }), false)).toMatchObject({ label: 'Pull 1 incoming change from GitHub', title: '1 file changed on GitHub. Tap to pull.' });
    const turn = incomingView(st({ busy: 'turn' }), false);
    expect(turn).toMatchObject({ show: true, disabled: true });
    expect(turn.title).toMatch(/AI is working/);
    expect(incomingView(st({ busy: 'sync' }), false).disabled).toBe(true);
    expect(incomingView(st(), true).disabled).toBe(true);
    expect(incomingView(st({ state: 'conflict' }), false).show).toBe(false);
    expect(incomingView(st({ incomingCount: 0, incomingPaths: [] }), false)).toMatchObject({ show: false });
        expect(incomingView(st({ incomingCount: 205, incomingPaths: Array.from({ length: 200 }, (_, i) => `${i}.md`) }), false).moreCount).toBe(5);
    expect(incomingView(undefined, false)).toMatchObject({ show: false });
  });
});
