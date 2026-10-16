import { describe, expect, it } from 'vitest';
import { BROWSER_TOOLS } from '@karpathy/shared';
import { browserTools, LOCATION_OPTIONS, locationError, locationResult, userLocation } from './browser-tools';

// The answering tab's handlers for browser tools (#151). The real Geolocation call is covered by the e2e
// (Playwright grants and fakes the position); here: what the tab makes of its answers.

describe('user_location', () => {
  it('asks for high accuracy, a fix at most a minute old', () => {
    expect(LOCATION_OPTIONS).toEqual({ enableHighAccuracy: true, maximumAge: 60_000, timeout: 60_000 });
  });

  it('passes the position through unrounded, with accuracy and the age of the fix', () => {
    const p = { coords: { latitude: 48.137154, longitude: 11.576124, accuracy: 12.5 }, timestamp: 1_000 };
    expect(locationResult(p, 4_200)).toEqual({ ok: true, value: { latitude: 48.137154, longitude: 11.576124, accuracy: 12.5, ageMs: 3_200 } });
    expect(locationResult(p, 500).ok && locationResult(p, 500)).toMatchObject({ value: { ageMs: 0 } });
  });

  it('maps PERMISSION_DENIED to denied, POSITION_UNAVAILABLE and TIMEOUT to no-position', () => {
    expect(locationError(1)).toEqual({ ok: false, reason: 'denied' });
    expect(locationError(2)).toEqual({ ok: false, reason: 'no-position' });
    expect(locationError(3)).toEqual({ ok: false, reason: 'no-position' });
  });

  it('without a Geolocation API: unsupported', async () => {
    expect(await userLocation(undefined)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('every browser tool has a handler, and only those', () => {
    expect(Object.keys(browserTools).sort()).toEqual([...BROWSER_TOOLS].sort());
  });
});
