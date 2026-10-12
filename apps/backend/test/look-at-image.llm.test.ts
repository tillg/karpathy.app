import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolCall } from '@karpathy/shared';
import { ChatService } from '../src/chat.js';
import { OpencodeHarness } from '../src/harness/opencode.js';
import { makeApp } from './app-helpers.js';
import { makeRemote } from './helpers.js';
import { LLM_MODEL, startOpencode, testDir } from './opencode-container.js';

// @llm tier: the chat model (text-only qwen2.5:3b) calls look_at_image and the real vision model (qwen3-vl:2b)
// describes the image. Assertions check the tool call and its output, never the chat model's wording.

let oc: Awaited<ReturnType<typeof startOpencode>>;
const base = testDir('look-at-image-llm');
const vaultsDir = join(base, 'vaults');

beforeAll(async () => {
  oc = await startOpencode(vaultsDir);
}, 120_000);
afterAll(() => oc?.stop());

/** A solid-red PNG of `size` x `size` pixels. */
function redPng(size = 64): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), out.length - 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [255, 0, 0]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe('@llm look_at_image', () => {
  it('@llm a chat turn about a red PNG calls look_at_image and the vision model names red', async () => {
    const remote = await makeRemote({ 'Home.md': '# Home\n' }, { name: `v${Math.random().toString(36).slice(2, 7)}` });
    const t = await makeApp(remote.remoteBase, { dirs: { config: join(base, `config-${Math.random()}`), vaults: vaultsDir } });
    await t.store.update((c) => { c.settings.model = LLM_MODEL; });
    const chat = new ChatService(t.vaults, t.store, new OpencodeHarness(oc.url, oc.password), '/vaults');
    const id = await t.addVault(remote.repo, { name: remote.repo.split('/')[1] });
    await mkdir(join(t.vaults.vaultRootDir(id), 'Photos'), { recursive: true });
    await writeFile(join(t.vaults.vaultRootDir(id), 'Photos/square.png'), redPng());

    const run = async () => {
      const chatId = (await chat.create(id)).chatId;
      const tools = new Map<string, ToolCall>();
      await chat.prompt(id, chatId, 'Use the look_at_image tool on Photos/square.png and tell me its colour.');
      await new Promise<void>((resolve) => {
        chat.stream(id, chatId, (e) => { if (e.type === 'part' && e.part.type === 'tool') tools.set(e.part.id, e.part.call); }, resolve);
      });
      const res = await oc.fetch(`${oc.url}/session/${chatId}/message?directory=${chat.dir(id)}`);
      const msgs = (await res.json()) as { parts: { type: string; tool?: string; state?: { status: string; output?: string; error?: string } }[] }[];
      return msgs.flatMap((m) => m.parts).filter((p) => p.type === 'tool' && p.tool === 'look_at_image');
    };
    let parts = await run();
    if (!parts.length) parts = await run(); // at most one retry
    if (!parts.length) throw new Error('INCONCLUSIVE: the chat model did not call look_at_image');
    expect(parts[0]!.state?.error).toBeUndefined();
    expect(parts[0]!.state?.output?.toLowerCase()).toMatch(/red/);
  }, 600_000);
});
