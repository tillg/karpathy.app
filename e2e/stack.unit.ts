// Unit tests for e2e/stack.ts: node --experimental-strip-types --test e2e/stack.unit.ts
// (named .unit.ts so Playwright doesn't collect it).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stackTarget } from './stack.ts';

const root = (remembered?: string) => {
  const d = mkdtempSync(join(tmpdir(), 'stack-'));
  if (remembered) {
    mkdirSync(join(d, 'tmp/dev'), { recursive: true });
    writeFileSync(join(d, 'tmp/dev/stack'), `${remembered}\n`);
  }
  return d;
};

test('STACK=3 → https://localhost:8030 and karpathy-app-3-backend-1', () => {
  assert.deepEqual(stackTarget({ STACK: '3' }, root('2')), { baseURL: 'https://localhost:8030', backendContainer: 'karpathy-app-3-backend-1', project: 'karpathy-app-3' });
});

test('STACK=3 → project karpathy-app-3', () => {
  assert.equal(stackTarget({ STACK: '3' }, root()).project, 'karpathy-app-3');
});

test('remembered 2 when STACK unset', () => {
  assert.deepEqual(stackTarget({}, root('2')), { baseURL: 'https://localhost:8020', backendContainer: 'karpathy-app-2-backend-1', project: 'karpathy-app-2' });
});

test('E2E_BASE_URL wins and is kept as-is', () => {
  const env = { E2E_BASE_URL: 'https://localhost:8025', E2E_BACKEND_CONTAINER: 'karpathy-app-2-prodtest-backend-1', STACK: '3' };
  assert.deepEqual(stackTarget(env, root('2')), { baseURL: 'https://localhost:8025', backendContainer: 'karpathy-app-2-prodtest-backend-1' });
});

test("nothing set → throws 'run just dev up'", () => {
  assert.throws(() => stackTarget({}, root()), /run just dev up/);
});
