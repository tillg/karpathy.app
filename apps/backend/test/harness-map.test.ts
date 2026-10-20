import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapEvent, mapMessageInfo, mapMessages, mapModels, mapPart, withLimit, mapToolPart, usageRows, usageSessions, toVaultPath, writtenPaths, type HarnessEvent } from '../src/harness/map.js';

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
  it('user_location maps as a browser tool with its opencode call id (#151)', () => {
    const part = { id: 'prt_1', callID: 'call_9', tool: 'user_location', state: { status: 'running', input: {} } };
    expect(mapToolPart(part, '/vaults/a')).toMatchObject({ id: 'prt_1', tool: 'user_location', status: 'running', browser: true, callId: 'call_9' });
    expect(mapToolPart({ ...part, tool: 'read' }, '/vaults/a')).not.toHaveProperty('browser');
  });

  it('a completed browser tool shows the chip title from its metadata (#151)', () => {
    const part = { id: 'prt_1', callID: 'call_9', tool: 'user_location', state: { status: 'completed', input: {}, title: '', metadata: { title: 'used your location (±12 m)' } } };
    expect(mapToolPart(part, '/vaults/a')).toMatchObject({ title: 'used your location (±12 m)' });
  });

  it('a synthetic text part (command instructions, the local-time line) is not shown in the chat', () => {
    expect(mapPart({ id: 'p', type: 'text', text: "User's local time: …", synthetic: true }, '/vaults/a')).toBeNull();
  });

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

  it('move_to_sources part yields file-edited for Input/x and Sources/x', () => {
    const files = [
      { filePath: 'Input/x/index.md', movePath: 'Sources/x/index.md' },
      { filePath: 'Input/x/photo.jpg', movePath: 'Sources/x/photo.jpg' },
    ];
    const part = { id: 'm1', tool: 'move_to_sources', state: { status: 'completed', input: { name: 'x' }, output: 'Moved to Sources/x', metadata: { files } } };
    expect(mapToolPart(part, '/vaults/a')).toMatchObject({ tool: 'move_to_sources', path: 'Sources/x', writes: true });
    expect(writtenPaths(part, '/vaults/a')).toEqual(['Input/x/index.md', 'Sources/x/index.md', 'Input/x/photo.jpg', 'Sources/x/photo.jpg']);
    expect(writtenPaths({ ...part, state: { ...part.state, status: 'error' } }, '/vaults/a')).toEqual([]);
  });

  it('suggest_next carries its prompt as suggestion; it writes and opens nothing', () => {
    const part = { id: 'g1', tool: 'suggest_next', state: { status: 'completed', input: { prompt: 'Summarize the open points' }, output: 'suggested: Summarize the open points' } };
    const call = mapToolPart(part, '/vaults/a');
    expect(call).toMatchObject({ tool: 'suggest_next', status: 'completed', suggestion: 'Summarize the open points', writes: false, opens: false });
    expect(call.path).toBeUndefined();
    expect(mapToolPart({ id: 'r', tool: 'read', state: { status: 'completed', input: { prompt: 'x', filePath: 'a.md' } } }, '/vaults/a').suggestion).toBeUndefined();
    expect(writtenPaths(part, '/vaults/a')).toEqual([]);
  });

  it('suggest_next collapses whitespace like the tool does, so Tab never inserts a newline (#145)', () => {
    const part = { id: 'g2', tool: 'suggest_next', state: { status: 'running', input: { prompt: '  Summarize\n the   open\tpoints \n' } } };
    expect(mapToolPart(part, '/vaults/a').suggestion).toBe('Summarize the open points');
  });

  it('save_url writes its filePath and keeps its url', () => {
    const part = { id: 's1', tool: 'save_url', state: { status: 'completed', input: { url: 'https://a.com/c.png', filePath: 'notes/c.png' }, output: 'saved notes/c.png (1 KB).' } };
    expect(mapToolPart(part, '/vaults/a')).toMatchObject({ tool: 'save_url', path: 'notes/c.png', url: 'https://a.com/c.png', writes: true, opens: false });
    expect(writtenPaths(part, '/vaults/a')).toEqual(['notes/c.png']);
    expect(writtenPaths({ ...part, state: { ...part.state, status: 'error' } }, '/vaults/a')).toEqual([]);
  });

  it('save_url with a note also reports the note as written (metadata.files)', () => {
    const part = { id: 's2', tool: 'save_url', state: { status: 'completed', input: { url: 'https://a.com/c.png', filePath: 'notes/c.png', note: 'Ideas.md' }, output: 'saved', metadata: { files: [{ filePath: 'Ideas.md' }] } } };
    expect(mapToolPart(part, '/vaults/a')).toMatchObject({ path: 'notes/c.png', writes: true });
    expect(writtenPaths(part, '/vaults/a')).toEqual(['notes/c.png', 'Ideas.md']);
  });

  it('save_url without filePath takes the saved file and the note from metadata.files', () => {
    const part = { id: 's3', tool: 'save_url', state: { status: 'completed', input: { url: 'https://a.com/c.png', note: 'n/Ideas.md' }, output: 'saved', metadata: { files: [{ filePath: 'n/c.png' }, { filePath: 'n/Ideas.md' }] } } };
    expect(mapToolPart(part, '/vaults/a')).toMatchObject({ path: 'n/c.png', writes: true });
    expect(writtenPaths(part, '/vaults/a')).toEqual(['n/c.png', 'n/Ideas.md']);
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

describe('context used (#140)', () => {
  const info = (tokens: unknown, role = 'assistant') => ({ id: 'm1', role, time: { created: 1 }, providerID: 'p', modelID: 'm', tokens });
  const t = { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 3 } };

  it('assistant tokens → used = total', () => {
    expect(mapMessageInfo(info({ ...t, total: 4242 })).context).toEqual({ used: 4242 });
  });
  it('no total → input + output + reasoning + cache read + cache write', () => {
    expect(mapMessageInfo(info(t)).context).toEqual({ used: 1128 });
  });
  it('zero tokens (a reply still starting) → no context', () => {
    expect(mapMessageInfo(info({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).context).toBeUndefined();
  });
  it('user message → no context', () => {
    expect(mapMessageInfo({ id: 'u', role: 'user', time: { created: 1 }, model: { providerID: 'p', modelID: 'm' } }).context).toBeUndefined();
  });
});

describe('context window (#140)', () => {
  const providers = { providers: [{ id: 'openrouter', models: {
    'qwen2.5:3b': { capabilities: { input: { image: false, pdf: false } }, limit: { context: 16384, output: 4096 } },
    'nolimit': { capabilities: { input: { image: true, pdf: false } }, limit: { context: 0, output: 0 } },
  } }] };

  it('mapModels keeps what the model reads and its context window', () => {
    expect(mapModels(providers)).toEqual([
      { id: 'openrouter/qwen2.5:3b', input: { image: false, pdf: false }, limit: 16384 },
      { id: 'openrouter/nolimit', input: { image: true, pdf: false } },
    ]);
  });

  it('withLimit adds the window of the message\'s model', () => {
    const limits = new Map([['openrouter/qwen2.5:3b', 16384]]);
    expect(withLimit({ id: 'm', role: 'assistant', createdAt: 1, model: 'openrouter/qwen2.5:3b', context: { used: 10 } }, limits).context).toEqual({ used: 10, limit: 16384 });
  });

  it('unknown model → no limit; no context → unchanged', () => {
    const limits = new Map([['openrouter/qwen2.5:3b', 16384]]);
    expect(withLimit({ id: 'm', role: 'assistant', createdAt: 1, model: 'x/y', context: { used: 10 } }, limits).context).toEqual({ used: 10 });
    const user = { id: 'u', role: 'user' as const, createdAt: 1, model: 'openrouter/qwen2.5:3b' };
    expect(withLimit(user, limits)).toEqual(user);
  });
});

describe('usageRows', () => {
  it('usageRows: assistant messages give created, model id, input/output/reasoning/cache read/write and cost; user messages and messages without tokens are skipped', () => {
    const rows = usageRows([
      { info: { id: 'u1', role: 'user', time: { created: 1 }, model: { providerID: 'p', modelID: 'm' } }, parts: [] },
      {
        info: {
          id: 'a1', role: 'assistant', providerID: 'openrouter', modelID: 'qwen', time: { created: 1700000000000, completed: 1700000005000 }, cost: 0.25,
          tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        },
        parts: [],
      },
      { info: { id: 'a2', role: 'assistant', providerID: 'openrouter', modelID: 'qwen', time: { created: 2 } }, parts: [] },
    ]);
    expect(rows).toEqual([{ created: 1700000000000, model: 'openrouter/qwen', input: 10, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25, completed: true }]);
  });

  it('usageRows: a message without time.completed (mid-turn) is completed: false', () => {
    const rows = usageRows([
      { info: { id: 'a', role: 'assistant', providerID: 'p', modelID: 'm', time: { created: 5 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] },
    ]);
    expect(rows.map((r) => r.completed)).toEqual([false]);
  });
});

describe('usageSessions', () => {
  it('keeps every session of the directory, children included, as { id, updatedAt }', () => {
    const list = [
      { id: 'root', directory: '/v/a', parentID: undefined, title: 't', time: { created: 1, updated: 10 } },
      { id: 'child', directory: '/v/a', parentID: 'root', title: 'c', time: { created: 2, updated: 20 } },
      { id: 'other', directory: '/v/b', time: { created: 3, updated: 30 } },
    ];
    expect(usageSessions(list, '/v/a')).toEqual([{ id: 'root', updatedAt: 10 }, { id: 'child', updatedAt: 20 }]);
  });
});
