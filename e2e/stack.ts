import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which stack the e2e suite runs against (the TypeScript twin of `stack_resolve` in deploy/stack.sh, minus
 * claiming one). E2E_BASE_URL means a non-dev stack (prodtest, a deploy target) and is used as-is; otherwise
 * dev stack N from STACK or this checkout's tmp/dev/stack: https://localhost:80N0, compose project karpathy-app-N.
 */
export function stackTarget(env: Record<string, string | undefined>, root: string) {
  if (env.E2E_BASE_URL) return { baseURL: env.E2E_BASE_URL, backendContainer: env.E2E_BACKEND_CONTAINER ?? 'karpathy-app-backend-1' };
  let n = env.STACK;
  if (!n) {
    try {
      n = readFileSync(join(root, 'tmp/dev/stack'), 'utf8').trim();
    } catch {
      throw new Error('no dev stack for this checkout: run just dev up');
    }
  }
  if (!/^[1-9]$/.test(n)) throw new Error(`stack must be 1-9, got '${n}'`);
  return { baseURL: `https://localhost:80${n}0`, backendContainer: env.E2E_BACKEND_CONTAINER ?? `karpathy-app-${n}-backend-1`, project: `karpathy-app-${n}` };
}
