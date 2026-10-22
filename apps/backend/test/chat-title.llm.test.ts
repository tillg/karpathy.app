import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatService } from '../src/chat.js';
import { OpencodeHarness } from '../src/harness/opencode.js';
import { makeApp } from './app-helpers.js';
import { makeRemote } from './helpers.js';
import { startOpencode, testDir, testModels } from './opencode-container.js';

// @llm tier (#148): the chat-title agent of the opencode image, with the real test model as the title model.

// Always OpenRouter (production models); without a key this throws with what to do (pickTestModels).
const models = testModels();
const LLM_MODEL = models.model;

let oc: Awaited<ReturnType<typeof startOpencode>>;
const base = testDir('llm-title');
const vaultsDir = join(base, 'vaults');

beforeAll(async () => {
  oc = await startOpencode(vaultsDir, {}, models);
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

  it('after ten turns that left the title\'s topic, a suggestion with a new title appears and the title stays', async () => {
    const remote = await makeRemote({ 'Home.md': '# Home\n' }, { name: `d${Math.random().toString(36).slice(2, 7)}` });
    const t = await makeApp(remote.remoteBase, { dirs: { config: join(base, `config-${Math.random()}`), vaults: vaultsDir } });
    await t.store.update((c) => { c.settings.model = LLM_MODEL; c.settings.titleModel = LLM_MODEL; });
    const chat = new ChatService(t.vaults, t.store, new OpencodeHarness(oc.url, oc.password), '/vaults');
    const id = await t.addVault(remote.repo, { name: remote.repo.split('/')[1] });
    const { chatId } = await chat.create(id);
    const turn = async (text: string) => {
      await chat.prompt(id, chatId, text);
      await new Promise<void>((resolve) => chat.stream(id, chatId, () => undefined, resolve));
    };
    const first = 'Give me one tip for growing tomatoes on a balcony. One sentence, use no tools.';
    await turn(first);
    await turn('Which tomato variety suits a small pot? One sentence, use no tools.');
    // Small models answer "keep" when asked whether a title still fits (#148): the check must not rely on that.
    // The preliminary title (the first prompt) names tomatoes too: wait for the generated one (#172).
    const end2 = Date.now() + 120_000;
    let title = first;
    while ((title === first || !/tomat/i.test(title)) && Date.now() < end2) {
      await new Promise((r) => setTimeout(r, 1000));
      title = (await chat.get(id, chatId)).title;
    }
    if (title === first || !/tomat/i.test(title)) throw new Error(`INCONCLUSIVE: no generated turn-2 title that names tomatoes: ${title}`);
    for (const q of ['flour for sourdough bread', 'proofing time for sourdough', 'oven temperature for sourdough bread', 'feeding a sourdough starter',
      'why sourdough bread turns out dense', 'baking sourdough in a Dutch oven', 'scoring sourdough bread', 'storing baked sourdough bread'])
      await turn(`A question about ${q}: answer in one sentence, use no tools.`);
    const end = Date.now() + 120_000;
    let d = await chat.get(id, chatId);
    while (!d.titleSuggestion && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 1000));
      d = await chat.get(id, chatId);
    }
    expect(d.titleSuggestion).toBeTruthy();
    expect(d.titleSuggestion).not.toMatch(/tomat/i);
    expect(d.title).toBe(title);
    chat.close();
    await t.vaults.close();
  }, 900_000);
});
