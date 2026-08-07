# FINDINGS: DESKTOP-{{issue}}

- Answer: {{answer}}
- Captured: {{captureCount}} step(s) with an attached run
- Written: {{writtenAt}}
  <!-- The artefact for an issue whose deliverable is an answer rather than a
       diff (section 1, the `answered` state). Everything below the first
       heading is a DRAFT of the comment for the upstream tracker: publishing it
       is a human action, `gh issue comment` is denied at the hook, and no state
       in section 1 authorises writing there.

       The rule that decides everything else here decides this too: a step
       nobody ran is a suggestion. A suggestion posted in the voice of a finding
       is worse than silence, because the reporter spends their evening on it. -->

---

## What was reproduced

<!-- The environment in enough detail that someone else can stand in it: the
     versions on both sides of anything that talks to anything, the platform,
     and the exact command output. Paste captures, do not summarise them. -->
{{reproduction}}

## What the cause turned out to be

<!-- One paragraph. If the cause is outside this repository, name the component
     and the versions on either side of the boundary. -->
{{cause}}

## How to tell whether you have this

<!-- A command whose output separates this problem from the ones it looks like.
     Without it every reader with a similar symptom follows the workaround
     below, and half of them are fixing something else. -->
{{detector}}

## Workaround

<!-- Steps that were RUN, in order, with what they cost — data loss especially.
     A step here that was reasoned about rather than executed does not belong
     in this section; put it under "What I could not verify". -->
{{workaround}}

## What I could not verify

<!-- The boundary of the answer, stated by whoever found it: platforms not
     tried, versions not tested, the parts inferred rather than observed. Same
     discipline as the review report — an answer that hides its edges is read as
     having none. -->
{{unverified}}

## What would have kept this from reaching a user

<!-- The product question the workaround leaves behind, and the reason this
     section is not optional: an environmental cause is a reason not to change
     this repository, not a reason for the repository to stay silent. If the
     answer is a separate issue, name it here. If there is genuinely nothing,
     say that — it is a finding too. -->
{{prevention}}
