#!/usr/bin/env bash
# Ingest service loop: fetch mail every INGEST_FETCH_S (15 min), resolve open links every INGEST_LOOP_S (1 min),
# write a heartbeat after each round. Profiles run in sequence; a vault that isn't cloned yet is skipped.
# Our config maps profile → vault id; ingest-email gets its own config with the vault's Input/ and Sources/.
set -uo pipefail
CONFIG=${INGEST_CONFIG:-/etc/ingest/config.json}
STATE=${INGEST_STATE:-/state}
VAULTS=${INGEST_VAULTS:-/vaults}
LOOP_S=${INGEST_LOOP_S:-60}
FETCH_S=${INGEST_FETCH_S:-900}
RENDERED="$STATE/ingest-email.json"

log() { echo "$(date -u +%FT%TZ) $*"; }

# gog's file keyring is encrypted with this password (compose secret); instascraper's state lives under $HOME.
[ -r /run/secrets/gog_keyring_password ] && GOG_KEYRING_PASSWORD=$(cat /run/secrets/gog_keyring_password) && export GOG_KEYRING_PASSWORD
[ -n "${HOME:-}" ] && mkdir -p "$HOME"

# Writes $RENDERED with the profiles whose vault is cloned; prints their names.
render() {
  python3 - "$CONFIG" "$VAULTS" "$RENDERED" <<'PY'
import json, os, sys, time
config, vaults, out = sys.argv[1:]
raw = json.load(open(config))
profiles = {}
for name, p in (raw.get("profiles") or {}).items():
    p = dict(p)
    vault, label = p.pop("vault"), p.pop("label")
    root = os.path.join(vaults, vault)
    if not os.path.isdir(root):
        print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), f"vault {vault} not cloned: profile {name} skipped", file=sys.stderr)
        continue
    # An empty Input/ is not a git change; ingest-email needs the target dir to exist.
    os.makedirs(os.path.join(root, "Input"), exist_ok=True)
    p.update(target_dir=os.path.join(root, "Input"), archive_dirs=[os.path.join(root, "Sources")],
             label_incoming=label, label_processed=f"{label}/processed",
             label_failed=f"{label}/failed", label_rejected=f"{label}/rejected")
    profiles[name] = p
tmp = out + ".tmp"
with open(tmp, "w") as f:
    json.dump({**raw, "profiles": profiles}, f, indent=2)
os.replace(tmp, out)
print(" ".join(profiles))
PY
}

# A half-built item from an interrupted run (built in Input/.tmp-*, renamed into place) never lingers.
for d in "$VAULTS"/*/Input/.tmp-*; do
  [ -d "$d" ] && rm -rf "$d" && log "removed leftover $d"
done

# The internal endpoint (Admin › Instagram via the backend), restarted if it dies.
SERVER=${INGEST_SERVER:-/opt/ingest/server.py}
server_pid=
serve() {
  [ -f "$SERVER" ] || return 0
  if [ -z "$server_pid" ] || ! kill -0 "$server_pid" 2>/dev/null; then
    python3 "$SERVER" & server_pid=$!
  fi
}

last_fetch=0
while :; do
  serve
  profiles=$(render) || { log "config unreadable: $CONFIG"; profiles=""; }
  now=$(date +%s)
  fetch=$(( now - last_fetch >= FETCH_S ))
  [ "$fetch" = 1 ] && last_fetch=$now
  for p in $profiles; do
    [ "$fetch" = 1 ] && { ingest-email ingest "$p" --config "$RENDERED" || log "ingest $p failed ($?)"; }
    ingest-email resolve "$p" --config "$RENDERED" || log "resolve $p failed ($?)"
  done
  touch "$STATE/last-run"
  sleep "$LOOP_S"
done
