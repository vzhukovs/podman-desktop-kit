# VALIDATION: DESKTOP-{{issue}}

- Outcome: {{outcome}}
- Steps: {{stepCount}} ({{withEvidence}} with an artefact)
- e2e: {{e2e}}
- Validated: {{validatedAt}}
  <!-- Rendered from validation.json. The Evidence column is written by
       `pdkit validate attach` and `pdkit validate run` from what was actually
       captured; there is no parameter that sets a step to PASS. What the
       outcome promises is an attached artefact, not that what appeared on
       screen was correct — that judgement stays with a human. -->

## Steps

| # | R-ID | What was checked | Expected | Observed | Evidence | Status |
|---|------|------------------|----------|----------|----------|--------|
{{steps}}

## Not verified
<!-- Every step above without an artefact, and why. This section is not
     paperwork: `validation-evidence` in preflight refuses a PR whose body does
     not carry these lines into `Notes for reviewers`. Silence about what was
     not checked reads exactly like a check that passed. -->
{{gaps}}

## e2e candidate
<!-- The test the manual scenario was codified into, and the consecutive runs
     it survived. A checklist is verified once, by one person, today; a test is
     verified by CI on every pull request that follows. -->
{{e2eDetail}}
