import type { PromptClient } from '@karpathy/shared';

const KEY = 'karpathy.tab';

/** getRandomValues works outside a secure context too (a dev stack over plain http), unlike randomUUID. */
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** The id when sessionStorage can't be used (blocked, private mode): lives as long as the page. */
let pageId: string | undefined;

/** This tab's id (#151): kept in sessionStorage, so a reload keeps it and a new tab gets its own. */
export function tabId(store?: Pick<Storage, 'getItem' | 'setItem'>): string {
  try {
    // Even reading `sessionStorage` can throw (storage blocked): inside the try.
    const s = store ?? sessionStorage;
    let id = s.getItem(KEY);
    if (!id) s.setItem(KEY, (id = newId()));
    return id;
  } catch {
    return (pageId ??= newId());
  }
}

export type ClientContext = Required<PromptClient>;

/** What every prompt tells the backend about the tab that sent it: the answering tab, its time zone and locale. */
export const clientContext = (store?: Pick<Storage, 'getItem' | 'setItem'>): ClientContext => ({
  tabId: tabId(store),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: navigator.language,
});
