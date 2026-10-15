---
feature: browser-tools
title: "Domain: browser tools"
status: proposed
order: 2
created: 2026-10-15
edited: 2026-10-15
---

# Domain: browser tools

## New terms

| Term | Meaning | In code (planned) |
|---|---|---|
| **Browser tool** | A tool the AI calls in opencode whose answer comes from the user's browser while the call waits. Today `local_time` and `user_location`. Read-only for the vault: it never writes a file. *Avoid:* client tool, frontend tool, device service. | `BROWSER_TOOLS` (harness), `browserTools` (web) |
| **Browser call** | One running call of a browser tool: chat, call id, tool, input, the answering tab, its deadline. Pending until the tab answers, the deadline passes (90 s) or the turn is aborted. | `BrowserCall`, `browser-calls.ts` |
| **Answering tab** | The browser tab that sent the turn's prompt, named by a random **tab id** it keeps in `sessionStorage` (survives a reload, not a new tab). Only it answers that turn's browser calls. *Avoid:* client, device (a device can have several tabs). | `client` in the prompt body, `tabId` |
| **Browser call result** | What the tab answers: a tool-specific object, validated by that tool's schema, or `unavailable` with a reason (`denied`, `no-position`, `unsupported`). Becomes the text the model reads. | `BrowserCallResult` |
| **Local time** | The answering device's wall clock: date, time, weekday, IANA time zone, UTC offset, locale. Not the server time. | `local_time` |
| **User location** | The answering device's position from the Geolocation API, rounded to two decimals (about 1 km), with accuracy in meters (at least 1000) and the age of the fix. No place name. | `user_location` |

## Changed terms

| Term | Before | After |
|---|---|---|
| **Prompt** (body) | `{ text, attachments?, openPage? }` | adds `client` (the tab id); queued with the turn, so a queued turn still knows its answering tab |
| **Vault event stream** | `status`, `files-changed`, agents move | adds `browser-call` and `browser-call-done`; on connect, pending calls are sent before the live events (as the last agents move is) |
| **Tool call** (chat) | `writes`, `opens`, `url`, `suggestion`, `query` | adds `browser: true` for browser tools; the chip shows a waiting state while the call is pending |

## Rules

- A browser call is answered at most once: the first valid answer wins, later ones get `409`.
- Only the answering tab answers; other tabs of the same user ignore the event.
- No answer by the deadline is not an error the model sees as a failure: the tool returns "the user's device did not
  answer", and `local_time` adds the server's UTC time.
- The position never leaves the user's chat: it is the tool's output, stored in the opencode session like every tool
  output, and deleted with the chat.
