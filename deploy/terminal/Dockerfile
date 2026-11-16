# Terminal (#175): a PTY server for the app's terminal panel. Shells run here, not in the backend: Claude Code reads
# untrusted vault content, so this container gets no app secrets and reaches the internet only through the egress proxy.
FROM node:22-alpine AS base
# bash + the tools of a working shell; libgcc/libstdc++ for Claude Code's native binary, ripgrep for its search.
RUN apk add --no-cache bash git ripgrep less curl openssh-client ncurses tzdata libgcc libstdc++ procps
# Claude Code, pinned like every other tool (a release at least two weeks old); no self-update in the image.
RUN npm install -g @anthropic-ai/claude-code@2.1.318 && npm cache clean --force
ARG APP_UID=1000
ARG APP_GID=1000
RUN mkdir -p /vaults /gitdirs /app && chown -R ${APP_UID}:${APP_GID} /vaults /gitdirs /app /home/node
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/terminal/package.json apps/terminal/
COPY apps/terminal/scripts apps/terminal/scripts
# node-pty has no musl prebuild: compile it, then drop the toolchain in the same layer.
RUN apk add --no-cache --virtual .build python3 make g++ \
  && npm ci --workspace apps/terminal --include-workspace-root=false --omit=dev \
  && npm cache clean --force && apk del .build
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -qO- http://127.0.0.1:8095/healthz || exit 1
ENV PORT=8095 VAULTS_DIR=/vaults HOME=/home/node USER=node SHELL=/bin/bash LANG=C.UTF-8 \
  DISABLE_AUTOUPDATER=1 USE_BUILTIN_RIPGREP=0
EXPOSE 8095

# Dev: sources bind-mounted (compose.dev.yml); no file watch, a reload would end every open shell.
FROM base AS dev
USER ${APP_UID}:${APP_GID}
WORKDIR /app/apps/terminal
CMD ["npx", "tsx", "src/main.ts"]

FROM base AS prod
COPY apps/terminal apps/terminal
USER ${APP_UID}:${APP_GID}
WORKDIR /app/apps/terminal
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/main.ts"]
