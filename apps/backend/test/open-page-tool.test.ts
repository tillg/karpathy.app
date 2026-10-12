import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveNote } from '../../../deploy/opencode/lib/resolve-note.js';
import { describeOpenPage } from '../../../deploy/opencode/lib/open-page.js';
import { testDir } from './opencode-container.js';

// The current_page tool's helper, on real directories (the tool itself runs inside opencode).

const base = testDir('open-page-tool');
const vault = join(base, 'vault');
const state = join(base, 'state');
const put = (id: string, page: object | string) => writeFile(join(state, `${id}.json`), typeof page === 'string' ? page : JSON.stringify(page));
const answer = (id: string) => describeOpenPage(state, id, (p) => resolveNote(vault, p));
const NONE = 'No page is open';

beforeAll(async () => {
  await mkdir(join(vault, 'notes'), { recursive: true });
  await mkdir(join(vault, '.git'), { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(vault, 'notes/a.md'), '# A\n');
  await writeFile(join(vault, '.git/config'), 'x\n');
  await mkdir(join(vault, '.agents/skills'), { recursive: true });
  await writeFile(join(vault, '.agents/skills/x.md'), 'x\n');
  await writeFile(join(base, 'secret.md'), 'x\n');
});

describe('describeOpenPage', () => {
  it('says nothing is open without a state file or with a broken one', async () => {
    expect(await answer('ses_none')).toContain(NONE);
    await put('ses_broken', '{nope');
    expect(await answer('ses_broken')).toContain(NONE);
    await put('ses_nopath', { mode: 'read' });
    expect(await answer('ses_nopath')).toContain(NONE);
  });

  it('names the open page and its mode, and flags unsaved edits', async () => {
    await put('ses_ok', { path: 'notes/a.md', mode: 'write', unsaved: false });
    expect(await answer('ses_ok')).toBe('The user has notes/a.md open (Write mode).');
    await put('ses_dirty', { path: 'notes/a.md', mode: 'read', unsaved: true });
    const text = await answer('ses_dirty');
    expect(text).toContain('notes/a.md open (Read mode)');
    expect(text).toContain('unsaved edits');
  });

  it('reports a page that was deleted since', async () => {
    await put('ses_gone', { path: 'notes/gone.md', mode: 'write', unsaved: false });
    expect(await answer('ses_gone')).toBe('The user had notes/gone.md open, but it no longer exists in the vault.');
  });

  it('a file in a visible dot dir is not claimed deleted (#143)', async () => {
    await put('ses_dot', { path: '.agents/skills/x.md', mode: 'read', unsaved: false });
    const text = await answer('ses_dot');
    expect(text).toBe('The user has .agents/skills/x.md open, in a dot folder that this tool does not check: read it by that path.');
    // Never a way out of the vault or into .git, even from a tampered state file.
    for (const [i, path] of ['.agents/../../secret.md', '.git/config', '/etc/.x/y'].entries()) {
      await put(`ses_dotbad${i}`, { path, mode: 'read', unsaved: false });
      expect(await answer(`ses_dotbad${i}`)).toContain('no longer exists');
    }
  });

  it('never points outside the vault, at dot paths or at a directory', async () => {
    for (const [i, path] of ['../secret.md', '/etc/passwd', '.git/config', 'notes'].entries()) {
      await put(`ses_bad${i}`, { path, mode: 'read', unsaved: false });
      const text = await answer(`ses_bad${i}`);
      expect(text).toContain('no longer exists');
      expect(text).not.toContain('The user has');
    }
  });

  it('refuses a session id that is not a plain id', async () => {
    await expect(answer('../ses_ok')).rejects.toThrow('invalid session');
  });
});
