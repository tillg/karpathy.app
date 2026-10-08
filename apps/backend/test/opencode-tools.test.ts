import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../src/harness/map.js';
import { offerUrl } from '../../../deploy/opencode/lib/offer-url.js';
import { OpencodeHarness } from '../src/harness/opencode.js';
import { DEAD_MODEL, INTERNAL_TARGET, LLM_MODEL, startOpencode, testDir } from './opencode-container.js';

// The custom tools baked into the opencode image (deploy/opencode/tools), as the real container sees them.

let oc: Awaited<ReturnType<typeof startOpencode>>;
// A public-internet check is skipped offline.
const online = await fetch('https://www.w3.org/', { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then(() => true, () => false);
const vaultsDir = join(testDir('opencode-tools'), 'vaults');

beforeAll(async () => {
  oc = await startOpencode(vaultsDir);
}, 300_000);
afterAll(() => oc?.stop());

describe('opencode server password', () => {
  it('opencode refuses requests without the password', async () => {
    expect((await fetch(`${oc.url}/global/health`)).status).toBe(401);
    expect((await oc.fetch(`${oc.url}/global/health`)).status).toBe(200);
  });
});

describe('opencode custom tools', () => {
  it('opencode lists open_note as a tool', async () => {
    const r = await oc.fetch(`${oc.url}/experimental/tool/ids?directory=/vaults`);
    expect(r.status).toBe(200);
    expect(await r.json()).toContain('open_note');
  });

  it('opencode lists open_url as a tool', async () => {
    const r = await oc.fetch(`${oc.url}/experimental/tool/ids?directory=/vaults`);
    expect(await r.json()).toContain('open_url');
  });

  it('open_url is allowed for vault and vault-readonly, hidden for commit-message', async () => {
    const cfg = JSON.parse(await readFile(join(import.meta.dirname, '../../../deploy/opencode/opencode.json'), 'utf8'));
    expect(cfg.agent.vault.permission.open_url).toBe('allow');
    expect(cfg.agent['vault-readonly'].permission.open_url).toBe('allow');
    expect(cfg.agent['commit-message'].permission).toEqual({ '*': 'deny' });
  });

  it('open_url refuses ftp: and javascript: URLs', () => {
    expect(offerUrl('https://example.com/a?b=1')).toBe('offered https://example.com/a?b=1');
    for (const bad of ['ftp://example.com/x', 'javascript:alert(1)', 'not a url', 'file:///etc/passwd'])
      expect(() => offerUrl(bad)).toThrow(/Only http\(s\) pages can be opened/);
  });

  it('open_note is allowed for vault and vault-readonly, hidden for commit-message', async () => {
    const cfg = JSON.parse(await readFile(join(import.meta.dirname, '../../../deploy/opencode/opencode.json'), 'utf8'));
    expect(cfg.agent.vault.permission.open_note).toBe('allow');
    expect(cfg.agent['vault-readonly'].permission.open_note).toBe('allow');
    expect(cfg.agent['commit-message'].permission).toEqual({ '*': 'deny' });
  });
});

describe('move_to_sources tool', () => {
  /** Runs the baked tool's execute inside the container (opencode's own Bun) on a vault folder; one output line. */
  async function runMove(name: string) {
    await writeFile(join(vaultsDir, 'move.ts'), [
      "const t = (await import('/opt/opencode-config/opencode/tools/move_to_sources.ts')).default;",
      `try { console.log(JSON.stringify(await t.execute({ name: ${JSON.stringify(name)} }, { directory: '/vaults/move' }))); } catch (e) { console.log('ERR ' + e.message); }`,
    ].join('\n'));
    const r = spawnSync('docker', ['exec', '-e', 'BUN_BE_BUN=1', oc.name, 'opencode', 'run', '/vaults/move.ts'], { encoding: 'utf8' });
    return `${r.stdout}${r.stderr}`.trim();
  }

  it('opencode lists move_to_sources as a tool', async () => {
    const r = await oc.fetch(`${oc.url}/experimental/tool/ids?directory=/vaults`);
    expect(await r.json()).toContain('move_to_sources');
  });

  it('move_to_sources moves an item in agent vault', async () => {
    await mkdir(join(vaultsDir, 'move/Input/mail-2026-10-08-a'), { recursive: true });
    await writeFile(join(vaultsDir, 'move/Input/mail-2026-10-08-a/index.md'), '---\ntitle: a\n---\n');
    expect(JSON.parse(await runMove('mail-2026-10-08-a'))).toEqual({
      output: 'Moved to Sources/mail-2026-10-08-a',
      metadata: { files: [{ filePath: 'Input/mail-2026-10-08-a/index.md', movePath: 'Sources/mail-2026-10-08-a/index.md' }] },
    });
    expect(await readFile(join(vaultsDir, 'move/Sources/mail-2026-10-08-a/index.md'), 'utf8')).toContain('title: a');
    expect(await runMove('../x')).toMatch(/^ERR not an input item name/);
  });

  it('move_to_sources is not available in vault-readonly', async () => {
    const cfg = JSON.parse(await readFile(join(import.meta.dirname, '../../../deploy/opencode/opencode.json'), 'utf8'));
    expect(cfg.permission.move_to_sources).toBe('deny');
    expect(cfg.agent.vault.permission.move_to_sources).toBe('allow');
    expect(cfg.agent['vault-readonly'].permission.move_to_sources).toBeUndefined();
    expect(cfg.agent['commit-message'].permission).toEqual({ '*': 'deny' });
  });
});

describe('save_url tool', () => {
  /**
   * Runs the baked tool's execute inside the container, on opencode's own Bun, for each URL; one output line
   * each. A local server on :8080 answers with a PNG, so a call that gets past the proxy rules saves a file.
   */
  async function runSaveUrl(urls: string[], env: Record<string, string> = {}) {
    await mkdir(join(vaultsDir, 'save'), { recursive: true });
    await writeFile(join(vaultsDir, 'probe.ts'), [
      "const t = (await import('/opt/opencode-config/opencode/tools/save_url.ts')).default;",
      "const s = Bun.serve({ port: 8080, hostname: '0.0.0.0', fetch: () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }) });",
      `for (const [i, url] of ${JSON.stringify(urls)}.entries()) {`,
      "  try { console.log(await t.execute({ url, filePath: `probe-${i}.png` }, { directory: '/vaults/save' })); } catch (e) { console.log('ERR ' + e.message); }",
      '}',
      's.stop();',
    ].join('\n'));
    const r = spawnSync('docker', ['exec', '-e', 'BUN_BE_BUN=1', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), oc.name, 'opencode', 'run', '/vaults/probe.ts'], { encoding: 'utf8' });
    return `${r.stdout}${r.stderr}`.trim().split('\n');
  }

  it('opencode lists save_url as a tool', async () => {
    const r = await oc.fetch(`${oc.url}/experimental/tool/ids?directory=/vaults`);
    expect(await r.json()).toContain('save_url');
  });

  it('save_url is denied by default, allowed for vault only', async () => {
    const cfg = JSON.parse(await readFile(join(import.meta.dirname, '../../../deploy/opencode/opencode.json'), 'utf8'));
    expect(cfg.permission.save_url).toBe('deny');
    expect(cfg.agent.vault.permission.save_url).toBe('allow');
    expect(cfg.agent['vault-readonly'].permission.save_url).toBeUndefined();
    expect(cfg.agent['commit-message'].permission).toEqual({ '*': 'deny' });
  });

  it('save_url refuses without an egress proxy instead of going direct', async () => {
    expect(await runSaveUrl([`http://${INTERNAL_TARGET}/x.png`], { HTTP_PROXY: '' })).toEqual(['ERR No egress proxy configured: downloads are disabled']);
  });

  it('save_url reaches no internal host: the proxy refuses it, NO_PROXY hosts are refused before Bun goes direct', async () => {
    // compose's NO_PROXY, plus the internal target: Bun would fetch all of these without the proxy.
    const env = { NO_PROXY: `localhost,127.0.0.1,0.0.0.0,${INTERNAL_TARGET}` };
    const local = ['localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', '127.0.0.1', '127.1', '0', '2130706433', '[::1]'].map((h) => `http://${h}:8080/x.png`);
    const out = await runSaveUrl([...local, `http://${INTERNAL_TARGET}/x.png`, 'http://169.254.169.254/x.png'], env);
    expect(out).toHaveLength(local.length + 2);
    for (const line of out) expect(line).toMatch(/^ERR (internal host refused|download failed: HTTP 403)/);
    expect(await readdir(join(vaultsDir, 'save'))).toEqual([]);
  });

  it.skipIf(!online)('save_url saves a public image into the vault', async () => {
    expect(await runSaveUrl(['https://www.w3.org/Icons/w3c_home.png'])).toEqual([expect.stringMatching(/^saved probe-0\.png \(\d+ KB\)\. Embed it in a note with !\[\[probe-0\.png\]\]$/)]);
    expect((await readFile(join(vaultsDir, 'save/probe-0.png'))).subarray(1, 4).toString()).toBe('PNG');
  });
});

describe('skill folder', () => {
  it('only .agents/skills are skills', async () => {
    // Written before the first request for this directory: opencode caches the list per directory (F7).
    const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody of ${name}.\n`;
    await mkdir(join(vaultsDir, 'flag/.claude/skills/old'), { recursive: true });
    await writeFile(join(vaultsDir, 'flag/.claude/skills/old/SKILL.md'), skill('old'));
    await mkdir(join(vaultsDir, 'flag/.agents/skills/new'), { recursive: true });
    await writeFile(join(vaultsDir, 'flag/.agents/skills/new/SKILL.md'), skill('new'));
    const r = await oc.fetch(`${oc.url}/skill?directory=/vaults/flag`);
    expect(r.status).toBe(200);
    const names = ((await r.json()) as { name: string }[]).map((s) => s.name);
    expect(names).toContain('new');
    expect(names).not.toContain('old');
    // The image's skills stay (the flag drops only .claude/skills).
    expect(names).toContain('research');
  });
});

const skillMd = (name: string, description: string, body = `Body of ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
async function addSkill(vault: string, name: string, description: string) {
  await mkdir(join(vaultsDir, vault, '.agents/skills', name), { recursive: true });
  await writeFile(join(vaultsDir, vault, '.agents/skills', name, 'SKILL.md'), skillMd(name, description));
}

describe('command list', () => {
  it('command list: a vault skill appears, built-ins are hidden', async () => {
    await addSkill('cmds', 'hello', 'Says hello');
    const harness = new OpencodeHarness(oc.url, oc.password);
    const list = await harness.commands('/vaults/cmds');
    expect(list).toContainEqual(expect.objectContaining({ name: 'hello', description: 'Says hello', source: 'vault', template: expect.stringContaining('Body of hello.') }));
    const names = list.map((c) => c.name);
    for (const builtin of ['init', 'review', 'customize-opencode']) expect(names).not.toContain(builtin);
    expect((await harness.commands('/vaults')).map((c) => c.name)).not.toContain('hello');
  });

  it('research skill is in the command list', async () => {
    const harness = new OpencodeHarness(oc.url, oc.password);
    expect(await harness.commands('/vaults')).toContainEqual(expect.objectContaining({ name: 'research', source: 'app' }));
    // On a name clash opencode's own pick isn't stable (F2); the backend's rule is tested in chat.test.ts.
  });

  it('a skill added after the first listing shows after refresh', async () => {
    const harness = new OpencodeHarness(oc.url, oc.password);
    await harness.commands('/vaults/cmds');
    await addSkill('cmds', 'late', 'Comes late');
    expect((await harness.commands('/vaults/cmds')).map((c) => c.name)).not.toContain('late'); // F7
    await harness.refresh('/vaults/cmds');
    expect((await harness.commands('/vaults/cmds')).map((c) => c.name)).toContain('late');
  });

  it('events arrive after refresh', async () => {
    const harness = new OpencodeHarness(oc.url, oc.password);
    const dir = '/vaults/cmds';
    const events: HarnessEvent[] = [];
    const stop = harness.subscribe(dir, (e) => events.push(e));
    try {
      await new Promise((r) => setTimeout(r, 1000)); // connected
      await harness.refresh(dir);
      const id = await harness.createSession(dir);
      await harness.prompt(dir, id, { text: 'hi', agent: 'vault-readonly', model: DEAD_MODEL });
      const end = Date.now() + 15_000;
      while (!events.some((e) => e.type === 'message' && e.sessionId === id)) {
        if (Date.now() > end) throw new Error(`no message event after refresh: ${JSON.stringify(events.map((e) => e.type))}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      stop();
    }
  }, 30_000);
});

describe('opencode web tools', () => {
  it('websearch is offered to the model', async () => {
    const [provider, ...model] = LLM_MODEL.split('/');
    const r = await oc.fetch(`${oc.url}/experimental/tool?directory=/vaults&provider=${provider}&model=${model.join('/')}`);
    expect(r.status).toBe(200);
    const tools = (await r.json()) as { id: string }[];
    expect(tools.map((t) => t.id)).toContain('websearch');
  });

  it('the managed config stays fail-closed: web tools denied, commit-message has no tools', async () => {
    const cfg = JSON.parse(await readFile(join(import.meta.dirname, '../../../deploy/opencode/opencode.json'), 'utf8'));
    expect(cfg.permission.websearch).toBe('deny');
    expect(cfg.permission.webfetch).toBe('deny');
    expect(cfg.agent['commit-message'].permission).toEqual({ '*': 'deny' });
  });
});

describe('per-turn tools map', () => {
  it('prompt tools map becomes session permission', async () => {
    const harness = new OpencodeHarness(oc.url, oc.password);
    const dir = '/vaults';
    const id = await harness.createSession(dir);
    const rules = async () => ((await (await oc.fetch(`${oc.url}/session/${id}?directory=${dir}`)).json()) as { permission?: { permission: string; pattern: string; action: string }[] }).permission ?? [];
    // promptAsync returns before the session is updated: poll until the rules show up.
    const permission = async (want: string) => {
      for (let i = 0; i < 30; i++) {
        const r = await rules();
        if (r.some((x) => x.permission === 'websearch' && x.action === want)) return r;
        await new Promise((res) => setTimeout(res, 200));
      }
      return rules();
    };
    const settle = () => new Promise((r) => setTimeout(r, 1500)); // the dead model's turn fails fast
    await harness.prompt(dir, id, { text: 'hi', agent: 'vault-readonly', model: DEAD_MODEL, tools: { websearch: true, webfetch: true } });
    expect(await permission('allow')).toEqual(expect.arrayContaining([
      { permission: 'websearch', pattern: '*', action: 'allow' },
      { permission: 'webfetch', pattern: '*', action: 'allow' },
    ]));
    await settle();
    await harness.prompt(dir, id, { text: 'hi', agent: 'vault-readonly', model: DEAD_MODEL, tools: { websearch: false, webfetch: false } });
    expect(await permission('deny')).toEqual(expect.arrayContaining([
      { permission: 'websearch', pattern: '*', action: 'deny' },
      { permission: 'webfetch', pattern: '*', action: 'deny' },
    ]));
  });
});

describe('known-url plugin', () => {
  it('known-url plugin is loaded', async () => {
    // The plugin logs once when opencode loads it.
    const logs = await waitForLog(oc.name, /known-url ready/);
    expect(logs).toMatch(/known-url ready/);
  });

  it('web caps come from env', async () => {
    const capped = await startOpencode(join(testDir('opencode-caps'), 'vaults'), { WEB_FETCH_CAP: '1' });
    try {
      // Plugins load with the first instance (directory) a request touches.
      await capped.fetch(`${capped.url}/experimental/tool/ids?directory=/vaults`);
      expect(await waitForLog(capped.name, /known-url ready/)).toContain('fetch cap 1, search cap 20');
      expect(await waitForLog(oc.name, /known-url ready/)).toContain('fetch cap 20, search cap 20');
    } finally {
      capped.stop();
    }
  }, 120_000);
});

async function waitForLog(container: string, re: RegExp, ms = 15_000) {
  const end = Date.now() + ms;
  let logs = '';
  while (Date.now() < end) {
    const r = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
    logs = `${r.stdout}${r.stderr}`;
    if (re.test(logs)) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  return logs;
}
