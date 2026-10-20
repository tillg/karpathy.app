import type { BrowserCall, BrowserCallResult, BrowserTool } from '@karpathy/shared';
import { api } from './api';
import { tabId } from './client-context';

// The answering tab's side of browser tools (#151): the AI's tool waits in opencode while this tab answers.

/** As precise as the device can tell (GPS); a fix up to a minute old is fine. */
export const LOCATION_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 60_000, timeout: 60_000 };

type Fix = { coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number };

export const locationResult = (p: Fix, now: number): BrowserCallResult => ({
  ok: true,
  value: { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, ageMs: Math.max(0, now - p.timestamp) },
});

/** GeolocationPositionError codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT. */
export const locationError = (code: number): BrowserCallResult => ({ ok: false, reason: code === 1 ? 'denied' : 'no-position' });

/** The position from the Geolocation API; the browser asks the user the first time. */
export function userLocation(geo: Geolocation | undefined = navigator.geolocation): Promise<BrowserCallResult> {
  if (!geo) return Promise.resolve({ ok: false, reason: 'unsupported' });
  return new Promise((resolve) =>
    geo.getCurrentPosition(
      (p) => resolve(locationResult(p, Date.now())),
      (e) => resolve(locationError(e.code)),
      LOCATION_OPTIONS,
    ),
  );
}

/** One handler per browser tool; a tool without one is answered `unsupported`. */
export const browserTools: Record<BrowserTool, (input: Record<string, unknown>) => Promise<BrowserCallResult>> = {
  user_location: () => userLocation(),
};

/** Calls this tab already took on: the event stream may announce one again (reconnect, replay). */
const taken = new Set<string>();

/** Answers a browser call if this tab sent the prompt; any chat, not just the one on screen. */
export async function answerBrowserCall(vaultId: string, call: BrowserCall): Promise<void> {
  if (call.tabId !== tabId() || taken.has(call.callId)) return;
  taken.add(call.callId);
  const handler = browserTools[call.tool as BrowserTool];
  const result: BrowserCallResult = handler ? await handler(call.input) : { ok: false, reason: 'unsupported' };
  // 404/409: the call is over or answered already (timeout, another copy of this tab); nothing to do.
  await api.answerBrowserCall(vaultId, call.chatId, call.callId, result).catch(() => undefined);
}
