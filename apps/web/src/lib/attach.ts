// Uploads from the device: the file name and the photo preparation before the POST.

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The name an upload gets: `photo-YYYYMMDD-HHMMSS.jpg` for a camera photo, else the file's own name
 * cleaned of what breaks file names or `![[…]]` embeds. A HEIC becomes `.jpg` (it is converted first).
 * The server adds `-2`, `-3` … when the name is taken.
 */
export function uploadName(file: File, fromCamera: boolean, now: Date): string {
  const dot = file.name.lastIndexOf('.');
  let ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'heic' || ext === 'heif') ext = 'jpg';
  if (fromCamera) {
    const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    return `photo-${d}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.jpg`;
  }
  const stem = (dot > 0 ? file.name.slice(0, dot) : file.name)
    // eslint-disable-next-line no-control-regex -- control characters are what is being replaced
    .replace(/[<>:"|?*\\#^[\]\x00-\x1f]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[-. ]+$/g, '')
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  const safe = !stem ? 'file' : /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(stem) ? `${stem}-file` : stem;
  return ext ? `${safe}.${ext}` : safe;
}

/** Long edge of a prepared photo, px. */
const MAX_EDGE = 2048;
const isHeic = (f: File) => /^image\/hei[cf]$/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
const isJpeg = (f: File) => f.type === 'image/jpeg' || /\.jpe?g$/i.test(f.name);

/**
 * Makes a JPEG or HEIC photo smaller before upload: at most 2048 px on the long edge, re-encoded as
 * JPEG 0.85, which also drops its metadata (GPS location). Everything else is passed through as it is.
 */
export async function prepare(file: File, fromCamera = false, now = new Date()): Promise<{ blob: Blob; name: string }> {
  const name = uploadName(file, fromCamera, now);
  if (!isJpeg(file) && !isHeic(file)) return { blob: file, name };
  let bmp: ImageBitmap;
  try {
    // Applies the EXIF orientation.
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(isHeic(file) ? "HEIC photos can't be converted in this browser" : `${file.name} can't be read as a photo`);
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error(`${file.name} can't be converted`);
  return { blob: stripMetadata(new Uint8Array(await blob.arrayBuffer())), name };
}

/** Drops the APP1 (Exif, XMP) and APP13 (IPTC) segments some encoders (WebKit) write into a new JPEG. */
function stripMetadata(jpg: Uint8Array): Blob {
  const keep: Uint8Array[] = [jpg.subarray(0, 2)];
  let i = 2;
  // Marker segments up to the start of scan; the rest is image data.
  while (i + 4 <= jpg.length && jpg[i] === 0xff && jpg[i + 1] !== 0xda) {
    const end = i + 2 + ((jpg[i + 2]! << 8) | jpg[i + 3]!);
    if (jpg[i + 1] !== 0xe1 && jpg[i + 1] !== 0xed) keep.push(jpg.subarray(i, end));
    i = end;
  }
  keep.push(jpg.subarray(i));
  return new Blob(keep as BlobPart[], { type: 'image/jpeg' });
}
