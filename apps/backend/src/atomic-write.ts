import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes `dest` atomically (temp file, then rename) in a folder the terminal (#175) can also write: the temp file has
 * an unguessable name and is created exclusively, so a planted symlink is never written through, and a folder
 * replaced by a symlink is refused instead of written into.
 */
export async function writeAtomic(dest: string, data: string): Promise<void> {
  const dir = dirname(dest);
  await mkdir(dir, { recursive: true });
  if ((await lstat(dir)).isSymbolicLink()) throw new Error(`${dir} is a symlink: not writing into it`);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, { flag: 'wx' });
  await rename(tmp, dest);
}
