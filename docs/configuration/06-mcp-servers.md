# MCP servers

[Configuration](README.md) › 6 of 8

The plugin ships **no** `.mcp.json`, and that is the point: a plugin-level MCP
declaration loads for everyone who enables the plugin, which would make optional
servers mandatory. Configure them yourself.

| Server | Used by | Absent |
|---|---|---|
| Playwright | `/pd:validate` | a human checklist instead of evidence, and no PASS is recorded |
| context7 | questions about someone else's library, in planning and in review | the answer comes from the model's own knowledge of that library's versions, which goes out of date without saying so |

Which agents can see a server's tools is controlled by `tools:` in
`agents/*.md`, since plugin agents cannot declare MCP servers themselves.

## Playwright: the one command to run by hand

The plugin cannot do this for you — no `.mcp.json` ships with it, deliberately,
because a plugin-level declaration loads for everyone. Run it once per machine:

```bash
claude mcp add playwright -s user -- \
  npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222
```

**`-s user` is the part worth getting right.** Without it `claude mcp add` uses
local scope, which is keyed by the exact directory you ran it in. Every issue
worktree is a different directory, and so is the fork root versus its parent —
so a server added locally is invisible from the session that needs it, while
`claude mcp list` in the directory you added it from shows it perfectly.

**The port is a constant on purpose.** It matches `validation.app.debug_port`,
and `pdkit validate launch` refuses to start when something else already answers
there rather than quietly picking another port — which is what allows the
endpoint to be written down once.

**Pointing it at nothing is safe.** The server connects lazily: it starts,
registers its tools and waits, so it survives every session in which you never
launch the application. It fails only when a tool is called with nothing
running.

`/pd:doctor` checks the wiring, not just the name — a server without
`--cdp-endpoint`, or one aimed at a different port, is reported as a warning
with the command to fix it.

**Playwright attaches to an application pdkit started.** `pdkit validate launch`
spawns the build with `--remote-debugging-port`, waits for `/json/version` and
prints the endpoint. That is the shape upstream's own runner uses
(`tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts`), which is
also the answer to whether an Electron podman-desktop can be driven at all: it
has been, in their CI, all along. Verified end to end on 2026-08-02 against the
development build — `browser_snapshot` came back with the real accessibility
tree.

"No Playwright" and "nothing to point Playwright at" are different problems.
`doctor` reports the second separately, as `validate:app` — a perfectly
configured server still has nothing to drive if the tree was never built.

---

**The design** — [8 · MCP servers](../specification/08-mcp-servers.md), [workflows · 4 · Validating against the running application](../workflows/04-validating.md)

← [Model selection](05-models.md) · [Contents](README.md) · [Hooks other tools install](07-hooks-from-other-tools.md) →
