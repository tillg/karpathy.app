import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent, VaultEvent } from '@karpathy/shared';
import { ChatService } from '../src/chat.js';
import { OpencodeCommitMessages } from '../src/commit-message.js';
import { basicAuth, OpencodeHarness } from '../src/harness/opencode.js';
import { makeApp, TOKEN } from './app-helpers.js';
import { makeRemote, sh } from './helpers.js';
import { DEAD_MODEL, DEAD_MODEL_2, startOpencode, testDir } from './opencode-container.js';

// Default tier: a real opencode container, but the model is on the dead provider (DEAD_MODEL), so every
// turn fails fast. That exercises the whole turn lifecycle deterministically without an LLM.

let oc: Awaited<ReturnType<typeof startOpencode>>;
const base = testDir('chat');
const vaultsDir = join(base, 'vaults');

beforeAll(async () => {
  oc = await startOpencode(vaultsDir);
}, 90_000);
afterAll(() => oc?.stop());

async function setup(files: Record<string, string> = {}) {
  const remote = await makeRemote({ 'Home.md': '# Home\n', 'Other.md': 'other\n', ...files }, { name: `v${Math.random().toString(36).slice(2, 7)}` });
  const t = await makeApp(remote.remoteBase, { dirs: { config: join(base, `config-${Math.random()}`), vaults: vaultsDir } });
  await t.store.update((c) => { c.settings.model = DEAD_MODEL; });
  const harness = new OpencodeHarness(oc.url, oc.password);
  const chat = new ChatService(t.vaults, t.store, harness, '/vaults');
  const commitMessages = new OpencodeCommitMessages(t.vaults, t.store, harness, (id) => chat.dir(id), 5000);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ token: TOKEN, vaults: t.vaults, store: t.store, chat, commitMessages, opencodeHealthy: () => harness.health() });
  const id = await t.addVault(remote.repo, { name: remote.repo.split('/')[1] });
  const request = (await import('supertest')).default;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const api = {
    get: (p: string) => request(app).get(`/api${p}`).set(auth),
    post: (p: string, body?: object) => request(app).post(`/api${p}`).set(auth).send(body),
    patch: (p: string, body?: object) => request(app).patch(`/api${p}`).set(auth).send(body),
    delete: (p: string) => request(app).delete(`/api${p}`).set(auth),
  };
  const raw = createOpencodeClient({ baseUrl: oc.url, headers: basicAuth(oc.password) });
  return { ...t, app, api, chat, harness, remote, id, raw, dir: chat.dir(id) };
}

async function waitIdle(chat: ChatService, vaultId: string, chatId: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (chat.turnState(vaultId, chatId) !== 'idle') {
    if (Date.now() > end) throw new Error('turn did not end');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function userAgents(raw: ReturnType<typeof createOpencodeClient>, dir: string, chatId: string) {
  const msgs = (await raw.session.messages({ directory: dir, sessionID: chatId })).data ?? [];
  return msgs.filter((m) => m.info.role === 'user').map((m) => (m.info as { agent?: string }).agent);
}

describe('chat API against a real opencode container', () => {
  it('health reports opencode ok', async () => {
    const t = await setup();
    expect((await t.api.get('/health')).body).toEqual({ backend: 'ok', opencode: 'ok', version: 'dev', built: null, deployed: null });
  });

  it('sessions of vault A never appear under vault B', async () => {
    const a = await setup();
    const b = await setup();
    const { chatId } = (await a.api.post(`/vaults/${a.id}/chats`)).body;
    expect((await a.api.get(`/vaults/${a.id}/chats`)).body.map((c: { id: string }) => c.id)).toContain(chatId);
    expect((await b.api.get(`/vaults/${b.id}/chats`)).body.map((c: { id: string }) => c.id)).not.toContain(chatId);
    expect((await b.api.get(`/vaults/${b.id}/chats/${chatId}`)).status).toBe(404);
  });

  it('child sessions (subagents) are left out of the list', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const child = (await t.raw.session.create({ directory: t.dir, parentID: chatId, title: 'child' })).data!;
    const ids = (await t.api.get(`/vaults/${t.id}/chats`)).body.map((c: { id: string }) => c.id);
    expect(ids).toContain(chatId);
    expect(ids).not.toContain(child.id);
  });

  it('prompt → 202; turn runs with agent "vault", lock released on idle, error surfaced in messages', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const r = await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'hello' });
    expect(r.status).toBe(202);
    await waitIdle(t.chat, t.id, chatId);
    expect(t.vaults.lock(t.id).isFree).toBe(true);
    expect(await userAgents(t.raw, t.dir, chatId)).toEqual(['vault']);
    const detail = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body;
    expect(detail.turn).toBe('idle');
    expect(detail.messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'hello' }] });
  });

  it('turn sets web tools from settings', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const web = async () => {
      const rules = ((await t.raw.session.get({ directory: t.dir, sessionID: chatId })).data as { permission?: { permission: string; action: string }[] }).permission ?? [];
      return Object.fromEntries(['websearch', 'webfetch', 'save_url'].map((n) => [n, rules.filter((r) => r.permission === n).at(-1)?.action]));
    };
    const turn = async (text: string) => {
      await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text });
      await waitIdle(t.chat, t.id, chatId);
    };
    await t.store.update((c) => { c.settings.webAccess = false; });
    await turn('off');
    expect(await web()).toEqual({ websearch: 'deny', webfetch: 'deny', save_url: 'deny' });
    await t.store.update((c) => { c.settings.webAccess = true; });
    await turn('on');
    expect(await web()).toEqual({ websearch: 'allow', webfetch: 'allow', save_url: 'allow' });
    // Conflict: read-only agent, web still allowed, downloads into the vault not.
    await t.api.get(`/vaults/${t.id}/file?path=Other.md`);
    await t.api.post(`/vaults/${t.id}/open`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'mine\n');
    await t.remote.obsidianPush({ 'Other.md': 'theirs\n' });
    await turn('conflict one');
    await turn('conflict two');
    expect(t.vaults.isConflict(t.id)).toBe(true);
    expect((await userAgents(t.raw, t.dir, chatId)).at(-1)).toBe('vault-readonly');
    expect(await web()).toEqual({ websearch: 'allow', webfetch: 'allow', save_url: 'deny' });
  });

  it('in Conflict every turn uses "vault-readonly"', async () => {
    const t = await setup();
    const f = (await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body;
    await t.api.post(`/vaults/${t.id}/open`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'mine\n');
    await t.remote.obsidianPush({ 'Other.md': 'theirs\n' });
    expect(f.version).toBeTruthy();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    // The pull at turn start runs into the conflict.
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'one' });
    await waitIdle(t.chat, t.id, chatId);
    expect(t.vaults.isConflict(t.id)).toBe(true);
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'two' });
    await waitIdle(t.chat, t.id, chatId);
    expect(await userAgents(t.raw, t.dir, chatId)).toEqual(['vault-readonly', 'vault-readonly']);
  });

  it('pull runs before the turn is dispatched: local HEAD equals the remote', async () => {
    const t = await setup();
    await t.remote.obsidianPush({ 'Other.md': 'remote change\n' });
    const remoteHead = sh(t.remote.bare, 'rev-parse', 'main').trim();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'x' });
    await waitIdle(t.chat, t.id, chatId);
    expect(sh(t.vaults.vaultRootDir(t.id), 'rev-parse', 'HEAD').trim()).toBe(remoteHead);
  });

  it('one running turn per vault: a second chat queues and starts after the first is idle', async () => {
    const t = await setup();
    const a = (await t.api.post(`/vaults/${t.id}/chats`)).body.chatId;
    const b = (await t.api.post(`/vaults/${t.id}/chats`)).body.chatId;
    const states: string[] = [];
    await t.api.post(`/vaults/${t.id}/chats/${a}/prompt`, { text: 'first' });
    await t.api.post(`/vaults/${t.id}/chats/${b}/prompt`, { text: 'second' });
    states.push(t.chat.turnState(t.id, b));
    await waitIdle(t.chat, t.id, a);
    await waitIdle(t.chat, t.id, b);
    expect(states[0]).toBe('queued');
    const msgsA = (await t.raw.session.messages({ directory: t.dir, sessionID: a })).data!;
    const msgsB = (await t.raw.session.messages({ directory: t.dir, sessionID: b })).data!;
    const aEnd = Math.max(...msgsA.map((m) => (m.info.time as { completed?: number; created: number }).completed ?? m.info.time.created));
    const bUser = msgsB.find((m) => m.info.role === 'user')!.info.time.created;
    expect(bUser).toBeGreaterThanOrEqual(aEnd);
  });

  it('queued turn says what it waits for (sync), messages carry the model that ran', async () => {
    const t = await setup();
    const release = await t.vaults.lock(t.id).acquireExclusive();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const got: unknown[] = [];
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'x' });
    t.chat.stream(t.id, chatId, (e) => got.push(e), () => undefined);
    expect(got[0]).toEqual({ type: 'turn', state: 'queued', waiting: 'sync' });
    release();
    await waitIdle(t.chat, t.id, chatId);
    const detail = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body;
    expect(detail.messages[0].model).toBe(DEAD_MODEL);
  });

  it('changing the model in settings changes the model reported for new turns (plan P4)', async () => {
    const t = await setup();
    const { createApp } = await import('../src/app.js');
    const request = (await import('supertest')).default;
    const app = createApp({ token: TOKEN, vaults: t.vaults, store: t.store, chat: t.chat, availableModels: () => t.harness.models() });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const turnWith = async (model: string) => {
      expect((await request(app).patch('/api/settings').set(auth).send({ model })).status).toBe(200);
      await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: `with ${model}` });
      await waitIdle(t.chat, t.id, chatId);
    };
    await turnWith(DEAD_MODEL_2);
    await turnWith(DEAD_MODEL);
    const users = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body.messages.filter((m: { role: string }) => m.role === 'user');
    expect(users.map((m: { model: string }) => m.model)).toEqual([DEAD_MODEL_2, DEAD_MODEL]);
  });

  it('settings expose modelInput', async () => {
    const t = await setup();
    const { createApp } = await import('../src/app.js');
    const request = (await import('supertest')).default;
    const app = createApp({ token: TOKEN, vaults: t.vaults, store: t.store, chat: t.chat, availableModels: () => t.harness.models() });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const patched = await request(app).patch('/api/settings').set(auth).send({ model: DEAD_MODEL_2 });
    expect(patched.body.modelInput).toEqual({ image: true, pdf: false });
    expect((await request(app).get('/api/settings').set(auth)).body.modelInput).toEqual({ image: true, pdf: false });
    await request(app).patch('/api/settings').set(auth).send({ model: DEAD_MODEL });
    expect((await request(app).get('/api/settings').set(auth)).body.modelInput).toEqual({ image: false, pdf: false });
    await t.store.update((c) => { c.settings.model = 'openrouter/not-listed'; });
    expect((await request(app).get('/api/settings').set(auth)).body.modelInput).toBeNull();
  });

  it('queued text, turn state in the list, and a title from the first prompt (#13)', async () => {
    const t = await setup();
    const release = await t.vaults.lock(t.id).acquireExclusive();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'Summarize the notes about gardening please' });
    expect((await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body).toMatchObject({ turn: 'queued', queued: [{ text: 'Summarize the notes about gardening please' }] });
    expect((await t.api.get(`/vaults/${t.id}/chats`)).body.find((c: { id: string }) => c.id === chatId)).toMatchObject({ turn: 'queued' });
    release();
    await waitIdle(t.chat, t.id, chatId);
    const d = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body;
    expect(d.queued).toEqual([]);
    expect(d.title).toBe('Summarize the notes about gardening please');
  });

  it("a turn's end runs the title job (#148)", async () => {
    const t = await setup();
    const ran: string[] = [];
    t.chat.titles.afterTurn = async (_v, chatId) => { ran.push(chatId); };
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'hello' });
    await waitIdle(t.chat, t.id, chatId);
    await new Promise((r) => setTimeout(r, 100));
    expect(ran).toEqual([chatId]);
  });

  it('title suggestion: shown in list and detail, PATCH renames and clears it, DELETE only clears it, all as vault events (#148)', async () => {
    const t = await setup();
    const events: VaultEvent[] = [];
    t.vaults.subscribe(t.id, (e) => events.push(e));
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.store.update((c) => { c.titleSuggestions = { [t.id]: { [chatId]: 'Kitchen budget' } }; });
    expect((await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body.titleSuggestion).toBe('Kitchen budget');
    expect((await t.api.get(`/vaults/${t.id}/chats`)).body.find((c: { id: string }) => c.id === chatId).titleSuggestion).toBe('Kitchen budget');
    expect((await t.api.patch(`/vaults/${t.id}/chats/${chatId}`, { title: ' Kitchen budget ' })).status).toBe(204);
    const d = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body;
    expect(d).toMatchObject({ title: 'Kitchen budget' });
    expect(d.titleSuggestion).toBeUndefined();
    await t.store.update((c) => { c.titleSuggestions = { [t.id]: { [chatId]: 'Other' } }; });
    expect((await t.api.delete(`/vaults/${t.id}/chats/${chatId}/title-suggestion`)).status).toBe(204);
    expect((await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body).toMatchObject({ title: 'Kitchen budget' });
    expect(t.store.get().titleSuggestions).toEqual({});
    expect(events.filter((e) => e.type === 'chat-title')).toEqual([
      { type: 'chat-title', chatId, title: 'Kitchen budget' },
      { type: 'chat-title', chatId, title: 'Kitchen budget' },
    ]);
    for (const title of ['', '   ', 'x'.repeat(501)]) expect((await t.api.patch(`/vaults/${t.id}/chats/${chatId}`, { title })).status, title).toBe(400);
    expect((await t.api.patch(`/vaults/${t.id}/chats/nope`, { title: 'x' })).status).toBe(404);
  });

  it("deleting a chat drops its title suggestion (#148)", async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.store.update((c) => { c.titleSuggestions = { [t.id]: { [chatId]: 'Kitchen budget', other: 'x' } }; });
    expect((await t.api.delete(`/vaults/${t.id}/chats/${chatId}`)).status).toBe(204);
    expect(t.store.get().titleSuggestions).toEqual({ [t.id]: { other: 'x' } });
  });

  it.each([
    ['.opencode/plugin/x.js', "require('fs').writeFileSync('/tmp/SENTINEL', 'pwned'); export default async () => ({});"],
    ['opencode.json', JSON.stringify({ mcp: { x: { type: 'local', command: ['sh', '-c', 'echo pwned > /tmp/SENTINEL'] } } })],
    ['sub/opencode.jsonc', '{}'],
  ])('a vault repo carrying opencode project config (%s) never reaches opencode (#27)', async (file, content) => {
    const sentinel = `/tmp/kai-sentinel-${Math.random().toString(36).slice(2, 8)}`;
    const sub: Record<string, string> = file.startsWith('sub/') ? { 'sub/Sources/.gitkeep': '', 'sub/Wiki/.gitkeep': '' } : {};
    const remote = await makeRemote({ 'a.md': 'a', ...sub, [file]: content.replace('/tmp/SENTINEL', sentinel) }, { name: `u${Math.random().toString(36).slice(2, 7)}` });
    const t = await setup();
    const { symlink } = await import('node:fs/promises');
    await symlink(remote.bare, join(t.remote.bare, '..', `${remote.repo.split('/')[1]}.git`));
    const root = file.startsWith('sub/') ? 'sub' : '';
    const id = await t.addVault(remote.repo, { name: remote.repo.split('/')[1], ...(root ? { root } : {}) });
    const r = await t.api.get(`/vaults/${id}/chats`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('unsafe-config');
    expect((await t.api.post(`/vaults/${id}/chats`)).status).toBe(409);
    expect((await t.api.post(`/vaults/${id}/commit-message`)).body.fallback).toBe(true);
    await new Promise((res) => setTimeout(res, 1500));
    const { execFileSync } = await import('node:child_process');
    expect(() => execFileSync('docker', ['exec', oc.name, 'cat', sentinel], { stdio: 'pipe' })).toThrow();
  });

  it('opencode unreachable → 503 "AI unavailable", not 404 (#29)', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const dead = new ChatService(t.vaults, t.store, new OpencodeHarness('http://127.0.0.1:9'), '/vaults');
    const { createApp } = await import('../src/app.js');
    const request = (await import('supertest')).default;
    const app = createApp({ token: TOKEN, vaults: t.vaults, store: t.store, chat: dead });
    const r = await request(app).get(`/api/vaults/${t.id}/chats/${chatId}`).set({ Authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('ai-unavailable');
    dead.close();
  });

  it('removing a vault deletes its chats; re-adding the same repo starts clean (#34)', async () => {
    const t = await setup();
    t.vaults.beforeRemove = (id) => t.chat.deleteAllChats(id);
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    expect((await t.api.delete(`/vaults/${t.id}`)).status).toBe(204);
    const id2 = await t.addVault(t.remote.repo, { name: t.remote.repo.split('/')[1] });
    expect(id2).toBe(t.id);
    expect((await t.api.get(`/vaults/${id2}/chats`)).body.map((c: { id: string }) => c.id)).not.toContain(chatId);
  });

  it('queued prompts survive a backend restart (#37)', async () => {
    const t = await setup();
    await t.vaults.lock(t.id).acquireExclusive(); // never released: the old process never dispatches
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'survive me' });
    t.chat.close();
    // "Restart": fresh Vaults (fresh locks) + ChatService on the same config and clones.
    const t2 = await makeApp(t.remote.remoteBase, { dirs: t.dirs });
    await t2.store.update((c) => { c.settings.model = DEAD_MODEL; });
    const chat2 = new ChatService(t2.vaults, t2.store, t.harness, '/vaults');
    await chat2.init();
    const end = Date.now() + 30_000;
    while ((await userAgents(t.raw, t.dir, chatId)).length === 0) {
      if (Date.now() > end) throw new Error('queued prompt was lost');
      await new Promise((r) => setTimeout(r, 200));
    }
    chat2.close();
    await t2.vaults.close();
  });

  it('prompt with attachments is queued and survives a restart', async () => {
    const t = await setup();
    await t.vaults.lock(t.id).acquireExclusive(); // never released: the turn stays queued
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const p = `/vaults/${t.id}/chats/${chatId}/prompt`;
    expect((await t.api.post(p, { text: '' })).status).toBe(400);
    expect((await t.api.post(p, { text: 'x', attachments: Array.from({ length: 6 }, (_, i) => `Sources/upload-x/${i}.png`) })).status).toBe(400);
    expect((await t.api.post(p, { text: '', attachments: ['Sources/upload-x/a.png'] })).status).toBe(202);
    const end = Date.now() + 10_000;
    while ((await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body.title !== 'a.png') {
      if (Date.now() > end) throw new Error('title was not set from the attachment');
      await new Promise((r) => setTimeout(r, 200));
    }
    t.chat.close();
    // "Restart": the queue is read back from config.json, which holds the path and no bytes.
    const t2 = await makeApp(t.remote.remoteBase, { dirs: t.dirs });
    expect(t2.store.get().queued[t.id]).toEqual([{ id: expect.any(String), chatId, text: '', attachments: ['Sources/upload-x/a.png'] }]);
    await t2.vaults.close();
  });

  it('prompt with openPage keeps the chat\'s state file current, outside the vault clone (#143)', async () => {
    const t = await setup();
    await t.vaults.lock(t.id).acquireExclusive(); // never released: the turns stay queued
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const p = `/vaults/${t.id}/chats/${chatId}/prompt`;
    const state = join(vaultsDir, '.open-page', `${chatId}.json`);
    const page = { path: 'Home.md', mode: 'write', unsaved: true };
    expect((await t.api.post(p, { text: 'summarize this note', openPage: page })).status).toBe(202);
    expect(JSON.parse(await readFile(state, 'utf8'))).toEqual(page);
    // Never an untracked file in the clone.
    expect(sh(t.vaults.vaultRootDir(t.id), 'status', '--porcelain')).toBe('');
    // A bad path is refused and leaves the state alone.
    for (const path of ['../x.md', '/etc/passwd', '.git/config', '']) expect((await t.api.post(p, { text: 'x', openPage: { ...page, path } })).status).toBe(400);
    expect((await t.api.post(p, { text: 'x', openPage: { ...page, mode: 'edit' } })).status).toBe(400);
    expect(JSON.parse(await readFile(state, 'utf8'))).toEqual(page);
    await t.chat.remove(t.id, chatId).catch(() => undefined);
  });

  it('a prompt without openPage clears it; deleting the chat removes the file (#143)', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const p = `/vaults/${t.id}/chats/${chatId}/prompt`;
    const state = join(vaultsDir, '.open-page', `${chatId}.json`);
    expect((await t.api.post(p, { text: 'one', openPage: { path: 'Home.md', mode: 'read', unsaved: false } })).status).toBe(202);
    await waitIdle(t.chat, t.id, chatId);
    expect(await readFile(state, 'utf8')).toContain('Home.md');
    expect((await t.api.post(p, { text: 'two' })).status).toBe(202);
    await expect(readFile(state, 'utf8')).rejects.toThrow('ENOENT');
    await waitIdle(t.chat, t.id, chatId);
    expect((await t.api.post(p, { text: 'three', openPage: { path: 'Other.md', mode: 'read', unsaved: false } })).status).toBe(202);
    await waitIdle(t.chat, t.id, chatId);
    expect((await t.api.delete(`/vaults/${t.id}/chats/${chatId}`)).status).toBe(204);
    await expect(readFile(state, 'utf8')).rejects.toThrow('ENOENT');
  });

  it('removing a vault removes the open-page files of its chats (#143)', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const state = join(vaultsDir, '.open-page', `${chatId}.json`);
    expect((await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'one', openPage: { path: 'Home.md', mode: 'read', unsaved: false } })).status).toBe(202);
    await waitIdle(t.chat, t.id, chatId);
    expect(await readFile(state, 'utf8')).toContain('Home.md');
    await t.chat.deleteAllChats(t.id);
    await expect(readFile(state, 'utf8')).rejects.toThrow('ENOENT');
  });

  it('attachment reaches opencode as a file part', async () => {
    const t = await setup();
    const request = (await import('supertest')).default;
    const { readFile } = await import('node:fs/promises');
    const png = await readFile(join(import.meta.dirname, '../../../e2e/fixtures/media/shot.png'));
    const up = await request(t.app).post(`/api/vaults/${t.id}/raw?name=shot.png&source=new&at=2026-10-04-091500`)
      .set('Authorization', `Bearer ${TOKEN}`).set('Content-Type', 'application/octet-stream').send(png);
    expect(up.status).toBe(201);
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    expect((await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'what is this?', attachments: [up.body.path] })).status).toBe(202);
    await waitIdle(t.chat, t.id, chatId);
    const msgs = (await t.raw.session.messages({ directory: t.dir, sessionID: chatId })).data ?? [];
    const user = msgs.find((m) => m.info.role === 'user')!;
    const file = user.parts.find((p) => p.type === 'file') as { mime: string; filename?: string; url: string } | undefined;
    expect(file).toMatchObject({ mime: 'image/png', filename: 'Sources/upload-2026-10-04-091500/shot.png' });
    expect(file!.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(Buffer.from(file!.url.slice('data:image/png;base64,'.length), 'base64').equals(png)).toBe(true);
  });

  it('bad attachment paths end the turn', async () => {
    const t = await setup();
    const { mkdir, rm, writeFile } = await import('node:fs/promises');
    const root = t.vaults.vaultRootDir(t.id);
    await mkdir(join(root, 'Sources/upload-x'), { recursive: true });
    await mkdir(join(root, 'Notes'), { recursive: true });
    await writeFile(join(root, 'Notes/n.md'), 'note');
    await writeFile(join(root, '.env'), 'SECRET=1');
    await writeFile(join(root, 'Sources/upload-x/big.pdf'), Buffer.alloc(21 * 1024 * 1024));
    await writeFile(join(root, 'Sources/upload-x/soon-gone.png'), 'png');
    const cases: [string, string, (() => Promise<void>)?][] = [
      ['Sources/upload-x/gone.png', 'Attachment not found: Sources/upload-x/gone.png'],
      ['../other-vault/x.png', '../other-vault/x.png'],
      ['.env', '.env'],
      ['Notes/n.md', 'Notes/n.md'],
      ['Sources/upload-x/big.pdf', 'Sources/upload-x/big.pdf'],
      // Discarded while the turn waited for the lock.
      ['Sources/upload-x/soon-gone.png', 'Attachment not found: Sources/upload-x/soon-gone.png', () => rm(join(root, 'Sources/upload-x/soon-gone.png'))],
    ];
    for (const [path, message, whileQueued] of cases) {
      const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
      const events: ChatEvent[] = [];
      const release = await t.vaults.lock(t.id).acquireExclusive();
      await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'look', attachments: [path] });
      const stop = t.chat.stream(t.id, chatId, (e) => events.push(e), () => undefined);
      await whileQueued?.();
      release();
      await waitIdle(t.chat, t.id, chatId);
      stop();
      expect(events.find((e) => e.type === 'error'), path).toMatchObject({ message: expect.stringContaining(message) });
      expect(await userAgents(t.raw, t.dir, chatId), path).toEqual([]);
    }
  });

  it('harness config pulled in right before a turn stops the turn before it reaches opencode (#27 bypass)', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const release = await t.vaults.lock(t.id).acquireExclusive();
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'hello' });
    const got: { type: string; message?: string }[] = [];
    t.chat.stream(t.id, chatId, (e) => got.push(e as { type: string; message?: string }), () => undefined);
    await t.remote.obsidianPush({ 'opencode.json': JSON.stringify({ mcp: {} }) });
    release();
    await waitIdle(t.chat, t.id, chatId);
    expect(await userAgents(t.raw, t.dir, chatId)).toEqual([]);
    expect(got.some((e) => e.type === 'error' && /opencode project config/.test(e.message ?? ''))).toBe(true);
    expect(t.vaults.lock(t.id).isFree).toBe(true);
  });

  it('opens the event subscription when a vault is added (onReady hook)', async () => {
    const t = await setup();
    const opened: string[] = [];
    t.vaults.onReady = (id) => opened.push(id);
    const remote = await makeRemote({ 'a.md': 'a' }, { name: `r${Math.random().toString(36).slice(2, 7)}` });
    const { symlink } = await import('node:fs/promises');
    await symlink(remote.bare, join(t.remote.bare, '..', `${remote.repo.split('/')[1]}.git`));
    const id2 = await t.addVault(remote.repo, { name: remote.repo.split('/')[1] });
    expect(opened).toEqual([id2]);
  });

  it('abort removes a queued prompt', async () => {
    const t = await setup();
    const release = await t.vaults.lock(t.id).acquireExclusive(); // hold the vault busy
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'never' });
    expect(t.chat.turnState(t.id, chatId)).toBe('queued');
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/abort`);
    expect(t.chat.turnState(t.id, chatId)).toBe('idle');
    release();
    await new Promise((r) => setTimeout(r, 500));
    expect(await userAgents(t.raw, t.dir, chatId)).toEqual([]);
  });

  it('next prompts of a busy chat queue behind its own turn and run in order (#155)', async () => {
    const t = await setup();
    const release = await t.vaults.lock(t.id).acquireExclusive();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const p = `/vaults/${t.id}/chats/${chatId}/prompt`;
    const ids: string[] = [];
    for (const text of ['one', 'two', 'three']) {
      const r = await t.api.post(p, { text });
      expect(r.status).toBe(202);
      expect(r.body.id).toEqual(expect.any(String));
      ids.push(r.body.id);
    }
    expect(new Set(ids).size).toBe(3);
    const d = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body;
    expect(d.turn).toBe('queued');
    expect(d.queued).toEqual([{ id: ids[0], text: 'one' }, { id: ids[1], text: 'two' }, { id: ids[2], text: 'three' }]);
    release();
    const end = Date.now() + 60_000;
    while ((await userAgents(t.raw, t.dir, chatId)).length < 3 || t.chat.turnState(t.id, chatId) !== 'idle') {
      if (Date.now() > end) throw new Error('queued prompts did not all run');
      await new Promise((r) => setTimeout(r, 200));
    }
    const users = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body.messages.filter((m: { role: string }) => m.role === 'user');
    expect(users.map((m: { parts: { type: string; text?: string }[] }) => m.parts.find((x) => x.type === 'text')?.text)).toEqual(['one', 'two', 'three']);
    expect((await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body.queued).toEqual([]);
  }, 90_000);

  it('at most 10 queued prompts per chat (#155)', async () => {
    const t = await setup();
    await t.vaults.lock(t.id).acquireExclusive();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    for (let i = 0; i < 10; i++) expect((await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: `p${i}` })).status).toBe(202);
    const r = await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'one too many' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('queue-full');
  });

  it('a queued prompt can be taken back: DELETE returns it, it never runs, the queue event follows (#155)', async () => {
    const t = await setup();
    const release = await t.vaults.lock(t.id).acquireExclusive();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await mkdir(join(t.vaults.vaultRootDir(t.id), 'Sources/upload-q'), { recursive: true });
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Sources/upload-q/a.png'), 'png-bytes');
    const a = (await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'keep me' })).body.id;
    const got: ChatEvent[] = [];
    t.chat.stream(t.id, chatId, (e) => got.push(e), () => undefined);
    const b = (await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'take me back', attachments: ['Sources/upload-q/a.png', 'Sources/upload-q/gone.png'] })).body.id;
    expect(got).toContainEqual({ type: 'queue', queued: [{ id: a, text: 'keep me' }, { id: b, text: 'take me back', attachments: ['Sources/upload-q/a.png', 'Sources/upload-q/gone.png'] }] });
    const r = await t.api.delete(`/vaults/${t.id}/chats/${chatId}/queue/${b}`);
    expect(r.status).toBe(200);
    // Attachments come back as composer chips (what ✕ needs to delete them); a file that is gone is left out.
    const { versionOf } = await import('../src/files.js');
    expect(r.body).toEqual({ id: b, text: 'take me back', attachments: [{ path: 'Sources/upload-q/a.png', version: versionOf('png-bytes'), mime: 'image/png', size: 9 }] });
    expect(got.at(-1)).toEqual({ type: 'queue', queued: [{ id: a, text: 'keep me' }] });
    expect((await t.api.delete(`/vaults/${t.id}/chats/${chatId}/queue/${b}`)).status).toBe(404);
    expect(t.store.get().queued[t.id]?.map((q) => q.text)).toEqual(['keep me']);
    release();
    await waitIdle(t.chat, t.id, chatId);
    const users = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body.messages.filter((m: { role: string }) => m.role === 'user');
    expect(users).toHaveLength(1);
  });

  it('a started prompt leaves the queue with a "started" queue event (#155)', async () => {
    const t = await setup();
    const release = await t.vaults.lock(t.id).acquireExclusive();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const a = (await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'go' })).body.id;
    const got: ChatEvent[] = [];
    t.chat.stream(t.id, chatId, (e) => got.push(e), () => undefined);
    release();
    await waitIdle(t.chat, t.id, chatId);
    const i = got.findIndex((e) => e.type === 'queue' && e.started);
    expect(got[i]).toEqual({ type: 'queue', queued: [], started: a });
    expect(got.findIndex((e) => e.type === 'turn' && e.state === 'running')).toBeGreaterThan(i);
  });

  it('stop hands back every queued prompt of the chat and leaves other chats queued (#155)', async () => {
    const t = await setup();
    const release = await t.vaults.lock(t.id).acquireExclusive();
    const a = (await t.api.post(`/vaults/${t.id}/chats`)).body.chatId;
    const b = (await t.api.post(`/vaults/${t.id}/chats`)).body.chatId;
    const ids = [];
    for (const text of ['first', 'second']) ids.push((await t.api.post(`/vaults/${t.id}/chats/${a}/prompt`, { text })).body.id);
    await t.api.post(`/vaults/${t.id}/chats/${b}/prompt`, { text: 'other chat' });
    const r = await t.api.post(`/vaults/${t.id}/chats/${a}/abort`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ restored: [{ id: ids[0], text: 'first', attachments: [] }, { id: ids[1], text: 'second', attachments: [] }] });
    expect(t.chat.turnState(t.id, a)).toBe('idle');
    expect(t.chat.turnState(t.id, b)).toBe('queued');
    release();
    await waitIdle(t.chat, t.id, b);
    expect(await userAgents(t.raw, t.dir, a)).toEqual([]);
  });

  it('a turn that fails before it runs does not drop the queued prompts behind it (#155)', async () => {
    const t = await setup();
    const release = await t.vaults.lock(t.id).acquireExclusive();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    // The first turn's attachment is missing: it ends with an error before reaching opencode.
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'bad', attachments: ['Sources/upload-x/missing.png'] });
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'still runs' });
    release();
    const end = Date.now() + 30_000;
    while ((await userAgents(t.raw, t.dir, chatId)).length < 1 || t.chat.turnState(t.id, chatId) !== 'idle') {
      if (Date.now() > end) throw new Error('the queued prompt was dropped');
      await new Promise((r) => setTimeout(r, 200));
    }
    const users = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body.messages.filter((m: { role: string }) => m.role === 'user');
    expect(users.map((m: { parts: { type: string; text?: string }[] }) => m.parts.find((x) => x.type === 'text')?.text)).toEqual(['still runs']);
  }, 90_000);

  it('a pull that fails for a prompt taken back while it waited for the lock drops no other prompt (#155)', async () => {
    const t = await setup();
    const release = await t.vaults.lock(t.id).acquireExclusive();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const pull = t.vaults.pullUnlocked.bind(t.vaults);
    let failures = 1;
    t.vaults.pullUnlocked = async (id: string) => {
      if (failures-- > 0) throw new Error('remote gone');
      return pull(id);
    };
    const a = (await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'taken back' })).body.id;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'still runs' });
    expect((await t.api.delete(`/vaults/${t.id}/chats/${chatId}/queue/${a}`)).status).toBe(200);
    const got: ChatEvent[] = [];
    t.chat.stream(t.id, chatId, (e) => got.push(e), () => undefined);
    release();
    const end = Date.now() + 30_000;
    while ((await userAgents(t.raw, t.dir, chatId)).length < 1 || t.chat.turnState(t.id, chatId) !== 'idle') {
      if (Date.now() > end) throw new Error('the queued prompt was dropped');
      await new Promise((r) => setTimeout(r, 200));
    }
    const users = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body.messages.filter((m: { role: string }) => m.role === 'user');
    expect(users.map((m: { parts: { type: string; text?: string }[] }) => m.parts.find((x) => x.type === 'text')?.text)).toEqual(['still runs']);
    // The taken-back prompt's failed pull is nobody's error.
    expect(got.some((e) => e.type === 'error' && /pull before the turn failed/.test(e.message))).toBe(false);
  }, 60_000);

  it('Stop after the prompt left the queue but before it reached opencode: it never runs and comes back (#155)', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await mkdir(join(t.vaults.vaultRootDir(t.id), 'Sources/upload-s'), { recursive: true });
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Sources/upload-s/a.png'), 'png-bytes');
    // The attachment check is the last step before opencode: hold the turn there.
    let reached!: () => void;
    const atCheck = new Promise<void>((r) => { reached = r; });
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    const check = t.vaults.checkAttachment.bind(t.vaults);
    t.vaults.checkAttachment = async (id: string, path: string) => {
      reached();
      await gate;
      return check(id, path);
    };
    const id = (await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'too late', attachments: ['Sources/upload-s/a.png'] })).body.id;
    await atCheck;
    const r = await t.api.post(`/vaults/${t.id}/chats/${chatId}/abort`);
    expect(r.status).toBe(200);
    expect(r.body.restored).toEqual([{ id, text: 'too late', attachments: [expect.objectContaining({ path: 'Sources/upload-s/a.png' })] }]);
    go();
    await waitIdle(t.chat, t.id, chatId);
    await new Promise((res) => setTimeout(res, 500));
    expect(await userAgents(t.raw, t.dir, chatId)).toEqual([]);
    expect(t.vaults.lock(t.id).isFree).toBe(true);
  });

  it('a stream opened while prompts wait starts with the queue as it is now (#155)', async () => {
    const t = await setup();
    await t.vaults.lock(t.id).acquireExclusive(); // never released: the turns stay queued
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const a = (await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'one' })).body.id;
    const b = (await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'two' })).body.id;
    const got: ChatEvent[] = [];
    t.chat.stream(t.id, chatId, (e) => got.push(e), () => undefined);
    expect(got).toEqual([{ type: 'turn', state: 'queued', waiting: 'sync' }, { type: 'queue', queued: [{ id: a, text: 'one' }, { id: b, text: 'two' }] }]);
  });

  it('stream: queued → running → idle over NDJSON; idle chat ends immediately', async () => {
    const t = await setup();
    const server = http.createServer(t.app).listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const read = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/vaults/${t.id}/chats/${chatId}/stream`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as ChatEvent);
    };
    expect(await read()).toEqual([{ type: 'turn', state: 'idle' }]);
    const release = await t.vaults.lock(t.id).acquireExclusive();
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'streamed' });
    const events = read();
    await new Promise((r) => setTimeout(r, 200));
    release();
    const got = await events;
    const turns = got.filter((e) => e.type === 'turn').map((e) => (e as { state: string }).state);
    expect(turns).toEqual(['queued', 'running', 'idle']);
    expect(got.some((e) => e.type === 'message')).toBe(true);
    server.close();
  });

  it('commit message: fallback when the model fails; throwaway session deleted, chat list unchanged', async () => {
    const t = await setup();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'changed\n');
    const before = (await t.api.get(`/vaults/${t.id}/chats`)).body;
    const r = await t.api.post(`/vaults/${t.id}/commit-message`);
    expect(r.body).toEqual({ message: 'Update 1 file', fallback: true });
    expect((await t.api.get(`/vaults/${t.id}/chats`)).body).toEqual(before);
  });

  it('commit message: fallback when opencode is down', async () => {
    const t = await setup();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'changed\n');
    const deadHarness = new OpencodeHarness('http://127.0.0.1:9');
    const cm = new OpencodeCommitMessages(t.vaults, t.store, deadHarness, (id) => t.chat.dir(id), 2000);
    expect(await cm.propose(t.id)).toEqual({ message: 'Update 1 file', fallback: true });
  });

  it('deleting a chat removes it from the list', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    expect((await t.api.delete(`/vaults/${t.id}/chats/${chatId}`)).status).toBe(204);
    expect((await t.api.get(`/vaults/${t.id}/chats`)).body.map((c: { id: string }) => c.id)).not.toContain(chatId);
  });
});

const helloSkill = { '.agents/skills/hello/SKILL.md': '---\nname: hello\ndescription: Says hello\n---\n\nHELLO-BODY for $ARGUMENTS. Run !`id -u` first.\n' };

const isLocalTime = (p: { text: string; synthetic?: boolean }) => Boolean(p.synthetic) && p.text.startsWith("User's local time:");

/** Text parts of the chat's first user message, as opencode stored them; `localTime` keeps the local-time line (#151). */
async function userParts(t: Awaited<ReturnType<typeof setup>>, chatId: string, { localTime = false } = {}) {
  const msgs = (await t.raw.session.messages({ directory: t.dir, sessionID: chatId })).data ?? [];
  const parts = (msgs.find((m) => m.info.role === 'user')?.parts ?? []).filter((p) => p.type === 'text') as { text: string; synthetic?: boolean }[];
  return localTime ? parts : parts.filter((p) => !isLocalTime(p));
}

describe('local time (#151)', () => {
  it('a prompt carries a hidden local-time line in the time zone it was sent with', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const body = { text: 'what day is it?', tabId: 'tab-12345678', timeZone: 'Pacific/Auckland', locale: 'en-NZ' };
    expect((await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, body)).status).toBe(202);
    await waitIdle(t.chat, t.id, chatId);
    const line = (await userParts(t, chatId, { localTime: true })).filter(isLocalTime);
    expect(line).toHaveLength(1);
    expect(line[0]!.text).toMatch(/^User's local time: \w+day \d{4}-\d{2}-\d{2} \d{2}:\d{2}, Pacific\/Auckland \(UTC\+1[23]:00\), locale en-NZ\./);
    const shown = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body.messages.find((m: { role: string }) => m.role === 'user');
    expect(shown.parts.map((p: { text?: string }) => p.text)).toEqual(['what day is it?']);
  });

  it('a /command turn carries it too, before the skill text', async () => {
    const t = await setup(helloSkill);
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: '/hello', timeZone: 'Europe/Berlin' });
    await waitIdle(t.chat, t.id, chatId);
    const hidden = (await userParts(t, chatId, { localTime: true })).filter((p) => p.synthetic);
    expect(hidden.map((p) => isLocalTime(p))).toEqual([true, false]);
    expect(hidden[0]!.text).toContain('Europe/Berlin');
  });

  it('without a time zone the line uses the backend zone (the timezone setting)', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'hi' });
    await waitIdle(t.chat, t.id, chatId);
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect((await userParts(t, chatId, { localTime: true })).find(isLocalTime)?.text).toContain(`, ${own} (UTC`);
  });

  it('tabId, timeZone and locale are kept on the queued turn; a bad tabId or an over-long zone is a 400 (an unknown zone falls back later)', async () => {
    const t = await setup();
    await t.vaults.lock(t.id).acquireExclusive(); // never released: the turn stays queued
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    const p = `/vaults/${t.id}/chats/${chatId}/prompt`;
    expect((await t.api.post(p, { text: 'x', tabId: '../../etc' })).status).toBe(400);
    expect((await t.api.post(p, { text: 'x', timeZone: 'x'.repeat(65) })).status).toBe(400);
    expect((await t.api.post(p, { text: 'x', tabId: 'tab-12345678', timeZone: 'Europe/Berlin', locale: 'de-DE' })).status).toBe(202);
    expect(t.store.get().queued[t.id]).toEqual([{ id: expect.any(String), chatId, text: 'x', tabId: 'tab-12345678', timeZone: 'Europe/Berlin', locale: 'de-DE' }]);
    t.chat.close();
  });
});

describe('browser calls and the turn (#151)', () => {
  const call = (t: Awaited<ReturnType<typeof setup>>, chatId: string, callId: string) =>
    t.vaults.browserCalls.open({ vaultId: t.id, chatId, callId, tool: 'user_location', input: {}, tabId: null });

  it("a turn's end closes the vault's pending calls, those of subagent sessions included", async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    call(t, chatId, 'c1');
    call(t, 'ses_subagent', 'c2');
    expect(t.vaults.browserCalls.pending(t.id)).toHaveLength(2);
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: 'hi' });
    await waitIdle(t.chat, t.id, chatId);
    await expect.poll(() => t.vaults.browserCalls.pending(t.id)).toEqual([]);
  });

  it('deleting a chat drops its calls', async () => {
    const t = await setup();
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    call(t, chatId, 'c3');
    expect((await t.api.delete(`/vaults/${t.id}/chats/${chatId}`)).status).toBe(204);
    expect(t.vaults.browserCalls.pending(t.id)).toEqual([]);
  });
});

describe('command turns', () => {
  it('a /command turn stores the user text plus a synthetic part with the skill text', async () => {
    const t = await setup(helloSkill);
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    expect((await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: '/hello world' })).status).toBe(202);
    await waitIdle(t.chat, t.id, chatId);
    const parts = await userParts(t, chatId);
    expect(parts.filter((p) => !p.synthetic).map((p) => p.text)).toEqual(['/hello world']);
    const hidden = parts.filter((p) => p.synthetic);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.text).toContain('HELLO-BODY for world');
    expect(hidden[0]!.text).toContain('!`id -u`');
    expect(hidden[0]!.text).not.toMatch(/\b1000\b/);
    const shown = (await t.api.get(`/vaults/${t.id}/chats/${chatId}`)).body.messages.find((m: { role: string }) => m.role === 'user');
    expect(shown.parts.map((p: { text?: string }) => p.text)).toEqual(['/hello world']);
  });

  it('unknown /word is a plain turn', async () => {
    const t = await setup(helloSkill);
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: '/etc/hosts is what?' });
    await waitIdle(t.chat, t.id, chatId);
    expect(await userParts(t, chatId)).toEqual([expect.objectContaining({ text: '/etc/hosts is what?' })]);
    expect((await userParts(t, chatId))[0]!.synthetic).toBeFalsy();
  });

  it('a skill pulled from GitHub runs in the next turn', async () => {
    const t = await setup(helloSkill);
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    // A first command turn lists the vault's commands (opencode caches the list, F7).
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: '/hello' });
    await waitIdle(t.chat, t.id, chatId);
    await t.remote.obsidianPush({
      '.agents/skills/pulled/SKILL.md': '---\nname: pulled\ndescription: Pulled\n---\n\nPULLED-BODY\n',
      '.claude/skills/moved/SKILL.md': '---\nname: moved\ndescription: Moved\n---\n\nMOVED-BODY\n',
    });
    for (const [cmd, body] of [['/pulled', 'PULLED-BODY'], ['/moved', 'MOVED-BODY']] as const) {
      const c = (await t.api.post(`/vaults/${t.id}/chats`)).body.chatId;
      await t.api.post(`/vaults/${t.id}/chats/${c}/prompt`, { text: cmd });
      await waitIdle(t.chat, t.id, c);
      expect((await userParts(t, c)).find((p) => p.synthetic)?.text).toContain(body);
    }
  });

  it('a /research turn follows Web access like any turn', async () => {
    const t = await setup();
    await t.store.update((c) => { c.settings.webAccess = true; });
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: '/research the history of Testland' });
    await waitIdle(t.chat, t.id, chatId);
    expect((await userParts(t, chatId)).some((p) => p.synthetic)).toBe(true);
    const rules = ((await t.raw.session.get({ directory: t.dir, sessionID: chatId })).data as { permission?: { permission: string; action: string }[] }).permission ?? [];
    const last = (n: string) => rules.filter((r) => r.permission === n).at(-1)?.action;
    expect({ websearch: last('websearch'), webfetch: last('webfetch') }).toEqual({ websearch: 'allow', webfetch: 'allow' });
    expect((await userAgents(t.raw, t.dir, chatId)).at(-1)).toBe('vault');
  });

  it('a listing during a pull waits for it and shows the pulled skill', async () => {
    const t = await setup(helloSkill);
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.map((c: { name: string }) => c.name)).not.toContain('pulled');
    await t.remote.obsidianPush({ '.agents/skills/pulled/SKILL.md': '---\nname: pulled\ndescription: Pulled\n---\n\nP.\n' });
    const release = await t.vaults.lock(t.id).acquireExclusive();
    const listing = t.api.get(`/vaults/${t.id}/commands`).then((r) => r.body);
    await new Promise((r) => setTimeout(r, 300));
    await t.vaults.pullUnlocked(t.id);
    release();
    expect((await listing).map((c: { name: string }) => c.name)).toContain('pulled');
  });

  it('a background fetch does not block the refresh', async () => {
    const t = await setup(helloSkill);
    await t.api.get(`/vaults/${t.id}/commands`);
    const release = t.vaults.lock(t.id).tryShared('fetch')!;
    await mkdir(join(t.vaults.vaultRootDir(t.id), '.agents/skills/fetched'), { recursive: true });
    await writeFile(join(t.vaults.vaultRootDir(t.id), '.agents/skills/fetched/SKILL.md'), '---\nname: fetched\ndescription: F\n---\n\nF.\n');
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.map((c: { name: string }) => c.name)).toContain('fetched');
    release();
  });

  it('a skill saved through the file API shows in the next listing (#134)', async () => {
    const t = await setup();
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.map((c: { name: string }) => c.name)).not.toContain('saved');
    const request = (await import('supertest')).default;
    const put = await request(t.app).put(`/api/vaults/${t.id}/file?path=.agents/skills/saved/SKILL.md`).set({ Authorization: `Bearer ${TOKEN}` })
      .send({ content: '---\nname: saved\ndescription: Saved\n---\n\nS.\n', version: null });
    expect(put.status).toBe(200);
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.map((c: { name: string }) => c.name)).toContain('saved');
  });

  it('no refresh while a commit message is being proposed', async () => {
    const t = await setup(helloSkill);
    await t.api.get(`/vaults/${t.id}/commands`);
    let finish!: () => void;
    const proposing = t.vaults.proposing(t.id, () => new Promise<void>((r) => { finish = r; }));
    await mkdir(join(t.vaults.vaultRootDir(t.id), '.agents/skills/during'), { recursive: true });
    await writeFile(join(t.vaults.vaultRootDir(t.id), '.agents/skills/during/SKILL.md'), '---\nname: during\ndescription: D\n---\n\nD.\n');
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.map((c: { name: string }) => c.name)).not.toContain('during');
    finish();
    await proposing;
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.map((c: { name: string }) => c.name)).toContain('during');
  });

  it('no refresh while a turn holds the lock', async () => {
    const t = await setup(helloSkill);
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.map((c: { name: string }) => c.name)).toContain('hello');
    const release = await t.vaults.lock(t.id).acquireShared('turn');
    await mkdir(join(t.vaults.vaultRootDir(t.id), '.agents/skills/later'), { recursive: true });
    await writeFile(join(t.vaults.vaultRootDir(t.id), '.agents/skills/later/SKILL.md'), '---\nname: later\ndescription: Later\n---\n\nLater.\n');
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.map((c: { name: string }) => c.name)).not.toContain('later');
    release();
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.map((c: { name: string }) => c.name)).toContain('later');
  });
});

describe('GET /vaults/:id/commands', () => {
  it('lists the commands sorted, without templates; 409 unsafe-config; 401 without the token', async () => {
    const t = await setup({ ...helloSkill, '.agents/skills/ask/SKILL.md': '---\nname: ask\ndescription: Asks\n---\n\nAsk.\n' });
    const r = await t.api.get(`/vaults/${t.id}/commands`);
    expect(r.status).toBe(200);
    const vault = r.body.filter((c: { source: string }) => c.source === 'vault');
    expect(vault).toEqual([
      { name: 'ask', description: 'Asks', source: 'vault' },
      { name: 'hello', description: 'Says hello', source: 'vault' },
    ]);
    expect(r.body.every((c: object) => !('template' in c))).toBe(true);
    const request = (await import('supertest')).default;
    expect((await request(t.app).get(`/api/vaults/${t.id}/commands`)).status).toBe(401);
    const u = await setup({ '.opencode/x.txt': 'x' });
    const bad = await u.api.get(`/vaults/${u.id}/commands`);
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('unsafe-config');
  });

  it('a vault skill that replaces an app skill says so', async () => {
    const t = await setup({ '.agents/skills/research/SKILL.md': '---\nname: research\ndescription: VAULT\n---\n\nMine.\n' });
    const research = (await t.api.get(`/vaults/${t.id}/commands`)).body.filter((c: { name: string }) => c.name === 'research');
    expect(research).toEqual([{ name: 'research', description: 'VAULT', source: 'vault', replaces: true }]);
    const u = await setup();
    const plain = (await u.api.get(`/vaults/${u.id}/commands`)).body.find((c: { name: string }) => c.name === 'research');
    expect(plain).toMatchObject({ source: 'app' });
    expect(plain.replaces).toBeUndefined();
  });

  it('a /research turn in a vault with its own research skill sends the vault\'s text', async () => {
    // opencode's pick on a name clash isn't stable (seen: a skill pulled in after the first listing loses);
    // the backend always takes the vault's.
    const t = await setup();
    await t.api.get(`/vaults/${t.id}/commands`);
    await t.remote.obsidianPush({ '.agents/skills/research/SKILL.md': '---\nname: research\ndescription: VAULT\n---\n\nVAULT-RESEARCH-BODY\n' });
    await t.api.post(`/vaults/${t.id}/pull`);
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.filter((c: { name: string }) => c.name === 'research'))
      .toEqual([{ name: 'research', description: 'VAULT', source: 'vault', replaces: true }]);
    const { chatId } = (await t.api.post(`/vaults/${t.id}/chats`)).body;
    await t.api.post(`/vaults/${t.id}/chats/${chatId}/prompt`, { text: '/research x' });
    await waitIdle(t.chat, t.id, chatId);
    const hidden = (await userParts(t, chatId)).find((p) => p.synthetic)?.text ?? '';
    expect(hidden).toContain('VAULT-RESEARCH-BODY');
    expect(hidden).not.toContain('Research a topic on the web');
  });

  it('moved skills show', async () => {
    const t = await setup({ '.claude/skills/x/SKILL.md': '---\nname: x\ndescription: X\n---\n\nX.\n' });
    await t.api.post(`/vaults/${t.id}/open`);
    expect((await t.api.get(`/vaults/${t.id}/commands`)).body.map((c: { name: string }) => c.name)).toContain('x');
  });
});
