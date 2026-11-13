# Pitfalls

Traps that cost time once and should not cost it twice. Each entry says what it
looks like, why it is a trap, and how it is now caught.

> Thirteen entries so far, and it grows one issue at a time: `/pd:close` proposes
> additions from what a finished issue actually cost. Short is the intended
> state, not an unfinished one — see "What to add here".

## RunOptions: internal-looking type that is public API

**Looks like:** `RunOptions` sits in `packages/main/src/plugin/util/exec.ts`, in a
`util` directory, in the main process. Everything about its location says
internal helper.

**Actually:** it is also declared in `extension-api.d.ts`, which makes it public
API with every compatibility obligation that carries.

**Why it matters:** changing an internal helper is routine. Changing public API
without saying so is how a PR gets rejected after review has already started.

**Caught by:** the `api-surface` preflight check greps every new or changed
exported symbol against `extension-api.d.ts`. This is deliberately a grep rather
than a judgment call — an agent asked to notice this will sometimes not.

## e2e flakes

**Looks like:** a new Playwright test that passes locally.

**Actually:** podman-desktop e2e tests are timing-sensitive, and a test that
passes once may fail one run in five.

**Why it matters:** a flake you introduce into someone else's repository is the
worst thing you can bring. It costs every future contributor time, and the blame
lands on the PR that added it.

**Caught by:** `pdkit preflight --e2e-stability` requires three consecutive local
passes. On the quickfix route, e2e is not added at all.

## Multi-platform CI

**Looks like:** CI is red, everything is green locally.

**Actually:** podman-desktop runs CI across platforms, and a Windows-only or
macOS-only failure is normal rather than exceptional.

**Why it matters:** the reflex is to re-run the job. If the failure is real, the
re-run wastes twenty minutes; if it is a known flake, re-running hides it.

**Caught by:** `/pd:pr-status` classifies a red job as platform difference,
flake, or real regression before proposing anything. A flake gets a link to the
existing issue, not a re-run.

## A window that ends inside a block

**Looks like:** `grep -n "export namespace <name>" -A40 extension-api.d.ts`, or
`sed -n 300,340p <file>.ts`, prints a namespace or an object literal that looks
complete: members, then nothing more.

**Actually:** the window stopped before the block did, and nothing in the
output says so. `grep -A`, `sed -n a,bp`, `head` and `tail` cut silently. New
members are appended at the end of a namespace or an object, so the members a
window from the top loses are the newest ones, which are exactly the ones a
question like "does the API already have X?" is about. A filter piped after the
window (`| grep export`) also removes the closing brace whose absence would
have given the cut away.

**Why it matters:** an unread member becomes "absent", and "absent" becomes a
proposal to add something that already exists, in a document a maintainer then
has to correct.

**The rule:** a block you draw a conclusion from is read to its closing brace.
Use Read on the file from the block's first line, or widen the window until the
closing brace is in the output, or search the whole file with no window. A
claim that something does not exist, is not supported or is not handled is
never made from windowed output.

**Caught by:** the `post-bash` and `post-read` hooks. After a Bash command
with a windowing operator, a `Read` that returned part of a file, or a `Grep`
with context lines or a cap, whose output ends with more `{` opened than
closed, they put this rule next to the output. It runs in every session, including work done outside the
`/pd:*` skills. It misses a cut when several reads in one command balance each
other's braces, so the rule holds without it.

## A name from another project

**Looks like:** a reference project exposes `env.someName`, a search for
`someName` here comes back empty, and the design says the field should be
added.

**Actually:** nothing here had a reason to use that project's name, so the
zero says nothing about the concept. The same thing is often present under the
local name, and the reference project usually shows the way to it: what its
API member is built from (a product setting, a config key) tends to be named
the same in both projects, while the API member on top of it is not. A search
can also hide its own zero: a name searched as one alternative among several
(`grep "a\|b\|someName"`) prints the others' matches, and nothing in the
output says one alternative matched nothing.

**Why it matters:** the claim lands in a design as a proposal to add what
already exists. A reviewer who trusts the question may even agree with it, and
the codebase then gets a second field with the same meaning.

**The rule:** translate a name before searching for it. In the reference
project, find what the member is built from, and search for that name here.
Search the API declarations for the concept as well, case-insensitive, with no
window and not as one alternative among others. A claim that something is
missing, or a proposal to add a member to an existing API, is written only when
both searches come back empty, and the document says what was searched.

**Caught by:** the `post-claim` hook. After a markdown write that says a
backticked name is missing, or proposes adding a member to something that
exists (`env.someName`), it searches podman-desktop for the name outside the
document and, when there is no match, puts this rule next to the write. It
cannot tell a borrowed name from a genuinely new one, and it does not see
claims about bare names phrased only as a proposal, so the rule holds without
it.

## Not found, written down as not there

**Looks like:** a search came back empty, or a read did not show the thing,
and the analysis moves on as if the codebase lacks it. Later the absence turns
up as a premise: "should we add X?", "X will need to be introduced".

**Actually:** "I did not see it" and "it is not there" are different findings,
and only a search can turn the first into the second. A cut window, a
borrowed name or a search in the wrong file all produce the first. The usual
verification convention makes it worse: a claim is checked by its `file:line`,
an absence has no line to cite, so it is either left unmarked or not written
down at all and goes straight into a question. A comparison table that lists
what was matched has no row for what was concluded missing.

**Why it matters:** an absence nobody wrote down cannot be checked by anybody,
including the author a minute later, and a premise inside a question is the
hardest claim for a reviewer to see.

**The rule:** an absence is written down as a claim of its own, with the search
it rests on: `searched: <query> in <where> -> 0`, case-insensitive, with no
window, for the concept and not only for one name. An absence scoped to a
place cites that place's `file:line` range instead. A comparison with another
project has a row for every element it touches, including those it concludes
are missing here.

**Caught by:** `pdkit plan check` refuses a `Context` line that says something
is absent and cites neither a location nor a search. The `post-claim` hook
asks for the search when a markdown write states an absence. Neither sees an
absence that was never written down, so the rule holds without them.

## A question for reviewers that carries an unchecked fact

**Looks like:** an open question in a design: "should `ns.member` be added
for callers that need it?", "is a new setting worth it?", "do we need
`ns.member`?".

**Actually:** a question about adding something rests on the fact that it is
not there, and a question is the one form nobody marks as checked. Put to
reviewers, it hands them a decision and quietly hands them the fact as well.
They answer the decision and take the fact as given, so a reviewer can agree
to add what already exists. The same happens when one list holds both "not
verified" and "open questions": a gap in the facts, phrased as "is X
needed?", turns from the author's work into the reviewers' decision. A public
document that carries no verification marks loses whatever provenance the
working notes had.

**Why it matters:** the premise reaches the people least placed to check it,
in the form least likely to be questioned, and their agreement then reads as
confirmation.

**The rule:** before a question goes to a reviewer, pull its premise out and
check it. Write the premise as a claim with its source, then ask: "`ns.other`
already holds this (`api.d.ts:120`); is it enough?" or "`ns.member` is not in
the API (searched: `git grep -i <concept> -- <api>` -> 0); should it be
added?". Questions for reviewers are decisions only. Keep "not verified" and
"open questions" in separate lists: the first is the author's work, the
second is someone else's.

**Caught by:** the `post-claim` hook reads a question about whether something
is needed or should be added as a claim that it is absent, and checks the name
against podman-desktop. It does not see a premise that names nothing in
backticks, or one asked in another language, so the rule holds without it.

## A file under the e2e tree that eslint cannot parse

**Looks like:** a fixture for an e2e test, such as a small CommonJS extension,
goes beside the other test resources under `tests/playwright/`, and its `Done
when` runs `npx eslint` on it.

**Actually:** eslint lints every file with type information (`projectService`
in `eslint.config.mjs`, with `allowDefaultProject` covering only
`types/*.d.ts`), and `tests/playwright/tsconfig.json` includes only `src/**/*.ts`
and the scripts. Any other `.js` or `.ts` file under `tests/playwright/` that
eslint does not ignore fails with "was not found by the project service",
whatever it contains.
`pnpm lint:check` lints the whole tree and lint-staged lints every staged
`.js` and `.ts`, so CI and the commit hook fail the same way. A path inside a
directory named `test-resources` matches the global `ignores` entry
`**/test-resources`: eslint reports it as ignored and exits 0.

**Why it matters:** no edit to the file makes it pass, and the ways around it
are a disable comment the maintainer's rules forbid (section 4 of
`maintainer-rules.md`) or a change to a shared config.

**Caught by:** nothing mechanical. `/pd:plan` gives this file to its scouts,
and `pd-plan-critic` reads it.

## An extension manifest the loader drops

**Looks like:** a test extension whose `package.json` has what running it
needs (`name`, `publisher`, `version`, `main`, `engines`), with a `Done when`
that checks the manifest parses.

**Actually:** `analyzeExtension` in
`packages/main/src/plugin/extension/extension-analyzer.ts` marks a manifest
missing any of `name`, `displayName`, `version`, `publisher` or `description`
as an error; the schema in
`packages/main/src/plugin/extension/extension-manifest-schema.ts` requires the
same five. A development folder the application finds in its configuration at
startup is then left out (`loadDevelopmentFolderExtensions` in
`packages/main/src/plugin/extension/extension-loader.ts`), with one
`console.error` in the main process log. Adding the folder through the UI
throws the same message instead.

**Why it matters:** the e2e test fails later and somewhere else, because the
extension is simply not there, and nothing in the UI says why.

**The rule:** a check on a manifest that a loader reads asserts the fields the
loader requires, not only that the file parses.

**Caught by:** nothing mechanical. `pd-plan-critic` reads the loader's
contract for every artifact a task creates; this entry names the fields.

## Two e2e runners

**Looks like:** an e2e spec that reaches into the main process through
`runner.getElectronApp()`, or launches the application with an extra argument.

**Actually:** `tests/playwright/src/runner/runner-factory.ts` picks one of two
runners. With `PODMAN_DESKTOP_BINARY` and `DEBUGGING_PORT` both set, it is
`ChromeDevToolsProtocolRunner`, which spawns the binary with
`--remote-debugging-port` as its only argument and connects over CDP;
otherwise it is `ElectronRunner`. Only `ElectronRunner` has `getElectronApp()`,
and the `runner` fixture is typed as the base `Runner`, which does not. Specs
that evaluate in the main process skip under CDP, either for the whole file on
the two variables
(`tests/playwright/src/specs/navigation-context-menu.spec.ts`) or in the test
with `test.skip(!(runner instanceof ElectronRunner))`
(`tests/playwright/src/specs/help-menu-smoke.spec.ts`).

**Why it matters:** a spec written for one runner fails, or does not
type-check, in the other mode, and an argument meant for the launch never
reaches the application under CDP.

**Caught by:** nothing mechanical. `pd-plan-critic` lists the modes of the
component a task touches; this entry says which two the e2e suite has.

## The e2e inventory changes with the spec

**Looks like:** a new spec under `tests/playwright/src/specs/`, or a changed
skip condition or runner option, planned as a change to the spec file alone.

**Actually:** `tests/playwright/AGENTS.md` requires
`tests/playwright/TESTS_SPECIFICATION.md` to be updated in the same change
when a spec is added, renamed, moved or removed; when its coverage, tags,
platforms, skip conditions, environment variables or runner settings change;
and when shared fixtures, helpers or runner configuration change in a way that
affects documented suites.

**Why it matters:** the obligation is the directory's own and nothing in the
plan points at it, so a task that owns only the spec cannot meet it.

**Caught by:** nothing mechanical. `pd-plan-critic` reads the `AGENTS.md` of
every directory a task owns.

## One e2e runner, whatever the options

**Looks like:** two `test.use({ runnerOptions })` in one spec file, one per
`describe`, to start the application two ways.

**Actually:** `RunnerFactory.getInstance` in
`tests/playwright/src/runner/runner-factory.ts` keeps one runner in a static
field and returns it whatever options it is called with; only closing the
runner clears it. The e2e suite runs with one worker (`playwright.config.ts`),
so options take effect only when no runner is open. Every spec that sets
runner options does it with a single `test.use` for the whole file.

**Why it matters:** unless the first runner was closed in between, the second
set of options is ignored without a word, and the tests under it run against
an application started the first way.

**Caught by:** nothing mechanical.

## A format gate that checks files git ignores

**Looks like:** `pnpm format:check`, or `biome format` with no paths, as the
gate in a `Done when`. It is green on CI, so it should be green here.

**Actually:** `biome.jsonc` has no `vcs` section, so Biome reads no ignore
file, neither `.gitignore` nor git's global excludes, and only
`files.includes` decides what it checks. On the whole tree it checks every
local or generated file git ignores: a local settings file an editor or an
agent keeps under `.claude/`, JSON generated under `website/static/`. A clean
CI checkout has none of them; a working machine usually has some.

**Why it matters:** the gate fails on files the change never touched and
`git status` does not show, on one machine and not on another.

**The rule:** a format gate names its files: `biome format <files>`, for the
files the task owns.

**Caught by:** `pdkit plan probe`, on a machine that has such a file: the
gate is red on the base, with the ignored file's name in its output.

## What to add here

A trap, not a mistake. The distinction: a trap is something the codebase makes
easy to get wrong.
