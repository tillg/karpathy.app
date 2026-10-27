---
title: Developing from the iPad
created: 2026-10-22
edited: 2026-10-22
status: research
subtitle: "Research for [issue #171](https://github.com/tillg/karpathy.app/issues/171): how to work on karpathy.app from an iPad, now that the dev stacks run on `karpathy-dev`. Research only, nothing is built yet: the options below are for the joint discussion the issue asks for."
description: How to develop karpathy.app from an iPad against the remote dev host karpathy-dev. Terminal, Claude Code, app preview and editor options, with a phased recommendation.
---

:::tldr
**Short answer: yes, and most of it works without changing the server.** The iPad is missing four things the Mac has. Each one has an answer:

1. **Terminal.** An iOS SSH app (Blink Shell or Termius) plus the Tailscale app reaches `karpathy-dev` the same way the Mac does. `herdr session attach` or `tmux attach` then shows the panes that are already running there. :verdict[works today]{tone="go"}
2. **Driving Claude.** Claude Code's **Remote Control** lets the Claude iOS app (or claude.ai/code in Safari) steer a `claude` session that keeps running on the server. Photos and screenshots can be attached, which a terminal on the iPad can't do. :verdict[works today]{tone="go"}
3. **Seeing the app.** This is the real gap. The Mac reaches stack N through an SSH `LocalForward` to `localhost:80N0`, and the iPad has no such forward. The clean fix is **`tailscale serve`**: each stack gets a URL like `https://karpathy-dev.<tailnet>.ts.net:80N0` with a real certificate. It needs a toggle in the Tailscale admin console and two small repo changes (Caddy's dev site name, the stacks' port binding). :verdict[needs work]{tone="partial"}
4. **Editor.** VS Code Remote-SSH has no iPad version. A browser VS Code (`code-server` behind `tailscale serve`, or VS Code Remote Tunnels at vscode.dev) fills the gap. It is optional while Claude does most of the editing. :verdict[optional]{tone="partial"}

**Recommendation:** do it in phases. **Phase 1** is docs only: iPad apps, attach to herdr, Remote Control. **Phase 2** adds `tailscale serve` for the dev stacks; as a bonus it also ends the Mac's port clash between local and remote stacks. **Phase 3**, only if the iPad turns out to need a real editor, is `code-server` on the tailnet. The questions to settle together are in [Open questions](#questions).
:::

## Context {#context}

`karpathy-dev` is a Hetzner server reachable only over Tailscale ([docs/dev-server.md](../../../docs/dev-server.md)). From the Mac you work in three ways:

- **Terminal:** `herdr --remote karpathy-dev`, or `ssh` plus tmux.
- **App preview:** `https://localhost:80N0` in the Mac's browser, through the `LocalForward` lines of the Mac's SSH entry.
- **Editor:** VS Code Remote-SSH, opened with `just code`.

The dev-server doc lists "iPad or phone as the only device" as out of scope: *"the shell works from any SSH client, the app needs the Mac's browser and its port forward"*. Issue #171 asks to change that.

What the server looks like today (checked on `karpathy-dev`, 2026-10-22):

| Fact | Value | Matters because |
| --- | --- | --- |
| Tailscale | 1.104.2, MagicDNS on, name `karpathy-dev.tailab154c.ts.net` | The iPad reaches the host by this name once the Tailscale app is on. |
| Tailscale HTTPS certificates | not enabled (`CertDomains` is empty), no serve config | `tailscale serve` needs them: a one-time toggle in the admin console. |
| Firewall | Hetzner cloud firewall `no-inbound`; on the host, `ufw` inactive and the `tailscale0` interface accepted | Anything listening on all interfaces is reachable from the whole tailnet. |
| Dev stack ports | `compose.dev.yml` publishes `${PROXY_PORT}:443`, so `0.0.0.0:80N0` | A stack is already reachable over the tailnet, but only with the `localhost` certificate (see [App preview](#preview)). |
| Caddy dev site | `https://localhost { tls internal … }` | Requests for any other host name get no certificate and no route. |
| herdr | installed, has `herdr session attach <name>` | An iPad SSH session can attach to the same workspace the Mac uses. |
| Claude Code | 2.1.308, logged in with the subscription, `--remote-control` available | Remote Control needs a claude.ai login, not an API key. |
| mosh | not installed | Optional: it makes a terminal survive network changes on the iPad. |

## The four gaps {#gaps}

### Terminal {#terminal}

Any iOS SSH client works over Tailscale. The candidates:

| App | Good at | Weak at |
| --- | --- | --- |
| **Blink Shell** (paid, subscription) | mosh and SSH, keyboard remapping (Caps Lock as Esc), Tailscale + mosh guide, also hosts VS Code for the web (Blink Code) | Subscription; its own config syntax |
| **Termius** | Polished, syncs hosts with the Mac | No mosh in the free tier; less keyboard control |
| **a-Shell / iSH** | Free, local shell | No real terminal emulator for long TUI sessions |

Whichever app you use, iOS **suspends it after a short time in the background**. A plain SSH session then drops. That is the same lesson as on the Mac: run everything inside herdr or tmux on the server and attach again. Two ways to make this smoother:

- **herdr:** `ssh karpathy-dev` and then `herdr session attach <name>` shows the panes the Mac's `herdr --remote` opened. `herdr --remote` itself needs herdr on the client, and there is no iOS build.
- **mosh** (Blink, or Termius Pro): the session survives Wi-Fi changes and sleep without reconnecting. It needs `mosh-server` on the host and UDP 60000–61000, which the `tailscale0` rule already allows. Blink can also bring its own `mosh-server`, so this is nice to have, not required. Installing it would be one package in the `devtools` role.

**Keyboard:** Claude Code uses **Esc** to interrupt. Older Magic Keyboards for iPad have no Esc key: map Caps Lock to Esc (Blink can, and so can iPadOS under *Settings › General › Keyboard › Hardware Keyboard › Modifier Keys*).

### Driving Claude: Remote Control {#remote-control}

Claude Code's Remote Control connects the Claude app on iOS, or claude.ai/code, to a Claude Code session that keeps running on its own machine. The docs say *"Claude keeps running locally the entire time, so your code execution and filesystem access stay on your machine"*. For us that means the server's checkout, worktrees, Docker stacks, `just`, MCP servers and plugins all stay where they are.

- **Start:** `claude --remote-control "<name>"` in a herdr or tmux pane, or `/remote-control` in a running session. The session then shows up in the Claude app's session list. You can type in the terminal and the app at the same time.
- **Requirements:** a Pro or Max subscription logged in via `/login` (API keys don't work), which is how `claude` is set up on `karpathy-dev`. There is a one-time "Enable Remote Control?" confirmation.
- **What it adds on the iPad:** a touch UI that doesn't need Esc or a terminal; **photos and screenshots** as attachments (the Mac pastes them into the remote `claude` through herdr, which an iPad SSH app can't); the session survives drops (*"Claude Code reconnects automatically when your machine comes back online"*).
- **What it doesn't replace:** the session must be started on the server, so you need the terminal at least once. Long runs still belong in herdr or tmux so they outlive the SSH connection that started them.
- **Optional:** `/config` › *Enable Remote Control for all sessions* turns it on for every session, so any session started on the Mac can be picked up on the iPad later.

**Claude Code on the web** (cloud sessions at claude.ai/code) is not an alternative here. It runs in Anthropic's sandbox, without our dev stacks, Docker or host secrets.

### App preview {#preview}

This is the only part that needs real work. On the Mac, `https://localhost:80N0` goes through the SSH forward to Caddy, which serves a certificate for `localhost` from its internal CA. The iPad has no forward, and it doesn't trust Caddy's CA either.

| Option | How | Verdict |
| --- | --- | --- |
| **A. `tailscale serve`** | `tailscale serve --bg --https=80N0 https+insecure://localhost:80N0` per running stack. Tailscale terminates TLS with a **Let's Encrypt certificate for `karpathy-dev.<tailnet>.ts.net`** and proxies to Caddy. | :verdict[recommended]{tone="go"} Real certificate, so no Safari warning, and the PWA's service worker and "Add to Home Screen" work. Reachable only inside the tailnet. |
| B. Stack on the tailnet IP | Open `https://karpathy-dev.<tailnet>.ts.net:80N0` directly, since the port already listens on all interfaces. Install each stack's Caddy root CA on the iPad as a profile. | :verdict[no]{tone="no"} Caddy has no certificate for that name today, and each stack has its own CA, so you'd need one profile per stack and again after every volume reset. |
| C. Port forward in the SSH app | Blink or Termius `ssh -L 8010:localhost:8010`, then Safari on `https://localhost:8010`. | :verdict[fragile]{tone="partial"} iOS suspends the SSH app, and with it the forward, as soon as Safari is in front. Caddy's CA is still untrusted. |
| D. VS Code port forwarding | VS Code tunnels forward ports through Microsoft's dev tunnels. | :verdict[no]{tone="no"} Takes the app out of the tailnet, through a third party. |

Option A needs four changes, none of them large:

1. **Tailscale admin console:** enable *HTTPS Certificates* (DNS page). Note that this puts the machine name `karpathy-dev.tailab154c.ts.net` into the public Certificate Transparency logs. The name reveals nothing beyond the tailnet's random suffix.
2. **Caddy dev site:** `https://localhost` → `https://localhost, https://{$DEV_HOST}` (or a catch-all site). Tailscale's proxy may forward the original `Host` header (the Tailscale docs don't say), and Caddy only routes requests for host names it knows. To verify in phase 2.
3. **Stack ports to loopback:** publish `127.0.0.1:${PROXY_PORT}:443` instead of `${PROXY_PORT}:443`. Otherwise Docker's listener on the tailnet IP and Tailscale's listener on the same port compete. As a side effect, dev stacks on the Mac stop being reachable from the LAN, which is a hygiene fix of its own. The SSH forward and `just e2e` use `localhost` and don't notice.
4. **Wiring:** `just dev up` adds the serve entry for its stack and `just dev down` removes it (`tailscale serve --https=80N0 off`), only where `tailscale` is present and HTTPS is enabled. `just dev up` then prints the tailnet URL next to the localhost one. Vite's live reload runs over the same origin, so it works through the proxy.

**Bonus for the Mac:** the tailnet URL works from the Mac's browser too, without any `LocalForward`. The "one dev host at a time" port clash in the dev-server doc then goes away.

### Editor {#editor}

On the iPad, Claude does most of the editing, and diffs can be read with `git diff` in the terminal or in the Remote Control app. If a real editor turns out to be needed:

| Option | How | Pros | Cons |
| --- | --- | --- | --- |
| **code-server** (Coder) | A service on `karpathy-dev`, published with `tailscale serve`; installed as a PWA in Safari for full-screen and better shortcuts | Stays in the tailnet; the Claude Code extension is on Open VSX; one Ansible task | Open VSX only (no Microsoft marketplace); one more service to keep up to date |
| **VS Code Remote Tunnels** | `code tunnel` on the server, open vscode.dev in Safari, log in with GitHub | Official VS Code, Microsoft marketplace; nothing to host | The editor traffic goes through Microsoft's relay, outside "Tailscale only"; another login on the server; `code tunnel` must keep running |
| **Blink Code** | Blink's built-in VS Code for the web, pointed at a code-server or vscode.dev | Better keyboard handling than Safari | Ties the setup to Blink |

## Recommendation {#recommendation}

Do it in three phases. Each one is useful on its own, and the later ones are only worth it once the earlier ones are in use.

| Phase | What | Changes | Effort |
| --- | --- | --- | --- |
| **1. Terminal + Claude** | Tailscale app and Blink (or Termius) on the iPad; `herdr session attach` / tmux; `claude --remote-control` from the Claude app | A new *iPad* section in `docs/dev-server.md`; optionally `mosh` in the `devtools` role | Small, docs only |
| **2. App preview** | `tailscale serve` per dev stack, real certificate, URL printed by `just dev up` | Admin toggle (human); `Caddyfile.dev` site name; loopback port binding in `compose.dev.yml`; `deploy/dev.sh` serve on/off with tests; docs | Medium |
| **3. Editor** (if needed) | code-server on the tailnet | An Ansible task in `devtools`, a serve entry, docs | Medium |

Why this order: phase 1 delivers most of the value (work with Claude from the couch) at almost no cost. Phase 2 is the only way to look at the app, and it also helps the Mac. Phase 3 is speculative until phases 1 and 2 have been used for a while.

## Open questions for the discussion {#questions}

1. **Which terminal app?** Blink (mosh, Esc remapping, subscription) or Termius (free tier, syncs with the Mac)? *My pick: Blink.*
2. **Remote Control:** OK to use it on `karpathy-dev`, and turn it on for all sessions there? It sends the conversation through Anthropic's relay, which our Claude Code sessions talk to anyway. *My pick: yes, all sessions.*
3. **HTTPS certificates in the tailnet:** OK to enable them, accepting that the machine name ends up in the public CT logs? *My pick: yes.*
4. **Serve URL scheme:** keep the port numbers (`…ts.net:8010`), or use a path or one port per stack name? *My pick: same port numbers, so nothing new to learn.*
5. **Editor:** needed at all? If yes, code-server (stays in the tailnet) or VS Code tunnels (official, through Microsoft)? *My pick: none yet; code-server if needed.*
6. **Scope:** the iPad as a second device next to the Mac, or as the **only** device on a trip? The second needs everything in phase 2, plus a way to run `just devhost` and `just secrets dev` (today on the Mac only, via its Keychain).

## Sources {#sources}

- On-host checks on `karpathy-dev`, 2026-10-22: `tailscale version` and `status --json`, `tailscale serve status` / `--help`, `nft list ruleset`, `herdr --help`, `claude --help`; repo files `deploy/compose.dev.yml`, `deploy/proxy/Caddyfile.dev`, `deploy/stack.sh`, `docs/dev-server.md`.
- Claude Code docs, [Remote Control](https://code.claude.com/docs/en/remote-control): requirements, start modes, reconnect behavior.
- Claude Code docs, [VS Code extension](https://code.claude.com/docs/en/vs-code): install from the Open VSX registry.
- Tailscale docs, [Tailscale Serve](https://tailscale.com/kb/1312/serve) (*"requires you to enable HTTPS certificates in your tailnet"*) and the [`tailscale serve` CLI](https://tailscale.com/kb/1242/tailscale-serve) (`https+insecure://` for self-signed backends).
- VS Code docs, [Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels).
- Blink docs, [Tailscale + Mosh](https://docs.blink.sh/integrations/tailscale+mosh) and [VS Code Server](https://docs.blink.sh/build-up/code_server).
- L. C., [Using iPad as a Python development machine with Mac, Tailscale and VS Code](https://medium.com/@lelioc/using-ipad-as-a-python-development-machine-with-mac-tailscale-and-vs-code-e4af30a7d383) (a user report: Blink + VS Code tunnels from Safari).
