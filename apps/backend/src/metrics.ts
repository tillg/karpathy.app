import { appendFile, mkdir, readFile, rename, statfs, writeFile } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import type { MetricsReport, MetricsSample } from '@karpathy/shared';

export type MetricsRange = '1h' | '24h' | '7d';

const HOUR = 3_600_000;
const KEEP_MS = 7 * 24 * HOUR;
const RANGE_MS: Record<MetricsRange, number> = { '1h': HOUR, '24h': 24 * HOUR, '7d': KEEP_MS };
const MAX_POINTS = 240;

/** Host readings, injectable so tests need no real host. `cpus` is cumulative (idle and total CPU time). */
export interface MetricsReaders {
  cpus: () => { idle: number; total: number };
  mem: () => { used: number; total: number } | Promise<{ used: number; total: number }>;
  load: () => number;
  statfs: (path: string) => Promise<{ used: number; total: number }>;
}

export interface MetricsSamplerOptions {
  /** Where `metrics.jsonl` lives (the config volume). */
  dir: string;
  vaultsDir: string;
  configDir: string;
  now?: () => number;
  readers?: Partial<MetricsReaders>;
  opencodeUp: () => Promise<boolean>;
  intervalMs?: number;
}

const defaultReaders: MetricsReaders = {
  cpus: () => {
    let idle = 0;
    let total = 0;
    for (const { times } of cpus()) {
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idle, total };
  },
  mem: async () => {
    const total = totalmem();
    let used = total - freemem();
    try {
      const m = /^MemAvailable:\s+(\d+) kB/m.exec(await readFile('/proc/meminfo', 'utf8'));
      if (m) used = total - Number(m[1]) * 1024;
    } catch {
      // no /proc (macOS): keep os.freemem()
    }
    return { used, total };
  },
  load: () => loadavg()[0]!,
  statfs: async (path) => {
    const s = await statfs(path);
    return { used: (s.blocks - s.bfree) * s.bsize, total: s.blocks * s.bsize };
  },
};

/**
 * Samples the host every `intervalMs` (30 s) and keeps 7 days in memory and in `<dir>/metrics.jsonl`:
 * one line appended per sample, rewritten atomically once an hour without the old samples.
 */
export class MetricsSampler {
  private samples: MetricsSample[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly readers: MetricsReaders;
  private readonly intervalMs: number;
  private readonly startedAt: number;
  private lastCompact: number;
  private prevCpu: { idle: number; total: number } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly opts: MetricsSamplerOptions) {
    this.file = join(opts.dir, 'metrics.jsonl');
    this.now = opts.now ?? Date.now;
    this.readers = { ...defaultReaders, ...opts.readers };
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.startedAt = this.lastCompact = this.now();
  }

  /** Loads the stored history (dropping old and torn lines), then samples every interval. */
  async start(): Promise<void> {
    let raw = '';
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const lines = raw.split('\n').filter(Boolean);
    this.samples = [];
    for (const line of lines) {
      try {
        this.samples.push(JSON.parse(line) as MetricsSample);
      } catch {
        // torn line, e.g. after a crash
      }
    }
    const cutoff = this.now() - KEEP_MS;
    this.samples = this.samples.filter((s) => s.at >= cutoff);
    // Rewrite when something was dropped, so the next append doesn't continue a torn line.
    if (this.samples.length !== lines.length || (raw && !raw.endsWith('\n'))) await this.compact();
    this.stop();
    this.timer = setInterval(() => void this.sample().catch(() => undefined), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One tick: read the host, append the sample, compact once an hour. */
  async sample(): Promise<void> {
    const at = this.now();
    const cpu = this.readers.cpus();
    const prev = this.prevCpu;
    this.prevCpu = cpu;
    const dTotal = prev ? cpu.total - prev.total : 0;
    const busy = dTotal > 0 ? (1 - (cpu.idle - prev!.idle) / dTotal) * 100 : 0;
    const [mem, vaults, config, opencodeUp] = await Promise.all([
      this.readers.mem(),
      this.readers.statfs(this.opts.vaultsDir),
      this.readers.statfs(this.opts.configDir),
      this.opts.opencodeUp().catch(() => false),
    ]);
    const s: MetricsSample = {
      at,
      cpu: Math.min(100, Math.max(0, busy)),
      memUsed: mem.used,
      memTotal: mem.total,
      load1: this.readers.load(),
      vaultsUsed: vaults.used,
      vaultsTotal: vaults.total,
      configUsed: config.used,
      configTotal: config.total,
      opencodeUp,
    };
    this.samples.push(s);
    this.samples = this.samples.filter((x) => x.at >= at - KEEP_MS);
    if (at - this.lastCompact >= HOUR) {
      this.lastCompact = at;
      await this.compact();
    } else {
      await this.enqueue(async () => {
        await mkdir(this.opts.dir, { recursive: true });
        await appendFile(this.file, `${JSON.stringify(s)}\n`);
      });
    }
  }

  report(range: MetricsRange): MetricsReport {
    const to = this.now();
    const span = RANGE_MS[range];
    const inRange = this.samples.filter((s) => s.at >= to - span);
    let samples = inRange;
    if (inRange.length > MAX_POINTS) {
      const width = span / MAX_POINTS;
      const buckets = new Map<number, MetricsSample[]>();
      for (const s of inRange) {
        const i = Math.floor((s.at - (to - span)) / width);
        (buckets.get(i) ?? buckets.set(i, []).get(i)!).push(s);
      }
      const avg = (b: MetricsSample[], k: 'cpu' | 'memUsed' | 'load1') => b.reduce((a, s) => a + s[k], 0) / b.length;
      samples = [...buckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, b]) => ({
          ...b[b.length - 1]!,
          cpu: avg(b, 'cpu'),
          memUsed: avg(b, 'memUsed'),
          load1: avg(b, 'load1'),
        }));
    }
    return {
      samples,
      latest: this.samples[this.samples.length - 1] ?? null,
      uptimeS: Math.floor((to - this.startedAt) / 1000),
      intervalS: this.intervalMs / 1000,
    };
  }

  /** Atomic rewrite (temp file + rename) with the samples kept in memory. */
  private compact(): Promise<void> {
    const body = this.samples.map((s) => `${JSON.stringify(s)}\n`).join('');
    return this.enqueue(async () => {
      await mkdir(this.opts.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, this.file);
    });
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.writing.then(job);
    this.writing = run.catch(() => undefined);
    return run;
  }
}
