# DEFERRAL {{id}}: DESKTOP-{{issue}} — bug

- What: {{what}}
- Raised by: {{raisedBy}}
- Where: {{where}}
- Recorded: {{recordedAt}}
  <!-- There is deliberately no Status field. What became of this is derived from
       the journal — `pdkit defer list --issue {{issue}}` — so this file cannot
       disagree with it.

       Everything below the rule is the DRAFT of the follow-up issue, laid out in
       the fields of podman-desktop's own `Bug 🐞` form. Open the issue through
       the template in the GitHub UI and copy field by field: the headings below
       are the labels the form uses, so the posted issue reads exactly like every
       other bug report in the repository.

       Opening it is a human action. `gh issue create` is denied at the hook from
       every state, and no state in section 1 authorises writing to a tracker
       that is not ours. -->

---

### Title

<!-- The title field at the top of the issue form, not part of the body.

     House style upstream is a plain sentence describing the wrong behaviour, in
     sentence case, with no prefix and no ticket id — "Kubernetes Pods view
     appears empty without a loading indicator while refreshing context",
     "initial setup - 'click next' but the button is off the screen". Titles run
     long there and that is fine; a title that says what is wrong beats a short
     one that does not.

     Derived from --what unless --title was given. Rewrite it if the derivation
     reads like a note to yourself rather than a report to somebody else. -->
{{title}}

### Bug description

<!-- What happens, and what was expected instead. The reviewer's words are worth
     quoting rather than paraphrasing: a paraphrase of a question is an answer to
     a slightly different question, and whoever picks this up did not read the
     thread. -->
{{description}}

Raised in review on {{where}}:

> {{quote}}

{{url}}

### Operating system

<!-- Auto-filled from the machine this was recorded on. Correct it if the report
     is about a platform you did not check. -->
{{os}}

### Installation Method

<!-- One of: Installer from website/GitHub releases · Brew (macOS) ·
     Chocolatey (Windows) · Flathub (Linux) · Scoop (Windows) · Winget (Windows) ·
     Other. A locally built tree is "Other". -->
{{installMethod}}

### Version

<!-- The form's dropdown. A build from source is "next (development version)". -->
{{version}}

### Steps to reproduce

<!-- Numbered, and each step an action with an expected result. Whoever fixes
     this needs to get the same screen you did, and "use a long command" is not
     enough — say how long, and whether it contains spaces. -->
{{steps}}

### Relevant log output

```shell
{{logs}}
```

### Additional context

<!-- Screenshots go here. Each placeholder below is deliberately VISIBLE text
     rather than an HTML comment: a comment renders as nothing, so a forgotten
     one reaches the issue invisibly, which is the failure this repository has
     fixed twice elsewhere. If you post one of these lines unreplaced, it is
     obvious to you and to the reader.

     To replace: drag the file into the GitHub comment box. It becomes a
     `![name](https://github.com/user-attachments/...)` line of its own. -->
{{screenshots}}

{{additionalContext}}
