import { expect, it } from 'vitest';
import { promptBody } from './api';
import { clientContext, tabId } from './client-context';

// What every prompt tells the backend about the tab that sent it (#151): the tab id (the answering tab of browser
// calls), the time zone and the locale (the hidden local-time line).

class MemStore {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
}

it('the tab id is created once per storage and kept (a reload keeps sessionStorage)', () => {
  const s = new MemStore();
  const id = tabId(s);
  expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  expect(tabId(s)).toBe(id);
  expect(tabId(new MemStore())).not.toBe(id);
});

it('a storage that throws (blocked, private mode) still gives an id: prompts never fail over the tab id', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  expect(tabId(broken)).toMatch(/^[A-Za-z0-9-]{8,64}$/);
});

it('the id needs no secure context: it comes from getRandomValues, not randomUUID', () => {
  const randomUUID = crypto.randomUUID;
  try {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    expect(tabId(new MemStore())).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  } finally {
    Object.defineProperty(crypto, 'randomUUID', { value: randomUUID, configurable: true });
  }
});

it('the client context is the tab id, the browser time zone and locale', () => {
  const s = new MemStore();
  expect(clientContext(s)).toEqual({
    tabId: tabId(s),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
  });
});

it('every prompt body carries the client context', () => {
  const ctx = { tabId: 'tab-12345678', timeZone: 'Europe/Berlin', locale: 'de-DE' };
  expect(promptBody('hi', undefined, undefined, ctx)).toEqual({ text: 'hi', ...ctx });
  expect(promptBody('/research x', ['a.png'], { path: 'Home.md', mode: 'read', unsaved: false }, ctx)).toEqual({
    text: '/research x',
    attachments: ['a.png'],
    openPage: { path: 'Home.md', mode: 'read', unsaved: false },
    ...ctx,
  });
});
