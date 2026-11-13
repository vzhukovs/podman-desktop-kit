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

// What a revision of the plan changed: the context `state.nextStep` takes for
// a `planned` issue.
//
// After `pdkit plan revised` the next step used to be another review round,
// whatever the revision had been: a revision that reworded a task's Context
// cost a full round and one more set of decisions, the same as one that moved
// a file between tasks. Which of the two follows is now a rule of the state
// machine, `afterRevision` in lib/state/machine.js, beside nextStep. This
// module gathers what the rule reads: the decisions of the round the plan now
// carries, by item and verdict, from plan-review.js; and what `plan diff`
// says changed since the snapshot of the plan that round read, from
// plan-rounds.js. They meet here because plan-rounds.js reads plan-review.js,
// so neither can ask the other.

import * as planReview from './plan-review.js';
import * as planRounds from './plan-rounds.js';

/**
 * The context `state.nextStep` takes, for a record. From `planned`: a waiting
 * revision while the review's decisions have not reached the plan, and what
 * the revision changed once they have. Nothing for any other state, or before
 * a review has decisions.
 *
 * @param {{issue: number, state: string, withdrawn?: Record<string, {replacedBy?: string[]}>}} record
 * @param {{home?: string}} [options]
 * @returns {Promise<import('./state/machine.js').NextContext>}
 */
export async function nextContext(record, options = {}) {
  if (record.state !== 'planned') return {};
  const found = await planReview.pending(record.issue, options);
  if (found.round === null) return {};
  if (found.pending) return { revision: { round: found.round } };
  return { revised: await revised(record, { ...found, round: found.round }, options) };
}

/**
 * What the applied revision of a round changed.
 *
 * The diff counts only against the snapshot of that very round. An earlier
 * one would show the earlier revisions as well, and miss an edit the last
 * revision made and undid within them; with none, `snapshot` is null and
 * nothing is said to have changed or not.
 *
 * @param {{issue: number, withdrawn?: Record<string, {replacedBy?: string[]}>}} record
 * @param {{round: number, decisions: import('./plan-review.js').ItemDecision[]}} found
 * @param {{home?: string}} options
 * @returns {Promise<import('./state/machine.js').Revised>}
 */
async function revised(record, found, options) {
  const ids = (letter, decision) => found.decisions.filter((item) => item.letter === letter && item.decision === decision).map((item) => item.id);
  const facts = {
    round: found.round,
    accepted: { A: ids('A', 'accepted'), B: ids('B', 'accepted') },
    undecided: ids('A', 'undecided'),
    unread: ids('A', 'other'),
  };

  const diff = await planRounds.diff(record.issue, { home: options.home, withdrawn: record.withdrawn ?? {} });
  if (!diff.ok || diff.base === null || diff.plan === null || diff.base.round !== found.round) {
    return { ...facts, snapshot: null, structural: [], tasks: [], sections: [] };
  }
  return {
    ...facts,
    snapshot: diff.base.path,
    structural: diff.because,
    tasks: diff.tasks.changed.map((task) => ({ id: task.id, parts: task.parts.map((entry) => entry.part) })),
    sections: [...(diff.plan.upstreamCompliance ? [planRounds.PLAN_SECTIONS.upstreamCompliance] : []), ...diff.other],
  };
}
