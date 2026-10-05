import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGit } from '../src/git.js';
import { identity } from './helpers.js';

describe('runGit timeout', () => {
  it('a hung git ends on SIGTERM (so it can drop its lock files), well before the SIGKILL grace runs out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kai-git-'));
    const t0 = Date.now();
    // stdin stays open: hash-object waits for input forever.
    const r = await runGit(dir, ['hash-object', '--stdin'], { identity, timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
