import { describe, expect, it } from 'vitest';
import { uploadName } from './attach';

const now = new Date(2026, 9, 4, 14, 30, 12);
const file = (name: string, type = '') => new File([new Uint8Array([1])], name, { type });

describe('uploadName', () => {
  it('names a camera photo by its time', () => expect(uploadName(file('image.jpg', 'image/jpeg'), true, now)).toBe('photo-20261004-143012.jpg'));
  it('gives a converted HEIC the .jpg extension', () => expect(uploadName(file('IMG_1234.HEIC'), false, now)).toBe('IMG_1234.jpg'));
  it('replaces characters that break names or links', () => expect(uploadName(file('a#b[c]|d^e?.PNG'), false, now)).toBe('a-b-c-d-e.png'));
  it('drops leading dots', () => expect(uploadName(file('.hidden.pdf'), false, now)).toBe('hidden.pdf'));
  it('keeps spaces', () => expect(uploadName(file('my scan.pdf'), false, now)).toBe('my scan.pdf'));
  it('keeps .jpeg', () => expect(uploadName(file('x.JPEG'), false, now)).toBe('x.jpeg'));
  it('cuts a long stem to 80 characters', () => expect(uploadName(file(`${'a'.repeat(200)}.pdf`), false, now)).toBe(`${'a'.repeat(80)}.pdf`));
  it('avoids Windows-reserved stems', () => expect(uploadName(file('con.pdf'), false, now)).toBe('con-file.pdf'));
  it('names an empty stem "file"', () => expect(uploadName(file('###.png'), false, now)).toBe('file.png'));
  it('drops trailing dots and spaces', () => expect(uploadName(file('a. .png'), false, now)).toBe('a.png'));
});
