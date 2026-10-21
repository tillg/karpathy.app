import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The commit's secret scan runs the pinned gitleaks from PATH, as in the backend image (#141).
const gitleaks = execFileSync('sh', ['../../deploy/gitleaks/install.sh'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' }).trim();
const env = { PATH: `${dirname(gitleaks)}:${process.env.PATH ?? ''}` };

// Three tiers (plan "Tooling assumptions"): default (no secrets), @github, @llm.
export default defineConfig({
  test: {
    env,
    projects: [
      { test: { name: 'default', env, include: ['test/**/*.test.ts'], exclude: ['test/**/*.github.test.ts', 'test/**/*.llm.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 } },
      { test: { name: 'github', env, include: ['test/**/*.github.test.ts'], testTimeout: 120_000 } },
      { test: { name: 'llm', env, include: ['test/**/*.llm.test.ts'], testTimeout: 900_000, hookTimeout: 120_000, fileParallelism: false } },
    ],
  },
});
