# Pitfalls

Traps that cost time once and should not cost it twice. Each entry says what it
looks like, why it is a trap, and how it is now caught.

> Five entries so far, and it grows one issue at a time: `/pd:close` proposes
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

**Caught by:** the `post-bash` hook. After any Bash command with a windowing
operator whose output ends with more `{` opened than closed, it puts this rule
next to the output. It runs in every session, including work done outside the
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

## What to add here

A trap, not a mistake. The distinction: a trap is something the codebase makes
easy to get wrong.
