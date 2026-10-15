import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fileKey, formatLocation, locationTitle, waitForAnswer } from '../../../deploy/opencode/lib/browser-call.js';
import { BROWSER_CALLS_DIR, BrowserCalls } from '../src/browser-calls.js';
import { testDir } from './opencode-container.js';

// The browser tools' wait for the browser's answer (#151), on real directories (the tools themselves run inside
// opencode): the backend writes <dir>/<session>/<call>.json once the answering tab replied.

const dir = join(testDir('browser-call-tool'), 'calls');
const put = async (session: string, call: string, answer: object) => {
  await mkdir(join(dir, fileKey(session)), { recursive: true });
  await writeFile(join(dir, fileKey(session), `${fileKey(call)}.json`), JSON.stringify(answer));
};

beforeAll(() => mkdir(dir, { recursive: true }));

describe('waitForAnswer', () => {
  it('returns the answer written after 300 ms and deletes the file', async () => {
    setTimeout(() => void put('ses_a', 'call_1', { ok: true, value: { x: 1 } }), 300);
    expect(await waitForAnswer(dir, 'ses_a', 'call_1', { timeoutMs: 5000 })).toEqual({ ok: true, value: { x: 1 } });
    expect(await readdir(join(dir, fileKey('ses_a')))).toEqual([]);
  });

  it('returns null after the timeout', async () => {
    const t = Date.now();
    expect(await waitForAnswer(dir, 'ses_b', 'call_1', { timeoutMs: 600 })).toBeNull();
    expect(Date.now() - t).toBeGreaterThanOrEqual(600);
  });

  it('stops on abort', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const t = Date.now();
    expect(await waitForAnswer(dir, 'ses_c', 'call_1', { timeoutMs: 10_000, abort: abort.signal })).toBeNull();
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('finds the answer the backend wrote for any call id (encoded file name, shared with the backend)', async () => {
    const calls = new BrowserCalls(join(dir, '..'), () => undefined);
    const id = 'functions.user_location:0';
    calls.open({ vaultId: 'v', chatId: 'ses_e', callId: id, tool: 'user_location', input: {}, tabId: null });
    setTimeout(() => void calls.answer('v', 'ses_e', id, { ok: false, reason: 'denied' }), 200);
    expect(await waitForAnswer(join(dir, '..', BROWSER_CALLS_DIR), 'ses_e', id, { timeoutMs: 5000 })).toEqual({ ok: false, reason: 'denied' });
    calls.close('v', 'ses_e', id);
  });

  it('a session or call id with / or .. never becomes a path', async () => {
    expect(await waitForAnswer(dir, '../x', 'a/b', { timeoutMs: 100 })).toBeNull();
    expect(await readdir(join(dir, '..'))).not.toContain('x');
  });
});

describe('formatLocation: what the model reads from user_location', () => {
  it('a position, at full precision, with accuracy and age', () => {
    expect(formatLocation({ ok: true, value: { latitude: 48.137154, longitude: 11.576124, accuracy: 12.4, ageMs: 3200 } })).toBe(
      'The user is at 48.137154, 11.576124 (accuracy ±12 m, fix 3 s old).',
    );
  });

  it('a refusal, no position, no Geolocation API, no answer', () => {
    expect(formatLocation({ ok: false, reason: 'denied' })).toBe('The user did not share their location.');
    expect(formatLocation({ ok: false, reason: 'no-position' })).toBe("No position is available on the user's device.");
    expect(formatLocation({ ok: false, reason: 'unsupported' })).toBe("The user's browser cannot share a location.");
    expect(formatLocation(null)).toBe("The user's device did not answer. Ask the user where they are if you need it.");
  });
});

describe('locationTitle: the chip text the tool sets', () => {
  it('accuracy when shared; else why not', () => {
    expect(locationTitle({ ok: true, value: { latitude: 1, longitude: 2, accuracy: 12.4, ageMs: 0 } })).toBe('used your location (±12 m)');
    expect(locationTitle({ ok: false, reason: 'denied' })).toBe('location not shared');
    expect(locationTitle({ ok: false, reason: 'no-position' })).toBe('no location available');
    expect(locationTitle({ ok: false, reason: 'unsupported' })).toBe('no location available');
    expect(locationTitle(null)).toBe('no answer from your device');
  });
});
