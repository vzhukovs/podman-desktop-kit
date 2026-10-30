/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

// The issue state machine (spec section 1), as data: the states, the edges
// between them, who may act from where, and what runs next. Nothing here
// reads or writes a file; the record on disk, and every write to it, stay in
// lib/state.js (invariant 1), which re-exports this file under the names
// callers know.

/** @typedef {'new'|'triaged'|'quickfix'|'planned'|'plan-approved'|'implemented'|'validated'|'audited'|'sliced'|'slices-approved'|'preflight-green'|'pr-open'|'review-in-progress'|'answered'|'merged'|'resolved'|'abandoned'} State */

/**
 * Allowed transitions. A transition absent from this table is not "unusual",
 * it is rejected — including transitions an agent is convinced are correct.
 *
 * @type {Record<State, State[]>}
 */
export const TRANSITIONS = {
  'new': ['triaged'],
  // `answered` from both of the states where the finding actually arrives.
  // Sometimes the cause is outside our tree and the triage sees it; more often
  // the investigation is the work, and by then the issue is `planned`. Measured
  // on #18284, where the report is a real, reproducible bug in podman-desktop
  // and the cause is a version skew between the podman client and the machine
  // it drives — nothing in this repository to change, and a reproduction, a
  // detector command and a workaround to publish.
  'triaged': ['quickfix', 'planned', 'answered', 'abandoned'],
  'quickfix': ['preflight-green', 'triaged'],
  'planned': ['plan-approved', 'triaged', 'answered'],
  'plan-approved': ['implemented'],
  'implemented': ['validated'],
  'validated': ['audited'],
  'audited': ['sliced'],
  'sliced': ['slices-approved'],
  // Back to sliced from everywhere a graph can still be wrong after approval,
  // and that is everywhere up to and including an open pull request. On
  // DESKTOP-19818 review asked for three published pull requests to become one
  // with three commits; the edge is what lets `pdkit slice join` put the new
  // graph in front of a human again rather than straight into branches.
  'slices-approved': ['preflight-green', 'sliced'],
  'preflight-green': ['pr-open', 'sliced'],
  // Back to preflight-green from pr-open, because an issue with three slices
  // passes through it three times. The gate is issued per branch and only from
  // preflight-green (section 1), so without this edge the second slice of a
  // sliced issue could never be pushed — and widening GATE_ELIGIBLE instead
  // would open a way around preflight itself, which is the one thing that set
  // is narrow to prevent.
  // Back to triage from an open pull request, because "the reviewer rejected
  // the approach" is a normal outcome of review in someone else's repository
  // and the machine had no way to say it. Without this edge the only moves from
  // here are to push again — which assumes the design survived — or to abandon,
  // which throws away an issue that is still worth doing. Found on #17577,
  // where a maintainer named the alternative design in the review body.
  //
  // Not a shortcut back into planning: it lands on `triaged`, so the route is
  // chosen again and planning runs from the issue rather than from the diff
  // that was refused. The same ordering escalate enforces, for the same reason.
  'pr-open': ['preflight-green', 'review-in-progress', 'sliced', 'triaged', 'merged', 'abandoned'],
  'review-in-progress': ['preflight-green', 'sliced', 'triaged', 'merged', 'abandoned'],
  // Answered is deliberately NOT terminal, and that is the correction the run
  // on #18284 made to its own design. The obvious move was a terminal state
  // meaning "settled without a diff" — but the moment the findings are posted,
  // the issue is not settled: it is waiting on the reporter to confirm, which
  // is exactly where #18284 sits, with one reporter asked to check and another
  // saying they cannot. The machine could already wait on a reviewer
  // (`review-in-progress`, `awaiting-review`) and could not wait on a reporter.
  //
  // Three exits, because all three happen. They confirm and it closes; the
  // answer turns out to imply product work — on #18284 the obvious candidate is
  // that Podman Desktop shows a 6.0.1 client driving a 5.8.2 machine and says
  // nothing — and planning starts from the issue again; or nobody ever answers.
  'answered': ['resolved', 'planned', 'abandoned'],
  'merged': [],
  // Settled, and not by a diff of ours. Distinct from `merged`, which claims a
  // change landed, and from `abandoned`, which says the work was dropped —
  // here the work is the entire deliverable and it was published. Reading one
  // of the other two would be false in a way nothing else on disk corrects.
  'resolved': [],
  'abandoned': [],
};

/**
 * States a consent token may be issued from, by what is being written.
 *
 * Two kinds, because stage 4 introduced a write that has no branch. Pushing
 * publishes code and is allowed from exactly one state; replying to a review
 * thread publishes a sentence, belongs to no branch, and happens when the issue
 * is in review — where preflight has nothing to say about it.
 *
 * Here rather than in the config, and `gates.require_states` was deleted for
 * this reason: the only thing such a key can really do is WIDEN the list, and a
 * widened push list is a token issued before preflight. The whole plugin rests
 * on the unwanted input not existing (receipts, the verify verdict), and a knob
 * that opens the gate wider contradicts exactly that.
 *
 * `merged` is on the reply list, and it was added by walking into the refusal it
 * fixes. A reviewer asked a question on #18561 a week after it merged; answering
 * is an ordinary continuation of the same review conversation, and the gate said
 * the issue was merged and refused. That is the failure section 6 names for the
 * tracker rules — a gate that cannot open is worse than a refusal that says what
 * to do — except here there is no route saying a human posts it instead, because
 * replying on your own pull request is exactly what `pr reply` is for.
 *
 * It widens nothing about publishing code. `push` is still one state, and a
 * reply token cannot be found for a push: the keys are of different kinds, which
 * is the hole stage 4 closed. What it authorises is a sentence on a pull request
 * that already exists.
 */
export const GATE_ELIGIBLE = {
  push: ['preflight-green'],
  reply: ['pr-open', 'review-in-progress', 'merged'],
};

/** The kinds of write a token can be issued for. */
export const GATE_KINDS = Object.keys(GATE_ELIGIBLE);

/** States a graph may be re-cut by joining slices from. */
export const JOIN_ELIGIBLE = ['sliced', 'slices-approved', 'preflight-green', 'pr-open', 'review-in-progress'];

/** States a slice branch may be cut from. */
export const MATERIALIZE_ELIGIBLE = ['slices-approved', 'preflight-green', 'pr-open', 'review-in-progress'];

/**
 * The routes triage can choose (section 4).
 *
 * `invalid` is deliberately not here: it is not a way of doing the work, it is
 * the finding that there is none, and the machine already expresses it as the
 * `abandoned` state. A route nothing can ever leave would be a second spelling
 * of a state that exists.
 *
 * Until 0.10 this vocabulary lived in three places and disagreed in all of
 * them: state.js knew two values, lib/preflight/index.js declared four, and
 * section 4 asked for five. Nothing broke, because the only consumer asks about
 * `quickfix` — but `multi-slice` and `redo` could not be recorded at all, which
 * is why the redo route had no way to exist beyond a sentence in a skill.
 */
export const ROUTES = ['standard', 'quickfix', 'multi-slice', 'redo'];

/**
 * The skill that advances an issue out of each state.
 *
 * Written because its absence produced a real failure. Nothing in the plugin
 * ever named the next command: every skill ends on a `pdkit state --to` call and
 * stops, and what the machine prints is `next: implemented` — a STATE. Seven of
 * the eight states in the chain are spelled like the command that reaches them
 * (`triaged`/triage, `planned`/plan, `validated`/validate …), so a model handed
 * "next: implemented" applies the pattern and types `/pd:implement`, which does
 * not exist. Observed on DESKTOP-18832, at exactly the one state whose name and
 * command diverge.
 *
 * The table is here rather than in the skills for the reason the architecture
 * gives for hooks: a handoff that lives only in prose is a handoff that holds
 * most of the time. The skills say it too — but this is what is printed by the
 * command the model has just run, whether or not it read anything.
 *
 * `null` is not a gap. It means the next move is not a skill: a terminal state,
 * or an approval that is a person's to give.
 *
 * @type {Record<State, string|null>}
 */
export const ADVANCES = {
  'new': 'triage',
  // The quickfix route overrides this; see nextStep.
  'triaged': 'plan',
  'quickfix': 'preflight',
  'planned': 'plan-review',
  'plan-approved': 'exec',
  'implemented': 'validate',
  'validated': 'audit',
  'audited': 'slice',
  // Approval is a human action, and branches are cut from it.
  'sliced': null,
  // Not /pd:preflight: under a graph there is nothing to check until /pd:pr
  // has materialized the slice's branch, and preflight is its step 3.
  'slices-approved': 'pr',
  'preflight-green': 'pr',
  'pr-open': 'pr-status',
  'review-in-progress': 'pr-sync',
  'answered': 'close',
  'merged': null,
  'resolved': null,
  'abandoned': null,
};

/**
 * Arguments each skill takes, where they are not the issue number.
 *
 * `<pr>` stays a placeholder on purpose: the number lives in `prs.json`, and
 * this module is not its reader. A placeholder the caller has to fill is honest;
 * a number guessed here would be wrong on any issue with more than one.
 */
const ARGUMENTS = {
  'pr-status': '',
  'pr-sync': ' <pr>',
};

/**
 * What to run next, as one line, or null where nothing follows.
 *
 * Takes the whole record rather than the state, because one answer depends on
 * the route: an issue triaged onto the quickfix route does not go to `/pd:plan`,
 * and sending it there is the mistake `escalate` exists to undo.
 *
 * @param {import('../state.js').Record_} record
 * @returns {string|null}
 */
export function nextStep(record) {
  const issue = record.issue;

  // Two states whose next move is a decision rather than a command. Saying so
  // beats naming a skill that would run before the decision was taken.
  if (record.state === 'sliced') {
    return `pdkit state ${issue} --to slices-approved — approval is yours; branches are cut from it`;
  }
  if (record.state === 'answered') {
    return `/pd:close ${issue} — once the reporter confirms; back to /pd:plan ${issue} if the answer implied product work`;
  }

  const skill = nextSkill(record);
  if (!skill) return null;

  return `/pd:${skill}${ARGUMENTS[skill] ?? ` ${issue}`}`;
}

/**
 * The skill the next step runs, by name, or null where the next step is not one.
 *
 * `sliced` and `answered` are null although nextStep has a line for them: what
 * follows there is a human decision, not a phase, and a phase is what this
 * answer is used to prepare for. A separate function rather than a second shape
 * of nextStep's return, because that line is read as a string by more than one
 * caller.
 *
 * @param {import('../state.js').Record_} record
 * @returns {string|null}
 */
export function nextSkill(record) {
  if (record.state === 'sliced' || record.state === 'answered') return null;
  return (record.state === 'triaged' && record.route === 'quickfix' ? 'quickfix' : ADVANCES[record.state]) ?? null;
}

/**
 * Whether a transition is allowed, without performing it.
 *
 * @param {State} from
 * @param {State} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}
