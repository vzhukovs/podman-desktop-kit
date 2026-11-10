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

// Preflight check: self-review
//
// Upstream's review agent reads every pull request against the maintainer's
// rules, title and body first, then every changed file. /pd:pr runs the same
// reading on our side first: the four review axes and the synthesis, on the
// commit and the body about to be published. This check asks for proof that
// it ran on *this* commit and *this* body, and that nothing it found is still
// open.
//
// It reads the body, because the review does: a body that changed after the
// review was read by nobody.

import { bodyDigest, entryFor, read, unresolved } from '../../self-review.js';
import { skipForBody } from '../body.js';

/** @type {string} */
export const id = 'self-review';

/** @type {boolean} */
export const blocking = true;

/** @type {boolean} */
export const needsBody = true;

/**
 * @param {import('../../self-review.js').Finding} finding
 */
const formatFinding = (finding) => {
  const where = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''} — ` : '';
  const source = finding.section === null ? '(outside the rule set)' : `(§${finding.section})`;
  return `${where}${finding.label}: ${finding.text} ${source}`;
};

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const record = `pdkit self-review record --issue ${context.issue}${Number.isInteger(context.slice) ? ` --slice ${context.slice}` : ''} --findings <f> --body <f>`;

  if (context.prBody === null) {
    return skipForBody({ id, blocking, remedy: `run the self-review on the drafted body (/pd:pr step 5), then ${record}` });
  }

  if (context.headSha === null) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'cannot tell which commit is under check, so no self-review can be matched to it',
      remedy: 'run preflight on a branch that resolves to a commit',
    };
  }

  const entry = entryFor(await read(context.issue, { home: context.home }), context.slice);

  if (entry === null) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'no self-review is recorded for this pull request',
      remedy: `run the four review axes and the synthesis on the branch and the body (/pd:pr step 5), then ${record}`,
    };
  }

  const head = context.headSha.slice(0, 8);
  if (entry.sha !== context.headSha) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `the self-review read ${entry.sha.slice(0, 8)}, and the branch is at ${head}`,
      remedy: `review the commit being published, not an earlier one: run the axes again, then ${record}`,
    };
  }

  if (entry.bodyDigest !== bodyDigest(context.prBody)) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'the PR body changed after the self-review read it',
      remedy: `the body is part of what upstream's agent reviews (section 1): run the axes on this body, then ${record}`,
    };
  }

  const open = unresolved(entry);
  if (open.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${open.length} self-review finding(s) still open on ${head}`,
      output: open.map(formatFinding).join('\n'),
      remedy:
        'fix each `issue:` and each `nit:` on code this branch wrote; answer each `question:` in the pull request. ' +
        `Then run the axes on the new commit and ${record}`,
    };
  }

  const kept = entry.findings.length;
  return {
    id,
    status: 'pass',
    blocking,
    summary:
      kept === 0
        ? `four axes on ${head}, nothing found`
        : `four axes on ${head}, nothing open (${kept} pre-existing nit(s) or answered question(s))`,
  };
}
