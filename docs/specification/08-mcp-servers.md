# 8. MCP servers: what actually makes a difference

[Specification](README.md) › Section 8

A deliberately short list. Each server is tokens in the context and one more
point of failure.

| Server | Role | Verdict |
|---|---|---|
| **Playwright MCP** | `/pd:validate`: walk scenarios in the running application, capture screenshots as evidence | **Take it.** The only way to close "manual validation" with evidence rather than claims. `pdkit` brings the application up (8.2); the server attaches to its CDP endpoint |
| **GitHub MCP** | issues, PRs, review threads, GraphQL resolve | **Optional.** The default is `gh` through `pdkit`: more deterministic, cheaper in tokens, easy to restrict to reads |
| **context7** (or an equivalent docs MCP) | a question about somebody else's library: API, configuration, what changed between versions | **Take it as optional.** A hint about a library is needed in planning and in reviewing somebody else's PR, and a model's knowledge of library versions goes out of date without saying so |
| **basic-memory** | a personal knowledge layer | **Optional, one-way bridge.** The source of truth is the `knowledge/` files, or the plugin is not portable to anybody else. There is no reverse import — two sources of truth would diverge |
| Chrome DevTools MCP | — | **No.** Covered by Playwright |
| sequential-thinking / memory-graph and similar | — | **No.** Orchestration is set by the skills and by `pdkit`; a separate "thinking" server only spends tokens |

**The plugin ships no `.mcp.json`, and that is the point:** a plugin-level MCP
declaration loads for everyone who enables the plugin, which would make optional
servers mandatory. `/pd:doctor` checks what is present and degrades gracefully —
no Playwright means `/pd:validate` produces a human checklist instead of a run,
and says explicitly that PASS was not recorded.

## 8.1 e2e tests as a first-class output

Since upstream welcomes e2e coverage, `/pd:validate` stops being only "run it and
capture evidence" and gains a second output: **a candidate for
`tests/playwright`**. That changes three things.

1. **`Done when` gets stronger.** A manual checklist is verified once, by one
   person, today; an e2e test is verified by CI on every pull request that
   follows. Where e2e fits, the done-criterion is a test run rather than steps in
   a description.
2. **The plan must decide it in advance.** `templates/plan.md` carries
   `e2e coverage: required | optional | no — <reason>`. The decision is made at
   planning, not afterwards: an e2e invented after implementation usually tests
   what was written rather than what was required.
3. **The e2e test is a slice candidate in its own right.** The `tests` layer is
   already last in merge order. The fork in the road: a test in the same PR as
   the feature proves the feature and simplifies review; a test as a separate PR
   gives a smaller diff but leaves the first PR unproven. **The default is that
   the test travels with the feature**, and it is split out only for bulk
   mechanical changes where one test covers the whole series.

A caution that cannot be dropped: podman-desktop's e2e tests are expensive and
flake-prone, and **a flake carried into somebody else's repository is the worst
thing this workflow can deliver.** Therefore: on the `quickfix` route e2e is not
added by default; a new e2e must pass three runs in a row locally before preflight
can go green; and a test needing an environment CI does not have is recorded in
`Notes for reviewers` rather than hidden.

## 8.2 How Playwright reaches an Electron application

The one question the delivery plan held open as needing a proof of concept, and
it was answered by upstream's own code.
`tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts` spawns the
podman-desktop binary with `--remote-debugging-port=<port>`, waits for a reply on
`http://127.0.0.1:<port>/json/version`, and connects with
`chromium.connectOverCDP`. The application exposes an ordinary CDP endpoint, and
Playwright MCP knows how to attach to one (`--cdp-endpoint`).

The division of labour follows directly:

- **`pdkit` brings the application up.** `validate launch` resolves the binary
  (`validation.app.binary`, then `PODMAN_DESKTOP_BINARY`, then
  `node_modules/.bin/electron .` after `pnpm build`), spawns it with the port,
  waits for readiness and records the pid and port in `validation.json`.
  Packaging is not required for this and costs noticeably more. The first two
  name a program from outside the tree, so they are read only from what the
  person wrote — `$PDKIT_HOME/config.yaml` and the environment, never a
  repository's `.pdkit.yaml` — and must be absolute.
- **The user connects the server.** No `.mcp.json` ships, deliberately, and the
  plugin cannot grant a server to one agent. `/pd:doctor` checks that the server
  is configured **with `--cdp-endpoint` and at the right port**, and says what to
  fix rather than just "Playwright is missing".

**Verified end to end on 2026-08-02, against a live application.** `validate
launch` brought up the development build (`PodmanDesktop/1.30.0-next
Electron/42.3.3`), CDP answered on `/json/version`, `@playwright/mcp` with
`--cdp-endpoint` attached, and `browser_snapshot` returned an 11.9 KB real
accessibility tree — navigation buttons, search.

Two findings came with it. **Pointing the server at nothing is safe:** a server
with a `--cdp-endpoint` leading nowhere starts normally and offers all its tools,
because it connects lazily on the first call. So it can be registered once per
machine rather than per run. And **restarting the application breaks the first
Playwright call** — three times out of three — after which it recovers on its
own; `validate launch` warns about this rather than leaving it to be discovered
mid-scenario.

What remains unmeasured: behaviour under a headless display, and the stability of
a CDP session over a long scenario. One snapshot on a fresh application says
nothing about the twentieth minute. Both are measured by running them, not by
reasoning, and neither blocks: the degradation is already described.

---

**In brief** — [`architecture/`](../architecture/README.md): [5 · Validation](../architecture/05-validation.md)

**In practice** — [`workflows/`](../workflows/README.md):

- [§4 — Validating against the running application](../workflows/04-validating.md)

← [7 · Preflight](07-preflight.md) · [Contents](README.md) · [9 · Configuration](09-configuration.md) →
