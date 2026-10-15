import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VaultEvent } from '@karpathy/shared';
import { BROWSER_CALLS_DIR, BrowserCalls } from '../src/browser-calls.js';
import { testDir } from './opencode-container.js';

// Pending browser calls (#151): announced on the vault event stream, answered once by the tab, handed to the waiting
// tool as <vaults>/.browser-calls/<chat>/<call>.json.

/** The file name of an id, as the tool and the backend compute it. */
const fk = (id: string) => Buffer.from(id).toString('base64url');

const pos = { latitude: 48.137154, longitude: 11.576124, accuracy: 12, ageMs: 3000 };

function setup(opts: { timeoutMs?: number; graceMs?: number } = {}) {
  const vaultsDir = join(testDir('browser-calls'), `v${Math.random().toString(36).slice(2, 8)}`);
  const events: { vaultId: string; e: VaultEvent }[] = [];
  const calls = new BrowserCalls(vaultsDir, (vaultId, e) => events.push({ vaultId, e }), opts);
  const call = (callId = 'call_1', chatId = 'ses_a') => ({ vaultId: 'v1', chatId, callId, tool: 'user_location', input: {}, tabId: 'tab-12345678' });
  const answerFile = (chatId: string, callId: string) => join(vaultsDir, BROWSER_CALLS_DIR, fk(chatId), `${fk(callId)}.json`);
  return { vaultsDir, events, calls, call, answerFile };
}

const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status);

describe('BrowserCalls', () => {
  it('open emits browser-call once per call id', () => {
    const t = setup();
    t.calls.open(t.call());
    t.calls.open(t.call());
    const announced = t.events.filter((x) => x.e.type === 'browser-call');
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ vaultId: 'v1', e: { type: 'browser-call', call: { chatId: 'ses_a', callId: 'call_1', tool: 'user_location', tabId: 'tab-12345678' } } });
    t.calls.close('v1', 'ses_a', 'call_1');
  });

  it('answer writes the file once, unrounded; a second answer is 409', async () => {
    const t = setup();
    t.calls.open(t.call());
    await t.calls.answer('v1', 'ses_a', 'call_1', { ok: true, value: pos });
    expect(JSON.parse(await readFile(t.answerFile('ses_a', 'call_1'), 'utf8'))).toEqual({ ok: true, value: pos });
    expect(t.events.map((x) => x.e.type)).toEqual(['browser-call', 'browser-call-done']);
    expect(await status(t.calls.answer('v1', 'ses_a', 'call_1', { ok: false, reason: 'denied' }))).toBe(409);
  });

  it('unknown call 404, wrong chat 404, wrong vault 404, bad body 400', async () => {
    const t = setup();
    t.calls.open(t.call());
    expect(await status(t.calls.answer('v1', 'ses_a', 'nope', { ok: false, reason: 'denied' }))).toBe(404);
    expect(await status(t.calls.answer('v1', 'ses_b', 'call_1', { ok: false, reason: 'denied' }))).toBe(404);
    expect(await status(t.calls.answer('v2', 'ses_a', 'call_1', { ok: false, reason: 'denied' }))).toBe(404);
    expect(await status(t.calls.answer('v1', 'ses_a', 'call_1', { ok: true, value: { ...pos, latitude: 99 } }))).toBe(400);
    t.calls.close('v1', 'ses_a', 'call_1');
  });

  it('after the deadline the call is dropped, browser-call-done emitted, an answer is 404', async () => {
    const t = setup({ timeoutMs: 100, graceMs: 50 });
    t.calls.open(t.call());
    await new Promise((r) => setTimeout(r, 300));
    expect(t.events.map((x) => x.e.type)).toEqual(['browser-call', 'browser-call-done']);
    expect(t.calls.pending('v1')).toEqual([]);
    expect(await status(t.calls.answer('v1', 'ses_a', 'call_1', { ok: false, reason: 'denied' }))).toBe(404);
  });

  it('close drops the call and removes a stale answer file', async () => {
    const t = setup();
    t.calls.open(t.call());
    await t.calls.answer('v1', 'ses_a', 'call_1', { ok: false, reason: 'denied' });
    t.calls.close('v1', 'ses_a', 'call_1');
    await new Promise((r) => setTimeout(r, 50));
    expect(await readdir(join(t.vaultsDir, BROWSER_CALLS_DIR, fk('ses_a')))).toEqual([]);
  });

  it('pending(vault) lists the open calls of that vault only', () => {
    const t = setup();
    t.calls.open(t.call('call_1'));
    t.calls.open({ ...t.call('call_2'), vaultId: 'v2' });
    expect(t.calls.pending('v1').map((c) => c.callId)).toEqual(['call_1']);
    expect(t.calls.pending('v1')[0]!.deadline).toBeGreaterThan(Date.now());
    t.calls.close('v1', 'ses_a', 'call_1');
    t.calls.close('v2', 'ses_a', 'call_2');
  });

  it('removeChat drops its calls and removes .browser-calls/<chat>', async () => {
    const t = setup();
    t.calls.open(t.call('call_1', 'ses_x'));
    await mkdir(join(t.vaultsDir, BROWSER_CALLS_DIR, fk('ses_x')), { recursive: true });
    await writeFile(join(t.vaultsDir, BROWSER_CALLS_DIR, fk('ses_x'), 'old.json'), '{}');
    await t.calls.removeChat('v1', 'ses_x');
    expect(t.calls.pending('v1')).toEqual([]);
    expect(await readdir(join(t.vaultsDir, BROWSER_CALLS_DIR))).not.toContain(fk('ses_x'));
  });

  it('any call id works (providers send e.g. functions.user_location:0): the file name is encoded, never a path', async () => {
    const t = setup();
    for (const id of ['functions.user_location:0', '../../etc/passwd']) {
      t.calls.open(t.call(id));
      await t.calls.answer('v1', 'ses_a', id, { ok: false, reason: 'denied' });
    }
    const files = await readdir(join(t.vaultsDir, BROWSER_CALLS_DIR, fk('ses_a')));
    expect(files).toHaveLength(2);
    for (const f of files) expect(f).toMatch(/^[A-Za-z0-9_-]+\.json$/);
    expect(() => t.calls.open(t.call('call_1', 'a/b'))).not.toThrow();
    expect(await readdir(join(t.vaultsDir, BROWSER_CALLS_DIR))).not.toContain('a');
  });

  it('the same call id in two vaults or chats is two calls', async () => {
    const t = setup();
    t.calls.open(t.call('call_0'));
    t.calls.open({ ...t.call('call_0'), vaultId: 'v2' });
    t.calls.open(t.call('call_0', 'ses_b'));
    expect(t.events.filter((x) => x.e.type === 'browser-call')).toHaveLength(3);
    await t.calls.answer('v2', 'ses_a', 'call_0', { ok: false, reason: 'denied' });
    expect(t.calls.pending('v1').map((c) => c.chatId).sort()).toEqual(['ses_a', 'ses_b']);
    t.calls.close('v1', 'ses_a', 'call_0');
    t.calls.close('v1', 'ses_b', 'call_0');
  });

  it('a failed write leaves the call answerable', async () => {
    const t = setup();
    t.calls.open(t.call('call_w'));
    await mkdir(t.vaultsDir, { recursive: true });
    await writeFile(join(t.vaultsDir, BROWSER_CALLS_DIR), 'not a dir');
    expect(await status(t.calls.answer('v1', 'ses_a', 'call_w', { ok: false, reason: 'denied' }))).not.toBe(200);
    await rm(join(t.vaultsDir, BROWSER_CALLS_DIR));
    expect(await status(t.calls.answer('v1', 'ses_a', 'call_w', { ok: false, reason: 'denied' }))).toBe(200);
  });

  it('closeVault ends every call of a vault (the turn ended; calls of subagent sessions included)', async () => {
    const t = setup();
    t.calls.open(t.call('c1', 'ses_parent'));
    t.calls.open(t.call('c2', 'ses_child'));
    t.calls.open({ ...t.call('c3'), vaultId: 'v2' });
    await t.calls.closeVault('v1');
    expect(t.calls.pending('v1')).toEqual([]);
    expect(t.calls.pending('v2')).toHaveLength(1);
    t.calls.close('v2', 'ses_a', 'c3');
  });
});
