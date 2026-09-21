## Let a coordinator session dispatch to it

The dashboard is only half of this. To let a Claude Code session act as a coordinator — dispatching
work, resolving escalations, adding repos it already knows about — register the MCP server.

**[Copy the registration command](command:multiRepoAgentControlCenter.copyMcpRegistrationCommand)**
— computed from where this extension is actually installed, not a hardcoded path (a dev checkout
and an installed `.vsix` sit in different places, so a fixed path here would be wrong for one of
them). It only copies the command; nothing runs until you paste it into a terminal yourself.

It looks like:

```bash
claude mcp add --scope project control-center -- node <this-install's-real-path>/out/mcpServer.js
```

`--scope project` registers it for sessions run from the current project only — use `--scope user`
instead for every project on this machine. Nothing here registers it globally for you; that's your
call to make.

This only reaches **new** sessions — one already running won't pick it up without a restart.
Verify with `claude mcp list`.
