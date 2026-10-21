import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BaseError, queryBase } from '../src/bases.js';

let root: string;

const files: Record<string, string> = {
  'wiki/entities/eureka-labs.md': '---\nconfidence: low\nupdated: 2026-06-02\ntags: [entity, org/company]\n---\n# Eureka\n',
  'wiki/entities/tinygrad.md': '---\nconfidence: low\nupdated: 2026-07-19\ntags: entity\nrelated: "[[micrograd]]"\n---\nSee [[micrograd]].\n',
  'wiki/entities/micrograd.md': '---\nconfidence: high\nupdated: 2026-09-01\nstars: 12\n---\nA #project note. `#notatag`\n',
  'wiki/sources/llm-wiki-gist.md': '---\ntype: source\ningested: 2026-09-24\n---\n',
  'wiki/sources/intro-to-llms.md': '---\ntype: source\ningested: 2025-01-12\n---\n',
  'wiki/index.md': '# Index\n',
  'raw/pic.png': 'x',
  'broken.md': '---\nkey: [unclosed\n---\n',
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bases-'));
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
});

const q = (source: string, now?: Date) => queryBase(root, source, now ? { now } : {});
const paths = async (source: string, now?: Date) => (await q(source, now)).rows.map((r) => r.path);

describe('queryBase filters', () => {
  it('file.inFolder and a frontmatter comparison, sorted by a property', async () => {
    const r = await q(`filters:
  and:
    - file.inFolder("wiki/entities")
    - 'confidence == "low"'
views:
  - type: table
    name: Low confidence
    order: [file.name, confidence, updated]
    sort:
      - property: updated
        direction: DESC
`);
    expect(r.view).toBe('Low confidence');
    expect(r.columns.map((c) => c.id)).toEqual(['file.name', 'confidence', 'updated']);
    expect(r.rows).toEqual([
      { path: 'wiki/entities/tinygrad.md', cells: [{ link: 'wiki/entities/tinygrad.md', text: 'tinygrad.md' }, 'low', '2026-07-19'] },
      { path: 'wiki/entities/eureka-labs.md', cells: [{ link: 'wiki/entities/eureka-labs.md', text: 'eureka-labs.md' }, 'low', '2026-06-02'] },
    ]);
    expect(r.total).toBe(2);
  });

  it('or / not, file.hasTag with nested tags and inline tags (not in code)', async () => {
    expect(await paths('filters:\n  or:\n    - file.hasTag("org")\n    - file.hasTag("#project")\n')).toEqual(['wiki/entities/eureka-labs.md', 'wiki/entities/micrograd.md']);
    expect(await paths('filters:\n  and:\n    - file.hasTag("notatag")\n')).toEqual([]);
    expect(await paths('filters:\n  and:\n    - file.inFolder("wiki/entities")\n    - not:\n        - file.hasTag("entity")\n')).toEqual(['wiki/entities/micrograd.md']);
  });

  it('a single string filter, &&, ||, !, numbers and file properties', async () => {
    expect(await paths('filters: \'stars > 10 && !file.hasTag("entity")\'\n')).toEqual(['wiki/entities/micrograd.md']);
    expect(await paths('filters: \'file.ext == "png" || file.name == "index.md"\'\n')).toEqual(['raw/pic.png', 'wiki/index.md']);
    expect(await paths('filters: file.hasProperty("ingested") && file.folder == "wiki/sources"\n')).toEqual(['wiki/sources/intro-to-llms.md', 'wiki/sources/llm-wiki-gist.md']);
  });

  it('dates: today() minus a duration against a frontmatter date', async () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(await paths('filters: \'ingested >= today() - "1 month"\'\n', now)).toEqual(['wiki/sources/llm-wiki-gist.md']);
    expect(await paths('filters: \'ingested < date("2026-01-01")\'\n', now)).toEqual(['wiki/sources/intro-to-llms.md']);
  });

  it('string and list methods, file.hasLink', async () => {
    expect(await paths('filters: \'file.name.startsWith("micro") || file.tags.contains("org/company")\'\n')).toEqual(['wiki/entities/eureka-labs.md', 'wiki/entities/micrograd.md']);
    expect(await paths('filters: file.hasLink("micrograd")\n')).toEqual(['wiki/entities/tinygrad.md']);
  });

  it('no filters: every file (dot folders hidden), sorted by path; limit caps the rows but not the total', async () => {
    const r = await q('views:\n  - type: table\n    limit: 2\n');
    expect(r.rows.map((x) => x.path)).toEqual(['broken.md', 'raw/pic.png']);
    expect(r.total).toBe(8);
    expect(r.columns).toEqual([{ id: 'file.name', label: 'file name' }]);
  });

  it('display names from properties, lists and missing values', async () => {
    const r = await q(`filters: file.inFolder("wiki/entities")
properties:
  note.confidence:
    displayName: Confidence
views:
  - type: table
    order: [file.basename, note.confidence, tags, stars]
    sort:
      - property: file.name
        direction: ASC
`);
    expect(r.columns.map((c) => c.label)).toEqual(['file basename', 'Confidence', 'tags', 'stars']);
    expect(r.rows[0]!.cells).toEqual([{ link: 'wiki/entities/eureka-labs.md', text: 'eureka-labs' }, 'low', ['entity', 'org/company'], null]);
    expect(r.rows[1]!.cells[3]).toBe(12);
  });
});

describe('queryBase limits', () => {
  const err = async (source: string) => {
    try {
      await q(source);
    } catch (e) {
      if (e instanceof BaseError) return { code: e.code, message: e.message };
      throw e;
    }
    throw new Error('no error');
  };

  it('unsupported syntax says so, never crashes', async () => {
    expect(await err('formulas:\n  ppu: "price / age"\n')).toMatchObject({ code: 'base-unsupported', message: expect.stringMatching(/formulas.*not supported in v1/i) });
    expect(await err('filters: file.hasLink(this.file)\n')).toMatchObject({ code: 'base-unsupported', message: expect.stringMatching(/this.*not supported in v1/i) });
    expect(await err('filters: \'price.toFixed(2) == "1"\'\n')).toMatchObject({ code: 'base-unsupported', message: expect.stringMatching(/toFixed.*not supported in v1/) });
    expect(await err('views:\n  - type: cards\n')).toMatchObject({ code: 'base-unsupported', message: expect.stringMatching(/cards.*not supported in v1/) });
    expect(await err('filters: \'/abc/.matches(file.name)\'\n')).toMatchObject({ code: 'base-unsupported' });
  });

  it('invalid YAML or expressions are reported as invalid', async () => {
    expect(await err('filters: [unclosed\n')).toMatchObject({ code: 'base-invalid' });
    expect(await err('filters: \'confidence == \'\n')).toMatchObject({ code: 'base-invalid' });
    expect(await err('filters:\n  xor: []\n')).toMatchObject({ code: 'base-invalid' });
  });

  it('deeply nested expressions are refused as invalid, not a crash', async () => {
    for (const src of ['('.repeat(20000) + '1' + ')'.repeat(20000), '!'.repeat(50000) + '1', Array(50000).fill('1').join(' + ') + ' == 1', '['.repeat(20000)]) {
      expect(await err(`filters: ${JSON.stringify(src)}\n`)).toMatchObject({ code: 'base-invalid', message: expect.stringMatching(/nested too deeply|Unexpected end/) });
    }
    expect(await err(`filters: ${JSON.stringify('('.repeat(300) + '1' + ')'.repeat(300))}\n`)).toMatchObject({ code: 'base-invalid', message: expect.stringMatching(/nested too deeply/) });
    expect(await err(`filters: ${'{and: ['.repeat(300)}true${']}'.repeat(300)}\n`)).toMatchObject({ code: 'base-invalid', message: expect.stringMatching(/nested too deeply/) });
    // Ordinary nesting still works.
    expect(await paths(`filters: ${JSON.stringify('('.repeat(50) + 'stars > 10' + ')'.repeat(50))}\n`)).toEqual(['wiki/entities/micrograd.md']);
  });

  it('property lookups only see a note\'s own keys, never inherited object members', async () => {
    expect(await paths('filters: constructor\n')).toEqual([]);
    expect(await paths('filters: note.toString\n')).toEqual([]);
    expect(await paths('filters: \'note["hasOwnProperty"]\'\n')).toEqual([]);
    expect(await paths('filters: file.properties.constructor\n')).toEqual([]);
    const r = await q('filters: file.inFolder("wiki/sources")\nviews:\n  - type: table\n    order: [__proto__, constructor]\n');
    expect(r.rows.map((x) => x.cells)).toEqual([[null, null], [null, null]]);
  });

  it('display-only keys it does not apply are named in a notice', async () => {
    const r = await q('views:\n  - type: table\n    groupBy:\n      property: confidence\n      direction: ASC\n  - type: table\n    name: Other\n');
    expect(r.notices.join(' ')).toMatch(/groupBy/);
    expect(r.notices.join(' ')).toMatch(/first view/);
  });

  it('picks up a changed note on the next query (index refresh)', async () => {
    const before = await paths('filters: \'confidence == "medium"\'\n');
    expect(before).toEqual([]);
    await writeFile(join(root, 'wiki/index.md'), '---\nconfidence: medium\n---\n# Index, now longer\n');
    expect(await paths('filters: \'confidence == "medium"\'\n')).toEqual(['wiki/index.md']);
  });
});
