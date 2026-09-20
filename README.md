# Multi-Repo Agent Control Center

Local VS Code extension: a live dashboard for coordinating coding-agent sessions across multiple
repos, replacing manual multi-terminal status checks.

Ad hoc local tooling — no release process, no CI, built incrementally as needed.

Design context: `ideas/multi-repo-agent-control-center.md` in the `.github-private` repo.

## Status

Scaffold only. `src/extension.ts` registers a placeholder "Agent Control Center: Open Dashboard"
command that opens an empty webview.

## Dev

```
npm install
npm run compile
```

Then `F5` in VS Code to launch an Extension Development Host.
