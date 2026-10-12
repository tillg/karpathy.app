import { tool } from '@opencode-ai/plugin';
import { describeImage } from '../lib/look-at-image.ts';

// Baked into the opencode image (Dockerfile), never loaded from a vault. Asks the vision model (VISION_* in
// opencode.env, a model of the chat model's gateway) what an image shows; the key never reaches the chat model.
export default tool({
  description:
    "Look at an image and get a description from an image-recognition model: what it shows and the text in it. Use it for any image (png, jpg, gif, webp) in the vault, and for an image the user attached to their message: an attached file appears as a path under Sources/upload-…/, and you must call this with that path whenever you cannot see the image yourself (e.g. a read of it fails). Pass a specific question to learn a detail; without one you get a full description. PDFs and SVGs are not supported.",
  args: {
    path: tool.schema.string().describe('Vault-relative path of the image, e.g. Sources/upload-2026-10-13/receipt.jpg'),
    question: tool.schema.string().optional().describe('What to find out, e.g. "What is the total on the receipt?"'),
  },
  async execute(args, context) {
    return describeImage(context.directory, args.path, args.question, process.env);
  },
});
