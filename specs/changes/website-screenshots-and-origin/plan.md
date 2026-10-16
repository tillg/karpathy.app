---
feature: website-screenshots-and-origin
title: "Plan: website screenshots and the idea's origin"
status: applying
order: 4
created: 2026-10-16
edited: 2026-10-16
---

# Plan: website screenshots and the idea's origin

Every step runs `node site/site.test.mjs` (the site suite, also part of `npm test`).

## Origin (#132)

- [x] Add the `#origin` section: tweet quote card and gist card
  - Test first: `site/site.test.mjs` › "names the idea's origin: Karpathy's tweet and gist" — asserts the
    `#origin` section links the tweet and the gist URLs, has a `<blockquote cite=…>` and
    `<time datetime="2026-04-02">` — fails today: no `#origin` section
  - Verify: `node site/site.test.mjs` → all pass
- [x] The hero points to the origin: "Built on Andrej Karpathy's LLM Wiki idea" linking `#origin`
  - Test first: `site.test.mjs` › "the hero links to the origin" — asserts the `.hero` section has
    `href="#origin"` — fails today: no such link
  - Verify: `node site/site.test.mjs` → all pass

## Screenshots (#156)

- [x] `site/build.sh` copies `site/screenshots/` into `_site/screenshots/`
  - Test first: `site.test.mjs` › "build copies site/screenshots" — puts no file, asserts every file of
    `site/screenshots/` exists under `_site/screenshots/` and that the dir exists — fails today: build.sh copies
    only top-level files
  - Verify: `node site/site.test.mjs` → all pass
- [x] Write `site/capture.mjs` and take the three screenshots from `just prodtest` with the demo vault
  - Test first: none — a capture tool driving a live stack; its output is checked by the next step's tests
  - Verify: `ls site/screenshots/{mac,ipad,iphone}.webp` → three files; each viewed and free of admin screens,
    tokens and error states
- [x] Add the `#screenshots` section with the three images
  - Test first: `site.test.mjs` › "shows the app on Mac, iPad and iPhone" (three `<img>` under `screenshots/`
    with `alt`, `loading="lazy"`, `width`/`height` equal to the WebP's real size) and › "screenshots stay under
    400 KB" — fail today: no `#screenshots` section
  - Verify: `node site/site.test.mjs` → all pass; `just site` page viewed at 1440 px and 390 px, light and dark,
    no horizontal scroll
- [ ] README › Website: how to retake the screenshots
  - Test first: none — docs
  - Verify: `grep -n "capture.mjs" README.md` → matches

System docs are updated at `/spec:archive`.
