import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, MEDIA, isPdf, isUploadable, mediaKind, rawType, uploadMime } from './media.js';

describe('mediaKind', () => {
  it.each([
    ['a/B.PNG', 'image'],
    ['x.svg', 'image'],
    ['x.mov', 'video'],
    ['x.webm', 'video'],
    ['x.m4a', 'audio'],
    ['x.opus', 'audio'],
    ['x.md', null],
    ['x.pdf', null],
    ['png', null],
    ['dir.png/file', null],
  ])('%s → %s', (path, kind) => expect(mediaKind(path)).toBe(kind));

  it('has the Content-Types the raw route serves', () => {
    expect(MEDIA.png?.type).toBe('image/png');
    expect(MEDIA.jpg?.type).toBe('image/jpeg');
    expect(MEDIA.svg?.type).toBe('image/svg+xml');
    expect(MEDIA.mov?.type).toBe('video/quicktime');
    expect(MEDIA.mp3?.type).toBe('audio/mpeg');
    expect(MEDIA.m4a?.type).toBe('audio/mp4');
  });
});

describe('rawType / isPdf', () => {
  it('serves media inline with its type, everything else as an attachment', () => {
    expect(rawType('a/B.PNG')).toEqual({ type: 'image/png', attachment: false });
    expect(rawType('doc.pdf')).toEqual({ type: 'application/pdf', attachment: true });
    expect(rawType('x.bin')).toEqual({ type: 'application/octet-stream', attachment: true });
    expect(rawType('Home.md')).toEqual({ type: 'application/octet-stream', attachment: true });
    expect(rawType('noext')).toEqual({ type: 'application/octet-stream', attachment: true });
  });
  it('knows a PDF by extension only', () => {
    expect(isPdf('a/X.PDF')).toBe(true);
    expect(isPdf('pdf')).toBe(false);
    expect(isPdf('x.pdf.png')).toBe(false);
  });
});

describe('uploadable files', () => {
  it.each(['a/B.JPG', 'x.jpeg', 'x.png', 'x.gif', 'x.webp', 'x.pdf'])('%s is uploadable', (p) => expect(isUploadable(p)).toBe(true));
  it.each(['x.heic', 'x.svg', 'x.avif', 'x.mp4', 'x.md', 'png'])('%s is not', (p) => expect(isUploadable(p)).toBe(false));
  it('has a mime per format and a 50 MiB cap', () => {
    expect(uploadMime('x.JPG')).toBe('image/jpeg');
    expect(uploadMime('x.pdf')).toBe('application/pdf');
    expect(uploadMime('x.webp')).toBe('image/webp');
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });
});
