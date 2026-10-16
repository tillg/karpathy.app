---
feature: website-screenshots-and-origin
title: "Architecture: website screenshots and the idea's origin"
status: applying
order: 3
created: 2026-10-16
edited: 2026-10-16
---

# Architecture: website screenshots and the idea's origin

The site stays what it is (`specs/system/architecture.md` › Website): plain HTML + CSS, no script, no
third-party request, relative paths only, assembled by `site/build.sh` into `_site/` and deployed by
`pages.yml` on pushes to `main`.

## Page structure

```mermaid
flowchart TB
  H[hero] --> F[features]
  F --> SS["#screenshots — new<br/>Mac wide, iPad + iPhone below"]
  SS --> HW["#how"]
  HW --> OR["#origin — new<br/>tweet quote card + gist card"]
  OR --> SH["#self-host"]
```

### `#screenshots`

- Heading "See it on every device", then three `<figure>`s with a `<figcaption>` each (Mac, iPad, iPhone).
- The Mac shot spans the full content width; iPad and iPhone share the row below (CSS grid, the iPhone column
  narrow). At phone width all three stack.
- Each `<img>` has `alt`, the real `width`/`height` of the file (no layout shift), `loading="lazy"` and
  `decoding="async"`, and is wrapped in a link to the file itself (click = full size, no script).
- Rounded corners and the site's `--shadow`, so the shots sit on the page like device screens.

### `#origin`

- The hero gets one line under the lead: "Built on Andrej Karpathy's LLM Wiki idea", linking `#origin`.
- Heading "Where the idea comes from".
- A `<blockquote cite="https://x.com/karpathy/status/2039805659525644595">` with the tweet's title line and its
  opening sentence, then a footer line: Andrej Karpathy, the date as `<time datetime="2026-04-02">`, a link
  "View on X".
- A card for the gist "LLM Wiki" (2026-04-04) with one sentence on what it describes and a link.
- One closing sentence: karpathy.app brings that loop to the iPad and the phone.

## Files

| File | Change |
|---|---|
| `site/index.html` | the two sections |
| `site/style.css` | `.shots`, `.shot`, `.origin`, `.quote` rules; tokens unchanged (the token-equality test stays) |
| `site/screenshots/{mac,ipad,iphone}.webp` | new |
| `site/build.sh` | also copies `site/screenshots/` to `_site/screenshots/` |
| `site/capture.mjs` | new: takes the shots |
| `site/site.test.mjs` | tests for both sections and the images |
| `README.md` › Website | how to retake the screenshots |

## Taking the screenshots: `site/capture.mjs`

A Node script using the repo's `playwright` dependency (WebKit for all three, so they render like Safari). Input: the app's base URL and a token file (defaults: this checkout's prodtest,
`tmp/prodtest/secrets/bearer_token`) and the vault id. For each device class it opens a fresh browser context at
the viewport and scale of the domain table, logs in with the token, opens the vault, a note and the chat that
already holds the demo answer, waits for the network to settle, saves a PNG to `tmp/shots/`, and converts it with
`cwebp -q 82` into `site/screenshots/`.

```mermaid
sequenceDiagram
  participant Dev as developer
  participant PT as just prodtest
  participant C as site/capture.mjs
  participant W as cwebp
  Dev->>PT: up + add demo vault + one chat turn
  Dev->>C: node site/capture.mjs
  loop Mac, iPad, iPhone
    C->>PT: open vault, note, chat (viewport)
    C->>C: screenshot → tmp/shots/<device>.png
    C->>W: → site/screenshots/<device>.webp
  end
```

The chat turn is made once by hand in the app (the local dev model answers), so the script only reads.

## Key decisions

| Decision | Alternatives considered | Why |
|---|---|---|
| Static quote card for the tweet, no `widgets.js` | official X embed | no script / tracking on the site; works when X is unreachable ([DECISIONS](../../../DECISIONS.md#run-2026-10-16-1016-3)) |
| Shots from `just prodtest` + demo vault | prod over Tailscale; a dev stack | no prod credentials; release UI with the `karpathy.app` header ([DECISIONS](../../../DECISIONS.md#run-2026-10-16-1016-2)) |
| WebP only, no PNG fallback | `<picture>` with PNG fallback | every browser the site targets (Safari ≥ 14) decodes WebP; one file per shot |
| A capture script in `site/` | Playwright MCP by hand | shots can be retaken after UI changes |
| Light mode only | a dark set via `<picture media>` | half the files; the shots are illustrations, not the page's own theme |
| The hero links to `#origin` ("Built on Andrej Karpathy's LLM Wiki idea") | origin section only, far down the page | #132 asks for the origin to be *visible*; a reader of the hero sees it without scrolling |
| WebKit for all three device classes | Chromium for the Mac | Safari is the browser on all three; one engine, one font rendering |
| The quote is the tweet's title line and first sentence, verbatim | a paraphrase; the whole tweet | short, attributed, linked; a paraphrase would put words in his mouth |
| Shot content: the demo vault's coffee topic — the note `aeropress` and a chat whose answer reads wiki pages (file chips visible) | the topology or mountains topics | coffee pages have pictures and short answers; file chips show what makes the app different |
| The capture script clicks through the UI (login, vault, note, chat) | deep links | the app has no URL routing for vault, note or chat |

## Tests (`site/site.test.mjs`)

- `#screenshots` has three `<img>` under `screenshots/`, each with non-empty `alt`, numeric `width`/`height` and
  `loading="lazy"`; the `width`/`height` match the WebP file's real size (read from its `VP8X`/`VP8 ` header).
- Each screenshot is ≤ 400 KB.
- `#origin` links `https://x.com/karpathy/status/2039805659525644595` and
  `https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`, has a `<blockquote cite>` and a
  `<time datetime="2026-04-02">`.
- The existing "every local href/src exists in _site" test covers the build copying `screenshots/`.
