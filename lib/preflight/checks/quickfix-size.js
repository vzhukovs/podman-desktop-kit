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

// Preflight check: how big the quickfix turned out to be
//
// The thresholds in `quickfix.*` were the route's whole justification — "if the
// diff fits in one sentence, a plan is overhead" — and until now nothing
// measured them. They were a judgement made at triage, on an estimate, before
// any code existed.
//
// This check measures and does not block, and the reason is the first live run.
// Issue #18248 is a one-line fix: `Command[0]` became `Command.join(' ')`. The
// test that the same skill demands — "too small to test is how a reviewer's
// first comment gets written for them" — cost 62 lines. Measured naively the
// change is 64 changed lines against a threshold of 20, so a blocking version
// of this check would have escalated a genuinely trivial fix into full planning
// because it was properly tested.
//
// So the split is the finding: production lines and test lines are counted
// separately, and only the first is compared with the threshold. Whether the
// numbers themselves are right is a separate question — `pdkit stats` measures
// what upstream actually merges, and says 71% of merged pull requests change
// three files or fewer.

import { changedLines } from '../../repo.js';

/** @type {string} */
export const id = 'quickfix-size';

/**
 * Never blocking, deliberately.
 *
 * A gate that stops a small correct change because its test is thorough teaches
 * people to write thinner tests, which is the opposite of what the route is for.
 * @type {boolean}
 */
export const blocking = false;

/** Test files, whose length says nothing about the size of the change. */
const TEST = /(^|\/)(tests?|__tests__|e2e)\/|\.(spec|test)\.[jt]sx?$/;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  if (context.route !== 'quickfix') {
    return { id, status: 'skip', blocking, summary: 'not the quickfix route' };
  }

  const diff = await changedLines(context.base, context.ref, { cwd: context.repoRoot });

  let code = 0;
  let tests = 0;
  const files = { code: 0, tests: 0 };

  for (const entry of diff) {
    // A binary file has no lines to compare; it still counts as a file.
    const lines = (entry.added ?? 0) + (entry.removed ?? 0);

    if (TEST.test(entry.path)) {
      tests += lines;
      files.tests += 1;
    } else {
      code += lines;
      files.code += 1;
    }
  }

  const maxLines = Number(context.config?.quickfix?.max_changed_lines ?? 20);
  const maxFiles = Number(context.config?.quickfix?.max_files ?? 3);
  const over = code > maxLines || files.code > maxFiles;

  const summary =
    `${code} line(s) in ${files.code} file(s), plus ${tests} test line(s) in ${files.tests}` +
    ` — thresholds are ${maxLines} lines and ${maxFiles} files, tests excluded`;

  return over
    ? {
        id,
        status: 'warn',
        blocking,
        summary,
        remedy:
          'the fix outgrew what the route assumes. `pdkit issue escalate <n>` returns it to triage so requirements ' +
          'come from the issue rather than from the diff — or say why the route still fits, because nothing here decides it',
      }
    : { id, status: 'pass', blocking, summary };
}
