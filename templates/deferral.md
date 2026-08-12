# DEFERRAL {{id}}: DESKTOP-{{issue}}

- What: {{what}}
- Raised by: {{raisedBy}}
- Where: {{where}}
- Recorded: {{recordedAt}}
  <!-- There is deliberately no Status field here. What became of this is
       derived from the journal — `pdkit defer list --issue {{issue}}` — so this
       file cannot disagree with it. An amendment carries its status because it
       is the record of a decision; this is a draft that gets used up the moment
       the follow-up issue exists.

       Everything below the rule is a DRAFT of that issue. Opening it is a human
       action: `gh issue create` is denied at the hook from every state, and no
       state authorises writing to somebody else's tracker. -->

---

## What was asked

<!-- The reviewer's words, quoted rather than paraphrased. A paraphrase of a
     question is an answer to a slightly different question, and the person who
     opens the follow-up is usually not the person who read the thread. -->
{{quote}}

{{url}}

## Why it is not part of {{issue}}

<!-- The argument that made this a separate issue rather than a bigger diff, and
     it has to survive being read by the reviewer who raised it. "Out of scope"
     is not the argument; the layer is. A fix in the logic and a fix in the
     renderer are reviewed by different domain owners, and putting both in one
     pull request asks the wrong people to approve half of it. -->
{{whySeparate}}

## Which layer this belongs to

<!-- The package, from `pdkit packages --of <path>`. This is what decides who
     reviews the follow-up, and getting it wrong here sends the new issue to the
     same wrong place the argument above was about. -->
{{layer}}

## What would have to be true to call it done

<!-- Concrete enough to become a requirement on triage: what a person should see,
     not what the code should contain. Vague here means a plan that cannot state
     an executable `Done when` later. -->
{{doneWhen}}
