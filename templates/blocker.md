# BLOCKER DRAFT: DESKTOP-{{issue}} waits on this — {{slug}}

- What: {{what}}
- Raised by: {{raisedBy}}
- Where: {{where}}
- Prior work: {{prior}}
- Drafted: {{recordedAt}}
  <!-- Below the rule is the DRAFT of an upstream issue for work that must merge
       BEFORE DESKTOP-{{issue}}'s pull request. It is not a deferral: a deferral
       is set aside for after this merges, and this is what this waits for.

       Opening it is a human action: `gh issue create` is denied at the hook.
       Copy the fields into whichever upstream form fits (bug, feature or task).
       Then, with the number GitHub gave it:

         pdkit issue block {{issue}} --by <new issue> --reason "{{what}}"

       and start it in a NEW session: /pd:triage <new issue>, with the prior
       work named on the lines after the number so the plan can reuse it. -->

---

### Title

<!-- A verb first, naming what should exist. Derived from --what unless
     --title was given. -->
{{title}}

### Description

<!-- What the change is and why it has to land on its own. The reviewer asked
     for it as a separate pull request, so say what they asked, in their words. -->
{{what}}

Requested in review on {{where}}:

> {{quote}}

{{url}}

### Additional context

<!-- The dependency, stated where upstream will read it. -->
{{where}} depends on this and will be rebased once it merges.

{{additionalContext}}
