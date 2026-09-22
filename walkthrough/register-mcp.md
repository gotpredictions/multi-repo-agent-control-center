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

Either way, both point at a plain URL (`http://127.0.0.1:<port>/mcp?dbId=<id>`) — no process to
spawn, since the daemon hosts the MCP endpoint itself over HTTP on a loopback port and fetches its
own current port fresh each time you run either command, rather than a stale one cached from
earlier. `dbId` names which database to talk to — an opaque label the daemon resolves to a file
itself, never a path you have to get right by hand.

This only reaches **new** sessions — one already running won't pick it up without a restart.
Verify with `claude mcp list`.
