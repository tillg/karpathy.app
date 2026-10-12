import { tool } from '@opencode-ai/plugin';
import { proxyFor, SAVE_URL_DESCRIPTION, saveUrl } from '../lib/save-url.ts';

// Baked into the opencode image (Dockerfile), never loaded from a vault. The only tool that writes bytes:
// it downloads through the egress proxy (passed explicitly) and refuses without one, and refuses NO_PROXY
// hosts on every redirect hop (Bun would fetch those directly). The
// known-url plugin checks the URL and the fetch cap first; the backend allows it only with Web access on and
// never in a read-only turn.
export default tool({
  description: SAVE_URL_DESCRIPTION,
  args: {
    url: tool.schema.string().describe('The http(s) URL of the file, exactly as it appears in the chat'),
    filePath: tool.schema.string().describe("Vault-relative path of the NEW file, with its extension, e.g. Animals/Cats/tabby.jpg. Not the note's name, no colon"),
  },
  async execute(args, context) {
    const proxy = proxyFor(args.url, process.env);
    if (!proxy) throw new Error('No egress proxy configured: downloads are disabled');
    return saveUrl(context.directory, args.url, args.filePath, { proxy, env: process.env });
  },
});
