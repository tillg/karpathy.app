/**
 * The open_url check (import-free, so the backend tests load it): only http(s) pages can be offered. The
 * known-URL check runs before, in the known-url plugin. Nothing is fetched: the user's browser opens the
 * page when they tap the chip.
 */
export function offerUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Only http(s) pages can be opened: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http(s) pages can be opened: ${url}`);
  return `offered ${u.href}`;
}
