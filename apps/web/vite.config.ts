import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

// Offline = read-only cache of the vault list, file trees and recently opened notes (mvp §3.1).
// Workbox keys the cache by URL only, so the Authorization header doesn't matter for lookups.

export default defineConfig(({ command }) => ({
  // Icons live in the repo-level assets folder; served as-is at the site root.
  publicDir: '../../assets/icons',
  // Release version (git tag without the v), baked in by the proxy image build; `dev` otherwise.
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || 'dev') },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // The dev stack (the e2e target) serves the manifest and a service worker, too (issue #1).
      devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' },
      manifest: {
        name: 'karpathy.app',
        short_name: 'karpathy.app',
        description: 'Markdown vaults with an AI chat',
        theme_color: '#0f1e33',
        background_color: '#f2f2f7',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,ico,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Serialized into sw.js: must not reference outer variables.
            urlPattern: ({ url, request }) => request.method === 'GET' && /^\/api\/vaults(\/[^/]+\/(files|file))?$/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'vault-api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 300 },
              cacheableResponse: { statuses: [200] },
            },
          },
          // Dev has no precached build: cache the app shell (Vite modules) as it is fetched, so an
          // offline reload still boots. Network first, so hot reload always gets fresh sources.
          ...(command === 'serve' ? [{
            urlPattern: ({ url, request }: { url: URL; request: Request }) =>
              request.method === 'GET' && url.origin === self.location.origin && !url.pathname.startsWith('/api/'),
            handler: 'NetworkFirst' as const,
            options: { cacheName: 'dev-shell', cacheableResponse: { statuses: [200] } },
          }] : []),
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    strictPort: true,
    // In the dev container, inotify events from macOS bind mounts don't arrive: poll.
    ...(process.env.HMR_CLIENT_PORT ? { watch: { usePolling: true, interval: 300 } } : {}),
    // Behind the dev proxy (https://localhost:80N0) the HMR socket goes through Caddy.
    ...(process.env.HMR_CLIENT_PORT ? { hmr: { clientPort: Number(process.env.HMR_CLIENT_PORT), protocol: 'wss' } } : {}),
    // http-proxy pipes chunked responses through, so NDJSON streams aren't buffered.
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:8788', changeOrigin: true } },
  },
  test: { include: ['src/**/*.test.ts'] },
}));
