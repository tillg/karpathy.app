import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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
  /** `step`: every reading advances the clock of the cpu by this much (100 total, 50 idle = 50 % busy). */
  const cpu = { idle: 0, total: 0, step: false };
  const sampler = () =>
    new MetricsSampler({
      dir: d,
      vaultsDir: '/vaults',
      configDir: '/config',
      now: () => clock.t,
      readers: {
        cpus: () => {
          if (cpu.step) {
            cpu.total += 100;
            cpu.idle += 50;
          }
          return { idle: cpu.idle, total: cpu.total };
        },
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
    expect(s.report('7d').samples.map((x) => x.at)).toEqual([clock.t - HOUR, clock.t]); // the old one is dropped, start sampled once
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
    const { d, clock, sampler } = await setup();
    // 2880 samples (30 s apart) ending at `now`; cpu alternates 0 / 100, so an average is 50 and a last-sample is 0 or 100.
    const mk = (at: number, cpu: number) => JSON.stringify({ at, cpu, memUsed: 1, memTotal: 8, load1: 0, vaultsUsed: 0, vaultsTotal: 0, configUsed: 0, configTotal: 0, opencodeUp: true });
    const lines = Array.from({ length: 2880 }, (_, i) => mk(clock.t - (2879 - i) * 30_000, i % 2 === 0 ? 0 : 100));
    await writeFile(join(d, 'metrics.jsonl'), `${lines.join('\n')}\n`);
    const s = sampler();
    await s.start();
    s.stop();
    const r = s.report('24h');
    expect(r.samples.length).toBeLessThanOrEqual(240);
    expect(r.samples.length).toBeGreaterThan(200);
    for (const x of r.samples.slice(1, -1)) expect(x.cpu).toBeCloseTo(50, 0);
    expect(r.latest?.memTotal).toBe(8);
    expect(r.intervalS).toBe(1e6);
    expect(s.report('1h').samples.length).toBeGreaterThanOrEqual(120);
  });

  it('the first sample after start has a real CPU reading, and latest is fresh', async () => {
    const { cpu, sampler } = await setup();
    cpu.step = true;
    const s = sampler();
    await s.start();
    s.stop();
    expect(s.report('1h').latest?.cpu).toBe(50);
  });

  it('a sample at exactly now is clamped into the last bucket: at most 240 points', async () => {
    const { d, clock, sampler } = await setup();
    const mk = (at: number) => JSON.stringify({ at, cpu: 1, memUsed: 1, memTotal: 2, load1: 0, vaultsUsed: 0, vaultsTotal: 0, configUsed: 0, configTotal: 0, opencodeUp: true });
    // one sample per bucket (6 min wide) plus one at exactly now
    const ats = Array.from({ length: 240 }, (_, i) => clock.t - DAY + i * 6 * MIN + 1);
    await writeFile(join(d, 'metrics.jsonl'), `${[...ats, clock.t].map(mk).join('\n')}\n`);
    const s = sampler();
    await s.start();
    s.stop();
    expect(s.report('24h').samples.length).toBeLessThanOrEqual(240);
  });

  it('start survives an unreadable history file and starts empty', async () => {
    const { d, clock, sampler } = await setup();
    await mkdir(join(d, 'metrics.jsonl')); // reading a directory: EISDIR
    const s = sampler();
    await expect(s.start()).resolves.toBeUndefined();
    s.stop();
    expect(s.report('7d').samples.map((x) => x.at)).toEqual([clock.t]); // no history, only the first sample
  });

  it('metrics.jsonl is written with mode 0600', async () => {
    const { d, sampler } = await setup();
    const s = sampler();
    await s.sample();
    expect((await stat(join(d, 'metrics.jsonl'))).mode & 0o777).toBe(0o600);
  });
});
