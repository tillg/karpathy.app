import { tool } from '@opencode-ai/plugin';
import { proxyFor, saveUrl } from '../lib/save-url.ts';

// Baked into the opencode image (Dockerfile), never loaded from a vault. The only tool that writes bytes:
// it downloads through the egress proxy (passed explicitly) and refuses without one, and refuses NO_PROXY
// hosts on every redirect hop (Bun would fetch those directly). The
// known-url plugin checks the URL and the fetch cap first; the backend allows it only with Web access on and
// never in a read-only turn.
export default tool({
  description:
    'Download an image, video, audio file or PDF from the web into the vault, e.g. to add a picture to a note. The URL must already appear in this chat (the user\'s messages, pages you fetched, search results). Save it next to the note that will show it. It never overwrites a file. Then add the embed it returns to the note with edit; a URL alone in a note is not saved.',
  args: {
    url: tool.schema.string().describe('The http(s) URL of the file, exactly as it appears in the chat'),
    filePath: tool.schema.string().describe('Vault-relative path of the new file, with its extension, e.g. Animals/Cats/tabby.jpg'),
  },
  async execute(args, context) {
    const proxy = proxyFor(args.url, process.env);
    if (!proxy) throw new Error('No egress proxy configured: downloads are disabled');
    return saveUrl(context.directory, args.url, args.filePath, { proxy, env: process.env });
  },
});
