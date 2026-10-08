#!/usr/bin/env bash
# run.sh against a fake ingest-email on PATH (logs its args): timing, heartbeat, skipped vaults, leftover
# .tmp-* folders, the rendered ingest-email config, and an idle loop without profiles.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'kill $pid 2>/dev/null || true; rm -rf "$t"' EXIT
fail() { echo "FAIL: $*" >&2; echo "--- calls:" >&2; cat "$t/calls" >&2; echo "--- run.sh output:" >&2; cat "$t/out" >&2 || true; exit 1; }

mkdir -p "$t/bin" "$t/state" "$t/vaults/mylife/Sources" "$t/vaults/mylife/Input/.tmp-abc" "$t/vaults/mylife/Input/mail-keep" "$t/vaults/sub/wiki"
cat > "$t/bin/ingest-email" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
FAKE
chmod +x "$t/bin/ingest-email"

start() { # $1 = config json
  echo "$1" > "$t/config.json"
  : > "$t/calls"; : > "$t/out"
  FAKE_LOG="$t/calls" PATH="$t/bin:$PATH" INGEST_CONFIG="$t/config.json" INGEST_STATE="$t/state" INGEST_VAULTS="$t/vaults" \
    INGEST_LOOP_S=1 INGEST_FETCH_S=3 bash "$here/run.sh" > "$t/out" 2>&1 &
  pid=$!
}

# 1. Profiles: one cloned vault, one not cloned.
start '{"defaults":{"max_per_poll":20},"profiles":{"mylife":{"vault":"mylife","label":"MyLife","account":"me@gmail.com","allowed_senders":["a@b.c"]},"gone":{"vault":"gone","label":"Gone","account":"me@gmail.com","allowed_senders":["a@b.c"]},"sub":{"vault":"sub","root":"wiki","label":"Sub","account":"me@gmail.com","allowed_senders":["a@b.c"]}}}'
sleep 4.5
kill $pid; wait $pid 2>/dev/null || true

n_ingest=$(grep -c '^ingest mylife ' "$t/calls" || true)
n_resolve=$(grep -c '^resolve mylife ' "$t/calls" || true)
[ "$n_ingest" -ge 1 ] && [ "$n_ingest" -le 2 ] || fail "expected ingest mylife once or twice (fetch every 3 s in 4.5 s), got $n_ingest"
[ "$n_resolve" -ge 3 ] || fail "expected resolve mylife >= 3 times, got $n_resolve"
grep -q -- '--config '"$t/state/ingest-email.json" "$t/calls" || fail "ingest-email not called with the rendered config"
! grep -q ' gone' "$t/calls" || fail "a vault that isn't cloned must be skipped"
grep -q 'vault gone not cloned' "$t/out" || fail "missing log line for the skipped vault"
[ ! -e "$t/vaults/mylife/Input/.tmp-abc" ] || fail "leftover Input/.tmp-* not removed at start"
[ -d "$t/vaults/mylife/Input/mail-keep" ] || fail "a real item was removed"
[ -f "$t/state/last-run" ] || fail "no heartbeat"
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }   # GNU first: GNU `stat -f` means file-system status
age=$(( $(date +%s) - $(mtime "$t/state/last-run") ))
[ "$age" -le 3 ] || fail "heartbeat is $age s old"

python3 - "$t" <<'PY' || fail "rendered ingest-email config is wrong"
import json, sys
t = sys.argv[1]
c = json.load(open(f"{t}/state/ingest-email.json"))
p = c["profiles"]["mylife"]
assert p["target_dir"] == f"{t}/vaults/mylife/Input", p
assert p["archive_dirs"] == [f"{t}/vaults/mylife/Sources"], p
assert (p["label_incoming"], p["label_processed"], p["label_failed"], p["label_rejected"]) == ("MyLife", "MyLife/processed", "MyLife/failed", "MyLife/rejected"), p
assert p["allowed_senders"] == ["a@b.c"] and p["account"] == "me@gmail.com", p
assert "vault" not in p and "label" not in p and "root" not in p, p
sub = c["profiles"]["sub"]
assert sub["target_dir"] == f"{t}/vaults/sub/wiki/Input" and sub["archive_dirs"] == [f"{t}/vaults/sub/wiki/Sources"], sub
assert "gone" not in c["profiles"], c
assert c["defaults"]["max_per_poll"] == 20, c
PY

# 2. A long ingest-email call (Instagram pacing) keeps the heartbeat fresh: it is touched around every call.
cat > "$t/bin/ingest-email" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
[ "$1" = resolve ] && sleep 3
true
FAKE
rm -f "$t/state/last-run"
start '{"defaults":{},"profiles":{"mylife":{"vault":"mylife","label":"MyLife","account":"me@gmail.com","allowed_senders":["a@b.c"]}}}'
sleep 1.5
[ -f "$t/state/last-run" ] || fail "no heartbeat while the first round is still running"
kill $pid; wait $pid 2>/dev/null || true

# 3. No profiles: idles with a fresh heartbeat, calls nothing.
rm -f "$t/state/last-run"
start '{"defaults":{},"profiles":{}}'
sleep 2.5
kill $pid; wait $pid 2>/dev/null || true
[ ! -s "$t/calls" ] || fail "no profiles, but ingest-email was called: $(cat "$t/calls")"
[ -f "$t/state/last-run" ] || fail "no heartbeat while idle"

echo "run.test.sh: ok"
