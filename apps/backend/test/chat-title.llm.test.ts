import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatService } from '../src/chat.js';
import { OpencodeHarness } from '../src/harness/opencode.js';
import { makeApp } from './app-helpers.js';
import { makeRemote } from './helpers.js';
import { LLM_MODEL, startOpencode, testDir } from './opencode-container.js';

// @llm tier (#148): the chat-title agent of the opencode image, with the real test model as the title model.

let oc: Awaited<ReturnType<typeof startOpencode>>;
const base = testDir('llm-title');
const vaultsDir = join(base, 'vaults');

beforeAll(async () => {
  oc = await startOpencode(vaultsDir);
}, 120_000);
afterAll(() => oc?.stop());

const FIRST = 'hi';

describe('chat titles with a real model', () => {
  it('after two turns the title is short and no longer the first prompt; the throwaway session is gone', async () => {
    const remote = await makeRemote({ 'Home.md': '# Home\n' }, { name: `t${Math.random().toString(36).slice(2, 7)}` });
    const t = await makeApp(remote.remoteBase, { dirs: { config: join(base, `config-${Math.random()}`), vaults: vaultsDir } });
    await t.store.update((c) => { c.settings.model = LLM_MODEL; c.settings.titleModel = LLM_MODEL; });
    const chat = new ChatService(t.vaults, t.store, new OpencodeHarness(oc.url, oc.password), '/vaults');
    const id = await t.addVault(remote.repo, { name: remote.repo.split('/')[1] });
    const { chatId } = await chat.create(id);
    for (const text of [FIRST, 'Give me three tips for growing tomatoes on a balcony. Answer in two sentences, use no tools.']) {
      await chat.prompt(id, chatId, text);
      await new Promise<void>((resolve) => chat.stream(id, chatId, () => undefined, resolve));
    }
    // The title job runs after the turn's end, in the background.
    const end = Date.now() + 300_000;
    let title = FIRST;
    while (title === FIRST && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 1000));
      title = (await chat.get(id, chatId)).title;
    }
    expect(title).not.toBe(FIRST);
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title).not.toContain('\n');
    // Wait for the job's cleanup, then only the chat itself is listed.
    await new Promise((r) => setTimeout(r, 2000));
    expect((await chat.list(id)).map((c) => c.id)).toEqual([chatId]);
    chat.close();
    await t.vaults.close();
  }, 900_000);
});
