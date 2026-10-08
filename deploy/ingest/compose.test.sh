#!/usr/bin/env bash
# The ingest service as compose renders it (prod, dev, prodtest): confined like opencode, no app secrets, and
# dev/prodtest read a config without profiles. Run: bash deploy/ingest/compose.test.sh (part of `just check`).
set -uo pipefail
deploy="$(cd "$(dirname "$0")/.." && pwd)"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

render() { # compose files… → JSON of the rendered config
  (cd "$deploy" && PROXY_PORT=8990 BACKEND_PORT=8991 STACK=9 PRODTEST_PORT=8995 docker compose "$@" config --format json 2>/dev/null)
}
# py <json> <python expression over `s` = the ingest service, `c` = the whole config>
py() { python3 -c "import json,sys; c=json.loads(sys.argv[1]); s=c['services']['ingest']; sys.exit(0 if ($2) else 1)" "$1"; }

prod=$(render -f compose.yml)
dev=$(render -f compose.yml -f compose.dev.yml)
prodtest=$(render -f compose.yml -f compose.prodtest.yml)
check "compose renders prod, dev and prodtest" test -n "$prod" -a -n "$dev" -a -n "$prodtest"

for v in prod dev prodtest; do
  j=${!v}
  check "$v: ingest is on the internal network only" py "$j" "list(s['networks']) == ['internal']"
  check "$v: ingest publishes no port" py "$j" "not s.get('ports')"
  check "$v: ingest goes out through the egress proxy" py "$j" "s['environment']['HTTPS_PROXY'] == 'http://egress:3128' and s['environment']['HTTP_PROXY'] == 'http://egress:3128'"
  check "$v: ingest has a healthcheck" py "$j" "'last-run' in ' '.join(s['healthcheck']['test'])"
  check "$v: ingest has its own secrets only, no app secrets" py "$j" "sorted(x['source'] for x in s['secrets']) == ['gog_keyring_password', 'ingest_token']"
  check "$v: ingest runs non-root with no capabilities" py "$j" "s.get('user') and s['cap_drop'] == ['ALL'] and 'no-new-privileges:true' in s['security_opt']"
  check "$v: ingest keeps its state in the ingest-state volume" py "$j" "any(m['source'] == 'ingest-state' and m['target'] == '/state' for m in s['volumes'])"
  check "$v: ingest reads its config read-only" py "$j" "any(m['target'] == '/etc/ingest/config.json' and m.get('read_only') for m in s['volumes'])"
done

check "prod: the image build takes ingest_email as a named build context, no token secret" py "$prod" "s['build'].get('additional_contexts', {}).get('ingest_email', '').endswith('tmp/ingest_email-src') and not s['build'].get('secrets') and 'gh_token' not in c.get('secrets', {})"
check "prod: the whole vaults volume is not mounted (the deploy adds per-vault Input/ and Sources/)" py "$prod" "not any(m['target'] == '/vaults' for m in s['volumes'])"
for v in dev prodtest; do
  j=${!v}
  cfg=$(python3 -c "import json,sys; s=json.loads(sys.argv[1])['services']['ingest']; print(next(m['source'] for m in s['volumes'] if m['target'] == '/etc/ingest/config.json'))" "$j")
  check "$v config has no profiles ($cfg)" python3 -c "import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get('profiles') == {} else 1)" "$cfg"
done

if [ "$fails" != 0 ]; then echo "compose.test.sh: $fails failed"; exit 1; fi
echo "compose.test.sh: ok"
