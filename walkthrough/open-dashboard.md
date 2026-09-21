## Open the dashboard

Run **"Agent Control Center: Open Dashboard"** from the Command Palette.

Nothing is tracked yet on a fresh install — the dashboard will ask how to populate it:

- **Use sibling repos** — scans a directory for git repos. No network, no `gh`, no auth.
- **Discover from GitHub** — asks `gh` what exists for an org/user, and cross-references local
  clones. Also finds repos that exist on GitHub but aren't cloned yet.
- **Skip** — leave it empty for now.

Either, both, or neither — nothing runs until you choose.
