<!-- This template is for pull requests against podman-desktop-kit itself.

     It is NOT templates/pr-body.md — that one is the body this plugin renders
     for pull requests it opens against podman-desktop, and it follows upstream's
     four headings rather than these. The two are separate on purpose; editing
     one does not change the other. -->

## What this changes

<!-- Say why, not what: the diff already says what. -->

## Which half of the plugin

<!-- Delete the ones that do not apply. The distinction decides where a rule can
     be trusted: anything in lib/ or lib/hooks/ is testable and therefore
     enforceable, anything in skills/ or agents/ holds most of the time. -->

- [ ] `lib/` — deterministic, and covered by a test
- [ ] `lib/hooks/` — a rule the plugin enforces rather than requests
- [ ] `skills/` or `agents/` — judgement
- [ ] `templates/`, `knowledge/`, `defaults/` — artefact shape, constitution, defaults
- [ ] documentation only

## What you ran

```
npm test
```

<!-- Required if anything under lib/hooks/, hooks/hooks.json or bin/pdkit
     changed. Every unit test stays green while a plugin whose manifest did not
     load gates nothing at all, so the suite cannot answer this: -->

```
pdkit doctor --gate-selftest --repo <a real podman-desktop fork>
```

## Notes for the reviewer

<!-- What you could not verify, and anything the tests do not cover. Every
     interesting defect this repository has found came from running it against
     live upstream rather than from the suite, so "I could not exercise this
     end to end" is a useful thing to say, not an admission. -->

---

- [ ] Commits are conventional and each carries exactly one `Signed-off-by`
- [ ] New `.js` and YAML files carry the licence header in full
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]`, if a user would notice
