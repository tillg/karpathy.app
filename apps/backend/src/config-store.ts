import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OpenPage, PromptClient, Settings, VaultConfig } from '@karpathy/shared';

export interface StoredVault extends VaultConfig {
  /** True once the clone finished; a vault without it is (re)cloned on startup. */
  cloned: boolean;
  cloneError?: string;
  /** Required folders the user agreed to create; written as `<folder>/.gitkeep` once the clone is done. */
  pendingFolders?: string[];
}

export interface EditStamp {
  ai?: number;
  human?: number;
}

export interface ConfigData {
  vaults: StoredVault[];
  settings: Settings;
  /** Per-vault AI-touched set (vault-relative paths), mvp §2.4. */
  aiTouched: Record<string, string[]>;
  /** Per-vault, per-path time (epoch ms) the AI / a person last wrote the file through the app (#122); kept across commits. */
  editStamps: Record<string, Record<string, EditStamp>>;
  /** Per-vault unresolved Conflict paths (repo-relative), kept while the pull stash exists. */
  conflicts: Record<string, string[]>;
  /** Per-vault queued chat prompts, so a backend restart doesn't drop them (#37). */
  queued: Record<string, ({ id?: string; chatId: string; text: string; attachments?: string[]; openPage?: OpenPage | null } & PromptClient)[]>;
  /** Per-vault, per-chat title suggestion of a drift check (#148), until the user renames or keeps. */
  titleSuggestions: Record<string, Record<string, string>>;
  /** GitHub token set in the app; kept out of `settings`, which GET /settings returns verbatim. */
  githubToken?: string;
}

/** Fallbacks below the deployment's settings (deploy/settings/, passed to `open`). */
export const DEFAULT_SETTINGS: Settings = {
  commitReminderThreshold: 4,
  model: '',
  titleModel: '',
  visionModel: '',
  webAccess: true,
};

/** The model settings, each stored only as an override of the deployment's default, under this key. */
const OVERRIDES = { model: 'modelOverride', titleModel: 'titleModelOverride', visionModel: 'visionModelOverride' } as const;
type ModelKey = keyof typeof OVERRIDES;

/** `settings` as stored: the models only as overrides of the deployment's defaults. */
type StoredSettings = Partial<Omit<Settings, ModelKey>> & { [K in ModelKey as (typeof OVERRIDES)[K]]?: string } & {
  /** Before the model default moved to the settings files, the model itself was stored. */
  model?: string;
};

/**
 * The backend-only config store: one JSON file on the config volume. Writes go to a temp
 * file first and are renamed into place, so a crash mid-write leaves the old file intact.
 */
export class ConfigStore {
  private data!: ConfigData;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    /** The deployment's defaults (deploy/settings/); a model the Admin picks is stored only if it differs from its default. */
    readonly defaults: Settings,
  ) {}

  static async open(dir: string, defaults: Partial<Settings> = {}): Promise<ConfigStore> {
    const base = { ...DEFAULT_SETTINGS, ...defaults };
    const store = new ConfigStore(join(dir, 'config.json'), base);
    let raw: Partial<Omit<ConfigData, 'settings'>> & { settings?: StoredSettings } = {};
    try {
      raw = JSON.parse(await readFile(store.file, 'utf8')) as typeof raw;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    store.data = {
      vaults: raw.vaults ?? [],
      settings: store.withOverride(raw.settings ?? {}, base),
      aiTouched: raw.aiTouched ?? {},
      editStamps: raw.editStamps ?? {},
      conflicts: raw.conflicts ?? {},
      queued: raw.queued ?? {},
      titleSuggestions: raw.titleSuggestions ?? {},
      ...(raw.githubToken ? { githubToken: raw.githubToken } : {}),
    };
    return store;
  }

  /** Stored settings over the defaults; each model is its override, else the default. */
  private withOverride({ modelOverride, titleModelOverride, visionModelOverride, model, ...rest }: StoredSettings, base: Settings): Settings {
    return { ...base, ...rest, model: modelOverride ?? model ?? base.model, titleModel: titleModelOverride ?? base.titleModel, visionModel: visionModelOverride ?? base.visionModel };
  }

  /** What goes to disk: each model only while it differs from its default. */
  private stored(settings: Settings): StoredSettings {
    const out: Record<string, unknown> = { ...settings };
    for (const [key, override] of Object.entries(OVERRIDES) as [ModelKey, string][]) {
      delete out[key];
      if (settings[key] !== this.defaults[key]) out[override] = settings[key];
    }
    return out as StoredSettings;
  }

  get(): Readonly<ConfigData> {
    return this.data;
  }

  /** Applies `fn` to a copy of the data and persists it atomically. */
  async update(fn: (d: ConfigData) => void): Promise<void> {
    const next = structuredClone(this.data);
    fn(next);
    // Applied in memory right away so concurrent updates build on each other.
    this.data = next;
    const snapshot = JSON.stringify({ ...next, settings: this.stored(next.settings) }, null, 2);
    // Serialize writes; a failed one must not reject every later update.
    const write = this.writing.catch(() => undefined).then(() => this.write(snapshot));
    this.writing = write;
    await write;
  }

  private async write(json: string) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, json);
    await rename(tmp, this.file);
  }
}
