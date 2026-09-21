## The rest is in the README

Three channels, deliberately not interchangeable — **dispatches** (proactive, queued), **escalations**
(reactive, genuinely blocking — permission gates and the agent's own `ask_human` pauses), and
**findings** (a durable log, not a live channel).

The README (in this extension's repo, `multi-repo-agent-control-center`) covers the full
architecture — the three local processes sharing one SQLite file, the repo self-introduction
mechanism, and the known limitations of this ad hoc build.
