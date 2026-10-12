# Proxy: Caddy (with a DNS provider module for DNS-01) serving the PWA build and /api.
FROM node:22-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY assets assets
# Release version (git tag without the v), shown in the settings dialog; set by the release workflow.
ARG APP_VERSION=dev
RUN APP_VERSION=${APP_VERSION} npm run build -w apps/web

# The PWA build, as the root of this stage. The release workflow builds it once for both architectures and passes it
# as the named build context `web` (--build-context web=<dist>), which replaces this stage: web-build isn't run then.
# Without it (just dev, prodtest, compose) BuildKit builds the stage above.
FROM scratch AS web
COPY --from=web-build /app/apps/web/dist /

FROM caddy:2.10-builder AS caddy
ARG DNS_PROVIDER=godaddy
RUN xcaddy build --with github.com/caddy-dns/${DNS_PROVIDER}

FROM caddy:2.10-alpine
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=web / /srv
COPY deploy/proxy/Caddyfile /etc/caddy/Caddyfile
