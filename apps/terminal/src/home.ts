import { copyFile, constants, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The image's shell dotfiles (zsh, oh-my-zsh, powerlevel10k) go into the home volume once: a file the home already
 * has is the user's and stays as it is, also across deploys. Returns the names copied.
 */
export async function seedHome(skel: string, home: string): Promise<string[]> {
  const names = await readdir(skel).catch(() => [] as string[]);
  const copied: string[] = [];
  for (const name of names) {
    try {
      await copyFile(join(skel, name), join(home, name), constants.COPYFILE_EXCL);
      copied.push(name);
    } catch { /* there already: the user's */ }
  }
  return copied;
}
