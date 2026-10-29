# What validation promises, and what it does not

[Architecture](README.md) › 5 of 7

`pdkit validate` brings up the built application with remote debugging on and
prints the endpoint; Playwright MCP attaches to it and drives it. Evidence is
attached as it goes — a captured run, or a file that has been hashed and described
— and the status of a step is derived from what is attached. There is no
`--status`.

The promise is deliberately narrower than [the slicer's](04-slicer.md), and the
difference is worth being explicit about. A slice's verdict is machine-readable all the way
down: it is an exit code. "The contrast is now 4.6:1" is an observation, and no
code can confirm it was read correctly. So PASS means **an artefact was
captured**, not that the application behaves. Promising more would buy a check
that reports on work it did not do — the same failure as a `pass` where a `skip`
belonged.

The third outcome follows from that. A step nobody could demonstrate is
`unverified`, and it does not block the transition: without Playwright the
pipeline would stall at `implemented`, and a gate that expensive gets routed
around. What keeps it from evaporating is preflight, which refuses a pull request
body that does not name it.

---

**In depth** — [`specification/`](../specification/README.md):

- [§4 — `/pd:validate`](../specification/04-contracts/validate.md)
- [§8.2 — How Playwright reaches an Electron application](../specification/08-mcp-servers.md#82-how-playwright-reaches-an-electron-application)

**In practice** — [`workflows.md`](../workflows.md):

- [§4 — Validating against the running application](../workflows.md#4-validating-against-the-running-application)

← [The slicer](04-slicer.md) · [Contents](README.md) · [Hooks](06-hooks.md) →
