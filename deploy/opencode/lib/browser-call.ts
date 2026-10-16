import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where the backend leaves the browser's answer to a browser call (apps/backend/src/browser-calls.ts), on the shared
 * vaults volume: `<dir>/<sessionID>/<callID>.json`. A literal for the same reason as OPEN_PAGE_DIR (open-page.ts).
 */
export const BROWSER_CALLS_DIR = '/vaults/.browser-calls';

/** How long user_location waits; the backend's deadline (apps/backend/src/browser-calls.ts) uses the same 90 s. */
export const BROWSER_CALL_TIMEOUT_MS = 90_000;

/**
 * A session or call id as a file name: base64url, so any id a provider sends (`functions.user_location:0`) works and
 * none becomes a path. The backend encodes the same way (browser-calls.ts `fileKey`).
 */
export const fileKey = (id: string) => Buffer.from(id).toString('base64url');

/**
 * Waits for the answer of a browser call (import-free, so the backend tests load it): polls every 250 ms, returns
 * the parsed answer and deletes the file, or null on timeout or abort.
 */
export async function waitForAnswer(
  dir: string,
  sessionID: string,
  callID: string,
  { timeoutMs, abort }: { timeoutMs: number; abort?: AbortSignal },
): Promise<unknown> {
  const file = join(dir, fileKey(sessionID), `${fileKey(callID)}.json`);
  const end = Date.now() + timeoutMs;
  while (!abort?.aborted) {
    const raw = await readFile(file, 'utf8').catch(() => null);
    if (raw !== null) {
      await rm(file, { force: true });
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (Date.now() >= end) return null;
    await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, end - Date.now()))));
  }
  return null;
}

/** What the model reads from user_location: the browser's answer (validated by the backend), or null = no answer. */
export function formatLocation(answer: unknown): string {
  const a = answer as { ok?: boolean; reason?: string; value?: { latitude: number; longitude: number; accuracy: number; ageMs: number } } | null;
  if (a?.ok === true && a.value) {
    const { latitude, longitude, accuracy, ageMs } = a.value;
    return `The user is at ${latitude}, ${longitude} (accuracy ±${Math.round(accuracy)} m, fix ${Math.round(ageMs / 1000)} s old).`;
  }
  if (a?.ok === false && a.reason === 'denied') return 'The user did not share their location.';
  if (a?.ok === false && a.reason === 'no-position') return "No position is available on the user's device.";
  if (a?.ok === false && a.reason === 'unsupported') return "The user's browser cannot share a location.";
  return "The user's device did not answer. Ask the user where they are if you need it.";
}

/** The chip text user_location sets as its title (the UI shows it; the model reads formatLocation). */
export function locationTitle(answer: unknown): string {
  const a = answer as { ok?: boolean; reason?: string; value?: { accuracy: number } } | null;
  if (a?.ok === true && a.value) return `used your location (±${Math.round(a.value.accuracy)} m)`;
  if (a?.ok === false && a.reason === 'denied') return 'location not shared';
  if (a?.ok === false) return 'no location available';
  return 'no answer from your device';
}
