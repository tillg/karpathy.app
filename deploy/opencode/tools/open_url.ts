import { tool } from '@opencode-ai/plugin';
import { offerUrl } from '../lib/offer-url.ts';

// Baked into the opencode image (Dockerfile), never loaded from a vault. It fetches nothing; the web app
// shows the completed call as an Open chip, and the page opens in the user's browser on a tap.
export default tool({
  description:
    'Offer a web page to the user, who opens it in their browser with a tap. Use it only when the user asks to open, show or see a web page. The URL must already appear in this chat (the user\'s messages, notes you read, search results). For vault notes use open_note; to read a page yourself use webfetch.',
  args: { url: tool.schema.string().describe('The http(s) URL of the page, exactly as it appears in the chat') },
  async execute(args) {
    return offerUrl(args.url);
  },
});
