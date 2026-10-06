import { describe, expect, it } from 'vitest';
import { commandInstructions, expandCommand, parseCommand, withoutBaseDir } from '../src/harness/command.js';

describe('parseCommand', () => {
  it('parses `/query what is X`', () => {
    expect(parseCommand('/query what is X')).toEqual({ name: 'query', args: 'what is X' });
    expect(parseCommand('/lint')).toEqual({ name: 'lint', args: '' });
    expect(parseCommand('/research\nthe topic')).toEqual({ name: 'research', args: 'the topic' });
  });

  it('`hello /query`, `/ query`, `//x` and empty text are no commands', () => {
    for (const t of ['hello /query', '/ query', '//x', '', '/', '/etc/hosts is what?']) expect(parseCommand(t)).toBeNull();
  });
});

describe('expandCommand', () => {
  it('$ARGUMENTS and $1/$2 are filled, the last one takes the rest', () => {
    expect(expandCommand('Answer: $ARGUMENTS.', 'what is X')).toBe('Answer: what is X.');
    expect(expandCommand('From $1 to $2.', 'a b c d')).toBe('From a to b c d.');
    expect(expandCommand('Only $1 and $ARGUMENTS', 'x y')).toBe('Only x y and x y');
    expect(expandCommand('Missing $2', 'one')).toBe('Missing ');
  });

  it('$ patterns in the arguments stay literal', () => {
    expect(expandCommand('Q: $ARGUMENTS', "cost $& $$ $' $1")).toBe("Q: cost $& $$ $' $1");
    expect(expandCommand('Q: $1', '$&')).toBe('Q: $&');
  });

  it('no placeholder → template unchanged, nothing appended', () => {
    expect(expandCommand('Read the index.', 'what is X')).toBe('Read the index.');
  });

  it('!`id -u` and @secret.env stay literal', () => {
    expect(expandCommand('Run !`id -u` and read @secret.env for $1', 'me')).toBe('Run !`id -u` and read @secret.env for me');
  });

  it('the instructions name the command', () => {
    expect(commandInstructions('query', 'Do it.')).toMatch(/^The user started the command `\/query`\..*\n\nDo it\.$/s);
  });
});

describe('withoutBaseDir', () => {
  it("drops opencode's base-directory footer of a skill template", () => {
    const t = '\nBODY\n\n\nBase directory for this skill: /opt/x/skills/research\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.';
    expect(withoutBaseDir(t)).toBe('\nBODY\n');
    expect(withoutBaseDir('no footer')).toBe('no footer');
  });
});
