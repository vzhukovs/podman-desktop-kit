# ARCHAEOLOGY: {{issue}} — {{title}}

- Attempt: {{attempt}}
- Reverted by: {{revert}}
- Lived in the base branch: {{livedDays}} day(s)
- Facts: `archaeology.json`, collected {{at}}
  <!-- The facts half is machine-collected by `pdkit issue history`. What is
       written below it is the reading, and the reading is why this file
       exists — the numbers are already in the JSON. -->

## Why it was reverted

<!-- In the reverter's words and the reviewers', not paraphrased into agreement.
     If the revert body only says "reverting as per discussion", say that: an
     unstated reason is a finding, not a blank to fill. -->
{{whyReverted}}

## What the reviewers objected to

<!-- Objections to the approach, separated from objections to the details. The
     first kind decides whether the redo is a rewrite; the second is a list of
     things not to repeat. -->
{{objections}}

## Does the objection still apply

<!-- The one question a redo exists to answer. Upstream may have moved: the
     API the approach needed may exist now, the reviewer who blocked it may
     have stated conditions, the code may have been restructured. -->
{{stillApplies}}

## What has happened in those files since

{{sinceRevert}}

## What this redo must do differently

<!-- Concrete, and traceable to something above. "Be more careful" is not an
     entry; "use tailwind classes rather than a <style> block, because that is
     what two reviewers asked for and one blocked on" is. -->
{{differently}}

## What could not be established

<!-- Copied from the `gaps` of the facts file, plus anything the discussion
     left open. A redo that starts by pretending it knows why the last one
     failed is the expensive path this route exists to close. -->
{{gaps}}
