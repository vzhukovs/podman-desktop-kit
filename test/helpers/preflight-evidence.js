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

// A green preflight, for suites that need an issue standing at
// `preflight-green` and are not about preflight.
//
// It exists because the transition stopped being free. Reaching that state now
// requires the record preflight writes, which is the point — it is the state the
// push gate opens from, and it used to be reachable by typing its name. A dozen
// fixtures walk the machine to it on their way to testing something else, and
// they should pay for it the same way real work does: by producing the evidence,
// through the module that owns it.
//
// Written through `record.write` rather than as hand-built JSON, deliberately.
// A fixture that fabricates the file directly would keep passing after the
// shape changed, and would then be testing a format nothing writes.
//
// Outside `test/*.test.js`, so the runner does not collect it as a suite.

import { BODY_DEPENDENT, CHECK_IDS } from '../../lib/preflight/index.js';
import { write } from '../../lib/preflight/record.js';

/**
 * Record every check passing, with the pull request body in hand.
 *
 * @param {number} issue
 * @param {{home: string, head?: string|null, branch?: string|null, slice?: number|null}} options
 * @returns {Promise<object>} the run as written
 */
export async function preflightGreen(issue, options) {
  return write({
    issue,
    report: {
      ok: true,
      results: CHECK_IDS.map((id) => ({ id, status: 'pass', blocking: true, summary: 'green, in a fixture' })),
    },
    context: {
      branch: options.branch ?? null,
      slice: options.slice ?? null,
      headSha: options.head ?? null,
      baseInfo: { ref: 'main', sha: null },
      // Not null, because a body-dependent check that has only ever run without
      // one has judged nothing — which is exactly what the guard refuses.
      prBody: '## What does this PR do?\n\nA fixture.\n',
    },
    bodyDependent: BODY_DEPENDENT,
    home: options.home,
  });
}
