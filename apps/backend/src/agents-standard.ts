import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentsMove } from '@karpathy/shared';
import { normalizeRel, resolveInVault } from './paths.js';
import type { Repo } from './repo.js';

// The `.agents` standard: instructions in AGENTS.md, skills in .agents/skills/. Vaults still in
// Anthropic's layout (CLAUDE.md, .claude/skills, .claude/commands) are moved there by the app.

/** CLAUDE.md of a moved vault: Claude Code's import of AGENTS.md. */
export const CLAUDE_POINTER = '@AGENTS.md';
/** The skill link `.claude/skills` and its target (no trailing newline, or the link target is wrong). */
export const SKILL_LINK = '.claude/skills';
export const SKILL_LINK_TARGET = '../.agents/skills';

export interface LegacyScan {
  /** Folder names in `.claude/skills/`. */
  skills: string[];
  /** Command names (`.claude/commands/<name>.md`). */
  commands: string[];
  /** CLAUDE.md to move into AGENTS.md, or AGENTS.md without a CLAUDE.md pointer. */
  instructions: boolean;
}

const read = (p: string) => readFile(p, 'utf8').catch(() => null);

async function names(dir: string, keep: (e: { name: string; isDirectory(): boolean; isFile(): boolean }) => boolean) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter(keep).map((e) => e.name).sort();
}

/** What in the vault root still follows Anthropic's layout. A plain file `.claude/skills` is the skill link stub. */
export async function scanLegacy(vaultRoot: string): Promise<LegacyScan> {
  const skillsDir = join(vaultRoot, '.claude/skills');
  const skills = (await stat(skillsDir).catch(() => null))?.isDirectory() ? await names(skillsDir, (e) => e.isDirectory()) : [];
  const commands = (await names(join(vaultRoot, '.claude/commands'), (e) => e.isFile() && e.name.endsWith('.md'))).map((n) => n.slice(0, -3));
  const claude = await read(join(vaultRoot, 'CLAUDE.md'));
  const agents = await read(join(vaultRoot, 'AGENTS.md'));
  const instructions = claude !== null ? claude.trim() !== CLAUDE_POINTER : agents !== null;
  return { skills, commands, instructions };
}

export const hasLegacy = (s: LegacyScan) => s.skills.length > 0 || s.commands.length > 0 || s.instructions;
export const isEmptyMove = (m: AgentsMove) => !m.moved.length && !m.converted.length && !m.instructions && !m.inlined.length && !m.skipped.length;

/** Moves the vault root of `repo` to the `.agents` standard. Never overwrites; commits nothing. */
export async function migrateToAgents(repo: Repo): Promise<AgentsMove> {
  const root = repo.rootDir;
  const result: AgentsMove = { moved: [], converted: [], instructions: false, inlined: [], skipped: [] };
  await moveInstructions(repo, result);
  await moveSkills(root, result);
  await convertCommands(root, result);
  if (result.moved.length || result.converted.length) await linkSkills(repo);
  return result;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

async function moveSkills(root: string, result: AgentsMove) {
  for (const name of (await scanLegacy(root)).skills) {
    const to = join(root, '.agents/skills', name);
    if (await exists(to)) {
      result.skipped.push(name);
      continue;
    }
    await mkdir(join(root, '.agents/skills'), { recursive: true });
    await rename(join(root, SKILL_LINK, name), to);
    result.moved.push(name);
  }
}

async function convertCommands(root: string, result: AgentsMove) {
  const dir = join(root, '.claude/commands');
  for (const name of (await scanLegacy(root)).commands) {
    const to = join(root, '.agents/skills', name);
    if (await exists(to)) {
      result.skipped.push(name);
      continue;
    }
    await mkdir(to, { recursive: true });
    await writeFile(join(to, 'SKILL.md'), commandToSkill(name, await readFile(join(dir, `${name}.md`), 'utf8')));
    await rm(join(dir, `${name}.md`));
    result.converted.push(name);
  }
  await rmdir(dir).catch(() => undefined); // only when empty
}

/** A Markdown file's frontmatter fields (simple `key: value` lines) and its body; CRLF is read as LF. */
export function readFrontmatter(content: string): { field(key: string): string | undefined; body: string } {
  const text = content.replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return {
    field: (key) => (fm ? new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(fm[1]!)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2') : undefined),
    body: fm ? text.slice(fm[0].length) : text,
  };
}

/** A YAML scalar: plain when that can't change its meaning, else double-quoted. */
const yamlScalar = (s: string) => (/^[A-Za-z][\w .,'()/-]*$/.test(s) && !/^(yes|no|true|false|on|off|null)$/i.test(s) ? s : JSON.stringify(s));

/** A Claude Code command file as a SKILL.md: `name`, `description` (its own, else its first line), body unchanged. */
function commandToSkill(name: string, content: string): string {
  const { field, body } = readFrontmatter(content);
  const description = (field('description') || body.split('\n').find((l) => l.trim())?.trim() || name).slice(0, 200);
  return `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n---\n${body}`;
}

/**
 * Stages the skill link again when the index lost it: a pull resets the index and stashes the work
 * tree, so an uncommitted link would otherwise be committed as a plain file.
 */
export async function restageSkillLink(repo: Repo): Promise<void> {
  if ((await read(join(repo.rootDir, SKILL_LINK))) !== SKILL_LINK_TARGET) return;
  if (!(await repo.stagedAsSymlink(SKILL_LINK))) await repo.stageSymlink(SKILL_LINK, SKILL_LINK_TARGET);
}

/** Replaces what is left of `.claude/skills` by the skill link, unless a clash left skills in it. */
async function linkSkills(repo: Repo) {
  const link = join(repo.rootDir, SKILL_LINK);
  const st = await stat(link).catch(() => null);
  if (st?.isDirectory()) {
    if ((await readdir(link)).length > 0) return;
    await rmdir(link);
  }
  await mkdir(join(repo.rootDir, '.claude'), { recursive: true });
  await writeFile(link, SKILL_LINK_TARGET);
  await repo.stageSymlink(SKILL_LINK, SKILL_LINK_TARGET);
}

async function moveInstructions(repo: Repo, result: AgentsMove) {
  const root = repo.rootDir;
  const claude = await read(join(root, 'CLAUDE.md'));
  const agents = await read(join(root, 'AGENTS.md'));
  if (claude === null) {
    if (agents === null) return;
    await writeFile(join(root, 'CLAUDE.md'), `${CLAUDE_POINTER}\n`);
    result.instructions = true;
    return;
  }
  if (claude.trim() === CLAUDE_POINTER) return;
  const lines = claude.split('\n');
  if (agents !== null || lines.some((l) => l.trim() === CLAUDE_POINTER)) {
    result.skipped.push('AGENTS.md');
    return;
  }
  const out: string[] = [];
  for (const line of lines) {
    const pasted = await importedText(repo, line);
    if (pasted === null) out.push(line);
    else {
      out.push(pasted.text.replace(/\n$/, ''));
      result.inlined.push(pasted.path);
    }
  }
  await writeFile(join(root, 'AGENTS.md'), out.join('\n'));
  await writeFile(join(root, 'CLAUDE.md'), `${CLAUDE_POINTER}\n`);
  result.instructions = true;
}

/**
 * A line that is only `@<path>` (Claude Code's import) of a file inside the vault root: its text. A gitignored
 * file isn't pasted: AGENTS.md is committed, so its content would reach the remote.
 */
async function importedText(repo: Repo, line: string): Promise<{ path: string; text: string } | null> {
  const m = /^@(\S+)$/.exec(line.trim());
  if (!m) return null;
  try {
    const path = normalizeRel(m[1]!);
    const abs = await resolveInVault(repo.rootDir, path);
    if (!(await stat(abs)).isFile()) return null;
    if ((await repo.git.run(['check-ignore', '-q', '--', repo.toRepoPath(path)], { allowFail: true })).code === 0) return null;
    return { path, text: await readFile(abs, 'utf8') };
  } catch {
    return null;
  }
}
