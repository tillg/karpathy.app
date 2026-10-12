import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPEN_PAGE_DIR, removeOpenPage, writeOpenPage } from '../src/open-page.js';
import { testDir } from './opencode-container.js';

// The open page of a chat, handed to the opencode tool as a file on the vaults volume (outside every clone).

const vaultsDir = join(testDir('open-page'), 'vaults');
const file = (chatId: string) => join(vaultsDir, OPEN_PAGE_DIR, `${chatId}.json`);

describe('open page state file', () => {
  it('writes <vaults>/.open-page/<chatId>.json, creating the dir, and overwrites', async () => {
    await mkdir(vaultsDir, { recursive: true });
    await writeOpenPage(vaultsDir, 'ses_a1', { path: 'notes/Todo.md', mode: 'write', unsaved: false });
    expect(JSON.parse(await readFile(file('ses_a1'), 'utf8'))).toEqual({ path: 'notes/Todo.md', mode: 'write', unsaved: false });
    await writeOpenPage(vaultsDir, 'ses_a1', { path: 'Home.md', mode: 'read', unsaved: true });
    expect(JSON.parse(await readFile(file('ses_a1'), 'utf8'))).toEqual({ path: 'Home.md', mode: 'read', unsaved: true });
    expect(await readdir(join(vaultsDir, OPEN_PAGE_DIR))).toEqual(['ses_a1.json']); // no temp file left
  });

  it('removes the file; removing a missing one is fine', async () => {
    await writeOpenPage(vaultsDir, 'ses_b2', { path: 'Home.md', mode: 'read', unsaved: false });
    await removeOpenPage(vaultsDir, 'ses_b2');
    await removeOpenPage(vaultsDir, 'ses_b2');
    expect(await readdir(join(vaultsDir, OPEN_PAGE_DIR))).not.toContain('ses_b2.json');
  });

  it('refuses a chat id that is not a plain id', async () => {
    const page = { path: 'Home.md', mode: 'read', unsaved: false } as const;
    await expect(writeOpenPage(vaultsDir, '../evil', page)).rejects.toThrow('invalid chat id');
    await expect(removeOpenPage(vaultsDir, 'a/b')).rejects.toThrow('invalid chat id');
  });
});
