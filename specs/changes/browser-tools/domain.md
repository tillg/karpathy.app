---
feature: browser-tools
title: "Domain: browser tools"
status: applied
order: 2
created: 2026-10-15
edited: 2026-10-15
---

# Domain: browser tools

## New terms

| Term | Meaning | In code (planned) |
|---|---|---|
| **Browser tool** | A tool the AI calls in opencode whose answer comes from the user's browser while the call waits. Today only `user_location` (local time is not one: see *Local time*). Read-only for the vault: it never writes a file. *Avoid:* client tool, frontend tool, device service. | `BROWSER_TOOLS` (harness), `browserTools` (web) |
| **Browser call** | One running call of a browser tool: chat, call id (opencode's `callID`), tool, input, the answering tab, its deadline. Pending until the tab answers, the deadline passes (90 s) or the turn is aborted. | `BrowserCall`, `browser-calls.ts` |
| **Answering tab** | The browser tab that sent the turn's prompt, named by a random **tab id** it keeps in `sessionStorage` (survives a reload, not a new tab; a duplicated tab copies it, and then the first answer wins). Only it answers that turn's browser calls. *Avoid:* client, device (a device can have several tabs). | `tabId` (prompt body, `browser-call` event, `BrowserCall`) |
| **Browser call result** | What the tab answers: a tool-specific object, validated by that tool's schema, or `unavailable` with a reason (`denied`, `no-position`, `unsupported`). Becomes the text the model reads. | `BrowserCallResult` |
| **User time zone** | The IANA time zone and locale of the tab that sent the prompt, captured when it is sent and kept with the turn. | `timeZone`, `locale` (prompt body) |
| **Local time** | The current date, time, weekday and UTC offset in the user time zone, computed on the server from the server clock when the turn is sent to opencode, and given to the model as a hidden line with every prompt (no tool). Needs no answer from the browser, so it works with the phone locked and for a queued turn. Without a user time zone: the deployment's `timezone` setting. | `localTimeLine` (harness), synthetic text part |
| **User location** | The answering device's position from the Geolocation API (high accuracy) as precise as the device reports it, with accuracy in meters and the age of the fix. No place name. | `user_location` |

## Changed terms

| Term | Before | After |
|---|---|---|
| **Prompt** (body) | `{ text, attachments?, openPage? }` | adds `tabId`, `timeZone` and `locale`; queued with the turn, so a queued turn still knows its answering tab and the user time zone |
| **Vault event stream** | `status`, `files-changed`, agents move | adds `browser-call` and `browser-call-done`; on connect, pending calls are sent before the live events (as the last agents move is) |
| **Tool call** (chat) | `writes`, `opens`, `url`, `suggestion`, `query` | adds `browser: true` for browser tools; the chip shows a waiting state while the call is pending |

## Rules

- A browser call is answered at most once: the first valid answer wins, later ones get `409`.
- Only the answering tab answers; other tabs of the same user ignore the event.
- No answer by the deadline is not an error the model sees as a failure: the tool returns "the user's device did not
  answer". While the call waits, the chip asks the user to open the app to share the location.
- A turn without a user time zone (old PWA, ingest runner) uses the deployment's `timezone` setting.
- The position never leaves the user's chat: it is the tool's output, stored in the opencode session like every tool
  output, and deleted with the chat.
