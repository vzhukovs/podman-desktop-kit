# DEFERRAL {{id}}: DESKTOP-{{issue}} — task

- What: {{what}}
- Raised by: {{raisedBy}}
- Where: {{where}}
- Recorded: {{recordedAt}}
  <!-- Status is derived from the journal, not stored here —
       `pdkit defer list --issue {{issue}}`.

       Below the rule is the DRAFT of the follow-up issue, in the field of
       podman-desktop's own `Task` form. That form has exactly one field, and its
       own note says tasks are normally created by the development team to plan
       work unrelated to features or bugs — so if this is really a defect or a
       request, the bug or feature kind is the honest one:
       `pdkit defer new --kind bug|feature`.

       Opening it is a human action: `gh issue create` is denied at the hook. -->

---

### Task content

<!-- One clear description. The form has no other fields, so everything a reader
     needs — where it came from, why it is separate, what done looks like — has
     to be in this one block. -->
{{content}}

Raised in review on {{where}}:

> {{quote}}

{{url}}

{{screenshots}}
