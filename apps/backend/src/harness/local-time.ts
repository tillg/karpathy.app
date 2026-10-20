/** The backend's own zone: the `timezone` setting, which reaches the container as `TZ`. */
const ownZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const validZone = (z: string | undefined): z is string => {
  if (!z) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

/** A BCP 47 language tag as Intl knows it, else undefined: the locale is free text from the browser. */
const validLocale = (l: string | undefined) => {
  try {
    return l ? Intl.getCanonicalLocales(l)[0] : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The hidden line every prompt carries (#151): the user's local time at `now`, in the time zone the browser sent.
 * Without a valid zone (headless ingest, an old PWA): the backend's own zone.
 */
export function localTimeLine(now: Date, timeZone?: string, locale?: string): string {
  const zone = validZone(timeZone) ? timeZone : ownZone();
  const tag = validLocale(locale);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const offset = parts.timeZoneName === 'GMT' ? 'UTC+00:00' : parts.timeZoneName!.replace('GMT', 'UTC');
  const time = `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return (
    `User's local time: ${time}, ${zone} (${offset})${tag ? `, locale ${tag}` : ''}. ` +
    "(Context from the app, not part of the user's message: use it for 'today', 'now' and dates in note names " +
    'instead of the server date; do not mention it unless asked.)'
  );
}
