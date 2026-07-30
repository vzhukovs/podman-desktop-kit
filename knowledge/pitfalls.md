# Pitfalls

Traps that cost time once and should not cost it twice. Each entry says what it
looks like, why it is a trap, and how it is now caught.

> Stub. Entries are harvested by `/pd:close` as issues finish.

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
than a judgement call — an agent asked to notice this will sometimes not.

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

## What to add here

A trap, not a mistake. The distinction: a trap is something the codebase makes
easy to get wrong.
