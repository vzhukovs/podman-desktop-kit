# 4. Validating against the running application

[Workflows](README.md) › Part II — Proving it works · [Sessions and models](#sessions-and-models)

Between `/pd:exec` and `/pd:audit`, and the only phase that looks at the
application rather than at the code.

```
/pd:validate 12345    → evidence, an e2e candidate, and validation.md
```

What happens under that line:

```
pdkit validate steps  --issue 12345          requirements, Done when, e2e decision
pdkit validate launch --issue 12345 [--build]  the app, with CDP on
                                             → Playwright MCP attaches here
pdkit validate attach --issue 12345 --title … --evidence shot.png --observed "4.6:1"
pdkit validate codify --issue 12345 --spec tests/playwright/src/specs/x.spec.ts
pdkit validate run    --issue 12345          the run PASS rests on
pdkit e2e stability   --issue 12345          three in a row, stopping at the first red
pdkit validate finish --issue 12345          outcome, validation.md, transition
pdkit validate stop   --issue 12345
```

**PASS is an attached artefact, not a claim.** `attach` has no `--status`: a
captured run produces pass or fail, a screenshot with an observation produces
`observed`, and a step with neither is `unverified`. There is no input through
which "I read the code and it looks right" becomes a pass.

**The promise is narrower than it sounds, on purpose.** No code here can confirm
that what appeared on screen was correct. PASS means an artefact was captured;
whether the artefact shows the right thing stays with you and the reviewer.

**`unverified` does not stop the pipeline.** Without Playwright there would be no
way out of `implemented`, and a gate that expensive gets routed around. What stops
the gap from vanishing is the other end: `validation-evidence` in preflight refuses
a pull request body that does not name the undemonstrated steps under `Notes for
reviewers`. An unverified step nobody mentions reads exactly like a verified one.

**A new e2e test runs three times in a row before it counts**, and the series is
tied to a digest of the spec: edit the test afterwards and preflight fails asking
for a re-run rather than passing on a stale series. A flake carried into someone
else's repository is the worst thing this workflow can deliver.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/clear
/model sonnet                       already sonnet if you came from /pd:exec
/effort medium
/pd:validate 12345                  Playwright MCP connected to this session

/clear
/effort high
/pd:audit 12345                     still sonnet
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `/pd:validate 12345` | **new** · issue tree | sonnet | `pd-validator` · sonnet |
| next: `/pd:audit 12345` | **new** · issue tree | sonnet | `pd-auditor` · opus |

Playwright MCP is connected to the session, not to the agent: connect it before
`/pd:validate`, in the session that runs it. The `pdkit validate …` lines below
are what the skill runs.

---

**The design** — [`/pd:validate`](../specification/04-contracts/validate.md), [8.2 · How Playwright reaches an Electron application](../specification/08-mcp-servers.md#82-how-playwright-reaches-an-electron-application), [architecture · Validation](../architecture/05-validation.md)

← [3 · A feature, cut into several pull requests](03-feature-in-several-prs.md) · [Contents](README.md) · [5 · Work that was already tried and reverted](05-tried-and-reverted.md) →
