import type { Plugin } from '@opencode-ai/plugin';
import { capFromEnv, GUARDED_TOOLS, guardWebCall } from '../lib/known-url.ts';

// Baked into the image (Dockerfile), never loaded from a vault. Guards the web tools and link offers:
//  - webfetch and open_url only take a URL that already appears in the chat (the user's text or earlier
//    tool output), so injected instructions can't append vault data to a URL;
//  - web caps: at most N webfetch and M websearch calls per turn (env WEB_FETCH_CAP / WEB_SEARCH_CAP).
// A throw here makes the tool call fail with that message; the turn goes on.
export const KnownUrl: Plugin = async ({ client, directory }) => {
  const fetchCap = capFromEnv(process.env.WEB_FETCH_CAP);
  const searchCap = capFromEnv(process.env.WEB_SEARCH_CAP);
  console.log(`known-url ready: fetch cap ${fetchCap}, search cap ${searchCap}`);
  return {
    'tool.execute.before': async (input, output) => {
      if (!GUARDED_TOOLS.includes(input.tool)) return;
      const res = await client.session.messages({ path: { id: input.sessionID }, query: { directory } });
      // Fail closed: without the chat there is no provenance to check.
      if (res.error || !res.data) throw new Error('Cannot check the chat for this URL; try again');
      // The current call may already be stored: don't count it against its own cap.
      const messages = ((res.data) as { info?: { role?: string }; parts?: { callID?: string }[] }[]).map((m) => ({
        ...m,
        parts: (m.parts ?? []).filter((p) => p.callID !== input.callID),
      }));
      const refusal = guardWebCall(input.tool, output.args, messages, { fetch: fetchCap, search: searchCap });
      if (refusal) throw new Error(refusal);
    },
  };
};
