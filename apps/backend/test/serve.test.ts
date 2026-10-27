import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { UPLOAD_TIMEOUT_MS } from '../src/ingest-worker.js';
import { serve } from '../src/serve.js';

// The HTTP server's own timeouts: Node's default requestTimeout (300 s) would cut off a slow worker result upload
// (150 MB over 3 Mbit/s takes ~400 s) although the route forwards it with a longer timeout.

describe('serve', () => {
  it('lets a request body take longer than the result upload forwarding timeout', async () => {
    const server = serve(express(), 0, '127.0.0.1');
    try {
      await new Promise<void>((r) => server.once('listening', () => r()));
      expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
      expect(server.requestTimeout).toBeGreaterThan(UPLOAD_TIMEOUT_MS);
      // The other protections keep Node's defaults: a slowloris still has only 60 s to send its headers.
      expect(server.headersTimeout).toBe(60_000);
    } finally {
      server.close();
    }
  });
});
