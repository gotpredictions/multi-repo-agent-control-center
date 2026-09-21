## Let a coordinator session dispatch to it

The dashboard is only half of this. To let a Claude Code session act as a coordinator — dispatching
work, resolving escalations, adding repos it already knows about — register the MCP server, either
way:

**[Create a .mcp.json](command:multiRepoAgentControlCenter.createMcpJson)** — the simpler option. A
plain, reviewable file at a project's root that Claude Code auto-discovers for sessions rooted
there. Merges into one that already exists rather than overwriting it, and opens the file after so
you can see exactly what it wrote.

**[Copy the registration command](command:multiRepoAgentControlCenter.copyMcpRegistrationCommand)**
— the CLI alternative, for `~/.claude.json`-based (user- or project-scoped) registration instead of
a file in the repo. Only copies; nothing runs until you paste it into a terminal yourself.

Either way, both are computed from where this extension is actually installed *and* which DB this
install's daemon actually watches, not hardcoded (a dev checkout and an installed `.vsix` sit in
different places, and the DB path — `--db`, always included — matters just as much as the script
path: without it pointing at the same file the dashboard uses, dispatches sent through MCP would
succeed but never be picked up by anything).

This only reaches **new** sessions — one already running won't pick it up without a restart.
Verify with `claude mcp list`.
