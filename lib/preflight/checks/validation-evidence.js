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

// Preflight check: validation evidence
//
// /pd:validate has three outcomes, and `unverified` is the interesting one. It
// does not block the transition — without Playwright there would be no way out
// of `implemented`, and a gate that expensive gets routed around. The gap is
// carried instead of used as a wall, and this is the other end of that
// decision: a step nobody could demonstrate has to be named in the pull request
// body, or it leaves silently.
//
// Silence is the failure mode worth spending a check on. A body that says
// nothing about what was not verified reads exactly like a body describing work
// that was — the same reason ci-blind-spots exists, applied to "and I did not
// check this myself" rather than "and CI will not check this".
//
// It does not require validation to have succeeded, and it never asks for PASS.

import { get } from '../../config.js';
import { evidenceIntact, outcomeOf, read } from '../../validation.js';

/** @type {string} */
export const id = 'validation-evidence';

/** @type {boolean} */
export const blocking = true;

/** Where the answer belongs. Same section as ci-blind-spots, deliberately. */
const NOTES = /Notes for reviewers([\s\S]{20,})/i;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  // The quickfix route skips validation by design (section 4): it goes
  // triaged -> quickfix -> preflight-green without passing through
  // `validated`, so there is no record to hold it to.
  if (context.route === 'quickfix') {
    return { id, status: 'skip', blocking, summary: 'the quickfix route does not validate' };
  }

  if (get(context.config, 'validation.require_evidence') === false) {
    return { id, status: 'skip', blocking, summary: 'validation.require_evidence is off' };
  }

  const record = await read(context.issue, { home: context.home });
  const { outcome, gaps } = outcomeOf(record);

  if (outcome === 'empty') {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'nothing was validated on the standard route',
      remedy:
        `pdkit validate steps --issue ${context.issue} says what is waiting. ` +
        'A checklist with no artefacts is still a record; no record at all leaves a reviewer nothing to re-check',
    };
  }

  if (outcome === 'fail') {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'a validation step failed',
      output: record.steps
        .filter((step) => step.evidence?.kind === 'run' && step.exitCode !== 0)
        .map((step) => `${step.id} ${step.title} — exit ${step.exitCode ?? 'killed'}, ${step.evidence.path}`)
        .join('\n'),
      remedy: 'fix the change, not the record',
    };
  }

  // An artefact that has moved or changed since it was attached is not evidence
  // any more. Checked here rather than at attach time because the interesting
  // gap is the one that opens between validating and pushing.
  const broken = [];
  for (const step of record.steps.filter((entry) => entry.evidence)) {
    const intact = await evidenceIntact({ repoRoot: context.repoRoot, home: context.home, issue: context.issue, step });
    if (!intact.ok) broken.push(`${step.id} ${step.title} — ${intact.reason}`);
  }

  if (broken.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${broken.length} artefact(s) no longer match what was attached`,
      output: broken.join('\n'),
      remedy: `re-attach the evidence: pdkit validate attach --issue ${context.issue} …`,
    };
  }

  if (gaps.length === 0) {
    return { id, status: 'pass', blocking, summary: `${record.steps.length} step(s), every one with an artefact` };
  }

  const output = gaps.map((step) => `${step.id} ${step.title}`).join('\n');

  if (context.prBody === null) {
    return {
      id,
      status: 'skip',
      blocking,
      summary: `${gaps.length} step(s) without an artefact — the PR body is not drafted yet`,
      remedy: 'name them in Notes for reviewers, then run preflight again',
      output,
    };
  }

  if (!NOTES.test(context.prBody)) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${gaps.length} step(s) could not be demonstrated, and the body has no Notes for reviewers`,
      output,
      remedy: 'say which scenarios were not exercised and why. An unverified step nobody mentions reads as a verified one',
    };
  }

  return { id, status: 'pass', blocking, summary: `${gaps.length} step(s) without an artefact, named in Notes for reviewers` };
}
