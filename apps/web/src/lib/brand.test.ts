import { describe, expect, it } from 'vitest';
import { brandName } from './brand';

describe('brandName (header brand; VITE_STACK on dev stack N)', () => {
  it('names the dev stack', () => {
    expect(brandName('2')).toBe('karpathy #2');
  });

  it('is karpathy.app without a stack number', () => {
    for (const s of [undefined, '', '0', 'x']) expect(brandName(s)).toBe('karpathy.app');
  });
});
