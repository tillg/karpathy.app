import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, VaultEvent } from '@karpathy/shared';
import { ChatTitles, cleanTitle, sameTopic, transcript } from '../src/chat-title.js';
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
    createSession: async (dir: string, t?: string) => {
      sessions.set('tmp', t ?? '');
      log.push(`create ${dir}`);
      return 'tmp';
    },
    promptSync: async (_dir: string, _id: string, input: PromptInput) => {
      prompts.push(input);
      return reply(input);
    },
    abort: async () => undefined,
    sessionExists: async (_dir: string, id: string) => sessions.has(id),
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
  const titles = new ChatTitles(store, h.harness, () => '/vaults/v', '/vaults', (_id: string, e: VaultEvent) => { h.log.push('emit'); events.push(e); }, opts.timeoutMs ?? 2000);
  return { ...h, store, titles, events };
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
  });

  it("the throwaway session runs outside the vault's directory (never in its chat list) and is deleted before the event", async () => {
    const t = await setup(2, () => 'A title');
    await t.titles.afterTurn('v', 'chat');
    expect(t.log).toEqual(['create /vaults', 'delete', 'setTitle', 'emit']);
    expect(t.sessions.has('tmp')).toBe(false);
  });

  it('an empty title model setting uses the chat model', async () => {
    const t = await setup(2, () => 'A title');
    await t.store.update((c) => { c.settings.titleModel = ''; });
    await t.titles.afterTurn('v', 'chat');
    expect(t.prompts[0]!.model).toBe('p/chat');
  });

  it('turn 10 titles the last ten turns afresh; a title with no word in common becomes a suggestion, the title stays', async () => {
    const t = await setup(10, () => 'Budget for the new kitchen', { title: 'Weekend trip planning' });
    await t.titles.afterTurn('v', 'chat');
    expect(t.sessions.get('chat')).toBe('Weekend trip planning');
    expect(t.titles.suggestion('v', 'chat')).toBe('Budget for the new kitchen');
    expect(t.events).toEqual([{ type: 'chat-title', chatId: 'chat', title: 'Weekend trip planning', titleSuggestion: 'Budget for the new kitchen' }]);
    // It survives a restart (config store).
    expect(t.store.get().titleSuggestions).toEqual({ v: { chat: 'Budget for the new kitchen' } });
  });

  it('the drift check reads only the last ten turns', async () => {
    const t = await setup(20, () => 'Budget for the new kitchen', { title: 'Weekend trip planning' });
    await t.titles.afterTurn('v', 'chat');
    expect(t.prompts[0]!.text).toContain('User: question 11');
    expect(t.prompts[0]!.text).toContain('User: question 20');
    expect(t.prompts[0]!.text).not.toMatch(/User: question 10\b/);
  });

  it("the first drift check (turn 10) leaves out the turns the title was made from (1-2): they'd pull the fresh title back to its topic", async () => {
    const t = await setup(10, () => 'Budget for the new kitchen', { title: 'Weekend trip planning' });
    await t.titles.afterTurn('v', 'chat');
    expect(t.prompts[0]!.text).toContain('User: question 3');
    expect(t.prompts[0]!.text).toContain('User: question 10');
    expect(t.prompts[0]!.text).not.toMatch(/User: question [12]\b/);
  });

  it('a fresh title on the same topic as the current one (or KEEP) stores no suggestion', async () => {
    for (const answer of ['KEEP', '"Weekend trip planning"', 'Planning the weekend', 'Weekend trips in the Alps', 'Trip ideas']) {
      const t = await setup(20, () => answer, { title: 'Weekend trip planning' });
      await t.titles.afterTurn('v', 'chat');
      expect(t.titles.suggestion('v', 'chat'), answer).toBeUndefined();
      expect(t.events, answer).toEqual([]);
    }
  });

  it('a title set meanwhile (the user renamed) is not overwritten', async () => {
    const t: Awaited<ReturnType<typeof setup>> = await setup(2, () => { t.sessions.set('chat', 'My own name'); return 'Generated'; });
    await t.titles.afterTurn('v', 'chat');
    expect(t.sessions.get('chat')).toBe('My own name');
    expect(t.events).toEqual([]);
  });

  it('a chat deleted during the drift check gets no suggestion', async () => {
    const t: Awaited<ReturnType<typeof setup>> = await setup(10, () => { t.sessions.delete('chat'); return 'Budget for the new kitchen'; }, { title: 'Weekend trip planning' });
    await t.titles.afterTurn('v', 'chat');
    expect(t.store.get().titleSuggestions).toEqual({});
  });

  it('a timeout while the throwaway session is still being created still deletes it', async () => {
    let release!: () => void;
    const t = await setup(2, () => 'x', { timeoutMs: 20 });
    const h = t.harness as unknown as { createSession: (d: string, title?: string) => Promise<string> };
    const create = h.createSession;
    h.createSession = (d, title) => new Promise((r) => { release = () => void create(d, title).then(r); });
    const done = t.titles.afterTurn('v', 'chat');
    await new Promise((r) => setTimeout(r, 50));
    release();
    await done;
    expect(t.sessions.has('tmp')).toBe(false);
  });

  it("counts only the turns up to the one that ended: a queued prompt already sent doesn't shift the count", async () => {
    const t = await setup(2, () => 'Weekend trip planning');
    const h = t.harness as unknown as { messages: () => Promise<ChatMessage[]> };
    const msgs = await h.messages();
    h.messages = async () => [...msgs, msg('user', 'queued question', 100)];
    await t.titles.afterTurn('v', 'chat', 50);
    expect(t.sessions.get('chat')).toBe('Weekend trip planning');
    expect(t.prompts[0]!.text).not.toContain('queued question');
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

describe('sameTopic', () => {
  it('needs at least half of the fresh title\'s significant words (4+ letters, first four compared) in the current one', () => {
    expect(sameTopic('Balcony tomato tips', 'Growing tomatoes on balcony')).toBe(true);
    expect(sameTopic('Planning the weekend', 'Weekend trip planning')).toBe(true);
    expect(sameTopic('Trip ideas', 'Weekend trip planning')).toBe(true);
    expect(sameTopic('Tipps für den Garten', 'Gartenplanung im Herbst')).toBe(true);
    // A generic word alone ("tips") doesn't make it the same topic.
    expect(sameTopic('Sourdough Bread Tips', 'Tomato Growing Tips')).toBe(false);
    expect(sameTopic('Sourdough baking basics', 'Growing tomatoes on balcony')).toBe(false);
    expect(sameTopic('How to do it', 'How to go')).toBe(true);
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
  });
});
