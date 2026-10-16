import { describe, expect, it } from 'vitest';
import { parseBrowserCallResult } from './browser-call.js';

// What an answering tab may send back for a browser call (#151); anything else is refused (400).

const pos = { latitude: 48.137154, longitude: 11.576124, accuracy: 12, ageMs: 3000 };

describe('parseBrowserCallResult: user_location', () => {
  it('accepts a position and keeps it unrounded', () => {
    expect(parseBrowserCallResult('user_location', { ok: true, value: pos })).toEqual({ ok: true, value: pos });
  });

  it.each([
    ['latitude above 90', { ...pos, latitude: 90.1 }],
    ['latitude below -90', { ...pos, latitude: -91 }],
    ['longitude above 180', { ...pos, longitude: 180.5 }],
    ['negative accuracy', { ...pos, accuracy: -1 }],
    ['negative age', { ...pos, ageMs: -1 }],
    ['a string', { ...pos, latitude: '48.1' }],
    ['NaN', { ...pos, longitude: Number.NaN }],
    ['extra keys', { ...pos, address: 'Marienplatz 1' }],
  ])('refuses %s', (_, value) => {
    expect(parseBrowserCallResult('user_location', { ok: true, value })).toBeNull();
  });

  it.each(['denied', 'no-position', 'unsupported'] as const)('accepts unavailable: %s', (reason) => {
    expect(parseBrowserCallResult('user_location', { ok: false, reason })).toEqual({ ok: false, reason });
  });

  it('refuses an unknown reason, a missing body and an unknown tool', () => {
    expect(parseBrowserCallResult('user_location', { ok: false, reason: 'nope' })).toBeNull();
    expect(parseBrowserCallResult('user_location', null)).toBeNull();
    expect(parseBrowserCallResult('camera', { ok: false, reason: 'unsupported' })).toBeNull();
  });
});
