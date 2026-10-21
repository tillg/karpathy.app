"""`just secrets <target>`: fill a target's Ansible Vault without the values passing through chat or
shell history. Asks for what only the operator has (hidden input; Enter keeps the current value),
generates what can be generated (once), and writes the vault encrypted again.

Run with Ansible's Python (it has PyYAML); the vault password comes from the Keychain as usual.
"""
import getpass
import os
import secrets
import string
import subprocess
import sys
import tempfile
import uuid

import yaml

PLACEHOLDER = "CHANGE_ME"
target = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
vault_file = os.path.join(here, "inventories", target, "group_vars", "all", "vault.yml")
vault_id = f"{target}@{os.path.join(here, 'vault-pass-client.sh')}"


def vault(*args, **kw):
    return subprocess.run(["ansible-vault", *args, "--vault-id", vault_id], check=True,
                          stdin=subprocess.DEVNULL, capture_output=True, text=True, **kw).stdout


data = yaml.safe_load(vault("view", vault_file)) or {}

# Values already entered for the dev stack (gitignored files): offered as defaults.
deploy_dir = os.path.dirname(here)


def from_file(name):
    try:
        return open(os.path.join(deploy_dir, name)).read().strip() or None
    except OSError:
        return None


def from_env_file(name, key):
    for line in (from_file(name) or "").splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip() or None
    return None


def unset(key, into=None):
    return (data if into is None else into).get(key) in (None, "", PLACEHOLDER)


def ask(key, prompt, hidden=True, optional=False, found=None, into=None):
    """found: (value, where) of a value entered elsewhere before; Enter takes it.
    into: the dict the key lives in (default: the vault's top level)."""
    d = data if into is None else into
    if unset(key, d) and found and found[0]:
        d[key] = found[0]
        state = f"found in {found[1]} — Enter takes it"
    else:
        state = "unset" if unset(key, d) else "set — Enter keeps it"
    while True:
        read = getpass.getpass if hidden else input
        value = read(f"{prompt} [{state}]: ").strip()
        if value:
            d[key] = value
            return
        if not unset(key, d) or optional:
            d.setdefault(key, "")
            return
        print("  required")


def save():
    # Plaintext only in a private temp file, encrypted straight back over the vault.
    fd, plain = tempfile.mkstemp(suffix=".yml")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(f"# {target} target secrets. Edit with: just secrets {target}\n")
            yaml.safe_dump(data, f, default_flow_style=False, sort_keys=True, allow_unicode=True)
        vault("encrypt", plain, "--encrypt-vault-id", target, "--output", vault_file)
    finally:
        os.remove(plain)
    print(f"\nWritten (encrypted): {os.path.relpath(vault_file, os.getcwd())}")


print(f"Secrets for target '{target}' (input is hidden where it's a secret).\n")
# The remote dev host (dev.yml): host secrets for its checkouts, the git token, the tailnet key.
if target == "dev":
    ask("vault_openrouter_api_key", "OpenRouter API key (the dev stacks' models)",
        found=(from_file("secrets/openrouter_api_key"), "deploy/secrets/openrouter_api_key"))
    ask("vault_exa_api_key", "Exa API key for web search (optional, Enter skips)", optional=True,
        found=(from_file("secrets/exa_api_key"), "deploy/secrets/exa_api_key"))
    ask("vault_github_token", "GitHub fine-grained token (karpathy.app, karpathy_demo_wiki, ingest_email: Contents read/write)")
    ask("vault_tailscale_authkey", "Tailscale auth key (tag:server, pre-approved, single-use)")
    save()
    sys.exit(0)

ask("vault_dns_api_token", "GoDaddy production API key and secret, as <key>:<secret>",
    found=(from_file("secrets/dns_api_token"), "deploy/secrets/dns_api_token"))
ask("vault_github_token", "GitHub fine-grained token (vault repos: Contents read/write)",
    found=(from_file("secrets/github_token"), "deploy/secrets/github_token"))
# Provider keys for opencode, whichever providers: the ones already in the vault plus the ones set
# in the dev stack's deploy/opencode.env (`*_API_KEY=…`).
if not isinstance(data.get("vault_opencode_env"), dict):
    data["vault_opencode_env"] = {}
providers = data["vault_opencode_env"]
dev_keys = [line.split("=", 1)[0] for line in (from_file("opencode.env") or "").splitlines()
            if line.split("=", 1)[0].endswith("_API_KEY") and line.split("=", 1)[-1].strip()]
for name in sorted(set(providers) | set(dev_keys)):
    ask(name, f"Provider key {name}", optional=True, into=providers,
        found=(from_env_file("opencode.env", name), "deploy/opencode.env"))
# Web search (Exa): optional, recommended for production; anonymous and rate-limited without it.
ask("EXA_API_KEY", "Exa API key for web search (optional, Enter skips)", optional=True, into=providers,
    found=(from_env_file("opencode.env", "EXA_API_KEY"), "deploy/opencode.env"))
# Per-turn caps on the AI's web calls (default 20 each when unset).
for cap in ("WEB_FETCH_CAP", "WEB_SEARCH_CAP"):
    ask(cap, f"{cap}: web calls per turn (optional, Enter keeps the default 20)", hidden=False, optional=True, into=providers)
for name in [k for k, v in providers.items() if not v]:
    del providers[name]
ask("vault_tailscale_authkey", "Tailscale auth key (tag:server, pre-approved, single-use)")
ask("vault_heartbeat_url", "healthchecks.io ping URL of this target's check", hidden=False, optional=True)
ask("vault_git_author_name", "Git author name for vault commits", hidden=False)
ask("vault_git_author_email", "Git author e-mail for vault commits", hidden=False)

# Generated once; kept on later runs.
alnum = string.ascii_letters + string.digits
if unset("vault_bearer_token"):
    data["vault_bearer_token"] = secrets.token_hex(24)
if unset("vault_ntfy_topic"):
    data["vault_ntfy_topic"] = f"karpathy-{target}-" + "".join(secrets.choice(alnum) for _ in range(32))
if unset("vault_beszel_password"):
    data["vault_beszel_password"] = secrets.token_urlsafe(24)
if unset("vault_beszel_token"):
    data["vault_beszel_token"] = str(uuid.uuid4())
if unset("vault_beszel_hub_key") or unset("vault_beszel_hub_pubkey"):
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "beszel-hub", "-f", f"{d}/k"], check=True)
        data["vault_beszel_hub_key"] = open(f"{d}/k").read()
        data["vault_beszel_hub_pubkey"] = open(f"{d}/k.pub").read().strip()

save()
print(f"ntfy topic for {target} alerts (subscribe to it in the ntfy app): {data['vault_ntfy_topic']}")
