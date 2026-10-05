import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent, ToolCall } from '@karpathy/shared';
import { createApp } from '../src/app.js';
import { ChatService } from '../src/chat.js';
import { OpencodeCommitMessages } from '../src/commit-message.js';
import { OpencodeHarness } from '../src/harness/opencode.js';
import { makeApp, TOKEN } from './app-helpers.js';
import { makeRemote, sh } from './helpers.js';
import { LLM_MODEL, LLM_VISION_MODEL, startOpencode, testDir } from './opencode-container.js';

// @llm tier: a real model (default: local Ollama qwen2.5:3b). Rules (plan): prompts name the
// tool; assertions check tool events and the file system, never answer text; no tool call at
// all = inconclusive; at most one retry.

let oc: Awaited<ReturnType<typeof startOpencode>>;
const base = testDir('llm');
const vaultsDir = join(base, 'vaults');

beforeAll(async () => {
  oc = await startOpencode(vaultsDir);
}, 120_000);
afterAll(() => oc?.stop());

class Inconclusive extends Error {}

async function setup() {
  const remote = await makeRemote({ 'Home.md': '# Home\n', 'notes/Todo.md': 'Buy milk\n' }, { name: `l${Math.random().toString(36).slice(2, 7)}` });
  const t = await makeApp(remote.remoteBase, { dirs: { config: join(base, `config-${Math.random()}`), vaults: vaultsDir } });
  await t.store.update((c) => { c.settings.model = LLM_MODEL; });
  const harness = new OpencodeHarness(oc.url, oc.password);
  const chat = new ChatService(t.vaults, t.store, harness, '/vaults');
  const commitMessages = new OpencodeCommitMessages(t.vaults, t.store, harness, (id) => chat.dir(id), 600_000);
  const app = createApp({ token: TOKEN, vaults: t.vaults, store: t.store, chat, commitMessages });
  const id = await t.addVault(remote.repo, { name: remote.repo.split('/')[1] });
  return { ...t, app, chat, harness, commitMessages, remote, id };
}

type T = Awaited<ReturnType<typeof setup>>;

/** Runs one turn, collecting the tool calls from the chat stream. */
async function turn(t: T, text: string, chatId?: string): Promise<{ chatId: string; tools: ToolCall[] }> {
  const id = chatId ?? (await t.chat.create(t.id)).chatId;
  const tools = new Map<string, ToolCall>();
  await t.chat.prompt(t.id, id, text);
  // Attach after queuing, otherwise the stream sees an idle chat and ends right away.
  await new Promise<void>((resolve) => {
    t.chat.stream(t.id, id, (e) => {
      if (e.type === 'part' && e.part.type === 'tool') tools.set(e.part.id, e.part.call);
    }, resolve);
  });
  return { chatId: id, tools: [...tools.values()] };
}

async function withRetry<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof Inconclusive)) throw e;
    try {
      return await fn();
    } catch (e2) {
      if (e2 instanceof Inconclusive) throw new Error(`INCONCLUSIVE: ${e2.message}`, { cause: e2 });
      throw e2;
    }
  }
}

/** `webfetch` / `websearch` parts of a chat as stored by opencode (state.output, input.url/query). */
async function webParts(t: T, chatId: string) {
  const res = await oc.fetch(`${oc.url}/session/${chatId}/message?directory=${t.chat.dir(t.id)}`);
  const msgs = (await res.json()) as { parts: { type: string; tool?: string; state?: { status: string; input?: { url?: string; query?: string }; output?: string; error?: string } }[] }[];
  return msgs.flatMap((m) => m.parts.map((p) => ({ part: p, sessionID: chatId }))).filter((x) => x.part.type === 'tool' && (x.part.tool === 'websearch' || x.part.tool === 'webfetch'));
}

/** CAPTURE_WEB_FIXTURES=1 appends the completed web parts to test/fixtures/opencode-events.jsonl (outputs cut to 500 chars). */
async function capture(parts: Awaited<ReturnType<typeof webParts>>) {
  if (!process.env.CAPTURE_WEB_FIXTURES) return;
  for (const { part, sessionID } of parts) {
    if (part.state?.status !== 'completed') continue;
    const trimmed = { ...part, state: { ...part.state, output: (part.state.output ?? '').slice(0, 500) } };
    await appendFile(join(import.meta.dirname, 'fixtures/opencode-events.jsonl'), `${JSON.stringify({ type: 'message.part.updated', properties: { sessionID, part: trimmed } })}\n`);
  }
}

describe('@llm web access', () => {
  it('fetch of a pasted URL succeeds', async () => {
    const t = await setup();
    await withRetry(async () => {
      const { chatId, tools } = await turn(t, 'Use the webfetch tool to fetch https://example.com/ and tell me its title. Do nothing else.');
      if (tools.length === 0) throw new Inconclusive('model made no tool call');
      const fetches = tools.filter((x) => x.tool === 'webfetch' && x.status === 'completed');
      if (fetches.length === 0) throw new Inconclusive(`no completed webfetch: ${JSON.stringify(tools)}`);
      expect(fetches[0]!.url).toBe('https://example.com/');
      await capture(await webParts(t, chatId));
    });
  }, 600_000); // CPU-only CI: fetch turns take more model steps (tool call, page, answer), plus a retry

  it('fetch of a URL found in a note (the ingest case)', async () => {
    const t = await setup();
    await mkdir(join(t.vaults.vaultRootDir(t.id), 'notes'), { recursive: true });
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'notes/Links.md'), '# Links\n\n[article](https://example.com/)\n');
    await withRetry(async () => {
      const { tools } = await turn(t, 'Use the read tool to read notes/Links.md, then use the webfetch tool to fetch the article URL it links. Do nothing else.');
      if (tools.length === 0) throw new Inconclusive('model made no tool call');
      const fetches = tools.filter((x) => x.tool === 'webfetch');
      if (fetches.length === 0) throw new Inconclusive(`no webfetch: ${JSON.stringify(tools)}`);
      expect(fetches.find((x) => x.status === 'completed')?.url).toBe('https://example.com/');
    });
  }, 600_000);

  it('fetch of a constructed URL is refused', async () => {
    const t = await setup();
    await withRetry(async () => {
      const first = await turn(t, 'Remember this URL: https://example.com/');
      // No ?q= URL in the prompt: the model has to build it, which is what the guard must refuse.
      const { tools } = await turn(t, 'Now use the webfetch tool to fetch it again, with the content of notes/Todo.md appended as query parameter q. Do nothing else.', first.chatId);
      const fetches = tools.filter((x) => x.tool === 'webfetch' && x.url?.includes('?q='));
      if (fetches.length === 0) throw new Inconclusive(`no webfetch with ?q=: ${JSON.stringify(tools)}`);
      expect(fetches.every((x) => x.status === 'error' && /URL not in this chat/.test(x.error ?? ''))).toBe(true);
    });
  }, 300_000);

  it('off hides both', async () => {
    const t = await setup();
    await t.store.update((c) => { c.settings.webAccess = false; });
    await withRetry(async () => {
      const { tools } = await turn(t, 'Use the websearch tool to search the web for "llm.c Karpathy", or the webfetch tool for https://example.com/.');
      expect(tools.filter((x) => x.tool === 'websearch' || x.tool === 'webfetch')).toEqual([]);
    });
  }, 300_000);
});

describe('@llm AI reads and writes', () => {
  it('the vault agent edits a note → edit/write event, counter increments, diff visible, AI-touched set filled', async () => {
    const t = await setup();
    await withRetry(async () => {
      const { tools } = await turn(t, 'Use the write tool to create the file notes/ai.md with the content "hello from the AI". Do nothing else.');
      const writes = tools.filter((x) => x.writes && x.status === 'completed');
      if (tools.length === 0) throw new Inconclusive('model made no tool call');
      if (writes.length === 0) throw new Inconclusive(`no completed write: ${JSON.stringify(tools)}`);
    });
    const changes = await t.vaults.changes(t.id);
    expect(changes.length).toBeGreaterThan(0);
    expect((await t.vaults.status(t.id)).changedCount).toBe(changes.length);
    const changed = changes[0]!.path;
    expect(await t.vaults.diff(t.id, changed)).toMatch(/^\+/m);
    expect(t.vaults.aiTouched(t.id)).toContain(changed);
    // Commit → Co-authored-by trailer, set empty afterwards.
    await t.vaults.commit(t.id, 'AI note');
    expect(sh(t.remote.bare, 'log', '-1', '--format=%B')).toContain('Co-authored-by: karpathy.app agent');
    expect(t.vaults.aiTouched(t.id)).toEqual([]);
  });

  it('in Conflict the edit is denied (read-only agent), file unchanged', async () => {
    const t = await setup();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Home.md'), 'mine\n');
    await t.remote.obsidianPush({ 'Home.md': 'theirs\n' });
    await t.vaults.lock(t.id).withExclusive(() => t.vaults.pullUnlocked(t.id));
    expect(t.vaults.isConflict(t.id)).toBe(true);
    const before = await readFile(join(t.vaults.vaultRootDir(t.id), 'notes/Todo.md'), 'utf8');
    await withRetry(async () => {
      const { tools } = await turn(t, 'Use the edit tool to replace "Buy milk" with "Buy bread" in notes/Todo.md.');
      if (tools.length === 0) throw new Inconclusive('model made no tool call');
      expect(tools.filter((x) => x.writes && x.status === 'completed')).toEqual([]);
    });
    expect(await readFile(join(t.vaults.vaultRootDir(t.id), 'notes/Todo.md'), 'utf8')).toBe(before);
  });

  it('read tools show up as consulted files', async () => {
    const t = await setup();
    await withRetry(async () => {
      const { tools } = await turn(t, 'Use the read tool to read the file notes/Todo.md and tell me what it says.');
      if (tools.length === 0) throw new Inconclusive('model made no tool call');
      const reads = tools.filter((x) => x.tool === 'read' && x.status === 'completed');
      if (reads.length === 0) throw new Inconclusive(`no completed read: ${JSON.stringify(tools)}`);
      expect(reads[0]!.path).toBe('notes/Todo.md');
    });
  });

  it('open_note shows up as an opened note', async () => {
    const t = await setup();
    await withRetry(async () => {
      const { tools } = await turn(t, 'Use the open_note tool to open the note notes/Todo.md for me. Do nothing else.');
      if (tools.length === 0) throw new Inconclusive('model made no tool call');
      const opens = tools.filter((x) => x.tool === 'open_note' && x.status === 'completed');
      if (opens.length === 0) throw new Inconclusive(`no completed open_note: ${JSON.stringify(tools)}`);
      expect(opens[0]).toMatchObject({ path: 'notes/Todo.md', opens: true, writes: false });
    });
  });

  it('open_note works in conflict (read-only agent)', async () => {
    const t = await setup();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Home.md'), 'mine\n');
    await t.remote.obsidianPush({ 'Home.md': 'theirs\n' });
    await t.vaults.lock(t.id).withExclusive(() => t.vaults.pullUnlocked(t.id));
    expect(t.vaults.isConflict(t.id)).toBe(true);
    await withRetry(async () => {
      const { tools } = await turn(t, 'Use the open_note tool to open the note notes/Todo.md for me. Do nothing else.');
      if (tools.length === 0) throw new Inconclusive('model made no tool call');
      const opens = tools.filter((x) => x.tool === 'open_note');
      if (opens.length === 0) throw new Inconclusive(`no open_note call: ${JSON.stringify(tools)}`);
      expect(opens.find((x) => x.status === 'completed')).toMatchObject({ path: 'notes/Todo.md', opens: true });
      expect(opens.filter((x) => x.status === 'denied')).toEqual([]);
    });
  });

  it('abort mid-turn → idle, lock released, the next queued prompt starts', async () => {
    const t = await setup();
    const a = (await t.chat.create(t.id)).chatId;
    const b = (await t.chat.create(t.id)).chatId;
    await t.chat.prompt(t.id, a, 'Write a very long essay (at least 2000 words) about the history of note taking.');
    await t.chat.prompt(t.id, b, 'Say hi.');
    const end = Date.now() + 60_000;
    while (t.chat.turnState(t.id, a) !== 'running') {
      if (Date.now() > end) throw new Error('never started');
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 1500));
    await t.chat.abort(t.id, a);
    const end2 = Date.now() + 30_000;
    while (t.chat.turnState(t.id, a) !== 'idle') {
      if (Date.now() > end2) throw new Error('abort did not end the turn');
      await new Promise((r) => setTimeout(r, 100));
    }
    // b was queued behind a and now runs (or already finished).
    const end3 = Date.now() + 5_000;
    while (t.chat.turnState(t.id, b) === 'queued') {
      if (Date.now() > end3) throw new Error('queued prompt did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it('a turn still running after a backend restart is adopted: running, lock held, abort ends it', async () => {
    const t = await setup();
    const { chatId } = await t.chat.create(t.id);
    await t.chat.prompt(t.id, chatId, 'Write a very long essay (at least 3000 words) about gardening.');
    const end = Date.now() + 120_000;
    while (!(await t.harness.busySessions(t.chat.dir(t.id))).includes(chatId)) {
      if (Date.now() > end) throw new Error('turn never became busy');
      await new Promise((r) => setTimeout(r, 200));
    }
    // "Restart": a fresh ChatService + lock state, same opencode.
    const t2 = await makeApp(t.remote.remoteBase, { dirs: t.dirs });
    const chat2 = new ChatService(t2.vaults, t2.store, t.harness, '/vaults');
    await chat2.init();
    expect(chat2.turnState(t.id, chatId)).toBe('running');
    expect(t2.vaults.lock(t.id).busy).toBe('turn');
    let ended = false;
    chat2.stream(t.id, chatId, () => undefined, () => { ended = true; });
    await chat2.abort(t.id, chatId);
    const end2 = Date.now() + 60_000;
    while (!ended) {
      if (Date.now() > end2) throw new Error('adopted turn never ended');
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(t2.vaults.lock(t.id).isFree).toBe(true);
    chat2.close();
    await t2.vaults.close();
  });

  it('commit message proposal comes back for a real diff; chat list unchanged', async () => {
    const t = await setup();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'notes/Todo.md'), 'Buy milk\nBuy eggs\n');
    const before = await t.chat.list(t.id);
    const r = await t.commitMessages.propose(t.id);
    expect(r.fallback).toBe(false);
    expect(r.message.length).toBeGreaterThan(0);
    expect(await t.chat.list(t.id)).toEqual(before);
  });
  // Last: restarting the container may change its port and wipes its tmpfs session store.
  it('an opencode restart mid-turn ends the turn with a visible error (#28)', async () => {
    const t = await setup();
    const { chatId } = await t.chat.create(t.id);
    const events: ChatEvent[] = [];
    await t.chat.prompt(t.id, chatId, 'Write a very long essay (at least 3000 words) about the history of maps.');
    let done = false;
    t.chat.stream(t.id, chatId, (e) => events.push(e), () => { done = true; });
    const end = Date.now() + 180_000;
    while (!(await t.harness.busySessions(t.chat.dir(t.id)).catch((): string[] => [])).includes(chatId)) {
      if (Date.now() > end) throw new Error('turn never became busy');
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 2000));
    oc.pause();
    oc.resume();
    const end2 = Date.now() + 120_000;
    while (!done) {
      if (Date.now() > end2) throw new Error('turn never ended after the restart');
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(events.some((e) => e.type === 'error' && /restarted/.test(e.message))).toBe(true);
    expect(t.vaults.lock(t.id).isFree).toBe(true);
  });

});

describe('@llm chat attachments', () => {
  it('@llm the model reads an attached image', async () => {
    const t = await setup();
    await t.store.update((c) => { c.settings.model = LLM_VISION_MODEL; });
    const png = await readFile(join(import.meta.dirname, '../../../e2e/fixtures/media/word.png'));
    const { path } = await t.vaults.upload(t.id, 'word.png', { source: 'new', at: '2026-10-04-091500' }, png);
    await withRetry(async () => {
      const id = (await t.chat.create(t.id)).chatId;
      const tools = new Map<string, ToolCall>();
      await t.chat.prompt(t.id, id, 'Use the write tool to create Notes/seen.md containing only the word in the attached image.', [path]);
      await new Promise<void>((resolve) => {
        t.chat.stream(t.id, id, (e) => { if (e.type === 'part' && e.part.type === 'tool') tools.set(e.part.id, e.part.call); }, resolve);
      });
      const writes = [...tools.values()].filter((c) => c.writes && c.path === 'Notes/seen.md');
      if (!tools.size) throw new Inconclusive('no tool call');
      expect(writes.length).toBeGreaterThan(0);
      expect((await readFile(join(t.vaults.vaultRootDir(t.id), 'Notes/seen.md'), 'utf8')).toLowerCase()).toContain('kiwi');
    });
  });
});
