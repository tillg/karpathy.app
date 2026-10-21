# Backend: Node/TS run via tsx (no build step). git + ripgrep for the git and search APIs.
FROM node:22-alpine AS base
# tzdata: git commit times follow TZ (compose).
RUN apk add --no-cache git ripgrep tzdata
# gitleaks: the commit's secret scan (#141); pinned and checksum-verified by the script.
COPY deploy/gitleaks/install.sh /tmp/gitleaks-install.sh
RUN sh /tmp/gitleaks-install.sh /usr/local/bin && rm /tmp/gitleaks-install.sh
ARG APP_UID=1000
ARG APP_GID=1000
# Mount points owned by the app user, so fresh named volumes inherit the ownership.
RUN mkdir -p /vaults /config /app && chown -R ${APP_UID}:${APP_GID} /vaults /config /app
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

# Dev: all deps; sources are bind-mounted and run with tsx watch (compose.dev.yml).
FROM base AS dev
RUN npm ci --workspace apps/backend --include-workspace-root=false && npm cache clean --force
USER ${APP_UID}:${APP_GID}
WORKDIR /app/apps/backend
ENV PORT=8787 VAULTS_DIR=/vaults CONFIG_DIR=/config
# Polling: inotify events from macOS bind mounts don't reach the VM (Rancher Desktop).
CMD ["npx", "nodemon", "--legacy-watch", "--watch", "src", "--watch", "../../packages/shared/src", "--ext", "ts", "--exec", "tsx src/main.ts"]

FROM base AS prod
RUN npm ci --workspace apps/backend --include-workspace-root=false --omit=dev && npm cache clean --force
COPY packages/shared packages/shared
COPY apps/backend apps/backend
USER ${APP_UID}:${APP_GID}
WORKDIR /app/apps/backend
# Release version (git tag without the v), reported by GET /api/health; set by the release workflow.
ARG APP_VERSION=dev
# Build time (ISO 8601), reported by GET /api/health as `built`; set by the release workflow, empty for local builds.
ARG BUILT_AT=
ENV NODE_ENV=production PORT=8787 VAULTS_DIR=/vaults CONFIG_DIR=/config APP_VERSION=${APP_VERSION} BUILT_AT=${BUILT_AT}
EXPOSE 8787
CMD ["npx", "tsx", "src/main.ts"]
