import { describe, expect, it } from 'vitest';
import { attachWarning } from '../lib/chat';

// The warning an unsent attachment's chip shows (ChipView in ChatPane). Images never warn since look_at_image
// describes them for a text-only model (#146); PDFs still do, the tool reads images only.
describe('attachment chip warning (#146)', () => {
  const textOnly = { image: false, pdf: false };

  it('text-only model + image: no warning', () => {
    expect(attachWarning(textOnly, 'Sources/upload-x/shot.png', 'glm-5.3')).toBeNull();
  });

  it('text-only model + PDF: warning', () => {
    expect(attachWarning(textOnly, 'Sources/upload-x/doc.pdf', 'glm-5.3')).toBe('glm-5.3 can’t see PDFs: the AI only gets the file’s path');
  });

  it('a model that reads PDFs, or an unknown model: no warning', () => {
    expect(attachWarning({ image: true, pdf: true }, 'a/doc.pdf', 'm')).toBeNull();
    expect(attachWarning(null, 'a/doc.pdf', 'm')).toBeNull();
  });
});
