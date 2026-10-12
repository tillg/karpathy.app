import { tool } from '@opencode-ai/plugin';
import { defaultFilePath, proxyFor, SAVE_URL_DESCRIPTION, saveUrl } from '../lib/save-url.ts';

// Baked into the opencode image (Dockerfile), never loaded from a vault. The only tool that writes bytes:
// it downloads through the egress proxy (passed explicitly) and refuses without one, and refuses NO_PROXY
// hosts on every redirect hop (Bun would fetch those directly). The
// known-url plugin checks the URL and the fetch cap first; the backend allows it only with Web access on and
// never in a read-only turn.
export default tool({
  description: SAVE_URL_DESCRIPTION,
  args: {
    url: tool.schema.string().describe('The http(s) URL of the file, exactly as it appears in the chat'),
    filePath: tool.schema.string().optional().describe("Vault-relative path of the NEW file, with its extension, e.g. Animals/Cats/tabby.jpg. Not the note's name, no colon. Optional with note: then the URL's file name next to the note"),
    note: tool.schema.string().optional().describe('Vault-relative path of the existing note that should show the file, e.g. Ideas.md. The tool adds the embed to it'),
  },
  async execute(args, context) {
    const proxy = proxyFor(args.url, process.env);
    if (!proxy) throw new Error('No egress proxy configured: downloads are disabled');
    const filePath = args.filePath ?? defaultFilePath(args.url, args.note);
    const output = await saveUrl(context.directory, args.url, filePath, { proxy, env: process.env, note: args.note });
    // The saved file and the note go in the metadata: the backend marks them as changed by the AI and shows the chip's path (harness/map.ts), also when filePath was left out.
    return args.note ? { output, metadata: { files: [{ filePath }, { filePath: args.note }] } } : output;
  },
});
