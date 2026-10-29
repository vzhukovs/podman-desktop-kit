# 7. Preflight — the deterministic gates

[Specification](README.md) › Section 7

`pdkit preflight [--slice N]` returns a machine-readable report. Twenty-three checks,
in the order `CHECK_IDS` in `lib/preflight/index.js` runs them:

| Check | How | Blocking |
|---|---|---|
| **working tree** | `git status --porcelain` is empty. First in the report: without it the rest are ambiguous | ✅ (untracked files ⚠️) |
| **quickfix size** | diff lines counted separately for code and tests, against `quickfix.max_changed_lines` and `max_files`. Only on the `quickfix` route | ⚠️ never blocks |
| tests | `pnpm test:<project>` per affected package, falling back to `pnpm test:unit` | ✅ |
| lint | `pnpm lint:check` | ✅ |
| typecheck | `pnpm typecheck`, the whole repository — a type error lands in the consumer of a change. `preflight.typecheck_scope: packages` narrows it to `pnpm typecheck:<package>` and says so | ✅ |
| SPDX | every added file carries the header in the repository's house format — the Apache block with the copyright line, the identifier inside it | ✅ |
| conventional commits | every commit on the branch: a type from the list in `CONTRIBUTING.md`. **Scope is not required by upstream** — its absence is a note on a passing check, not a failure | ✅ on type, a note on scope |
| Signed-off-by | exactly one per commit | ✅ |
| schemas | `pnpm generate:schemas` produces no diff | ✅ |
| extension-api | if `extension-api.d.ts` is touched, the body must carry a backwards-compatibility and disposal section | ✅ |
| **API-surface grep** | every new or changed exported type is grepped in `extension-api.d.ts`; found means it is public API, not an internal utility | ✅ |
| slice standalone | the `pdkit slice verify` result from `slices.json` plus a digest comparison. A stale result is `fail`, not `pass`; a red run against a red baseline is `warn`, marked inconclusive | ✅ for slices with `base: main` |
| **merge order** | every merge order the body states — `#A → #B`, "depends on #A", "after #A merges" — between this issue's slices is a stack in the graph. An order between independent slices is a dependency nobody verified, and main is broken between those merges | ✅ |
| branch name | matches `DESKTOP-<n>/[<i>-]<slug>` | ✅ |
| **PR body from the template** | every section, fixed line and footer `templates/pr-body.md` declares is in the body. Eight checks read the body and each reads a part of it; this one asks whether it is the shape upstream's template wants at all | ✅ |
| **PR body size** | each section of the body against its budget in characters, and the total. `How to test this PR?` is bounded by its heading and not counted: it is the one section a reviewer executes rather than reads | ⚠️ never blocks |
| steps-to-check | ≥ 3 steps, each with an expected result. Applies on `quickfix` too | ✅ |
| e2e stability | a new `tests/playwright` test passed `validation.e2e_stability_runs` times in a row; the series is tied to a digest of the spec, and a stale one is `fail` | ✅ if e2e was added |
| e2e environment | a test needing an environment CI does not have requires a `Notes for reviewers` entry | ✅ |
| **validation evidence** | a validation step with no attached artefact is named in `Notes for reviewers`. Skipped on `quickfix` and when `validation.require_evidence: false` | ✅ |
| debug leftovers | `console.log`, `.only`, `.skip`, `@ts-ignore`, `any` in the diff | ⚠️ warn, listing them |
| maintainer rules | the greppable part of `knowledge/maintainer-rules.md` in the added lines, each pattern scoped to the files its rule covers: `vi.spyOn`, `Object.defineProperty(window)`, `clearAllMocks`, `afterEach` in unit specs; `as unknown as`, `eslint-disable`, `*Sync(`, `../` imports, built-ins without `node:`; `export function` in `packages/main`; `<style>` and `$:` in Svelte; a hardcoded "Podman Desktop", a hex colour in the colour registry; a copyright year other than this one | ⚠️ warn, with the rule's section |
| CI blind spots | the diff touches build, packaging, platform-specific behaviour or the **dependency graph** — CI will not check it; a `Notes for reviewers` entry is required, worded per the area that fired | ✅ |

Four results, and the difference between them matters: **pass** (the check ran
and was satisfied), **skip** (it did not run, and the summary says why), **warn**
(an advisory check found something), **fail** (blocking, unless the check is
advisory). A skip is never a pass. Whether a check is advisory is its own
`blocking` export — four are: `quickfix-size`, `pr-body-size`, `debug-leftovers`,
`maintainer-rules`.

**There is no R-ID coverage check any more.** `r-coverage` required every R-ID to
appear in the published body, and was removed: `requirementProblems()` in
`lib/slice.js` already refuses to store a graph in which a frozen requirement
reaches no slice, so the check added no guarantee — only a demand on the shape
of the body. See the `Removed` entry in `CHANGELOG.md`.

**API-surface grep** is a direct codification of the `RunOptions` trap: the type
lives in `packages/main/src/plugin/util/exec.ts` and looks like an internal
utility, but it is also declared in `extension-api.d.ts`, making it public API.
This is not a heuristic for an agent, it is a grep, and it belongs in preflight
rather than in a prompt.

**The dependency-graph area of `ci-blind-spots` is keyed on the lockfile, not on
`package.json`.** The difference is measurable: a manifest edited on its own — a
renamed script, a version field — installs exactly what was installed before, and
demanding a paragraph for it would price the gate where there is no risk. The
lockfile (plus `pnpm-workspace.yaml`, `.npmrc`, `patches/`) is a statement that
the resolved graph changed, and that is precisely what unit tests on one platform
do not exercise: the breakage arrives transitively, a level below the diff.

That check's requirement is worded **by the area that fired**. It used to ask
about the platform whatever the finding was, and a requirement naming the wrong
thing gets answered with the wrong thing — after which the check passes on a note
about nothing. The same defect was fixed in `steps-to-check` and in the config
arrays message: **a message wider than its measurement**.

**validation evidence** is what makes `unverified` different from silence. It
does not require validation to have passed; it requires the unverified to be
**named** to the reviewer. The form is taken from `ci-blind-spots` and the
argument is the same: in both cases something exists that the gate did not check,
and silence about it reads as checked.

Both of those read the PR body, and both must be listed in `BODY_DEPENDENT` —
all eight: `extension-api`, `merge-order`, `pr-body-template`, `pr-body-size`,
`steps-to-check`, `ci-blind-spots`, `e2e-environment`, `validation-evidence`. A
check that depends on the body without declaring it stays forever at its
first-pass result, `skip` — the worst possible outcome, because it looks like a
check that ran. Not every one of the eight needs the body on every diff, so the
note after pass one counts only those that actually skipped for lack of it, and
names them.

Pass two reads the body from `--body <file>`, or, for a pull request that is
already open, from `--body-from-pr <k>` — after a rebase or a review round, where
the body that matters is the one upstream has.

**working tree** was not added out of tidiness. The checks in this table read two
different states: file checks (`spdx`, `api-surface`, `debug-leftovers`) look at
the committed diff `base...ref`, while command checks (`tests`, `lint`,
`typecheck`) run whatever is on disk. On a clean tree those are one thing. On a
dirty one the report mixes two and can go green on a diff that will not be
pushed. Not hypothetical: the first full run on the fork produced a red
`test:renderer`, caused by uncommitted work in `packages/preload` that the
renderer tests pick up — while the file checks were reading a commit without it.

**The base is a ref, not a branch name.** `repo.base_branch` names a branch, and
on a fork the local branch of that name is a copy of the base as fresh as the
last pull. First live run: a local `main` 491 commits behind turned a two-file
diff into an 805-file one, and preflight reported four blocking failures about
other people's work — a licence header on a file we never touched, 87 commits
with the wrong sign-off, eight public API symbols. Nothing looked wrong. The base
now resolves to `<upstream_remote>/<base_branch>` when that ref exists, and **the
report prints which ref it read, at what sha and from what date**: a
remote-tracking ref goes stale too, and a measurement has to say what it saw.

**And the ref comes from there too.** Taking the base from the graph was half the
rule: the ref stayed `HEAD`, so the report was about the slice exactly when
preflight was run from the slice's own worktree. From anywhere else every file
check read an unrelated change without a sign, because `HEAD` always resolves. So
the ref is now the slice's branch; if the branch does not exist yet the run
**refuses**, because the flow materialises before preflight and answering about
`HEAD` would answer a question nobody asked. An empty diff under a slice is also
refused: every check passes on nothing, and a green report would open the gate on
a branch with nothing on it.

**The base comes from the graph, not from the config.** Every file check reads
`base...ref`, and for a stacked slice the base is the predecessor's branch. From
`main` the stack's diff contains the previous slice's changes, and `spdx`,
`api-surface`, `debug-leftovers` and `conventional-commits` start reporting on
somebody else's work — confidently, with no sign they are reading the wrong
thing.

**A run `slice verify` has just made is not made again.** `tests`, `lint` and
`typecheck` reuse the slice verification's run when its receipt validates,
exited 0, names this exact commit, covers every script the check would run, and
the tree has no tracked change. The commit says what was verified while the
scripts run the working tree, which is why a tracked change disqualifies it.
Verify and preflight back to back had outlived a 600-second timeout, running the
same scripts on the same commit twice.

**The environment is not the code.** A script that could not start — exit 127,
or 9009 on Windows, `pnpm` not on `PATH` — is reported as `could not run: … —
the environment, not the code`, not as failing tests with a remedy for broken
tests. It still blocks: nothing was measured.

**Script names are not hard-coded.** The "How" column above shows a shape, not a
constant: preflight resolves the name from the repository's own `package.json`,
walking a candidate chain and taking the first that exists. The package for
`<project>` / `<package>` comes from `package-map.json`. The reason is direct:
podman-desktop has no `pnpm lint`, and its `pnpm test` drags in the e2e suite, and
upstream renames scripts without notice. A hard-coded name, after a rename,
becomes a check that silently does not run — the worst possible outcome for a
gate. If no candidate is found the check returns **`skip` with an explanation,
not `pass`**. The override is the `preflight:` block in the config, empty by
default: the config is the emergency exit, not the first source.

**conventional commits** is calibrated against the real repository.
podman-desktop's `commitlint.config.cjs` is a bare `config-conventional`, and its
`CONTRIBUTING.md` writes the format as `<type>[optional scope]`; commits without
a scope reach `main` regularly. Requiring a scope as blocking would reject valid
pull requests. We still write scopes — they tell a reviewer which area they are
being asked about — but that is our discipline, not upstream's rule, and it is
never raised in a review of somebody else's PR.

---

**In brief** — [`architecture/`](../architecture/README.md): [4 · The slicer](../architecture/04-slicer.md)

**In practice** — [`workflows/`](../workflows/README.md):

- [What preflight actually runs](../workflows/reference/preflight.md)

← [6 · Hooks](06-hooks.md) · [Contents](README.md) · [8 · MCP servers](08-mcp-servers.md) →
