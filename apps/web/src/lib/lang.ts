// What a vault file is, by name (#126): the media table first, then the backend's text check, then the name.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { mediaKind } from '@karpathy/shared';

export type FileKind = 'note' | 'html' | 'code' | 'media' | 'binary';

export function fileKind(path: string, binary: boolean): FileKind {
  if (mediaKind(path)) return 'media';
  if (binary) return 'binary';
  if (/\.(md|markdown)$/i.test(path)) return 'note';
  if (/\.html?$/i.test(path)) return 'html';
  return 'code';
}

/** The mode a file shows in: notes follow the mode preference, HTML pages the page mode, code files are always Write. */
export function viewMode(kind: FileKind, mode: 'write' | 'read', pageMode: 'write' | 'read'): 'write' | 'read' {
  return kind === 'code' ? 'write' : kind === 'html' ? pageMode : mode;
}

/** The language a code file is colored with, by its name; null = plain text. Each language loads lazily. */
export function languageFor(path: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, path.slice(path.lastIndexOf('/') + 1));
}
