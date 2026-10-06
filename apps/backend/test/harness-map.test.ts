import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapEvent, mapMessages, mapToolPart, toVaultPath, writtenPaths, type HarnessEvent } from '../src/harness/map.js';

// Real opencode 1.18.25 event captures from the Phase 0 spike (vault root /vaults/a).
const raw = readFileSync(join(import.meta.dirname, 'fixtures/opencode-events.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const events = raw.map((e) => mapEvent(e, '/vaults/a')).filter((e): e is HarnessEvent => e !== null);

describe('opencode → harness mapping (real captures)', () => {
  it('maps busy/idle status, messages, text deltas', () => {
    const states = events.filter((e) => e.type === 'status').map((e) => (e as { state: string }).state);
    expect(states).toContain('busy');
    expect(states).toContain('idle');
    expect(events.some((e) => e.type === 'message' && e.message.role === 'user')).toBe(true);
    expect(events.some((e) => e.type === 'text-delta' && e.delta.length > 0)).toBe(true);
  });

  it('maps write/edit tool parts with vault-relative paths; denied calls get status denied', () => {
    const tools = events.flatMap((e) => (e.type === 'part' && e.part.type === 'tool' ? [e.part.call] : []));
    const completedWrite = tools.find((t) => t.tool === 'write' && t.status === 'completed');
    expect(completedWrite).toMatchObject({ writes: true });
    expect(completedWrite!.path).not.toMatch(/^\/vaults\/a\//);
    const denied = tools.find((t) => t.status === 'denied');
    expect(denied).toMatchObject({ tool: 'write', path: 'opencode.json' });
    expect(denied!.error).toBeUndefined();
  });

  it('open_note maps to opens: true, writes: false, vault-relative path', () => {
    const opens = events.flatMap((e) => (e.type === 'part' && e.part.type === 'tool' && e.part.call.tool === 'open_note' ? [e.part.call] : []));
    expect(opens.find((t) => t.status === 'completed')).toMatchObject({ opens: true, writes: false, path: 'notes/Todo.md' });
    // Other tools don't open anything.
    const others = events.flatMap((e) => (e.type === 'part' && e.part.type === 'tool' && e.part.call.tool !== 'open_note' ? [e.part.call] : []));
    expect(others.length).toBeGreaterThan(0);
    for (const t of others) expect(t.opens).toBe(false);
  });

  it('writtenPaths ignores open_note', () => {
    const parts = raw.filter((e) => e.type === 'message.part.updated' && e.properties.part.tool === 'open_note').map((e) => e.properties.part);
    expect(parts.some((p) => p.state.status === 'completed')).toBe(true);
    for (const p of parts) expect(writtenPaths(p, '/vaults/a')).toEqual([]);
  });

  it('file.edited → vault-relative path', () => {
    const fe = events.filter((e) => e.type === 'file-edited');
    expect(fe.length).toBeGreaterThan(0);
    for (const e of fe) expect((e as { path: string }).path.startsWith('/')).toBe(false);
  });
});

describe('mapping edge cases', () => {
  it('relative tool paths are resolved against the vault root (#12)', () => {
    expect(toVaultPath('./Home.md', '/vaults/a')).toBe('Home.md');
    expect(toVaultPath('notes/../Home.md', '/vaults/a')).toBe('Home.md');
    expect(toVaultPath('../b/x.md', '/vaults/a')).toBe('/vaults/b/x.md');
    // The vault root itself: no container path in the chip.
    expect(toVaultPath('/vaults/a', '/vaults/a')).toBe('');
    expect(mapToolPart({ id: 'p', tool: 'glob', state: { status: 'completed', input: { path: '/vaults/a' } } }, '/vaults/a').path).toBeUndefined();
  });

  it('paths outside the root stay absolute', () => {
    expect(toVaultPath('/vaults/b/x.md', '/vaults/a')).toBe('/vaults/b/x.md');
    expect(toVaultPath('/vaults/a/n/x.md', '/vaults/a')).toBe('n/x.md');
  });

  it('apply_patch files come from metadata', () => {
    const part = { id: 'p', tool: 'apply_patch', state: { status: 'completed', input: { patchText: '…' }, metadata: { files: [{ filePath: '/vaults/a/x.md' }, { filePath: '/vaults/a/y.md', movePath: '/vaults/a/z.md' }] } } };
    expect(mapToolPart(part, '/vaults/a')).toMatchObject({ path: 'x.md', writes: true, status: 'completed' });
    expect(writtenPaths(part, '/vaults/a')).toEqual(['x.md', 'y.md', 'z.md']);
  });

  it('real captured websearch and webfetch parts map to query / url', () => {
    const tools = events.flatMap((e) => (e.type === 'part' && e.part.type === 'tool' ? [e.part.call] : []));
    expect(tools.find((t) => t.tool === 'websearch')).toMatchObject({ status: 'completed', query: expect.any(String), writes: false });
    expect(tools.find((t) => t.tool === 'webfetch')).toMatchObject({ status: 'completed', url: 'https://example.com/', writes: false });
    for (const t of tools.filter((x) => x.tool === 'websearch' || x.tool === 'webfetch')) expect(t).not.toHaveProperty('path');
  });

  it('websearch → query', () => {
    const part = { id: 'w1', tool: 'websearch', state: { status: 'completed', input: { query: 'obsidian sync' }, output: 'results…' } };
    const call = mapToolPart(part, '/vaults/a');
    expect(call).toMatchObject({ tool: 'websearch', query: 'obsidian sync', status: 'completed', writes: false, opens: false });
    expect(call).not.toHaveProperty('path');
    expect(call).not.toHaveProperty('url');
  });

  it('webfetch → url', () => {
    const part = { id: 'w2', tool: 'webfetch', state: { status: 'completed', input: { url: 'https://example.com/a/b' }, output: 'page…' } };
    const call = mapToolPart(part, '/vaults/a');
    expect(call).toMatchObject({ tool: 'webfetch', url: 'https://example.com/a/b', status: 'completed', writes: false, opens: false });
    expect(call).not.toHaveProperty('path');
    expect(call).not.toHaveProperty('query');
  });

  it('open_url part → url set, opens false, writes false', () => {
    const part = { id: 'o1', tool: 'open_url', state: { status: 'completed', input: { url: 'https://example.com/a' }, output: 'offered https://example.com/a' } };
    const call = mapToolPart(part, '/vaults/a');
    expect(call).toMatchObject({ tool: 'open_url', url: 'https://example.com/a', status: 'completed', writes: false, opens: false });
    expect(call).not.toHaveProperty('path');
  });

  it('writtenPaths ignores web tools', () => {
    expect(writtenPaths({ id: 'w1', tool: 'websearch', state: { status: 'completed', input: { query: 'x' }, output: 'y' } }, '/vaults/a')).toEqual([]);
    expect(writtenPaths({ id: 'w2', tool: 'webfetch', state: { status: 'completed', input: { url: 'https://example.com/x.md' }, output: 'y' } }, '/vaults/a')).toEqual([]);
  });

  it('abort → error event with aborted flag', () => {
    const e = mapEvent({ type: 'session.error', properties: { sessionID: 's', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } }, '/v');
    expect(e).toEqual({ type: 'error', sessionId: 's', message: 'Aborted', aborted: true });
  });
});

describe('user file parts (real capture: a prompt with an attached PNG, chat.test "file part")', () => {
  const stored = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/opencode-user-file.json'), 'utf8'));

  it('user file part maps to a file chat part', () => {
    const [m] = mapMessages([stored], '/vaults/x');
    expect(m!.parts).toEqual([
      { type: 'text', id: expect.any(String), text: 'what is this?' },
      { type: 'file', id: expect.any(String), path: 'Sources/upload-2026-10-04-091500/shot.png', mime: 'image/png' },
    ]);
    // The data URL (the file's bytes) never goes to the browser.
    expect(JSON.stringify(m)).not.toContain('data:');
  });

  it('a file part without a file name maps to nothing', () => {
    const noName = { ...stored, parts: stored.parts.map((p: Record<string, unknown>) => (p.type === 'file' ? { ...p, filename: undefined } : p)) };
    expect(mapMessages([noName], '/vaults/x')[0]!.parts.map((p) => p.type)).toEqual(['text']);
  });
});
