import { copyFile, constants, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The image's shell dotfiles (zsh, oh-my-zsh, powerlevel10k, ~/.claude/CLAUDE.md) go into the home volume once: a file
 * the home already has is the user's and stays as it is, also across deploys. Folders are walked; what else they hold
 * stays. Returns the paths copied, relative to the home.
 */
export async function seedHome(skel: string, home: string, rel = ''): Promise<string[]> {
  const entries = await readdir(join(skel, rel), { withFileTypes: true }).catch(() => []);
  const copied: string[] = [];
  for (const e of entries) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await mkdir(join(home, path), { recursive: true });
      copied.push(...(await seedHome(skel, home, path)));
      continue;
    }
    try {
      await copyFile(join(skel, path), join(home, path), constants.COPYFILE_EXCL);
      copied.push(path);
    } catch { /* there already: the user's */ }
  }
  return copied;
}
