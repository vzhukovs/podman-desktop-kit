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

// What a plan has to show before an approval of it is recorded: a plan.md
// under the issue that passes the mechanical checks `pdkit plan check` makes.
//
// Two readers, one answer. The entry rule of `plan-approved` refuses the move
// on a plan that fails them, and `pdkit ids freeze`, which runs first in the
// approval line, refuses to freeze on one: a set frozen on a refused plan
// cannot take the requirement a fix may need, and nothing unfreezes it short
// of a rework. Read from disk at the moment it is asked, not taken from an
// earlier run: a plan edited after its check is the plan being approved.
//
// A leaf, and on purpose. The checks are lib/artefacts.js's, which reaches
// gate.js through render.js and gh.js, and gate.js imports lib/state.js, whose
// entry rule reads this. So the caller hands them in: lib/state.js loads
// artefacts.js at run time, as it already does for amendments, and a command
// imports it like any other module.
//
// Facts only. Whether the plan is any good is the review's, and the person's.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { issueDir, resolveHome } from './config.js';

/**
 * The two functions of lib/artefacts.js this reads a plan with.
 *
 * @typedef {object} PlanChecks
 * @property {typeof import('./artefacts.js').parsePlan} parsePlan
 * @property {typeof import('./artefacts.js').checkPlan} checkPlan
 */

/**
 * The plan's mechanical failures, as `plan check` names them.
 *
 * The probe is not read: its warnings never block, and a plan approved with a
 * `Done when` nobody ran is the review's to weigh, not this rule's.
 *
 * @param {number} issue
 * @param {{record: {requirements?: {ids: string[], frozen: boolean}, withdrawn?: Record<string, unknown>}, checks: PlanChecks, home?: string}} options
 * @returns {Promise<{ok: boolean, path: string, problems: import('./artefacts.js').Problem[]}>}
 */
export async function planProblems(issue, options) {
  const path = join(issueDir(options.home ?? resolveHome(), issue), 'plan.md');
  const content = await readFile(path, 'utf8').catch(() => null);
  if (content === null) return { ok: false, path, problems: [{ check: 'plan', detail: `there is no plan at ${path}` }] };

  const result = await options.checks.checkPlan({ plan: options.checks.parsePlan(content), content, record: options.record });
  return { ok: result.ok, path, problems: result.problems };
}

/**
 * The refusal for a plan that fails its checks, in the words both readers use.
 *
 * @param {number} issue
 * @param {string} refused   what is refused, as the end of a sentence: "it cannot be approved"
 * @param {Awaited<ReturnType<typeof planProblems>>} found
 * @returns {string}
 */
export function refusal(issue, refused, found) {
  return (
    `issue ${issue}: the plan fails its mechanical checks, so ${refused}:\n` +
    found.problems.map((problem) => `    ${problem.check}: ${problem.detail}\n`).join('') +
    `  Run: pdkit plan check ${issue}. These get a plan redone rather than patched, and the approval comes after.`
  );
}
