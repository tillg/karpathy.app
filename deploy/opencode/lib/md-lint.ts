/**
 * The Markdown check run after every AI write of a .md file (free of opencode imports, so the backend tests load it):
 * finds Markdown that Obsidian renders broken (#118).
 */
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

export interface Finding {
  rule: 'wikilink-wrapped' | 'table-wikilink-pipe';
  /** 1-based line of the problem. */
  line: number;
  /** The offending snippet. */
  text: string;
  /** What to write instead. */
  fix: string;
}

const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/**
 * `text` with what isn't rendered prose blanked to spaces (newlines kept, so offsets and lines hold): frontmatter,
 * HTML comments, fenced code blocks and inline code spans. The fence rules are those of `codeRanges`
 * (packages/shared/src/relink.ts), repeated here because this file is baked into the opencode image on its own.
 */
function blankNonProse(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  const lines = text.replace(/^---\n[^]*?\n---(?=\n|$)/, blank).replace(/<!--[^]*?-->/g, blank).split('\n');
  for (const line of lines) {
    if (fence) {
      // A closing fence has no info string (CommonMark): "```js" inside a block is code.
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
      out.push(blank(line));
      continue;
    }
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      fence = m[1]!;
      out.push(blank(line));
    } else out.push(line.replace(/(`+)[^`]*?\1/g, blank));
  }
  return out.join('\n');
}

const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

// `[[` … `]]` across one to three line breaks, with no other bracket in between.
const WRAPPED_RE = /\[\[[^[\]\n]*\n(?:[^[\]\n]*\n){0,2}[^[\]\n]*\]\]/g;
// A GFM table line, after any blockquote prefix; and the delimiter row that makes such lines a table.
const quoted = (line: string) => line.replace(/^\s*(?:>\s*)*/, '');
const isRow = (line: string) => quoted(line).startsWith('|');
const isDelimiter = (line: string) => /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(quoted(line));
// An alias bar not yet escaped (no `g`: `test` with a global regex keeps state between calls).
const BAR = /(?<!\\)\|/;

export function lintMarkdown(text: string): Finding[] {
  const src = text.replace(/\r\n?/g, '\n');
  const plain = blankNonProse(src);
  const out: Finding[] = [];
  for (const m of plain.matchAll(WRAPPED_RE)) {
    // A blank line in between is a paragraph break: a lone `[[` in prose, not a wrapped link.
    if (/\n[ \t>]*\n/.test(m[0])) continue;
    out.push({
      rule: 'wikilink-wrapped',
      line: lineAt(plain, m.index),
      text: src.slice(m.index, m.index + m[0].indexOf('\n')).trim(),
      fix: 'put the whole link on one line',
    });
  }
  // In a table row, the alias `|` of `[[target|alias]]` splits the cell: Obsidian wants `\|`.
  const lines = plain.split('\n');
  for (let i = 0; i < lines.length; ) {
    let end = i;
    while (end < lines.length && isRow(lines[end]!)) end++;
    if (end === i) { i++; continue; }
    if (lines.slice(i, end).some(isDelimiter))
      for (let r = i; r < end; r++)
        for (const m of lines[r]!.matchAll(/\[\[([^[\]\n]+?)\]\]/g))
          if (BAR.test(m[1]!)) out.push({ rule: 'table-wikilink-pipe', line: r + 1, text: m[0], fix: m[0].replace(new RegExp(BAR, 'g'), '\\|') });
    i = end;
  }
  return out.sort((a, b) => a.line - b.line);
}

// The tools that write text the model wrote; not `save_url` (media and PDFs) or `move_to_sources` (moves folders).
const LINTED_TOOLS = ['edit', 'write', 'multiedit', 'apply_patch', 'patch'];

/**
 * The .md files a write tool call changed: `args.filePath`, plus a patch's `metadata.files[]` (`filePath`,
 * and `movePath` for a moved file). Same shapes as the backend's `writtenPaths` (harness/map.ts).
 */
export function writtenFiles(tool: string, args: unknown, metadata: unknown): string[] {
  if (!LINTED_TOOLS.includes(tool)) return [];
  const out: string[] = [];
  const fp = (args as { filePath?: unknown } | undefined)?.filePath;
  if (typeof fp === 'string') out.push(fp);
  const files = (metadata as { files?: unknown } | undefined)?.files;
  if (Array.isArray(files))
    for (const f of files) for (const k of ['filePath', 'movePath']) if (typeof f?.[k] === 'string') out.push(f[k]);
  return [...new Set(out)].filter((p) => p.toLowerCase().endsWith('.md'));
}

/** Inline code for a snippet; one that holds a backtick gets a double-backtick span. */
const code = (s: string) => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);

/** The text appended to the write's tool output, so the model fixes the file; empty without findings. */
export function checkReport(path: string, findings: Finding[]): string {
  if (!findings.length) return '';
  return [
    `Markdown problems in ${path} (they render broken in Obsidian). Fix them now:`,
    ...findings.map((f) => `- line ${f.line} [${f.rule}] ${code(f.text)}: ${f.rule === 'table-wikilink-pipe' ? `escape the pipe in a table row → ${code(f.fix)}` : f.fix}`),
  ].join('\n');
}

/**
 * The plugin's `tool.execute.after` hook: after a write tool, lints each .md file it wrote (in `directory`, the
 * vault) and appends the reports to `output.output`, so the model reads them as part of the tool result.
 * Never throws: a check that fails leaves the output as it is.
 */
export async function appendReport(directory: string, input: { tool: string; args: unknown }, output: { output: string; metadata: unknown }): Promise<void> {
  for (const file of writtenFiles(input.tool, input.args, output.metadata)) {
    try {
      const abs = resolve(directory, file);
      const report = checkReport(relative(directory, abs), lintMarkdown(await readFile(abs, 'utf8')));
      if (report) output.output += `\n\n${report}`;
    } catch (e) {
      // A deleted or moved file, or a directory: nothing to check.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'EISDIR') console.error(`md-lint: ${file}: ${e}`);
    }
  }
}

