// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextMeter } from './ContextMeter';

afterEach(cleanup);

describe('ContextMeter (#140)', () => {
  it('full: used / limit and the meter value', () => {
    render(<ContextMeter usage={{ used: 3560, limit: 16384 }} variant="full" model="ollama/some-model" locale="en-US" />);
    expect(screen.getByTestId('context-meter').textContent).toContain('3,560 / 16,384');
    const m = screen.getByRole('meter');
    expect(m.getAttribute('aria-valuenow')).toBe('3560');
    expect(m.getAttribute('aria-valuemax')).toBe('16384');
  });

  it('levels: ok below 70 %, warn from 70 %, crit from 90 %', () => {
    const level = (used: number) => {
      const { container } = render(<ContextMeter usage={{ used, limit: 100 }} variant="bar" />);
      const cls = container.querySelector('[role="meter"]')!.className;
      cleanup();
      return cls;
    };
    expect(level(69)).toContain('ok');
    expect(level(70)).toContain('warn');
    expect(level(89)).toContain('warn');
    expect(level(90)).toContain('crit');
  });

  it('the tooltip names the share, the model and compaction', () => {
    render(<ContextMeter usage={{ used: 3560, limit: 16384 }} variant="full" model="ollama/some-model" locale="en-US" />);
    expect(screen.getByTestId('context-meter').getAttribute('title')).toBe("22% of some-model's context · drops when the chat is compacted");
  });

  it('numbers follow the locale', () => {
    render(<ContextMeter usage={{ used: 3560, limit: 16384 }} variant="full" model="ollama/some-model" locale="de-DE" />);
    const m = screen.getByTestId('context-meter');
    expect(m.textContent).toContain('3.560 / 16.384');
    expect(m.getAttribute('title')).toMatch(/^22\s%/);
    cleanup();
    render(<ContextMeter usage={{ used: 3560 }} variant="full" locale="de-DE" />);
    expect(screen.getByTestId('context-meter').textContent).toBe('3.560 tokens');
  });

  it('no limit: full shows only the tokens, bar renders nothing', () => {
    render(<ContextMeter usage={{ used: 3560 }} variant="full" locale="en-US" />);
    expect(screen.getByTestId('context-meter').textContent).toBe('3,560 tokens');
    expect(screen.queryByRole('meter')).toBeNull();
    cleanup();
    const { container } = render(<ContextMeter usage={{ used: 3560 }} variant="bar" />);
    expect(container.innerHTML).toBe('');
  });
});
