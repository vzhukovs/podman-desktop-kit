# Hooks other tools install, and why they cannot get past the gate

[Configuration](README.md) › 7 of 8

Hooks on the `Bash` tool are **global**: one installed for an unrelated project
sees the commands you run here too, and can rewrite them. That is why
`lib/hooks/command-parse.js` strips wrapper programs — `sudo`, `env`, `nice`,
`nohup` and the rest — before any rule is applied, and why
`/pd:doctor --gate-selftest` probes that exact shape. The question the parser
answers is never "did somebody mean to wrap it" but "what is going to run".

If you install anything that hooks `Bash`, run the self-test afterwards.

**Receipts are unaffected either way.** `lib/evidence.js` spawns the command
itself from Node, so no hook on the `Bash` tool is consulted and nothing sits
between the command and the output that lands in the receipt.

---

**The design** — [6 · Hooks](../specification/06-hooks.md), [workflows · The push gate](../workflows/reference/push-gate.md)

← [MCP servers](06-mcp-servers.md) · [Contents](README.md) · [Retired keys](08-retired-keys.md) →
