// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Sparkline } from './Sparkline';
import { StackedBars } from './StackedBars';

afterEach(cleanup);

const fmt = (v: number) => `${v} u`;
const points = [{ t: 0, v: 4 }, { t: 1, v: 9 }, { t: 2, v: 2 }, { t: 3, v: 7 }];
const series = [
  { key: 'input', label: 'Input', color: 'var(--series-1)' },
  { key: 'output', label: 'Output', color: 'var(--series-2)' },
];
const rows = [
  { label: 'Mon', values: { input: 1200, output: 300 } },
  { label: 'Tue', values: { input: 0, output: 5000 } },
  { label: 'Wed', values: { input: 800, output: 100 } },
];

const sparkline = () => render(<Sparkline points={points} format={fmt} label="CPU over 24 h" fromLabel="24 h ago" toLabel="now" />);
const bars = () => render(<StackedBars rows={rows} series={series} format={fmt} label="Tokens per day" />);

describe('charts (#150)', () => {
  it('Sparkline draws one path over the points, labels min/max and the latest value', () => {
    const { container } = sparkline();
    const svg = screen.getByRole('img', { name: 'CPU over 24 h' });
    expect(svg.querySelectorAll('path.line')).toHaveLength(1);
    expect(svg.querySelector('path.line')!.getAttribute('d')!.match(/[ML]/g)).toHaveLength(points.length);
    expect(svg.textContent).toContain('24 h ago');
    expect(svg.textContent).toContain('now');
    const txt = container.textContent!;
    expect(txt).toContain('min 2 u');
    expect(txt).toContain('max 9 u');
    expect(txt).toContain('7 u'); // latest
  });

  it('Sparkline hover shows the value of the nearest point in a tooltip', () => {
    sparkline();
    const svg = screen.getByRole('img', { name: 'CPU over 24 h' });
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 80, right: 300, bottom: 80, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 10 });
    expect(screen.getByRole('tooltip').textContent).toContain('9 u');
    fireEvent.pointerLeave(svg);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('StackedBars draws one stack per day with one rect per series', () => {
    bars();
    const svg = screen.getByRole('img', { name: 'Tokens per day' });
    const stacks = svg.querySelectorAll('g.stack');
    expect(stacks).toHaveLength(rows.length);
    expect(stacks[0]!.querySelectorAll('rect.seg')).toHaveLength(series.length);
    // zero values draw no height
    expect(stacks[1]!.querySelector('rect.seg')!.getAttribute('height')).toBe('0');
    // legend for >= 2 series
    expect(document.querySelector('.legend')!.textContent).toBe('InputOutput');
  });

  it('StackedBars hover shows the day with every series value', () => {
    bars();
    const svg = screen.getByRole('img', { name: 'Tokens per day' });
    fireEvent.pointerMove(svg.querySelectorAll('rect.hit')[0]!, { clientX: 5, clientY: 5 });
    const tip = screen.getByRole('tooltip').textContent!;
    expect(tip).toContain('Mon');
    expect(tip).toContain('Input 1200 u');
    expect(tip).toContain('Output 300 u');
  });

  it('both render a <details> table with the same numbers', () => {
    const a = sparkline();
    const d1 = a.container.querySelector('details')!;
    expect(d1.querySelector('summary')!.textContent).toBe('Show numbers');
    const t1 = within(d1).getByRole('table', { hidden: true });
    expect(t1.textContent).toContain('2 u');
    expect(t1.textContent).toContain('9 u');
    expect(t1.textContent).toContain('7 u');
    cleanup();
    const b = bars();
    const t2 = within(b.container.querySelector('details')!).getByRole('table', { hidden: true });
    expect(t2.querySelectorAll('tbody tr')).toHaveLength(rows.length);
    expect(t2.querySelectorAll('thead th')).toHaveLength(series.length + 1);
    expect(t2.textContent).toContain('1200 u');
    expect(t2.textContent).toContain('5000 u');
  });

  it('empty data shows "No data yet"', () => {
    const a = render(<Sparkline points={[]} format={fmt} label="CPU" />);
    expect(a.container.textContent).toContain('No data yet');
    expect(a.container.querySelector('svg')).toBeNull();
    cleanup();
    const b = render(<StackedBars rows={[]} series={series} format={fmt} label="Tokens" />);
    expect(b.container.textContent).toContain('No data yet');
    expect(b.container.querySelector('svg')).toBeNull();
  });
});
