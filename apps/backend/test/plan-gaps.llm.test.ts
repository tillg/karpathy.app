import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatDetail, ChatEvent } from '@karpathy/shared';
import { createApp } from '../src/app.js';
import { ChatService } from '../src/chat.js';
import { OpencodeHarness } from '../src/harness/opencode.js';
import { makeApp, TOKEN } from './app-helpers.js';
import { makeRemote } from './helpers.js';
import { LLM_MODEL, startOpencode, testDir } from './opencode-container.js';

// @llm tier: plan P4 rows "Chat API … stream contains text parts + tool parts in order" and
// "One opencode event subscription per vault … disconnect mid-turn / reconnect". Same rules as
// chat.llm.test.ts: assertions on events and state, never answer text; no tool call = inconclusive.

let oc: Awaited<ReturnType<typeof startOpencode>>;
const base = testDir('llm-gaps');
const vaultsDir = join(base, 'vaults');

beforeAll(async () => {
  oc = await startOpencode(vaultsDir);
}, 120_000);
afterAll(() => oc?.stop());

class Inconclusive extends Error {}

async function setup() {
  const remote = await makeRemote({ 'Home.md': '# Home\n', 'notes/Todo.md': 'Buy milk\n' }, { name: `g${Math.random().toString(36).slice(2, 7)}` });
  const t = await makeApp(remote.remoteBase, { dirs: { config: join(base, `config-${Math.random()}`), vaults: vaultsDir } });
  await t.store.update((c) => { c.settings.model = LLM_MODEL; });
  const chat = new ChatService(t.vaults, t.store, new OpencodeHarness(oc.url, oc.password), '/vaults');
  const app = createApp({ token: TOKEN, vaults: t.vaults, store: t.store, chat });
  const id = await t.addVault(remote.repo, { name: remote.repo.split('/')[1] });
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  /** Attaches to the chat stream over HTTP (NDJSON), like the PWA does. */
  const attach = (chatId: string) => {
    const ctrl = new AbortController();
    const events: ChatEvent[] = [];
    const done = (async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/vaults/${id}/chats/${chatId}/stream`, { headers: auth, signal: ctrl.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (end) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) events.push(JSON.parse(line));
        }
      }
    })().catch(() => undefined);
    return { events, done, disconnect: () => ctrl.abort() };
  };
  const api = {
    get: (p: string) => request(app).get(`/api${p}`).set(auth),
    post: (p: string, body?: object) => request(app).post(`/api${p}`).set(auth).send(body),
  };
  const close = () => { server.close(); chat.close(); };
  return { ...t, id, chat, api, attach, close };
}

async function until(pred: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('@llm chat stream and turn lifecycle (plan P4)', () => {
  it('the NDJSON stream carries text and tool parts in the order of the stored message', async () => {
    const t = await setup();
    try {
      const run = async () => {
        const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
        await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'Use the read tool to read the file notes/Todo.md, then tell me in one sentence what it says.' });
        const s = t.attach(chatId);
        await s.done;
        const partOrder: string[] = [];
        const kind = new Map<string, string>();
        for (const e of s.events) {
          const pid = e.type === 'part' ? e.part.id : e.type === 'text-delta' ? e.partId : null;
          if (!pid) continue;
          if (!partOrder.includes(pid)) partOrder.push(pid);
          if (e.type === 'part') kind.set(pid, e.part.type);
          else if (!kind.has(pid)) kind.set(pid, 'text');
        }
        const kinds = new Set([...kind.values()]);
        if (!kinds.has('tool')) throw new Inconclusive(`no tool part streamed: ${JSON.stringify(s.events).slice(0, 500)}`);
        if (!kinds.has('text')) throw new Inconclusive('no text part streamed');
        expect(s.events.at(-1)).toEqual({ type: 'turn', state: 'idle' });
        const detail: ChatDetail = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body;
        const stored = detail.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts.filter((p) => p.type !== 'reasoning').map((p) => p.id));
        const streamed = partOrder.filter((id) => kind.get(id) !== 'reasoning' && stored.includes(id));
        expect(streamed).toEqual(stored.filter((id) => streamed.includes(id)));
        // Every stored text/tool part was streamed.
        expect(stored.filter((id) => !partOrder.includes(id))).toEqual([]);
      };
      try {
        await run();
      } catch (e) {
        if (!(e instanceof Inconclusive)) throw e;
        await run().catch((e2) => { throw e2 instanceof Inconclusive ? new Error(`INCONCLUSIVE: ${e2.message}`) : e2; });
      }
    } finally {
      t.close();
    }
  });

  it('client disconnects mid-turn → the turn still finishes and the lock is released on idle', async () => {
    const t = await setup();
    try {
      const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
      await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'Say hi in one short sentence.' });
      const s = t.attach(chatId);
      await until(() => s.events.some((e) => e.type === 'turn' && e.state === 'running'), 120_000, 'turn running');
      s.disconnect();
      await until(() => t.chat.turnState(t.id, chatId) === 'idle', 600_000, 'turn finished without a client');
      expect(t.vaults.lock(t.id).isFree).toBe(true);
      const detail: ChatDetail = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body;
      const assistant = detail.messages.filter((m) => m.role === 'assistant');
      expect(assistant.length).toBeGreaterThan(0);
      expect(assistant.some((m) => m.error)).toBe(false);
    } finally {
      t.close();
    }
  });

  it('reconnect while the turn still runs → messages reload, the stream re-attaches and keeps delivering', async () => {
    const t = await setup();
    try {
      const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
      const prompt = 'Write a very long, detailed essay (at least 3000 words) about the history of cartography.';
      await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: prompt });
      const first = t.attach(chatId);
      await until(() => first.events.some((e) => e.type === 'text-delta'), 300_000, 'first text delta');
      first.disconnect();
      await new Promise((r) => setTimeout(r, 1000));
      expect(t.chat.turnState(t.id, chatId)).toBe('running');

      // Reconnect: reload the messages first, then attach.
      const detail: ChatDetail = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body;
      expect(detail.turn).toBe('running');
      expect(detail.messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: prompt }] });
      const second = t.attach(chatId);
      await until(() => second.events.length > 0, 10_000, 'stream snapshot');
      expect(second.events[0]).toMatchObject({ type: 'turn', state: 'running' });
      const n = second.events.length;
      await until(() => second.events.slice(n).some((e) => e.type === 'text-delta'), 120_000, 'live deltas after re-attach');

      await t.api.post(`/vaults/${t.id}/chats/${chatId}/abort`);
      await second.done;
      expect(second.events.at(-1)).toMatchObject({ type: 'turn', state: 'idle' });
      await until(() => t.vaults.lock(t.id).isFree, 30_000, 'lock released');
    } finally {
      t.close();
    }
  });
});
