// node-pty 1.1.0 ships its macOS prebuilt spawn-helper without the exec bit, so every spawn fails with
// "posix_spawnp failed" (the terminal service, #175). Linux builds it from source and is unaffected.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = createRequire(import.meta.url).resolve('node-pty/package.json').replace(/package\.json$/, 'prebuilds');
if (existsSync(root))
  for (const dir of readdirSync(root)) {
    const helper = join(root, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
