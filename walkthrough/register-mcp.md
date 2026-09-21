## Let a coordinator session dispatch to it

The dashboard is only half of this. To let a Claude Code session act as a coordinator — dispatching
work, resolving escalations, adding repos it already knows about — register the MCP server with the
exact `claude mcp add` command for **your** install (it's logged, ready to copy, in the "Agent
Control Center" Output channel — Output view → select that channel).

It looks like:

```bash
claude mcp add --scope project control-center -- node /path/to/this/extension/out/mcpServer.js
```

`--scope project` registers it for sessions run from the current project only — use `--scope user`
instead for every project on this machine. Nothing here registers it globally for you; that's your
call to make.

This only reaches **new** sessions — one already running won't pick it up without a restart.
Verify with `claude mcp list`.
