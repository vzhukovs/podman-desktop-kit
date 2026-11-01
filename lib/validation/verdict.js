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

// Validation as an entity (spec section 2.2, invariant 5) — the verdicts: the
// status of a step, the outcome of a record, and the length of a green e2e
// series, each derived from what is recorded and nothing else.
//
// Storing the record stays with lib/validation.js, its one writer. This file is
// a leaf of the package: every module under lib/validation/ may import it.

/** @typedef {import('../validation.js').Record_} Record_ */
/** @typedef {import('../validation.js').Step} Step */

/** No artefact, no observation: nothing was established about this step. */
export const UNVERIFIED = 'unverified';

/**
 * The status of one step, derived from what is attached to it.
 *
 * This function is the invariant. Every field it reads is written by capture or
 * by hashing a file on disk, so there is no path from "the agent says it
 * passed" to `pass`.
 *
 * @param {Step} step
 * @returns {'pass'|'fail'|'observed'|'unverified'}
 */
export function statusOf(step) {
  if (!step.evidence) return UNVERIFIED;
  if (step.evidence.kind === 'run') return step.exitCode === 0 ? 'pass' : 'fail';
  // An artefact with nothing said about it is a file, not a finding. Requiring
  // the observation here rather than at the call site means a screenshot
  // attached and never described cannot quietly count as evidence.
  return step.observed ? 'observed' : UNVERIFIED;
}

/** Worst first. The outcome of a validation is the most serious thing in it. */
const SEVERITY = ['fail', UNVERIFIED, 'observed', 'pass'];

/**
 * The outcome of the whole validation.
 *
 * `observed` steps roll up into `pass`: an artefact plus a description of what
 * it shows is evidence, and demanding a runnable assertion for every visual
 * check would make the honest path the expensive one. What does not roll up is
 * a step with nothing attached — see section 4 for why that is `unverified`
 * rather than a refusal.
 *
 * @param {Record_|null} record
 * @returns {{outcome: 'pass'|'fail'|'unverified'|'empty', gaps: Step[]}}
 */
export function outcomeOf(record) {
  const all = record?.steps ?? [];
  if (all.length === 0) return { outcome: 'empty', gaps: [] };

  // A superseded step is still in the record and no longer in the arithmetic.
  // That is the whole difference between setting a step aside and editing it
  // out: the run, the reason and the step that replaced it stay readable.
  const steps = all.filter((step) => !step.superseded);
  if (steps.length === 0) return { outcome: 'empty', gaps: [] };

  const statuses = steps.map((step) => statusOf(step));
  const gaps = steps.filter((step) => statusOf(step) === UNVERIFIED);
  const worst = SEVERITY.find((status) => statuses.includes(status)) ?? 'pass';

  return { outcome: worst === 'observed' ? 'pass' : worst, gaps };
}

/**
 * How many runs at the end of the series were green, most recent first.
 *
 * Green is an exit code of zero AND a run that executed something. The second
 * half is not pedantry: a suite whose every test skipped exits zero, and three
 * of those satisfy the check that exists to stop a flake reaching somebody
 * else's repository.
 *
 * @param {Array<{exitCode: number|null, executed?: boolean}>} runs
 * @returns {number}
 */
export function streak(runs) {
  let consecutive = 0;
  for (const entry of [...runs].reverse()) {
    if (entry.exitCode !== 0 || entry.executed === false) break;
    consecutive += 1;
  }
  return consecutive;
}
