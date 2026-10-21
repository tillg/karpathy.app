import { describe, expect, it } from 'vitest';
import { commitRequest, MAX_DIFF } from '../src/commit-message.js';

// The user message of the commit-message turn (prompts as files, #149).

const files = [{ kind: 'modified', path: 'Ideas.md' }, { kind: 'untracked', path: 'Lists/Reading.md' }] as const;
const stat = ' Ideas.md | 2 +-\n 1 file changed\n';

describe('commitRequest', () => {
  it('lists files, stat and diff', () => {
    expect(commitRequest([...files], stat, 'DIFF')).toBe(
      'Write the commit message for these changes.\n\nFiles:\nmodified: Ideas.md\nuntracked: Lists/Reading.md\n\n' +
        'Ideas.md | 2 +-\n 1 file changed\n\nDiff:\nDIFF',
    );
  });

  it('a diff over MAX_DIFF ends in [diff truncated]', () => {
    const text = commitRequest([...files], stat, 'x'.repeat(MAX_DIFF + 10));
    expect(text.endsWith(`Diff:\n${'x'.repeat(MAX_DIFF)}\n[diff truncated]`)).toBe(true);
  });
});
