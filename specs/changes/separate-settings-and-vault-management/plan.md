---
feature: separate-settings-and-vault-management
title: "Plan: separate settings from vault management"
status: applied
order: 4
created: 2026-10-05
edited: 2026-10-05
---

# Plan: separate settings from vault management

Each step is one red → green cycle. Nothing is mocked.

- **e2e:** Playwright against the dev stack (`just dev` running): `just e2e <spec>`. Phone cases are tagged
  `@iphone`, tablet `@ipad`; untagged cases run on `desktop` and `webkit-desktop`.
- **Full check:** `just check` (lint, typecheck, unit + integration tests) and `just e2e` (whole suite).

Existing-test changes in steps 1 and 3 need the user's OK (see the proposal, "Tests this change has to
touch"). Step 1 changes paths only; step 3 changes assertions because the behaviour changes on purpose.

- [x] Route every existing admin test through `openVaults` / `openSettings` helpers (refactor, today's UI)
  - Test first: existing `admin`, `a11y`, `a11y-keyboard`, `fix-15`, `fix-16`, `fix-24`, `git`, `mobile`,
    `version`, `web-access` specs pass before and after. Add to `e2e/helpers.ts`:
    `openVaults(page)` = click `vault-switcher` → `manage-vaults`, wait for `admin`;
    `openSettings(page)` = click `open-admin` → `admin-open-settings`, wait for `token-input`.
    Replace each `open-admin` click (18 uses) with the matching helper; assertions untouched.
  - Verify: `grep -rn "open-admin" e2e/*.spec.ts` → no match (the two in-dialog list → Settings walks in
    `a11y.spec.ts` and `mobile.spec.ts` stay until step 3);
    `just e2e admin a11y a11y-keyboard fix-15 fix-16 fix-24 git mobile version web-access` → green.

- [x] The gear opens a Settings dialog that holds only settings
  - Test first: `e2e/settings-split.spec.ts` › "gear opens Settings: token, app settings, version, no
    vaults". Clicks `open-settings`; expects `getByRole('dialog', { name: 'Settings' })` visible, its
    heading focused, `token-input`, `settings-threshold`, `settings-web-access`, `version-server` inside
    it, and `admin-vault`, `admin-back`, `admin-open-add` absent. Escape → dialog hidden, focus on
    `open-settings`. Fails today: no `open-settings` testid (the gear is `open-admin` and opens the
    vault list).
  - Code: store `AdminOpen` union and `setAdminOpen(false | 'vaults' | 'settings', vault?)`; update the
    four callers; `SettingsDialog` in `Admin.tsx`; gear `title`/`aria-label` "Settings",
    `data-testid="open-settings"`. Change `openSettings` helper body to click `open-settings` and wait
    for `settings-dialog`. Settings tests that screenshot or close the dialog via the `admin` testid
    (`fix-16`, `git`, `web-access`) use `settings-dialog` (path only). Focus return is checked after
    opening from the keyboard: WebKit doesn't focus a clicked button.
  - Verify: `just e2e settings-split` → green; `just check` → green (typecheck proves every caller
    moved to the new signature); `just e2e fix-16 git version web-access` → green.

- [x] Manage vaults… opens a Vaults dialog that holds no settings
  - Test first: `settings-split.spec.ts` › "Manage vaults… opens Vaults: list, add, help, no settings".
    Via the vault menu: the `manage-vaults` item's text doesn't contain "settings";
    `getByRole('dialog', { name: 'Vaults' })` visible with `admin-vault` rows, `admin-open-add`,
    `admin-help`; `admin-open-settings`, `token-input`, `settings-threshold` absent. Fails today: the
    dialog is named "Vaults & settings" and has the Settings button.
    Second case › "Edit vault opens details, All vaults shows Vaults without settings": makes a vault
    `clone-failed` as `fix-22.spec.ts` does, clicks `manage-vaults-cta`; expects `vault-details`, then
    `admin-back` → dialog named "Vaults", no `admin-open-settings`. Fails today for the same reason.
  - Code: remove the `settings` view kind and `admin-open-settings` from the vault dialog; list title
    "Vaults"; menu subtitle "Add / configure GitHub repos", icon `rectangle_stack`.
    Update `a11y-keyboard.spec.ts:71-73` to dialog/heading name "Vaults" (exact). `expectTabTrapped(page,
    12)` presses Tab 12 times and checks focus stays inside; it doesn't count stops, so 12 stays.
    `a11y.spec.ts:100` and `mobile.spec.ts:49`: open the Settings dialog with `openSettings` instead of
    list → Settings → back; scans and 375 px checks unchanged.
  - Verify: `just e2e settings-split a11y a11y-keyboard mobile admin fix-22` → green; `just check` → green.

- [x] Both dialogs fit a phone and look right
  - Test first: `settings-split.spec.ts` › "@iphone Settings and Vaults dialogs fit 375 px": opens each via
    the helpers and asserts `document.documentElement.scrollWidth <= innerWidth`. A guard (steps 2–3
    already built the dialogs); `mobile.spec.ts:49` keeps covering the token-test overflow.
  - Verify: `just e2e settings-split --project=iphone` → green; 1× Playwright screenshots of both dialogs
    on desktop and `@iphone`, saved to `tmp/` and looked at: Settings has no "All vaults" button, Vaults
    has no Settings button, the gear tooltip reads "Settings".

- [x] README names the gear for settings
  - Test first: none — docs. `README.md:47` and `:53` say "admin area → Settings".
  - Code: "the gear → Settings" (token), "the gear → Settings → Web access".
  - Verify: `grep -n "admin area" README.md` → no match; `grep -rn "Vaults & settings" apps/web/src
    README.md` → no match.

- [x] No leftovers of the combined modal
  - Test first: none — static check.
  - Verify: `grep -rn -e open-admin -e admin-open-settings -e "kind: 'settings'" apps/web/src e2e` → only the
    absence checks in `settings-split.spec.ts`;
    `just check` → green; full `just e2e` → green.

System docs are updated at `/spec:archive`.
