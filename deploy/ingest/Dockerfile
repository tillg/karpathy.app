# Ingest service: fetches mail and resolves links into the vaults' Input/ (deterministic, no LLM, never commits).
# Runs ingest-email (its own repo, pinned) with the tools its resolvers call: tesseract (OCR), poppler (PDF),
# ffmpeg (Reels), and gog (Gmail).

# ingest-email is private: the build needs a GitHub token as BuildKit secret `gh_token` (`gh auth token`; the
# release workflow passes a repo secret). Without it the plain URL is used (works once the repo is public).
FROM python:3.13-slim AS build
ARG INGEST_EMAIL_REF=e68a689b01e7b523708c0ff03d5e4cd86af6aa65
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=gh_token,required=false set -e; \
    python -m venv /opt/venv; \
    if [ -s /run/secrets/gh_token ]; then \
      git config --global url."https://x-access-token:$(cat /run/secrets/gh_token)@github.com/".insteadOf "https://github.com/"; \
    fi; \
    /opt/venv/bin/pip install --no-cache-dir "ingest-email[instagram] @ git+https://github.com/tillg/ingest_email@${INGEST_EMAIL_REF}"; \
    rm -f /root/.gitconfig

FROM python:3.13-slim
ARG APP_UID=1000
ARG APP_GID=1000
ARG TARGETARCH
# gog (Gmail CLI), pinned and checksum-verified.
ARG GOG_VERSION=0.43.0
ARG GOG_SHA256_amd64=a16d4b8b917e36b96b09b30ecb7a5049d06ff1e88b856a101eec12b86b33fe05
ARG GOG_SHA256_arm64=f66e3c9ab7664b7633d57d2d5303e0db75deb4045e1b32c3493c0d8ba68a70f7
RUN set -e; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng poppler-utils ffmpeg; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in amd64) sum=$GOG_SHA256_amd64 ;; arm64) sum=$GOG_SHA256_arm64 ;; *) echo "no gog for $arch" >&2; exit 1 ;; esac; \
    curl -fsSL -o /tmp/gog.tgz "https://github.com/steipete/gogcli/releases/download/v${GOG_VERSION}/gogcli_${GOG_VERSION}_linux_${arch}.tar.gz"; \
    echo "$sum  /tmp/gog.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gog.tgz -C /usr/local/bin ./gog; \
    rm /tmp/gog.tgz; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    mkdir -p /state /vaults; chown ${APP_UID}:${APP_GID} /state /vaults
COPY --from=build /opt/venv /opt/venv
COPY --chmod=755 deploy/ingest/run.sh /usr/local/bin/ingest-loop
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1
USER ${APP_UID}:${APP_GID}
WORKDIR /state
CMD ["/usr/local/bin/ingest-loop"]
