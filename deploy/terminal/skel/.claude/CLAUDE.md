# This machine: the karpathy.app terminal

You run in the app's terminal on the server, inside a vault (`/vaults/<id>`, a git clone of a GitHub repo).

- **git is read-only here.** `git status`, `log` and `diff` work; `git add`, `commit`, `push` and `pull` fail.
- **Commit and push with `vault`** (it goes through the app, like its Commit button, with the app's secret scan):
  - `vault status`: what changed, what isn't pushed
  - `vault commit -m "message"`: commits every change in the vault and pushes it (no staging: it is all or nothing)
  - `vault push`, `vault pull`
- If the secret scan blocks a commit, tell the user to commit it from the app (Changes) after checking the finding.
