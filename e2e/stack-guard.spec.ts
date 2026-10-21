import { expect, stackDown, test } from './helpers';

// The per-test stack check (helpers.ts › stackGuard): a stack that stops answering mid-run names its likely cause.
test('stackDown names the cause for a port that refuses, and nothing for the running stack', async () => {
  expect(await stackDown('https://localhost:1')).toContain(process.platform === 'darwin' ? "Rancher's port forwarder" : 'just dev ps');
  expect(await stackDown()).toBeNull();
});
