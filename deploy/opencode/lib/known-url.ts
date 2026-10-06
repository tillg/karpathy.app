/**
 * The web provenance check and caps (import-free, so the backend tests load it): a URL may only be
 * fetched if it already appears in the chat (user text or completed tool output).
 */

// Loose on purpose: opencode session messages, [{ info: { role }, parts: [{ type, ... }] }].
type Part = { type?: string; text?: unknown; tool?: unknown; state?: { status?: string; output?: unknown; input?: Record<string, unknown> } };
type Message = { info?: { role?: string }; parts?: Part[] | null };

const count = (s: string, c: string) => s.split(c).length - 1;

/** `http(s)://` URLs in `text`, with Markdown and trailing punctuation stripped (a `)` only when unbalanced). */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'`\]]+/gi) ?? [];
  return found
    .map((u) => {
      for (;;) {
        const last = u[u.length - 1];
        if (last !== undefined && '.,;:!?'.includes(last)) u = u.slice(0, -1);
        else if (last === ')' && count(u, ')') > count(u, '(')) u = u.slice(0, -1);
        else return u;
      }
    })
    .filter((u) => u.length > 0);
}

/** WHATWG parse, http(s) only, fragment dropped; the URL class lowercases scheme/host and drops default ports. */
function normalize(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** True if `url` equals (after normalization) a URL found in `texts`. Path and query stay exact. */
export function isKnownUrl(url: string, texts: string[]): boolean {
  const wanted = normalize(url);
  if (wanted === null) return false;
  return texts.some((t) => extractUrls(t).some((u) => normalize(u) === wanted));
}

/** Number of `tool` parts after the last user message (the current turn). */
export function callsThisTurn(messages: Message[], tool: string): number {
  let last = -1;
  messages.forEach((m, i) => {
    if (m?.info?.role === 'user') last = i;
  });
  let n = 0;
  for (const m of messages.slice(last + 1)) {
    if (!Array.isArray(m?.parts)) continue;
    for (const p of m.parts) if (p?.type === 'tool' && p.tool === tool && ['running', 'completed'].includes(p.state?.status ?? '')) n++;
  }
  return n;
}

const WRITE_TOOLS = ['edit', 'write', 'apply_patch', 'patch', 'multiedit'];
const SOURCE_TOOLS = ['read', 'webfetch', 'websearch'];

const samePath = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * The chat's known text: user text parts, plus the output of `read`, `webfetch` and `websearch`. Other tool
 * output (todowrite, ...) is text the model wrote itself and would let it mint a URL; a read of a file the
 * AI wrote or edited earlier in the session is the same echo, so it doesn't count either.
 */
export function knownTexts(messages: Message[]): string[] {
  const out: string[] = [];
  const written: string[] = [];
  const patches: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m?.parts)) continue;
    for (const p of m.parts) {
      if (m.info?.role === 'user' && p?.type === 'text' && typeof p.text === 'string') out.push(p.text);
      if (p?.type !== 'tool' || typeof p.tool !== 'string') continue;
      const input = p.state?.input ?? {};
      if (WRITE_TOOLS.includes(p.tool)) {
        for (const k of ['filePath', 'path']) if (typeof input[k] === 'string') written.push(input[k] as string);
        // Patch tools name their files inside the patch text.
        patches.push(JSON.stringify(input));
      } else if (p.state?.status === 'completed' && typeof p.state.output === 'string' && SOURCE_TOOLS.includes(p.tool)) {
        const file = p.tool === 'read' && typeof input.filePath === 'string' ? input.filePath : null;
        if (file !== null && (written.some((w) => samePath(w, file)) || patches.some((t) => t.includes(file)))) continue;
        out.push(p.state.output);
      }
    }
  }
  return out;
}

/** A positive-integer cap from env; anything else is the default 20. */
export function capFromEnv(value: string | undefined): number {
  return value !== undefined && /^[1-9]\d*$/.test(value.trim()) ? Number(value) : 20;
}

/** The tools the plugin guards: the web tools and the link offer. */
export const GUARDED_TOOLS = ['webfetch', 'websearch', 'open_url'];

/**
 * The plugin's decision for one tool call: the error to fail it with, or null to let it run. `webfetch` and
 * `websearch` are capped per turn; `webfetch` and `open_url` need a known URL. `open_url` has no cap: the
 * user taps every link offer. `messages` must not hold the call itself.
 */
export function guardWebCall(tool: string, args: Record<string, unknown> | undefined, messages: Message[], caps: { fetch: number; search: number }): string | null {
  if (tool === 'webfetch' || tool === 'websearch') {
    const cap = tool === 'webfetch' ? caps.fetch : caps.search;
    if (callsThisTurn(messages, tool) >= cap) return `${tool === 'webfetch' ? 'Fetch' : 'Search'} limit reached (${cap} per turn)`;
  }
  if ((tool === 'webfetch' || tool === 'open_url') && !isKnownUrl(String(args?.url ?? ''), knownTexts(messages)))
    return 'URL not in this chat: paste it into the chat first';
  return null;
}
