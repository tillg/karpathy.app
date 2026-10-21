#!/usr/bin/env bash
# Installs the Claude Code plugins this repo uses (keep in sync with enabledPlugins in
# .claude/settings.json). Runs from the SessionStart hook locally and from the cloud environment's
# setup script, since cloud sessions ignore enabledPlugins / extraKnownMarketplaces.
# Plugins installed here load from the next Claude Code start on.

marketplaces=(tillg/till-claude-code-marketplace mattpocock/skills anthropics/claude-plugins-official)
plugins=(
  spec@till-claude-code-marketplace
  md2html@till-claude-code-marketplace
  mattpocock-skills@mattpocock
  claude-security@claude-plugins-official
)

installed="${CLAUDE_CODE_PLUGIN_CACHE_DIR:-$HOME/.claude/plugins}/installed_plugins.json"
# Only a user-scope install counts: a project-scope one is tied to one path (not worktrees).
user_installed=$(python3 -c 'import json, sys
for k, v in json.load(open(sys.argv[1]))["plugins"].items():
    if any(e.get("scope") == "user" for e in v): print(k)' "$installed" 2>/dev/null)
missing=()
for p in "${plugins[@]}"; do
  grep -qxF "$p" <<<"$user_installed" || missing+=("$p")
done
[ ${#missing[@]} -eq 0 ] && exit 0

for m in "${marketplaces[@]}"; do
  claude plugin marketplace add "$m" >/dev/null 2>&1
done
for p in "${missing[@]}"; do
  claude plugin install "$p" --scope user >/dev/null 2>&1 || echo "claude-plugins: failed to install $p" >&2
done
exit 0
