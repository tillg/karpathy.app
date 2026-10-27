#!/usr/bin/env bash
# server.test.sh must run the image it just built, by its ID, not by a shared tag: parallel checkouts (worktrees) build
# the same tag at the same time and would test each other's server.py. A stub docker on PATH records the calls.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
[ "$1" = build ] && echo "sha256:feedbeef"
exit 0
STUB
chmod +x "$tmp/docker"
mkdir -p "$tmp/src"
printf '#!/usr/bin/env bash\necho %s\n' "$tmp/src" > "$tmp/fetch-source.sh"
chmod +x "$tmp/fetch-source.sh"
DOCKER_LOG="$tmp/log" PATH="$tmp:$PATH" FETCH_SOURCE="$tmp/fetch-source.sh" bash "$root/deploy/ingest/server.test.sh" >/dev/null
grep -q '^run --rm sha256:feedbeef ' "$tmp/log" || { echo "server-test-image.test.sh: docker run does not use the built image ID:"; cat "$tmp/log"; exit 1; }
! grep -q -- '-t kai-test-ingest-stage' "$tmp/log" || { echo "server-test-image.test.sh: still tags a shared image"; exit 1; }
echo "server-test-image.test.sh: ok"
