#!/usr/bin/env bash
# Secret scan of this repo (#141) with the pinned gitleaks: the whole git history, the staged and unstaged changes,
# and untracked files that aren't ignored. Prints rule, file and line of each finding, never the secret.
# Run: bash deploy/gitleaks/scan-repo.sh (a step of `just check` and CI). A false positive goes into .gitleaksignore
# (its fingerprint) at the repo root.
set -euo pipefail
cd "$(dirname "$0")/../.."
gitleaks=$(sh deploy/gitleaks/install.sh)
run() { "$gitleaks" "$@" --no-banner --no-color --redact --verbose --log-level warn; }

run git .
run git --staged .
run git --pre-commit .
git ls-files -z --others --exclude-standard | while IFS= read -r -d '' f; do
  [ -f "$f" ] && run dir "$f"
done
echo "gitleaks: no secrets found"
