import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, VaultEvent } from '@karpathy/shared';
import { ChatTitles, cleanTitle, transcript } from '../src/chat-title.js';
import { ConfigStore } from '../src/config-store.js';
import type { Harness, PromptInput } from '../src/harness/opencode.js';

const msg = (role: 'user' | 'assistant', text: string, i: number): ChatMessage => ({ id: `m${i}`, role, parts: [{ type: 'text', id: `p${i}`, text }], createdAt: i });

/** A chat of `turns` user messages, each answered. */
const chatOf = (turns: number) => Array.from({ length: turns }, (_, i) => [msg('user', `question ${i + 1}`, 2 * i), msg('assistant', `answer ${i + 1}`, 2 * i + 1)]).flat();

/** Only what ChatTitles uses; `reply` answers the title prompt. */
function fakeHarness(messages: ChatMessage[], reply: (input: PromptInput) => Promise<string> | string, title = 'question 1') {
  const log: string[] = [];
  const prompts: PromptInput[] = [];
  const sessions = new Map<string, string>([['chat', title]]);
  const harness = {
    messages: async () => messages,
    listSessions: async () => [...sessions].map(([id, t]) => ({ id, title: t, updatedAt: 0 })),
    createSession: async (_dir: string, t?: string) => {
      sessions.set('tmp', t ?? '');
      log.push('create');
      return 'tmp';
    },
    promptSync: async (_dir: string, _id: string, input: PromptInput) => {
      prompts.push(input);
      return reply(input);
    },
    abort: async () => undefined,
    deleteSession: async (_dir: string, id: string) => {
      sessions.delete(id);
      log.push('delete');
    },
    setTitle: async (_dir: string, id: string, t: string) => {
      sessions.set(id, t);
      log.push('setTitle');
    },
  } as unknown as Harness;
  return { harness, log, prompts, sessions };
}

async function setup(turns: number, reply: (input: PromptInput) => Promise<string> | string, opts: { title?: string; timeoutMs?: number } = {}) {
  const store = await ConfigStore.open(await mkdtemp(join(tmpdir(), 'titles-')), { model: 'p/chat', titleModel: 'p/title' });
  const h = fakeHarness(chatOf(turns), reply, opts.title);
  const events: VaultEvent[] = [];
  let proposing = 0;
  const vaults = { proposing: async <T>(_id: string, fn: () => Promise<T>) => { proposing++; return fn(); }, harnessConfigIn: () => null };
  const titles = new ChatTitles(vaults, store, h.harness, () => '/vaults/v', (_id, e) => { h.log.push('emit'); events.push(e); }, opts.timeoutMs ?? 2000);
  return { ...h, store, titles, events, proposing: () => proposing };
}

describe('ChatTitles.afterTurn', () => {
  it('turn 2 sets a generated title with the title model and the chat-title agent', async () => {
    const t = await setup(2, () => 'Weekend trip planning');
    await t.titles.afterTurn('v', 'chat');
    expect(t.sessions.get('chat')).toBe('Weekend trip planning');
    expect(t.prompts[0]).toMatchObject({ agent: 'chat-title', model: 'p/title' });
    expect(t.prompts[0]!.text).toContain('question 2');
    expect(t.prompts[0]!.text).toContain('answer 1');
    expect(t.events).toEqual([{ type: 'chat-title', chatId: 'chat', title: 'Weekend trip planning' }]);
    expect(t.proposing()).toBe(1);
  });

  it('the throwaway session is deleted before the event, so a list reload never shows it', async () => {
    const t = await setup(2, () => 'A title');
    await t.titles.afterTurn('v', 'chat');
    expect(t.log).toEqual(['create', 'delete', 'setTitle', 'emit']);
    expect(t.sessions.has('tmp')).toBe(false);
  });

  it('an empty title model setting uses the chat model', async () => {
    const t = await setup(2, () => 'A title');
    await t.store.update((c) => { c.settings.titleModel = ''; });
    await t.titles.afterTurn('v', 'chat');
    expect(t.prompts[0]!.model).toBe('p/chat');
  });

  it('turn 10 stores a suggestion and keeps the title', async () => {
    const t = await setup(10, () => 'Budget for the new kitchen', { title: 'Weekend trip planning' });
    await t.titles.afterTurn('v', 'chat');
    expect(t.sessions.get('chat')).toBe('Weekend trip planning');
    expect(t.titles.suggestion('v', 'chat')).toBe('Budget for the new kitchen');
    expect(t.prompts[0]!.text).toContain('Current title: Weekend trip planning');
    expect(t.events).toEqual([{ type: 'chat-title', chatId: 'chat', title: 'Weekend trip planning', titleSuggestion: 'Budget for the new kitchen' }]);
    // It survives a restart (config store).
    expect(t.store.get().titleSuggestions).toEqual({ v: { chat: 'Budget for the new kitchen' } });
  });

  it('KEEP or the same title stores no suggestion', async () => {
    for (const answer of ['KEEP', 'keep.', '"Weekend trip planning"']) {
      const t = await setup(20, () => answer, { title: 'Weekend trip planning' });
      await t.titles.afterTurn('v', 'chat');
      expect(t.titles.suggestion('v', 'chat'), answer).toBeUndefined();
      expect(t.events, answer).toEqual([]);
    }
  });

  it('turns 1, 3, 9 and 11 do nothing', async () => {
    for (const n of [1, 3, 9, 11]) {
      const t = await setup(n, () => 'x');
      await t.titles.afterTurn('v', 'chat');
      expect(t.prompts, String(n)).toEqual([]);
    }
  });

  it('a failing or slow model keeps the title, quietly', async () => {
    const failing = await setup(2, () => { throw new Error('model down'); });
    await failing.titles.afterTurn('v', 'chat');
    expect(failing.sessions.get('chat')).toBe('question 1');
    expect(failing.sessions.has('tmp')).toBe(false);
    const slow = await setup(2, () => new Promise<string>(() => undefined), { timeoutMs: 50 });
    await slow.titles.afterTurn('v', 'chat');
    expect(slow.sessions.get('chat')).toBe('question 1');
    expect(slow.sessions.has('tmp')).toBe(false);
    expect([...failing.events, ...slow.events]).toEqual([]);
  });

  it('rename sets the title and drops the suggestion; dismiss only drops it; forget drops the chat', async () => {
    const t = await setup(10, () => 'New one', { title: 'Old one' });
    await t.titles.afterTurn('v', 'chat');
    await t.titles.rename('v', 'chat', '  New one  ');
    expect(t.sessions.get('chat')).toBe('New one');
    expect(t.titles.suggestion('v', 'chat')).toBeUndefined();
    expect(t.events.at(-1)).toEqual({ type: 'chat-title', chatId: 'chat', title: 'New one' });
    await t.titles.afterTurn('v', 'chat');
    await t.titles.dismiss('v', 'chat');
    expect(t.titles.suggestion('v', 'chat')).toBeUndefined();
    expect(t.sessions.get('chat')).toBe('New one');
    await t.store.update((c) => { c.titleSuggestions = { v: { chat: 'x', other: 'y' } }; });
    await t.titles.forget('v', 'chat');
    expect(t.store.get().titleSuggestions).toEqual({ v: { other: 'y' } });
    await t.titles.forget('v');
    expect(t.store.get().titleSuggestions).toEqual({});
  });
});

describe('cleanTitle', () => {
  it('takes the first line, drops quotes, a Title: prefix, Markdown and a trailing period, caps the length', () => {
    expect(cleanTitle('"Kitchen budget."\nBecause the chat is about…')).toBe('Kitchen budget');
    expect(cleanTitle('Title: **Kitchen budget**')).toBe('Kitchen budget');
    expect(cleanTitle('\n\n  # Küchenbudget  ')).toBe('Küchenbudget');
    expect(cleanTitle('x'.repeat(300))).toHaveLength(120);
    expect(cleanTitle('   ')).toBe('');
  });
});

describe('transcript', () => {
  it('cuts long messages and drops the oldest first to fit the cap', () => {
    const msgs = [msg('user', 'old '.repeat(2000), 0), msg('assistant', 'reply', 1), msg('user', 'newest question', 2)];
    const text = transcript(msgs, 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain('User: newest question');
    expect(text).toContain('AI: reply');
  });
});

describe('opencode.json', () => {
  it('the chat-title agent may use no tool', async () => {
    const config = JSON.parse(await readFile(new URL('../../../deploy/opencode/opencode.json', import.meta.url), 'utf8'));
    expect(config.agent['chat-title']).toMatchObject({ mode: 'primary', permission: { '*': 'deny' } });
    expect(config.agent['chat-title'].prompt).toMatch(/KEEP/);
  });
});
