import { resolve } from 'node:path';
import { tidyAttachments } from './tidy-attachments.js';

// `just tidy-attachments <vault> [--apply]`: moves pictures next to the notes showing them (dry run without --apply).
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('usage: just tidy-attachments <vault dir> [--apply]');
  process.exit(2);
}
const apply = args.includes('--apply');
const r = await tidyAttachments(resolve(dir), { dryRun: !apply });
for (const m of r.moved) console.log(`move     ${m.from} → ${m.to}`);
for (const p of r.rewritten) console.log(`relink   ${p}`);
for (const s of r.skipped) console.log(`skip     ${s.path}: ${s.reason}`);
console.log(`${r.moved.length} moves, ${r.rewritten.length} pages relinked, ${r.skipped.length} skipped${apply ? '' : ' (dry run; --apply to write)'}`);
