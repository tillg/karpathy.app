// Unsent chat attachments, remembered per chat on this device so a reload doesn't orphan their uploads.

/** A file uploaded for the next message of a chat (not sent yet). */
export interface Chip {
  path: string;
  /** From the upload: lets ✕ delete exactly that file. */
  version: string;
  mime: string;
  size: number;
}

export interface ChipDraft {
  chips: Chip[];
  /** The draft's source folder (`upload-…`), shared by all its files; null before the first upload. */
  folder: string | null;
}

const key = (vault: string, chat: string) => `karpathy.chips:${vault}:${chat}`;
const EMPTY: ChipDraft = { chips: [], folder: null };

export function loadChips(vault: string, chat: string): ChipDraft {
  try {
    const raw = localStorage.getItem(key(vault, chat));
    const d = raw ? (JSON.parse(raw) as ChipDraft) : null;
    return d && Array.isArray(d.chips) ? { chips: d.chips, folder: d.folder ?? null } : EMPTY;
  } catch { return EMPTY; }
}

export function saveChips(vault: string, chat: string, d: ChipDraft) {
  try {
    if (d.chips.length) localStorage.setItem(key(vault, chat), JSON.stringify(d));
    else localStorage.removeItem(key(vault, chat));
  } catch { /* not remembered */ }
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The device's local time as `YYYY-MM-DD-HHMMSS`: names a new source folder (`upload-<at>`). */
export const localStamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
