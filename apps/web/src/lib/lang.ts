// What a vault file is, by name (#126): the media table first, emails (#166), then the backend's text check, then the name.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { mediaKind } from '@karpathy/shared';

export type FileKind = 'note' | 'html' | 'base' | 'code' | 'email' | 'media' | 'binary';

export function fileKind(path: string, binary: boolean): FileKind {
  if (mediaKind(path)) return 'media';
  // Before the text check: a mail with Latin-1 or 8-bit parts is not UTF-8, but still a mail.
  if (/\.eml$/i.test(path)) return 'email';
  if (binary) return 'binary';
  if (/\.(md|markdown)$/i.test(path)) return 'note';
  if (/\.html?$/i.test(path)) return 'html';
  // An Obsidian base (#91): YAML in Write mode, its table in Read mode.
  if (/\.base$/i.test(path)) return 'base';
  return 'code';
}

/** The mode a file shows in: notes follow the mode preference, HTML pages and bases the page mode, code files are always Write, emails always Read. */
export function viewMode(kind: FileKind, mode: 'write' | 'read', pageMode: 'write' | 'read'): 'write' | 'read' {
  return kind === 'code' ? 'write' : kind === 'email' ? 'read' : kind === 'html' || kind === 'base' ? pageMode : mode;
}

/** The language a code file is colored with, by its name; null = plain text. Each language loads lazily. */
export function languageFor(path: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, path.slice(path.lastIndexOf('/') + 1));
}
