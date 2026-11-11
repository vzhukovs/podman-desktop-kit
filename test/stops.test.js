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

// Stop reports, from the values a session writes to the amendment that settles
// them.
//
// What these protect: findings that lived in a session's scratch directory, an
// answer of "the values format is not known" to "what goes in the amendment",
// and an amendment that fixed the stopped task while a second task ran the
// same broken command — and stopped next.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseAmendment, parsePlan } from '../lib/artefacts.js';
import { allocateRequirement, freezeRequirements } from '../lib/ids.js';
import { transition } from '../lib/state.js';
import { amendmentProblems, problemsOf, reachOf } from '../lib/stops.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const ISSUE = 17000;
const TSC = 'npx tsc --noEmit -p tests/playwright/tsconfig.json';

/** Two tasks run the same typecheck; a third owns an unrelated file. */
const PLAN = [
  `# PLAN: DESKTOP-${ISSUE}`,
  '',
  '- Requirements: R1 (frozen on approval)',
  '- e2e coverage: no — a runner option',
  '- Slice hypothesis: 1 slices',
  '',
  '## Context',
  '- `tests/playwright/tsconfig.json:9` — rootDir',
  '',
  '## Tasks',
  '### T11: runner option',
  '- Satisfies: R1',
  '- Owns: tests/playwright/src/runner/runner-options.ts',
  `- Done when: \`npx eslint tests/playwright/src/runner && ${TSC}\` → OK`,
  '- Slice: S9',
  '',
  '### T16: product.json helper',
  '- Satisfies: R1',
  '- Owns: tests/playwright/src/utility/product-json.ts',
  `- Done when: \`${TSC}\` → OK`,
  '- Slice: S6',
  '',
  '### T12: cold start spec',
  '- Satisfies: R1',
  '- Owns: tests/playwright/src/specs/cold-start.spec.ts',
  '- Done when: `node run-e2e.mjs cold-start` → passed',
  '- After: T11, T16',
  '',
  '## Slice hypothesis',
  'One slice.',
  '',
  '## Open decisions',
  'none',
  '',
].join('\n');

const FINDING = {
  wrong: '`tsc -p tests/playwright/tsconfig.json` fails with TS6059 on the base branch: `tsconfig.json:9` puts playwright.config.ts outside rootDir.',
  evidence: '$ npx tsc --noEmit -p tests/playwright/tsconfig.json\nerror TS6059: File playwright.config.ts is not under rootDir',
  command: TSC,
  decision: '—',
  proposal: 'T11: same Owns; Done when gains `--rootDir .`.',
};

describe('problemsOf', () => {
  const context = { taskId: 'T11', plan: parsePlan(PLAN) };

  test('every required part has to be there', () => {
    const problems = problemsOf({ wrong: 'x', evidence: '', decision: 'y' }, context);
    assert.deepEqual(problems, ['"evidence" is empty — the command that shows it and what it printed', '"proposal" is empty — what the amendment should change, per task']);
  });

  test('a live task running the same command has to be named or excused — the task the last amendment forgot', () => {
    const problems = problemsOf(FINDING, context);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^T16 runs the same command in its Done when/);
  });

  test('named under affects, or excused with a sentence, it passes', () => {
    assert.deepEqual(problemsOf({ ...FINDING, affects: ['T16'] }, context), []);
    assert.deepEqual(problemsOf({ ...FINDING, unaffected: { T16: 'its own tsconfig' } }, context), []);
    assert.deepEqual(problemsOf({ ...FINDING, unaffected: { T16: ' ' } }, context), ['"unaffected" excuses T16 without saying why']);
  });

  test('a file the finding names reaches the task that owns it', () => {
    const reach = reachOf({ files: ['tests/playwright/src/specs/cold-start.spec.ts'] }, parsePlan(PLAN).tasks, 'T11');
    assert.deepEqual(reach, [{ task: 'T12', because: 'owns tests/playwright/src/specs/cold-start.spec.ts' }]);
  });

  test('affects naming a task the plan does not have is refused', () => {
    assert.deepEqual(problemsOf({ ...FINDING, affects: ['T16', 'T99'] }, context), ['"affects" names T99, which plan.md does not have']);
  });
});

describe('amendmentProblems', () => {
  const amendment = (blocks) =>
    parseAmendment(['# AMENDMENT A3: DESKTOP-17000', '', '- Status: proposed', '', '## Slices affected', ...blocks].join('\n'));
  const report = { id: 'T11-1', task: 'T11', names: ['T11', 'T16'], status: 'open' };
  const t20 = ['### T20 (replaces T11): runner option', '- Satisfies: R1', '- Owns: a.ts', '- Done when: `x`'];
  const t21 = ['### T21 (replaces T16): helper', '- Satisfies: R1', '- Owns: b.ts', '- Done when: `y`'];

  test('replacing one task a report names and leaving the other is refused', () => {
    const problems = amendmentProblems({ amendment: amendment(t20), reports: /** @type {any} */ ([report]) });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /stop report T11-1 names T16 as well, and A3 leaves it as it is/);
  });

  test('replacing both, or one already withdrawn, settles it', () => {
    assert.deepEqual(amendmentProblems({ amendment: amendment([...t20, '', ...t21]), reports: /** @type {any} */ ([report]) }), []);
    assert.deepEqual(amendmentProblems({ amendment: amendment(t20), reports: /** @type {any} */ ([report]), withdrawn: { T16: {} } }), []);
  });

  test('an amendment that touches none of the report is not its business', () => {
    const other = ['### T22 (replaces T12): spec', '- Satisfies: R1', '- Owns: c.ts', '- Done when: `z`'];
    assert.deepEqual(amendmentProblems({ amendment: amendment(other), reports: /** @type {any} */ ([report]) }), []);
  });
});

describe('the flow, through the CLI', () => {
  let home;
  const homes = [];
  const file = (...parts) => join(home, 'issues', String(ISSUE), ...parts);

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-stops-'));
    homes.push(home);
    await transition(ISSUE, 'triaged', { home, route: 'standard' });
    await allocateRequirement(ISSUE, { home });
    await freezeRequirements(ISSUE, { home });
    await writeFile(file('plan.md'), PLAN);
  });

  after(async () => {
    for (const dir of homes) await rm(dir, { recursive: true, force: true });
  });

  async function pdkit(...args) {
    try {
      const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { cwd: home, env: { ...process.env, PDKIT_HOME: home }, encoding: 'utf8' });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
  }

  async function stopT11(values) {
    await writeFile(join(home, 'finding.json'), JSON.stringify(values));
    return pdkit('task', 'stop', '--finding', join(home, 'finding.json'), '--issue', String(ISSUE), '--task', 'T11');
  }

  test('a report that leaves out T16 is not written', async () => {
    const out = await stopT11(FINDING);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /T16 runs the same command/);
    assert.equal((await pdkit('task', 'list', '--issue', String(ISSUE))).stdout.includes('STOPPED'), false);
  });

  test('stop, list, draft, new, approve: the report is settled only when both tasks are replaced', async () => {
    const stopped = await stopT11({ ...FINDING, affects: ['T16'] });
    assert.equal(stopped.code, 0, stopped.stderr);
    const report = await readFile(file('stops', 'T11-1.md'), 'utf8');
    assert.match(report, /^# STOP T11-1: DESKTOP-17000/);
    assert.match(report, /- Affects: T16/);

    const listed = await pdkit('task', 'list', '--issue', String(ISSUE));
    assert.match(listed.stdout, /STOPPED\s+T11 .*stops\/T11-1\.md/);
    assert.match(listed.stdout, /STOPPED\s+T16 /);
    assert.match(listed.stdout, /waiting\s+T12 .*after T11, T16/);
    assert.match(listed.stdout, /next: nothing can start\. T11, T16 stopped on the plan/);

    const draftPath = join(home, 'draft.json');
    const drafted = await pdkit('amendment', 'draft', '--issue', String(ISSUE), '--out', draftPath);
    assert.equal(drafted.code, 0, drafted.stderr);
    const values = JSON.parse(await readFile(draftPath, 'utf8'));
    assert.match(values.slices, /### T17 \(replaces T11\): runner option/);
    assert.match(values.slices, /### T18 \(replaces T16\): product\.json helper/);
    assert.match(values.slices, /- Slice: S9/);
    assert.match(values.slices, /\[FILL IN: the corrected command/);

    // The draft is refused as it stands, and it says which parts.
    const refused = await pdkit('amendment', 'new', '--issue', String(ISSUE), '--values', draftPath);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /slices, rationale still have a \[FILL IN/);

    // Finished — but only T11 replaced: approval is refused over the report.
    const fixed = `\`npx eslint tests/playwright/src/runner && ${TSC} --rootDir .\` → OK`;
    const t17 = values.slices.split('\n\n')[0].replace(/- Done when: .*/, `- Done when: ${fixed}`).replace(/  2\. \[FILL IN[^\n]*/, '  2. Add --rootDir .');
    await writeFile(draftPath, JSON.stringify({ ...values, slices: t17, rationale: 'the typecheck never ran on this config' }));
    const proposed = await pdkit('amendment', 'new', '--issue', String(ISSUE), '--values', draftPath);
    assert.equal(proposed.code, 0, proposed.stderr);
    const half = await pdkit('amendment', 'approve', 'A1', '--issue', String(ISSUE));
    assert.notEqual(half.code, 0);
    assert.match(half.stderr, /leaves a stop report half settled/);
    assert.match(half.stderr, /names T16 as well/);
  });

  test('a cleared report frees its tasks, and needs a reason', async () => {
    assert.equal((await stopT11({ ...FINDING, affects: ['T16'] })).code, 0);
    const bare = await pdkit('task', 'clear', '--issue', String(ISSUE), '--report', 'T11-1');
    assert.notEqual(bare.code, 0);
    assert.match(bare.stderr, /--reason/);

    const cleared = await pdkit('task', 'clear', '--issue', String(ISSUE), '--report', 'T11-1', '--reason', 'the config was fixed upstream');
    assert.equal(cleared.code, 0, cleared.stderr);
    const listed = await pdkit('task', 'list', '--issue', String(ISSUE));
    assert.match(listed.stdout, /next: T11/);
  });
});
