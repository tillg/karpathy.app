# opencode harness, pinned (the server API moves fast). Stock image on purpose: it has no
# git, and without git opencode can't find the worktree, so `external_directory: deny` also
# confines the AI to a subfolder vault root (spike-opencode.md, finding 1). Skill deps come in M5.
FROM ghcr.io/anomalyco/opencode:1.18.25
ARG APP_UID=1000
ARG APP_GID=1000
# Mount points owned by the app user, so fresh named volumes inherit the ownership.
RUN mkdir -p /vaults /data && chown ${APP_UID}:${APP_GID} /vaults /data
# Managed config dir: merged last, so a vault's own opencode.json can't override it.
COPY deploy/opencode/opencode.json /etc/opencode/opencode.json
# Custom tools (open_note, open_url, save_url, move_to_sources) and plugins (known-url) in a global config dir that comes only from the image. opencode writes
# .gitignore/package.json into every config dir and installs @opencode-ai/plugin there on startup, so
# one throwaway start populates it now; read-only afterwards, it loads offline.
COPY deploy/opencode/tools/ /opt/opencode-config/opencode/tools/
COPY deploy/opencode/plugins/ /opt/opencode-config/opencode/plugins/
COPY deploy/opencode/lib/ /opt/opencode-config/opencode/lib/
# App skills (research): listed in every vault. A vault skill of the same name wins (the backend decides that).
COPY deploy/opencode/skills/ /opt/opencode-config/opencode/skills/
COPY --chmod=755 deploy/opencode/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN set -e; export XDG_CONFIG_HOME=/opt/opencode-config HOME=/tmp/bake XDG_DATA_HOME=/tmp/bake/data OPENCODE_MODEL=none/none; \
    mkdir -p /tmp/bake; (opencode serve --hostname 127.0.0.1 --port 4097 >/tmp/bake/serve.log 2>&1 &); ok=; \
    # -T: a server that accepts but doesn't answer must not block the poll (and the build) forever.
    for i in $(seq 120); do \
      if wget -q -T 2 -O- 'http://127.0.0.1:4097/experimental/tool/ids?directory=/tmp' 2>/dev/null | grep -q '"open_note"' && wget -q -T 2 -O- 'http://127.0.0.1:4097/experimental/tool/ids?directory=/tmp' 2>/dev/null | grep -q '"open_url"' && wget -q -T 2 -O- 'http://127.0.0.1:4097/experimental/tool/ids?directory=/tmp' 2>/dev/null | grep -q '"save_url"' && wget -q -T 2 -O- 'http://127.0.0.1:4097/experimental/tool/ids?directory=/tmp' 2>/dev/null | grep -q '"move_to_sources"' && grep -q 'known-url ready' /tmp/bake/serve.log; then ok=1; break; fi; sleep 1; \
    done; \
    pkill opencode || true; \
    if [ -z "$ok" ]; then echo 'open_note/open_url/save_url/move_to_sources tools or known-url plugin never loaded; opencode log:' >&2; cat /tmp/bake/serve.log >&2; exit 1; fi; \
    test -d /opt/opencode-config/opencode/node_modules/@opencode-ai/plugin; \
    rm -rf /tmp/bake; chmod -R a-w,a+rX /opt/opencode-config
# Web search: opencode's websearch tool, pinned to Exa (the search backend; EXA_API_KEY is optional, from
# opencode.env). Denied in the managed config; a turn gets it only through the per-turn tools map.
ENV OPENCODE_ENABLE_EXA=true OPENCODE_WEBSEARCH_PROVIDER=exa
# Vault skills come from .agents/skills/ only (the .agents standard). The only OPENCODE_DISABLE_* flag
# (security.md): it drops .claude/skills/ and nothing else; CLAUDE.md and AGENTS.md still load.
ENV OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
# HOME is an empty tmpfs (compose): no global ~/.claude or ~/.config/opencode.
ENV HOME=/home/app XDG_DATA_HOME=/data XDG_CONFIG_HOME=/opt/opencode-config
USER ${APP_UID}:${APP_GID}
WORKDIR /vaults
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
