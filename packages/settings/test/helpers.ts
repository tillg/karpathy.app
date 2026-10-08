import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A temp directory with the given files (name → content). */
export function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'settings-test-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/** A complete central settings.yaml; `extra` is appended (top-level keys must not repeat). */
export const CENTRAL = `
ai:
  gateway: ollama
  model: ollama/small
  web: { access: true, fetch_cap: 20, search_cap: 20, exa_api_key: { secret: exa_api_key, optional: true } }
auth:
  bearer_token: { secret: bearer_token }
  opencode_password: { secret: opencode_password }
git:
  remote_base: https://github.com/
  author: { name: karpathy.app user, email: user@karpathy.app }
  github_token: { secret: github_token, optional: true }
proxy:
  domain: localhost
  tls: internal
  dns: { provider: godaddy, api_token: { secret: dns_api_token, optional: true } }
timezone: Etc/UTC
commit_reminder_threshold: 4
files: { visible_dot_dirs: [.agents] }
gateways:
  ollama:
    kind: openai-compatible
    base_url: http://ollama.internal:11434/v1
    relay_upstream: host.docker.internal:11434
    models:
      small: { tool_call: true }
      vision: { tool_call: true }
  openrouter:
    kind: openrouter
    api_key: { secret: openrouter_api_key }
    models:
      z-ai/glm-5.3: { options: { provider: { zdr: true } } }
`;
