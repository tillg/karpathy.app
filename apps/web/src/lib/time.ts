/** When a chat had its last entry (#140): the time today, else the date (with the year when it isn't this one) and the time. */
export function chatTime(t: number, now = Date.now(), locale: string | string[] = []): string {
  const d = new Date(t);
  const n = new Date(now);
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString(locale, time);
  return d.toLocaleString(locale, { month: 'short', day: 'numeric', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}), ...time });
}
