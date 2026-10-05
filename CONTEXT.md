# karpathy.app

A mobile-friendly app for reading, editing, and talking to an AI about Markdown vaults that live in GitHub repos.

## Language

### Vaults

**Vault**:
A GitHub repo (optionally a subfolder of it) whose Markdown notes the app works on. The app holds no content of its own.
_Avoid_: Workspace, project, notebook

**Vault root**:
The folder inside the repo that the vault starts at; the repo root unless a subfolder was configured.

**Active vault**:
The one vault the UI is currently scoped to; every file, search, and chat operation targets it.

### AI

**Chat**:
A resumable conversation with the AI, bound to exactly one vault; each vault keeps a list of past chats. The AI's reach is limited to that vault's root.
_Avoid_: Session, thread, conversation

**Turn**:
One user prompt in a chat plus everything the AI reads and changes in response.

### Changes

**Uncommitted change**:
A file in a vault that differs from its last commit, whether the user or the AI changed it. Both are pooled together until the next commit.
_Avoid_: Draft, pending edit, dirty file

**Unsaved change**:
An edit held only in the editor that hasn't been written to the vault yet.

**Commit**:
The user-triggered act of recording all uncommitted changes of a vault and pushing them to GitHub in one step. There is no commit without a push.
_Avoid_: Sync, save, publish

**Unpushed commit**:
A commit whose push failed; it stays local and is pushed again on the next commit or pull. If GitHub has moved on in the meantime, the next pull turns it back into uncommitted changes.

**Commit reminder**:
A prompt that appears once the number of uncommitted changes passes a configurable threshold, offering to commit right away.

**Stale save**:
A save rejected because the file changed (by the AI or a pull) since the editor loaded it.
_Avoid_: Conflict (reserved for git)

**Conflict**:
A git-level clash between the vault's uncommitted changes and changes pulled from GitHub (e.g. from Obsidian). It blocks writes to the vault until the user resolves each clashing file (keep mine / theirs / both).

### Editor

**Vault file**:
Any file in the vault: a note, a media file or a binary file. The file tree, Delete, the Changes list and commits work on vault files.
_Avoid_: Note (for anything that isn't text), document, item

**Note**:
A vault file that is UTF-8 text, usually `.md`. Only notes can be edited and have a Write/Read mode.

**Media file**:
A vault file whose extension marks it as an image, video or audio file. Shown, never edited.
_Avoid_: Attachment, asset, resource

**Embed**:
Markdown that asks for a file to be shown inside a note: `![[target]]`, `![[target|300]]` or `![alt](path)`. Showing it never changes the note.
_Avoid_: Attachment (that's the file), inline image, transclusion (embedding a note's text, which the app doesn't do)

**Upload**:
The user putting a file from the device into the vault: a photo or a PDF, with the **+** (Take photo, Choose file) or by dropping it on the note. It creates a new vault file and never overwrites one; the result is an uncommitted change.
_Avoid_: Import, add file, attach (that's the button)

**Own folder**:
A folder that belongs to one page and holds its attachments: the folder carries the page's name (`Wiki/foo/foo.md`) or the page is its `index.md`. A page that isn't in one is flat; its first upload from the editor moves it into one.
_Avoid_: Rename (there is no general rename)

**Path-form link**:
A link that names a folder on the way to its target (`[[serien/foo]]`, `[Foo](../serien/foo.md)`), as opposed to a bare link (`[[foo]]`). A move into the own folder rewrites the path-form links to the page; bare links keep resolving by name.

**Chat attachment**:
A vault file sent with a prompt, so the model receives its content (image or PDF), not only its path. It is uploaded first, into a new `Sources/upload-…/` folder per message.
_Avoid_: Attachment for a file in general

**File card**:
What shows instead of a player: file name, size, Download, plus Open for a PDF and Load anyway for a media file over the preview limit (50 MB).
_Avoid_: Placeholder

**Write mode**:
Raw Markdown with live preview, editable. The mode of a new browser.
_Avoid_: Edit mode, source mode

**Read mode**:
A rendered, non-editable view of a note that the user can switch to.
_Avoid_: Preview

**Mode preference**:
The Write/Read mode the user last chose. Applies to every note opened afterwards and survives a reload; one per browser.
_Avoid_: Default mode

### Operations

Terms for running the app, not for using it ([`specs/system/deployment.md`](specs/system/deployment.md)).

**Release**:
A git tag `vX.Y.Z` together with the four images CI built from it (`ghcr.io/tillg/karpathy.app-{proxy,backend,opencode,egress}:X.Y.Z`) and the `compose.yml` attached to the GitHub release. Never changes once published; a tag whose images failed to build isn't one.
_Avoid_: Build, deployment

**Pre-release**:
A release from a `vX.Y.Z-rc.N` tag, from any commit. Deployable by name, but never GitHub's "Latest" or `:latest`, so a deployment without a version never picks it.

**Version**:
The `X.Y.Z` of a release (the tag without the `v`), as `GET /api/health` reports it. Dev and prodtest builds report `dev`.

**Target**:
A named place a release can be deployed to: `local` (the Lima VM on the Mac) or `hetzner`. One host, its own settings and secrets.
_Avoid_: Environment, stage, server

**Deployment**:
One run of `just deploy <target> [version]`: brings the host to the desired state, starts the release and ends with the smoke check. Failing the smoke check fails the deployment.
_Avoid_: Rollout, push, ship

**Current release**:
The release a target runs now (the `current` symlink on the host); earlier ones stay for rollback.

**Rollback**:
A deployment of an older release, with today's playbook. Not a separate mechanism.

**Smoke check**:
The end of every deployment: all containers healthy, `/api/health` reachable through the proxy with the target's token, and it reports the requested version.

**Alert**:
A push message to the operator's phone (ntfy) when something needs a person: disk or memory over the threshold, a container unhealthy or down, the certificate expiring, the heartbeat missing.

**Heartbeat**:
A ping the server sends to healthchecks.io every 5 minutes; when it stops (or reports a failure), healthchecks.io raises the alert. The only way to notice the whole box is gone.
_Avoid_: Uptime check

**Website**:
The public product page at `https://karpathy.app` that describes the app. Static, no login, no user data; its source is `site/`. The app itself runs elsewhere (`app.karpathy.app` on the `hetzner` target).
_Avoid_: Homepage, landing page, web app

**Website deploy**:
Publishing the current `site/` from `main` to GitHub Pages. Happens on its own, independent of releases; the website has no version.
_Avoid_: Release
