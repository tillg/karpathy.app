// Media files the app shows inline (embeds, media viewer) and the Content-Type the raw route serves.

export type MediaKind = 'image' | 'video' | 'audio';

export const MEDIA: Record<string, { kind: MediaKind; type: string }> = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' },
  webp: { kind: 'image', type: 'image/webp' },
  avif: { kind: 'image', type: 'image/avif' },
  bmp: { kind: 'image', type: 'image/bmp' },
  svg: { kind: 'image', type: 'image/svg+xml' },
  mp4: { kind: 'video', type: 'video/mp4' },
  webm: { kind: 'video', type: 'video/webm' },
  mov: { kind: 'video', type: 'video/quicktime' },
  m4v: { kind: 'video', type: 'video/x-m4v' },
  ogv: { kind: 'video', type: 'video/ogg' },
  mp3: { kind: 'audio', type: 'audio/mpeg' },
  m4a: { kind: 'audio', type: 'audio/mp4' },
  wav: { kind: 'audio', type: 'audio/wav' },
  ogg: { kind: 'audio', type: 'audio/ogg' },
  flac: { kind: 'audio', type: 'audio/flac' },
  opus: { kind: 'audio', type: 'audio/ogg; codecs=opus' },
};

/** Media kind by file extension (case-insensitive); null for anything else, PDF included. */
export function mediaKind(path: string): MediaKind | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return Object.hasOwn(MEDIA, name.slice(dot + 1).toLowerCase()) ? MEDIA[name.slice(dot + 1).toLowerCase()]!.kind : null;
}

const extOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/** `.pdf`: shown as a file card with Open (the browser's viewer), never inline. */
export const isPdf = (path: string) => extOf(path) === 'pdf';

/** How `GET /raw` serves a file: the Content-Type, and whether it is only ever downloaded (everything that isn't media). */
export function rawType(path: string): { type: string; attachment: boolean } {
  const ext = extOf(path);
  if (Object.hasOwn(MEDIA, ext)) return { type: MEDIA[ext]!.type, attachment: false };
  return { type: ext === 'pdf' ? 'application/pdf' : 'application/octet-stream', attachment: true };
}

/** Files the user may upload (editor, chat): what opencode reads as an image or PDF and model providers accept. */
export const UPLOADABLE = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'] as const;
/** Server cap per upload (413 above). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** The browser asks before an upload above this: it stays in the git history for good. */
export const WARN_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Per chat attachment (keeps the base64 request under provider limits). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Chat attachments per prompt. */
export const MAX_ATTACHMENTS = 5;

export const isUploadable = (path: string) => (UPLOADABLE as readonly string[]).includes(extOf(path));

/** Content type of an uploadable file, by extension. */
export const uploadMime = (path: string) => (isPdf(path) ? 'application/pdf' : rawType(path).type);
