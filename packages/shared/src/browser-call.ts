// Browser tools (#151): tools the AI calls in opencode whose answer comes from the tab that sent the prompt.

/** The browser tools: the harness marks their calls (harness/map.ts), the web has one handler each (lib/browser-tools.ts). */
export const BROWSER_TOOLS = ['user_location'] as const;
export type BrowserTool = (typeof BROWSER_TOOLS)[number];

/** What a prompt says about the tab that sent it: the answering tab, its time zone and locale. */
export interface PromptClient {
  tabId?: string;
  timeZone?: string;
  locale?: string;
}

/** The answering device's position as the Geolocation API reports it: degrees, accuracy in meters, age of the fix. */
export interface UserLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  ageMs: number;
}

export type BrowserCallUnavailable = 'denied' | 'no-position' | 'unsupported';

/** What the answering tab sends back (POST …/browser-calls/:callId). */
export type BrowserCallResult = { ok: true; value: UserLocation } | { ok: false; reason: BrowserCallUnavailable };

/** A pending browser call, as the vault event stream announces it. `tabId` null: no tab can answer (the tool times out). */
export interface BrowserCall {
  chatId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  tabId: string | null;
  /** When the call stops waiting (ms since epoch). */
  deadline: number;
}

const REASONS: readonly string[] = ['denied', 'no-position', 'unsupported'];

const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

const VALUES: Record<BrowserTool, (v: unknown) => boolean> = {
  user_location: (v) => {
    if (!v || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    return (
      Object.keys(o).length === 4 &&
      num(o.latitude, -90, 90) &&
      num(o.longitude, -180, 180) &&
      num(o.accuracy, 0, Number.MAX_VALUE) &&
      num(o.ageMs, 0, Number.MAX_VALUE)
    );
  },
};

/** The body of an answer if it is a valid result for `tool`, else null. */
export function parseBrowserCallResult(tool: string, body: unknown): BrowserCallResult | null {
  const valid = VALUES[tool as BrowserTool];
  if (!valid || !body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.ok === true && valid(b.value)) return { ok: true, value: b.value as UserLocation };
  if (b.ok === false && typeof b.reason === 'string' && REASONS.includes(b.reason)) return { ok: false, reason: b.reason as BrowserCallUnavailable };
  return null;
}
