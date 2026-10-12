// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAcceptKey } from '../lib/chat';
import { Ghost } from './Suggestion';

afterEach(cleanup);

describe('Ghost (#145)', () => {
  it('shows the suggestion greyed out next to a use button named after it', () => {
    render(<Ghost text="Summarize the open points" onAccept={() => undefined} />);
    expect(screen.getByTestId('chat-ghost').textContent).toContain('Summarize the open points');
    const use = screen.getByTestId('chat-suggestion');
    expect(use.getAttribute('aria-label')).toBe('Use suggested prompt: Summarize the open points');
    // Both affordances are in the DOM; CSS shows "Tab" on hover devices and "Tap" on touch.
    expect(use.textContent).toMatch(/Tab/);
    expect(use.textContent).toMatch(/Tap/);
  });

  it('a tap on the button accepts, and the ghost goes with the typed text', () => {
    const accept = vi.fn();
    const { rerender } = render(<Ghost text="Do it" onAccept={accept} />);
    fireEvent.click(screen.getByTestId('chat-suggestion'));
    expect(accept).toHaveBeenCalledTimes(1);
    rerender(<Ghost text={null} onAccept={accept} />);
    expect(screen.queryByTestId('chat-ghost')).toBeNull();
  });

  it('keeps focus in the composer on mouse down', () => {
    render(<Ghost text="Do it" onAccept={() => undefined} />);
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    screen.getByTestId('chat-suggestion').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('renders the text as text, never as HTML', () => {
    render(<Ghost text="<img src=x onerror=alert(1)>" onAccept={() => undefined} />);
    expect(screen.getByTestId('chat-ghost').querySelector('img')).toBeNull();
  });
});

describe('isAcceptKey', () => {
  const k = (o: Partial<KeyboardEvent>) => ({ key: 'Tab', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  it('is a plain Tab only', () => {
    expect(isAcceptKey(k({}))).toBe(true);
    expect(isAcceptKey(k({ shiftKey: true }))).toBe(false);
    expect(isAcceptKey(k({ metaKey: true }))).toBe(false);
    expect(isAcceptKey(k({ key: 'Enter' }))).toBe(false);
  });
});

// The same wiring as the composer: ghost only while empty, Tab/tap put the text in without sending.
function Composer({ suggestion, onSend }: { suggestion: string; onSend(t: string): void }) {
  const [text, setText] = useState('');
  return (
    <div>
      <textarea data-testid="c" value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (!text && isAcceptKey(e)) { e.preventDefault(); setText(suggestion); } else if (e.key === 'Enter') onSend(text); }} />
      <Ghost text={text ? null : suggestion} onAccept={() => setText(suggestion)} />
    </div>
  );
}

describe('ghost in a composer', () => {
  it('Tab accepts without sending, typing hides the ghost, Enter then sends', () => {
    const send = vi.fn();
    render(<Composer suggestion="Summarize it" onSend={send} />);
    const c = screen.getByTestId('c') as HTMLTextAreaElement;
    expect(screen.getByTestId('chat-ghost')).toBeTruthy();
    fireEvent.keyDown(c, { key: 'Tab' });
    expect(c.value).toBe('Summarize it');
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-ghost')).toBeNull();
    fireEvent.keyDown(c, { key: 'Enter' });
    expect(send).toHaveBeenCalledWith('Summarize it');
  });

  it('typing makes the ghost disappear', () => {
    render(<Composer suggestion="Summarize it" onSend={() => undefined} />);
    fireEvent.change(screen.getByTestId('c'), { target: { value: 'x' } });
    expect(screen.queryByTestId('chat-ghost')).toBeNull();
  });
});
