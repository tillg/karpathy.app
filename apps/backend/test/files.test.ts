import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { listTree } from '../src/files.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'files-'));
  await mkdir(join(root, '.agents/skills/ingest'), { recursive: true });
  await mkdir(join(root, '.obsidian'));
  await mkdir(join(root, 'notes/.agents'), { recursive: true });
  await writeFile(join(root, '.agents/skills/ingest/SKILL.md'), 's');
  await writeFile(join(root, '.agents/.hidden.md'), 'h');
  await writeFile(join(root, '.obsidian/app.json'), '{}');
  await writeFile(join(root, '.agents.md'), 'f');
  await writeFile(join(root, 'notes/.agents/x.md'), 'x');
  await writeFile(join(root, 'notes/a.md'), 'a');
});

describe('listTree', () => {
  it('hides every dot-entry by default', async () => {
    expect((await listTree(root)).map((e) => e.path)).toEqual(['notes', 'notes/a.md']);
  });

  it('shows whitelisted dot-folders (at any depth), never dot-files or other dot-entries inside them', async () => {
    expect((await listTree(root, ['.agents'])).map((e) => e.path)).toEqual([
      '.agents',
      '.agents/skills',
      '.agents/skills/ingest',
      '.agents/skills/ingest/SKILL.md',
      'notes',
      'notes/.agents',
      'notes/.agents/x.md',
      'notes/a.md',
    ]);
  });
});
