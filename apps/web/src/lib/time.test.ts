import { describe, expect, it } from 'vitest';
import { chatTime } from './time';

describe('chatTime (#140)', () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime();

  it('today: time only', () => {
    expect(chatTime(new Date(2026, 9, 12, 14, 22).getTime(), now, 'en-US')).toBe('02:22 PM');
  });

  it('this year: date and time', () => {
    expect(chatTime(new Date(2026, 9, 3, 14, 22).getTime(), now, 'en-US')).toBe('Oct 3, 02:22 PM');
  });

  it('an earlier year: date with year and time', () => {
    expect(chatTime(new Date(2025, 9, 3, 14, 22).getTime(), now, 'en-US')).toBe('Oct 3, 2025, 02:22 PM');
  });

  it('23:59 yesterday is not today', () => {
    expect(chatTime(new Date(2026, 9, 11, 23, 59).getTime(), now, 'en-US')).toBe('Oct 11, 11:59 PM');
  });

  it('24-hour locales stay 24-hour', () => {
    expect(chatTime(new Date(2026, 9, 3, 14, 22).getTime(), now, 'de-DE')).toBe('3. Okt., 14:22');
  });
});
