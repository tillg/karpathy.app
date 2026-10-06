// Command turns: `/name args` where `name` is a skill. The skill's text goes to the model as plain text,
// never through opencode's command endpoint, which runs `!`cmd`` snippets and resolves `@file` (F4).

/** `/name` at the very start, then whitespace or the end; everything after the name is `args`. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9][\w.:-]*)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: m[1]!, args: (m[2] ?? '').trim() } : null;
}

/**
 * opencode's argument rules (F6): `$1`…`$N` take positional arguments, the highest one the rest;
 * `$ARGUMENTS` takes all. Unlike opencode nothing is appended without a placeholder: the user's
 * message already carries the arguments. Everything else stays literal.
 */
export function expandCommand(template: string, args: string): string {
  const words = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^(["'])(.*)\1$/, '$2')) ?? [];
  const highest = Math.max(0, ...[...template.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  return template
    .replace(/\$(\d+)/g, (_, n: string) => {
      const i = Number(n) - 1;
      return Number(n) === highest ? words.slice(i).join(' ') : (words[i] ?? '');
    })
    .replaceAll('$ARGUMENTS', () => args);
}

/**
 * A skill template without opencode's footer naming the skill's base directory. For an app skill that
 * directory lies outside the vault and can't be read; the footer only sends the model there.
 */
export function withoutBaseDir(template: string): string {
  return template.replace(/\n*Base directory for this skill: [^\n]*(\nRelative paths in this skill[^\n]*)?\s*$/, '\n');
}

/** The hidden part of a command turn: what the model is told, plus the expanded skill text. */
export function commandInstructions(name: string, expanded: string): string {
  // opencode's template ends with the skill's base directory; the vault's notes are not there (found with a small model).
  return `The user started the command \`/${name}\`. Its arguments are the text after the name in their message. Paths to notes (such as Wiki/…) are relative to the vault root, your working directory; only the skill's own files are under its base directory. Follow these instructions for this turn:\n\n${expanded}`;
}
