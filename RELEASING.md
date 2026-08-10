# Releasing

How a version is decided, what a release run consists of, and what a colleague
has to do to receive it.

## Versioning

Semantic versioning, and pre-1.0 the slots mean:

| Bump | For |
|---|---|
| **MINOR** (`0.1.0` → `0.2.0`) | anything a user would have to change: a renamed command or flag, a new required state transition, a config key that stops being read, a preflight check that starts blocking |
| **PATCH** (`0.1.0` → `0.1.1`) | fixes and additions that break nothing |

`1.0.0` means the state machine, the `pdkit` command surface and the artefact
formats are stable enough that changing them would be a breaking change worth
announcing. Nothing about the current status justifies claiming that yet — see
section 13 of [`docs/specification.md`](docs/specification.md).

### The version lives in one place, and it decides everything

Claude Code resolves an installed plugin's version from
`.claude-plugin/plugin.json`, and **skips the update when it matches what is
already installed**. So:

> **A release shipped without bumping `plugin.json` reaches nobody.**
> `/plugin update` reports "already at the latest version", every colleague stays
> on the old copy, and nothing anywhere reports a problem.

`package.json` carries the same number because `pdkit version` reads it, and
`CHANGELOG.md`'s newest heading carries it because that is what a person checks.
All three are asserted equal by `test/release.test.js` — a forgotten bump is a red
test rather than a silent no-op.

The marketplace entry deliberately carries **no** version. When both are set
`plugin.json` wins, so a second field is a value that does nothing until the day
the two disagree.

## First publication

The repository has not been pushed anywhere yet. Once:

```bash
gh repo create vzhukovs/podman-desktop-kit --public --source . --remote origin
git push -u origin main

git tag -a v0.1.0 -m "podman-desktop-kit 0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "0.1.0" \
  --notes-file <(sed -n '/^## \[0\.1\.0\]/,/^## \[/p' CHANGELOG.md | sed '$d')
```

Then tell colleagues the two lines from the README:

```
/plugin marketplace add vzhukovs/podman-desktop-kit
/plugin install pd@podman-desktop-kit
```

## Every release after that

Run in this order. Each step has caught something at least once.

```bash
# 1. The tree is clean and main is current.
git status --porcelain          # must be empty
git pull --ff-only

# 2. Bump the version in BOTH manifests.
#    .claude-plugin/plugin.json  ->  "version": "0.2.0"
#    package.json                ->  "version": "0.2.0"

# 3. Move [Unreleased] into a dated release heading, and add the link
#    definition at the bottom of CHANGELOG.md.
#    ## [0.2.0] - YYYY-MM-DD

# 4. The suite, including the version-sync guard.
npm test

# 5. The manifest, before anybody installs it.
claude plugin validate . --strict

# 6. The gate, against a real podman-desktop fork. This is the only check that
#    answers "is the gate actually on"; the suite stays green without it.
pdkit doctor --gate-selftest --repo /path/to/podman-desktop

# 7. Load the release as a plugin and invoke one skill, because steps 4-6 all
#    run pdkit directly and none of them prove the plugin loads.
claude --plugin-dir . -p "/pd:doctor"

# 8. Commit, tag, push, release.
git commit -am "chore(release): 0.2.0"
git tag -a v0.2.0 -m "podman-desktop-kit 0.2.0"
git push && git push origin v0.2.0
gh release create v0.2.0 --title "0.2.0" \
  --notes-file <(sed -n '/^## \[0\.2\.0\]/,/^## \[/p' CHANGELOG.md | sed '$d')
```

Step 7 is not ceremony. Of the twenty-one skills this plugin ships, twenty have
never been invoked through a Claude Code session, and every check above passes
whether or not the manifest loads.

## How a colleague receives an update

Third-party marketplaces have **auto-update off by default**, so an update is not
automatic unless they turn it on.

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

To turn auto-update on: `/plugin` → **Marketplaces** → select
`podman-desktop-kit` → **Enable auto-update**. Claude Code then refreshes in the
background shortly after a session starts, and prompts for `/reload-plugins` if
anything changed.

**After any upgrade, they should run one command:**

```bash
pdkit doctor --gate-selftest
```

The gate is registered by the manifest and executed by the host. An upgrade that
broke the wiring leaves every unit test green and the plugin gating nothing, and
this is the only check that can tell.

`pdkit version` prints the version and the commit it was built from, with
`, modified` if the checkout is dirty — worth asking for in any bug report,
alongside `pdkit doctor`.

## What a release must not do

- **Ship without a bump.** See above; it is silent.
- **Change `$PDKIT_HOME`'s layout without a migration.** State lives outside the
  repository precisely so it survives plugin updates. A release that renames a
  file under `issues/<n>/` orphans every issue in flight; if one has to, it needs
  a `pdkit` command that performs the move and a MINOR bump.
- **Widen what the gate allows without saying so in the changelog.** That is the
  one behaviour whose failure mode is public and irreversible.
