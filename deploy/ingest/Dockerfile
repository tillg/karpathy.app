# Ingest service: fetches mail and resolves links into the vaults' Input/ (deterministic, no LLM, never commits).
# Runs ingest-email (its own repo, at the commit in ingest-email.ref) with the tools its resolvers call: tesseract (OCR), poppler (PDF),
# ffmpeg (Reels), and gog (Gmail).

# ingest-email is a private repo: it comes in as the named build context `ingest_email` (deploy/ingest/fetch-source.sh
# locally, a deploy-key checkout in CI), so the build itself needs no GitHub credentials. instascraper (public) is
# installed at its own tag, not through ingest-email's [instagram] extra: the ingest service needs a newer one.
FROM python:3.13-slim AS build
ARG INSTASCRAPER_REF=v1.1.0
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY --from=ingest_email . /src/ingest_email
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir /src/ingest_email "instascraper @ git+https://github.com/tillg/instascraper@${INSTASCRAPER_REF}"

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
