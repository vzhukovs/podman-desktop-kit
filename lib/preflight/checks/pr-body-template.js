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

// Preflight check: the PR body was made from the template
//
// Six checks read the body and every one of them reads a part of it. None asked
// whether the body is the shape upstream's pull request template asks for, so a
// body composed directly — rather than rendered — passed all six while missing
// things none of them looks at.
//
// That happened on 18834. The `/pd:pr` skill says to render the body with
// `pdkit render prBody`; the session wrote it by hand instead, and what went
// missing was upstream's own `- [ ] Tests are covering the bug fix or the new
// feature` checkbox and the attribution footer. The gates went green, the pull
// request was published, and the gap was found by a person reading the result.
//
// A rule enforced only by prose in a skill is a rule that holds until somebody
// takes a shortcut, which is the thing this repository keeps rediscovering.
//
// Sections, not wording. Extra content is fine and is not reported: a body that
// says more than the template asked for is not a defect, and treating it as one
// would push whoever wrote it to say less.

import { validateSections } from '../../render.js';

/** @type {string} */
export const id = 'pr-body-template';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  if (context.prBody === null) {
    return {
      id,
      status: 'skip',
      blocking,
      summary: 'the PR body is not drafted yet',
      remedy: 'draft the body, then run preflight again — this check has to read it',
    };
  }

  const checked = await validateSections('prBody', context.prBody);

  if (!checked.ok) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${checked.missing.length} thing(s) the template declares are not in the body`,
      output: checked.missing.join('\n'),
      remedy:
        'render it rather than writing it: `pdkit render prBody --issue <n> --values <f> --strip-comments`. ' +
        'The checkbox and the footer are upstream\'s and ours respectively, and neither is decoration',
    };
  }

  return { id, status: 'pass', blocking, summary: 'every section the template declares is present' };
}
