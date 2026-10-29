# `/pd:validate <issue>` — evidence instead of claims

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:validate`

The only phase that must **look at the running application**. The order is: bring
it up, explore, codify what was seen into a test, and only the run of the
codified test counts as proof.

1. `pdkit validate steps` — what is subject to checking: the R-set, the tasks
   with their `Done when`, the `e2e coverage` decision, and what is already
   attached.
2. `pdkit validate launch` brings the built application up under CDP. The shape
   is taken from upstream itself
   (`tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts`): the binary
   is spawned with `--remote-debugging-port` and readiness is decided by a reply
   on `/json/version`. Playwright MCP attaches to that endpoint.
3. `pd-validator` drives the application and attaches artefacts:
   `pdkit validate attach --evidence <file> --observed "<what is visible>"`. A
   step carries every R-ID it demonstrates — `--requirement` takes several, and
   one screenshot of a list usually shows two or three at once.
4. The same scenario is codified into a `tests/playwright` spec, and
   `pdkit validate run` runs it. **The run is the basis for `pass`**; exploration
   screenshots are an attachment to it, not a substitute.

   That command must run **exactly that spec**. Appending a path to a resolved
   suite script is not narrowing if the script already carries a path of its own:
   podman-desktop's `test:e2e:run` ends in a directory, so Playwright receives two
   positional filters and runs all forty-four specs. Resolution order:
   `preflight.scripts.e2e_spec` with `{spec}` → the Playwright runner directly
   when the repository has a config for it → the script plus the spec, but only if
   the script names no path. Otherwise it refuses: a command that runs the whole
   suite under the name of one spec is worse than no command.
5. `pdkit e2e stability` — `validation.e2e_stability_runs` green runs in a row.
6. `pdkit validate finish` computes the outcome and moves the state.

Three outcomes, and the third is not leniency:

| Outcome | When | What follows |
|---|---|---|
| `pass` | every step has an artefact, no non-zero exits | the normal path |
| `fail` | a capture with a non-zero exit | not `validated`; fix it |
| `unverified` | steps without artefacts: no Playwright, the app will not build, the scenario is unreachable | the transition is **allowed**, but the gap must reach the reviewer |

**A fourth thing can happen to a step, and it is not a fourth outcome.** A step
whose run failed because of the environment — the application launched for
exploration holding the Electron single-instance lock, a port in use, no
container engine — is a red finding about the laptop, and `finish` takes the
worst status in the record. `pdkit validate supersede <Vk> --by <Vn> --reason
"<what happened>"` sets it aside: it keeps its exit code, its run and its reason
in `validation.md` under `Set aside`, and stops counting towards the outcome.
The guards are what make it not an eraser — the replacement must have
demonstrated something itself, a step that passed cannot be set aside, the reason
is required, and the supersession is journalled. It exists because the
alternative was observed on 18835: an issue that could not move until somebody
edited `validation.json` by hand, which is exactly what the record is designed to
make impossible.

`unverified` does not block `implemented → validated` on purpose: a gate that is
expensive to pass gets routed around, and without Playwright the pipeline would
stall outright. But the gap is not allowed to evaporate either:
`validation-evidence` in preflight requires every artefact-less step to be named
under `Notes for reviewers`. Same device as `inconclusive` for slices and CI:
blocking over something the change did not do teaches people to work around the
gate, and staying silent is a lie.

**Validation runs in the issue's working tree, not in the verification tree.**
The verification tree gets `reset --hard` and `clean -fdx` before every run, and
would eat the build validation exists to look at.

---

**In brief** — [`architecture/`](../../architecture/README.md): [5 · Validation](../../architecture/05-validation.md)

**In practice** — [`workflows/`](../../workflows/README.md):

- [§4 — Validating against the running application](../../workflows/04-validating.md)

← [`/pd:plan-review`](plan-review.md) · [Contents](../README.md) · [`/pd:audit`](audit.md) →
