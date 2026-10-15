import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MetricsSample } from '@karpathy/shared';
import { MetricsSampler } from '../src/metrics.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const dir = () => mkdtemp(join(tmpdir(), 'metrics-'));

/** A sampler on a fake clock and fake readers; `cpu` is the cumulative {idle,total} reading. */
async function setup(opts: { start?: number } = {}) {
  const d = await dir();
  const clock = { t: opts.start ?? 1_000_000_000_000 };
  const cpu = { idle: 0, total: 0 };
  const sampler = () =>
    new MetricsSampler({
      dir: d,
      vaultsDir: '/vaults',
      configDir: '/config',
      now: () => clock.t,
      readers: {
        cpus: () => ({ ...cpu }),
        mem: () => ({ used: 4, total: 8 }),
        load: () => 0.5,
        statfs: async (p) => (p === '/vaults' ? { used: 10, total: 100 } : { used: 1, total: 10 }),
      },
      opencodeUp: async () => true,
      intervalMs: 1e9,
    });
  return { d, clock, cpu, sampler };
}

describe('MetricsSampler', () => {
  it('CPU % from the difference of two cpu-time readings', async () => {
    const { cpu, sampler } = await setup();
    const s = sampler();
    cpu.idle = 100;
    cpu.total = 200;
    await s.sample();
    cpu.idle = 175; // +75 idle of +100 total → 25 % busy
    cpu.total = 300;
    await s.sample();
    const { samples } = s.report('1h');
    expect(samples[1]).toMatchObject({
      cpu: 25,
      memUsed: 4,
      memTotal: 8,
      load1: 0.5,
      vaultsUsed: 10,
      vaultsTotal: 100,
      configUsed: 1,
      configTotal: 10,
      opencodeUp: true,
    });
  });

  it('appends one JSON line per sample', async () => {
    const { d, clock, sampler } = await setup();
    const s = sampler();
    await s.sample();
    clock.t += 30_000;
    await s.sample();
    const lines = (await readFile(join(d, 'metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]!) as MetricsSample).at).toBe(clock.t);
  });

  it('on start drops samples older than 7 days and skips a torn last line', async () => {
    const { d, clock, sampler } = await setup();
    const mk = (at: number) => JSON.stringify({ at, cpu: 1, memUsed: 1, memTotal: 2, load1: 0, vaultsUsed: 0, vaultsTotal: 0, configUsed: 0, configTotal: 0, opencodeUp: true });
    await writeFile(join(d, 'metrics.jsonl'), `${mk(clock.t - 8 * DAY)}\n${mk(clock.t - HOUR)}\n{"at":${clock.t - 60},"cp`);
    const s = sampler();
    await s.start();
    s.stop();
    expect(s.report('7d').samples.map((x) => x.at)).toEqual([clock.t - HOUR]);
  });

  it('hourly compaction rewrites the file without the old samples', async () => {
    const { d, clock, sampler } = await setup();
    const s = sampler();
    await s.start();
    s.stop();
    await s.sample();
    const old = clock.t;
    clock.t += 7 * DAY + 2 * HOUR;
    await s.sample();
    const lines = (await readFile(join(d, 'metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as MetricsSample).at)).toEqual([clock.t]);
    expect(old).toBeLessThan(clock.t - 7 * DAY);
  });

  it('range 24h is bucket-averaged to at most 240 points', async () => {
    const { clock, cpu, sampler } = await setup();
    const s = sampler();
    for (let i = 0; i < 2880; i++) {
      cpu.total += 100;
      cpu.idle += 50;
      await s.sample();
      clock.t += 30_000;
    }
    const r = s.report('24h');
    expect(r.samples.length).toBeLessThanOrEqual(240);
    expect(r.samples.length).toBeGreaterThan(200);
    expect(r.samples[10]!.cpu).toBeCloseTo(50);
    expect(r.latest?.memTotal).toBe(8);
    expect(r.intervalS).toBe(1e6);
    expect(s.report('1h').samples).toHaveLength(120);
  });
});
