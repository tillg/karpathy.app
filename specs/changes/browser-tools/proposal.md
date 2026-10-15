---
feature: browser-tools
title: "Proposal: browser tools (local time and position)"
status: applied
order: 1
created: 2026-10-15
edited: 2026-10-15
---

# Proposal: browser tools (local time and position)

**Issue:** [#151](https://github.com/tillg/karpathy.app/issues/151)

## Why

The AI runs in the opencode container on the server. All it knows about "now" is the server clock (UTC in every
deployment), and it knows nothing about where the user is. That shows up in everyday prompts:

- "What's on for today?", "Write today's journal entry", `/research` naming its note `Research/<YYYY-MM-DD>-…`:
  after 22:00 in Germany the server's date is already tomorrow's (or, in summer, two hours off in the other
  direction for an early morning prompt). The AI can't tell, so it guesses or uses UTC.
- "Find a good café near me", "What's the weather here?", "Add this place to my travel notes": the AI has to ask
  where "here" is.

The browser knows both: the device's time zone, and, with the user's permission, the position. The issue asks for
tools the AI can call to get them, served by the browser, and for thoughts on other browser-side services.

## What changes

Two parts, because time and position differ: the time zone is harmless and needed on almost every turn, the position
is sensitive and needed rarely.

**Local time, with every prompt.** The browser sends its IANA time zone and locale with every prompt (slash commands
included). When the backend hands the turn to opencode, it adds a hidden line with the user's current local time:
"User's local time: Thursday 2026-10-15 23:41, Europe/Berlin (UTC+02:00), locale de-DE." No tool and no browser
round-trip: it works with the phone locked and for a queued turn (the time is taken when the turn runs). A turn without
a time zone (headless ingest, an old PWA) uses the deployment's existing `timezone` setting.

**Position, as a browser tool.** A new kind of tool, the **browser tool**: the AI calls it in opencode like any tool,
but the answer comes from the user's browser, live, while the tool call waits. One ships with this change:

| Tool | Returns | Permission |
|---|---|---|
| `user_location` | Latitude and longitude as precise as the device can tell (GPS: about 10 m), accuracy in meters, age of the fix; or that the user declined / no position is available | the browser's own location prompt, the first time |

```mermaid
sequenceDiagram
  participant M as Model (opencode)
  participant B as Backend
  participant W as Browser (the tab that sent the prompt)
  M->>M: calls user_location
  B-->>W: vault event browser-call {chat, call, tool}
  W->>W: navigator.geolocation (browser asks the first time)
  W->>B: POST …/browser-calls/:call {result}
  B->>M: answer handed to the waiting tool
  M->>M: continues the reply with the position
```

- **Who answers.** The browser tab that sent the turn's prompt. Not "any open device": a laptop at home must not
  answer "where am I?" for the phone in the user's pocket.
- **Live, not a snapshot.** The AI asks only when it needs it; the position travels with no prompt that doesn't.
- **When nobody answers** (the tab was closed, the phone locked, the user ignored the prompt for 90 s), the tool
  returns that the device did not answer, and the AI asks the user. While it waits, the chip says "open the app to
  share your location".
- **Visible.** Each call shows as a chip in the chat ("used your location (±12 m)", "location not shared"), like every
  other tool call.
- **The mechanism is general.** Adding the next browser tool means one handler in the web app, one result schema in
  `shared` and one small tool file in the opencode image. Nothing in the channel itself changes.

## Decisions taken with the user (2026-10-15)

- **Position: ask on first use.** No app setting, and no extra in-app confirmation per call. The first
  `user_location` call triggers the browser's own permission prompt; the browser remembers the answer (per site, and
  on iOS per app). Declining is a normal answer the AI gets ("the user did not share their location"), not an error.
- **Position: live round-trip**, not context sent with every prompt: the tool call waits for the browser's answer.
- **Time: sent with every prompt**, not a tool (grill): opencode's system prompt already states the server's date, so
  the model would rarely think to ask for the local one.
- **Coordinates and accuracy only, as precise as possible** (grill): high-accuracy request, no rounding, so "nearest
  bakery" and "which street am I on" work. The cost: the exact position (the user's house) goes to the model provider
  and stays in the chat history; see the architecture's *Security*. No reverse geocoding: no third party sees the
  position. If web access is on, the model can look the place up itself.
- **Only time and position for now.** Other browser-side services wait until the mechanism exists. The user named
  client-side Instagram scraping as a candidate (see *Later*).

## Scope

In scope: time zone and locale in the prompt body, the hidden local-time line, the fallback to the `timezone` setting; the
browser-call channel (tool waits, backend announces on the vault event stream, browser answers by POST, backend hands
the answer to the tool); the tool `user_location`, its web handler and chip labels; e2e and docs.

Out of scope:

- an app setting or per-call confirmation for location sharing (the browser's site permission does that);
- reverse geocoding, maps, place names;
- continuous tracking or a position sent with every prompt;
- any further browser tool (camera, clipboard, notifications, Instagram);
- answering from a device other than the one that sent the prompt.

### Later: other browser tools

Candidates the channel makes possible, each its own change:

| Idea | Note |
|---|---|
| Instagram download in the browser | Named by the user. Caveat: a page on the app's origin can't fetch `instagram.com` with the user's login (CORS and `SameSite` cookies), so plain `fetch` from the PWA won't see more than the server does. Needs its own research (share sheet, bookmarklet, extension). |
| Device and screen | Phone, tablet or desktop, so the AI can keep answers short on a phone. |
| Ask the user | A form the AI shows in the chat (choices, a date). opencode's `question` tool is denied today. |
| Clipboard, notifications, camera | Each needs a user gesture or permission; weigh separately. |

### Housekeeping in this change

The local Lima VM target (`just vm`, `deploy/lima/`, the Ansible `local` inventory, https://localhost:9444) is
removed (user, 2026-10-15): every test runs on plain docker compose stacks (dev stack, `just prodtest`).

## Expected outcome

- "Write today's journal entry" at 23:30 in Munich uses today's Munich date, without a tool call.
- `/research` and the ingest runner name notes with the user's date.
- "Find a bakery near me" on the phone: the browser asks once for the location, the AI gets the position and (with
  web access) searches near it.
- The user sees every location lookup as a chip and can decline it.
- The next browser tool is a small, local change.

## Impact

| Area | Change |
|---|---|
| `deploy/opencode` | New tool `user_location.ts`; helper `lib/browser-call.ts` (wait for the answer file); allowed for `vault` and `vault-readonly` in `opencode.json`; bake step waits for eight tools |
| `apps/backend` | Prompt body gains `tabId`, `timeZone`, `locale`; `harness/opencode.ts` adds the local-time line as a synthetic part; new `browser-calls.ts` (pending calls, answer files, timeout); `harness/map.ts` marks browser tools (`BROWSER_TOOLS`); vault events `browser-call` / `browser-call-done`; route `POST /vaults/:id/chats/:chatId/browser-calls/:callId` |
| `apps/web` | Tab id in `sessionStorage`; `tabId`, `timeZone`, `locale` on every prompt; `lib/browser-tools.ts` (handler `user_location`), answering in the vault event handler, chip labels |
| `packages/shared` | Types `BrowserCall`, `BrowserCallResult`, result schema |
| `e2e` | `browser-tools.spec.ts` (fake time zone and geolocation through Playwright, decline, no answer) |
| Docs | `specs/system/*` at archive (architecture, domain, functional, security); README feature list; demo run book chapter "Time and place" |
