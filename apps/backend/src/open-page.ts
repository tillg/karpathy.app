import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenPage } from '@karpathy/shared';

/**
 * The open page of a chat (#143), handed to opencode's `current_page` tool as a file on the vaults volume:
 * `<vaults>/.open-page/<chatId>.json`, next to the clones and outside every git clone. The tool finds it by its
 * session id (= chat id) and checks the path against the vault again (deploy/opencode/lib/open-page.ts).
 */
export const OPEN_PAGE_DIR = '.open-page';

const file = (vaultsDir: string, chatId: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error('invalid chat id');
  return join(vaultsDir, OPEN_PAGE_DIR, `${chatId}.json`);
};

export async function writeOpenPage(vaultsDir: string, chatId: string, page: OpenPage): Promise<void> {
  const dest = file(vaultsDir, chatId);
  await mkdir(join(vaultsDir, OPEN_PAGE_DIR), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(page));
  await rename(tmp, dest);
}

export async function removeOpenPage(vaultsDir: string, chatId: string): Promise<void> {
  await rm(file(vaultsDir, chatId), { force: true });
}
