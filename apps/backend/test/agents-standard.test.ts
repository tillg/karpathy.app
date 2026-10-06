import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateToAgents, scanLegacy } from '../src/agents-standard.js';
import { Repo } from '../src/repo.js';
import { identity, writeFiles } from './helpers.js';

/** A temp git repo with `files`, cloned like the app's clones (`core.symlinks=false`). */
async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'kai-agents-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'core.symlinks', 'false'], { cwd: dir });
  await writeFiles(dir, files);
  return dir;
}

describe('scanLegacy', () => {
  it('finds skills, commands and CLAUDE.md', async () => {
    const dir = await repo({ '.claude/skills/a/SKILL.md': 'A', '.claude/commands/b.md': 'B', 'CLAUDE.md': '# Rules\n' });
    expect(await scanLegacy(dir)).toEqual({ skills: ['a'], commands: ['b'], instructions: true });
  });

  it('finds nothing in a moved vault (stub link, CLAUDE.md = @AGENTS.md)', async () => {
    const dir = await repo({ '.claude/skills': '../.agents/skills', 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '# Rules\n' });
    expect(await scanLegacy(dir)).toEqual({ skills: [], commands: [], instructions: false });
  });

  it('finds nothing without .claude/ and CLAUDE.md', async () => {
    const dir = await repo({ 'Home.md': '# Home\n' });
    expect(await scanLegacy(dir)).toEqual({ skills: [], commands: [], instructions: false });
  });
});

const text = (dir: string, p: string) => readFile(join(dir, p), 'utf8').catch(() => null);
const migrate = (dir: string) => migrateToAgents(new Repo(dir, 'main', '', { identity }));

describe('migrateToAgents: instructions', () => {
  it('imports pasted in', async () => {
    const dir = await repo({ 'CLAUDE.md': '# Entry\n@Schema/CLAUDE.md\nmore', 'Schema/CLAUDE.md': 'RULES' });
    const r = await migrate(dir);
    expect(await text(dir, 'AGENTS.md')).toBe('# Entry\nRULES\nmore');
    expect(await text(dir, 'CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(r).toMatchObject({ instructions: true, inlined: ['Schema/CLAUDE.md'], skipped: [] });
    expect(await text(dir, 'Schema/CLAUDE.md')).toBe('RULES');
  });

  it('a missing or outside import stays as text', async () => {
    const dir = await repo({ 'CLAUDE.md': '@nope.md\n@../../etc/passwd\n' });
    const r = await migrate(dir);
    expect(await text(dir, 'AGENTS.md')).toBe('@nope.md\n@../../etc/passwd\n');
    expect(r.inlined).toEqual([]);
  });

  it('a gitignored import stays as text (AGENTS.md is committed, the file is not)', async () => {
    const dir = await repo({ '.gitignore': 'private.md\n', 'CLAUDE.md': '@private.md\n@public.md\n', 'private.md': 'SECRET\n', 'public.md': 'OPEN\n' });
    const r = await migrate(dir);
    expect(await text(dir, 'AGENTS.md')).toBe('@private.md\nOPEN\n');
    expect(r.inlined).toEqual(['public.md']);
  });

  it('only one level', async () => {
    const dir = await repo({ 'CLAUDE.md': '@a.md\n', 'a.md': 'A\n@b.md\n', 'b.md': 'B\n' });
    await migrate(dir);
    expect(await text(dir, 'AGENTS.md')).toBe('A\n@b.md\n');
  });

  it('AGENTS.md exists → clash', async () => {
    const dir = await repo({ 'CLAUDE.md': 'mine\n', 'AGENTS.md': 'theirs\n' });
    const r = await migrate(dir);
    expect(await text(dir, 'CLAUDE.md')).toBe('mine\n');
    expect(await text(dir, 'AGENTS.md')).toBe('theirs\n');
    expect(r).toMatchObject({ instructions: false, skipped: ['AGENTS.md'] });
  });

  it('AGENTS.md without CLAUDE.md', async () => {
    const dir = await repo({ 'AGENTS.md': 'rules\n' });
    const r = await migrate(dir);
    expect(await text(dir, 'CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(await text(dir, 'AGENTS.md')).toBe('rules\n');
    expect(r.instructions).toBe(true);
  });

  it('an @path inside a sentence stays text', async () => {
    const dir = await repo({ 'CLAUDE.md': 'See @a.md for more.\n', 'a.md': 'A\n' });
    const r = await migrate(dir);
    expect(await text(dir, 'AGENTS.md')).toBe('See @a.md for more.\n');
    expect(r.inlined).toEqual([]);
  });

  it('@AGENTS.md plus extra lines → clash', async () => {
    const dir = await repo({ 'CLAUDE.md': '@AGENTS.md\nextra\n', 'AGENTS.md': 'rules\n' });
    const r = await migrate(dir);
    expect(await text(dir, 'CLAUDE.md')).toBe('@AGENTS.md\nextra\n');
    expect(r.skipped).toEqual(['AGENTS.md']);
  });
});

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
const exists = (dir: string, p: string) => lstat(join(dir, p)).then(() => true, () => false);

describe('migrateToAgents: skills and commands', () => {
  it('skill folder moved whole', async () => {
    const dir = await repo({ '.claude/skills/a/SKILL.md': 'A', '.claude/skills/a/ref.md': 'REF' });
    const r = await migrate(dir);
    expect(await text(dir, '.agents/skills/a/SKILL.md')).toBe('A');
    expect(await text(dir, '.agents/skills/a/ref.md')).toBe('REF');
    expect(r.moved).toEqual(['a']);
  });

  it('command becomes a skill', async () => {
    const dir = await repo({
      '.claude/commands/b.md': '---\ndescription: Bee\nallowed-tools: Bash\n---\nDo $ARGUMENTS\n',
      '.claude/commands/c.md': '\nSee the wiki.\nThen $1.\n',
    });
    const r = await migrate(dir);
    expect(await text(dir, '.agents/skills/b/SKILL.md')).toBe('---\nname: b\ndescription: Bee\n---\nDo $ARGUMENTS\n');
    expect(await text(dir, '.agents/skills/c/SKILL.md')).toBe('---\nname: c\ndescription: See the wiki.\n---\n\nSee the wiki.\nThen $1.\n');
    expect(r.converted).toEqual(['b', 'c']);
    expect(await exists(dir, '.claude/commands')).toBe(false);
  });

  it('a CRLF command and a YAML-unsafe name convert cleanly', async () => {
    const dir = await repo({ '.claude/commands/yes.md': '---\r\ndescription: "Says: yes"\r\n---\r\nDo it.\r\n' });
    await migrate(dir);
    expect(await text(dir, '.agents/skills/yes/SKILL.md')).toBe('---\nname: "yes"\ndescription: "Says: yes"\n---\nDo it.\n');
  });

  it('a clashing name stays', async () => {
    const dir = await repo({ '.claude/skills/a/SKILL.md': 'OLD', '.agents/skills/a/SKILL.md': 'NEW' });
    const r = await migrate(dir);
    expect(await text(dir, '.claude/skills/a/SKILL.md')).toBe('OLD');
    expect(await text(dir, '.agents/skills/a/SKILL.md')).toBe('NEW');
    expect(r).toMatchObject({ moved: [], skipped: ['a'] });
    expect(git(dir, 'ls-files', '-s', '.claude/skills')).not.toMatch(/^120000/);
  });

  it('commands only still get the link', async () => {
    const dir = await repo({ '.claude/commands/b.md': 'Do it\n' });
    await migrate(dir);
    expect(await text(dir, '.agents/skills/b/SKILL.md')).toContain('name: b');
    expect(await text(dir, '.claude/skills')).toBe('../.agents/skills');
    expect(git(dir, 'ls-files', '-s', '.claude/skills')).toMatch(/^120000 /);
  });

  it('.claude/commands/ removed only when empty', async () => {
    const dir = await repo({ '.claude/commands/b.md': 'Do it\n', '.claude/commands/notes.txt': 'keep', '.agents/skills/x/SKILL.md': 'X' });
    await migrate(dir);
    expect(await text(dir, '.claude/commands/notes.txt')).toBe('keep');
    expect(await exists(dir, '.claude/commands/b.md')).toBe(false);
  });
});

describe('the skill link', () => {
  it('the commit carries a symlink', async () => {
    const dir = await repo({ 'Home.md': '# Home\n' });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'seed'], { cwd: dir });
    await writeFiles(dir, { '.claude/skills/a/SKILL.md': 'A' });
    const r = new Repo(dir, 'main', '', { identity });
    await migrateToAgents(r);
    expect(await r.commit('move to .agents', false)).toBeTruthy();
    expect(git(dir, 'ls-files', '-s', '.claude/skills')).toMatch(/^120000 /);
    expect(git(dir, 'cat-file', '-p', 'HEAD:.claude/skills')).toBe('../.agents/skills');
    const fresh = await mkdtemp(join(tmpdir(), 'kai-agents-mac-'));
    execFileSync('git', ['-c', 'core.symlinks=true', 'clone', '-q', dir, fresh]);
    expect((await lstat(join(fresh, '.claude/skills'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(fresh, '.claude/skills'))).toBe('../.agents/skills');
    expect(await text(fresh, '.claude/skills/a/SKILL.md')).toBe('A');
  });
});
