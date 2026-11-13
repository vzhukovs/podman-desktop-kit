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

// A plan an approval can be recorded on, for suites that walk an issue through
// `plan-approved` and are not about planning.
//
// It exists because the transition stopped being free, as `preflight-green`
// did before it: the move now reads the plan and refuses one that fails the
// checks `pdkit plan check` makes, or whose requirement set was not frozen.
// The fixtures that walk the machine pay for it the way real work does.
//
// Rendered from the real template and frozen through lib/state.js, not written
// as hand-built text and a hand-set flag: a fixture that fabricated either
// would keep passing after the shape changed.
//
// Outside `test/*.test.js`, so the runner does not collect it as a suite.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { issueDir } from '../../lib/config.js';
import { render } from '../../lib/render.js';
import { allocateRequirement, freezeRequirements, read } from '../../lib/state.js';

/**
 * Write a one-task plan over the issue's requirements and freeze the set.
 *
 * An issue with none gets R1. `allocate: false` leaves the record without it
 * and writes the plan over R1 all the same, which the checks accept from an
 * issue that has allocated nothing: for a suite whose later steps read the
 * record's set and were written against an issue that has none. `slices` is the
 * plan's slice hypothesis, for a suite that cuts the change into that many.
 * `freeze: false` leaves the set open, for the suite about the freeze itself.
 *
 * @param {number} issue
 * @param {{home: string, allocate?: boolean, slices?: number, freeze?: boolean}} options
 * @returns {Promise<string>} the path of the plan
 */
export async function approvablePlan(issue, options) {
  const { home, allocate = true, slices = 1, freeze = true } = options;
  let record = await read(issue, { home });
  if (allocate && record.requirements.ids.length === 0 && !record.requirements.frozen) {
    const allocated = await allocateRequirement(issue, { home });
    if (!allocated.ok) throw new Error(`approvablePlan: ${allocated.error}`);
    record = await read(issue, { home });
  }
  const ids = record.requirements.ids.join(', ') || 'R1';

  const text = await render(
    'plan',
    {
      issue,
      requirementIds: ids,
      e2eCoverage: 'no — a fixture',
      sliceCount: slices,
      context: '- `packages/main/src/index.ts:1` — the file the fixture task owns',
      interfaces: 'none',
      tasks: [
        '### T1: a fixture task',
        `- Satisfies: ${ids}`,
        '- Owns: packages/main/src/index.ts',
        '- Done when: `pnpm test:main`',
        '- Intent: stands in for the plan the suite is not about',
      ].join('\n'),
      spdx: 'no new files',
      schemas: 'no',
      extensionApi: 'no',
      scope: 'main',
      sliceHypothesis: slices === 1 ? 'One slice.' : `${slices} slices.`,
      decisions: 'none',
    },
    { home },
  );

  const dir = issueDir(home, issue);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'plan.md');
  await writeFile(path, text);

  if (freeze) {
    const frozen = await freezeRequirements(issue, { home });
    if (!frozen.ok) throw new Error(`approvablePlan: ${frozen.error}`);
  }
  return path;
}
