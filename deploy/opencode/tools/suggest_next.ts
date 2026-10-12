import { tool } from '@opencode-ai/plugin';
import { cleanSuggestion } from '../lib/suggestion.ts';

// Baked into the opencode image (Dockerfile), never loaded from a vault. It only checks the text; the web app
// hides the call's chip and shows the prompt as ghost text in the composer (ToolCall.suggestion).
export default tool({
  description:
    "Suggest the user's next message, shown greyed out in their chat box; they accept it with one tap or keypress. Call it at most once per turn, as your very last action, after your answer is written, with one concise next step the user could plausibly send (a short request or question, written as the user would, in the user's language). Skip it when no sensible next step exists or the turn failed. Never mention the suggestion in your answer.",
  args: { prompt: tool.schema.string().describe('The suggested next user message, one line, at most 160 characters') },
  async execute(args) {
    return cleanSuggestion(args.prompt);
  },
});
