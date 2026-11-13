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

// The step after a revision: another review round, or the approval.
//
// What these protect: every revision used to go back to review, and a round
// that found nothing that must change, with three B items accepted, was
// followed by two more full rounds and two more sets of decisions. The other
// way round matters as much: a revision that moved a file between tasks, or
// fixed an accepted A, sent to approval with no critic over the change.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { TASK_PARTS } from '../lib/artefacts.js';
import { markRevised } from '../lib/plan-review.js';
import { nextContext } from '../lib/plan-revision.js';
import { INTERFACE_PART, snapshot } from '../lib/plan-rounds.js';
import { EXECUTION_PARTS, afterRevision, nextSkill, nextStep, transition } from '../lib/state.js';

const exec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'pdkit');
const ISSUE = 17004;
const APPROVAL = `pdkit ids freeze ${ISSUE} && pdkit state ${ISSUE} --to plan-approved — approval is yours; the revision changed task text only`;

const PLAN = [
  `# PLAN: DESKTOP-${ISSUE}`,
  '',
  '- Requirements: R1 (frozen on approval)',
  '- Slice hypothesis: 1 slice',
  '',
  '## Frozen interfaces',
  'None.',
  '',
  '## Tasks',
  '### T1: registry',
  '- Satisfies: R1',
  '- Owns: src/registry.ts',
  '- Done when: `npx vitest run src/registry.spec.ts`',
  '- Steps:',
  '  1. Write the registry.',
  '### T2: wiring',
  '- Satisfies: R1',
  '- Owns: src/index.ts',
  '- Done when: `npx vitest run src/index.spec.ts`',
  '- After: T1',
  '- Steps:',
  '  1. Call it at start.',
  '',
  '## Upstream compliance',
  '- SPDX headers needed: yes',
  '',
  '## Slice hypothesis',
  '- S1: T1, T2',
  '',
].join('\n');

/** A task file in the shape of templates/task.md. */
function taskFile(id, owns) {
  return [`# ${id}: a task`, '', `- Issue: ${ISSUE}`, '- Satisfies: R1', '', '## Owns', `- ${owns}`, '', '## Context', '- a fact at `src/a.ts:1`', '', '## Steps', '1. Do it.', ''].join('\n');
}

/** A round-1 review with these decision lines, as /pd:plan-review leaves it. */
function review(...lines) {
  return [`# PLAN REVIEW: DESKTOP-${ISSUE} — round 1`, '', '## B — worth discussing', '### B1. x', '', '## Operator decisions (round 1)', ...lines, ''].join('\n');
}

describe('the rule', () => {
  // A part renamed in artefacts.js and not here would never send a revision to
  // review again, and nothing would say so.
  test('every execution part is a part plan diff reports', () => {
    for (const part of EXECUTION_PARTS) assert.ok([...TASK_PARTS, INTERFACE_PART].includes(part), part);
  });

  const base = { round: 4, accepted: { A: [], B: ['B1', 'B2'] }, undecided: [], unread: [], snapshot: '/r4', structural: [], tasks: [], sections: [] };

  // Not structural any more, so a delta round reviews it; still a contract
  // execution reads, so it is not sent to approval as text.
  test('a frozen interface entry that changed goes to review, named by its tasks', () => {
    const tasks = [
      { id: 'T1', parts: [INTERFACE_PART] },
      { id: 'T2', parts: ['Context', INTERFACE_PART] },
    ];
    assert.deepEqual(afterRevision({ ...base, tasks }), { review: true, because: 'Frozen interfaces changed in T1, T2' });
  });

  test('says what it measured, in one line', () => {
    assert.deepEqual(afterRevision({ ...base, accepted: { A: ['A1'], B: [] } }), { review: true, because: 'A1 accepted' });
    assert.deepEqual(afterRevision({ ...base, tasks: [{ id: 'T11', parts: ['Owns', 'Done when', 'Context'] }] }), {
      review: true,
      because: 'Owns changed in T11; Done when changed in T11',
    });
    assert.deepEqual(afterRevision({ ...base, tasks: [{ id: 'T3', parts: ['Context', 'Steps'] }, { id: 'T5', parts: ['Steps'] }] }), {
      review: false,
      because: 'no A accepted, B1, B2 accepted; text only — Context changed in T3; Steps changed in T3, T5',
    });
    assert.deepEqual(afterRevision(base), { review: false, because: 'no A accepted, B1, B2 accepted; the plan is the one round 4 read' });
  });

  // A decision written without the verdict word may be an acceptance; a skip
  // is never a pass.
  test('an A decided in words with no verdict goes to review', () => {
    assert.equal(afterRevision({ ...base, unread: ['A2'] }).review, true);
  });

  // A finding that must change reaches approval only rejected: one nobody
  // decided is still open, whatever the diff says.
  test('an A left with no decision goes to review', () => {
    assert.deepEqual(afterRevision({ ...base, undecided: ['A3'] }), { review: true, because: 'A3 left with no decision' });
  });

  test('the approval line is not wider than what changed', () => {
    const record = { issue: ISSUE, state: 'planned', route: 'standard' };
    const step = (revised) => nextStep(/** @type {any} */ (record), { revised: { ...base, ...revised } });
    assert.equal(step({ tasks: [{ id: 'T1', parts: ['Context'] }] }), APPROVAL);
    assert.match(step({ sections: ['Upstream compliance'] }), /the revision changed text only$/);
    assert.match(step({}), /the revision changed nothing in the plan$/);
    // Not a skill: the approval is a person's, and no model line is printed for it.
    assert.equal(nextSkill(/** @type {any} */ (record), { revised: base }), null);
  });
});

describe('the step after a revision, read from disk', () => {
  let home;
  const homes = [];
  const record = { issue: ISSUE, state: 'planned', route: 'standard' };
  const dir = () => join(home, 'issues', String(ISSUE));

  /** Replace one string in a file of the issue, and fail when it is not there. */
  async function edit(name, from, to) {
    const path = join(dir(), name);
    const text = await readFile(path, 'utf8');
    assert.ok(text.includes(from), `${name} has no "${from}"`);
    await writeFile(path, text.replace(from, to));
  }

  /** Round 1 read the plan, was decided with these lines, and the revision applied them. */
  async function decided(...lines) {
    await snapshot(ISSUE, { home });
    await writeFile(join(dir(), 'plan-review.md'), review(...lines));
    await markRevised(ISSUE, 1, { home });
  }

  /** The line `pdkit next` prints, and the reason `pdkit plan revised` gives. */
  async function next() {
    const context = await nextContext(/** @type {any} */ (record), { home });
    return { step: nextStep(/** @type {any} */ (record), context), because: context.revised ? afterRevision(context.revised).because : null };
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-revision-'));
    homes.push(home);
    await mkdir(join(dir(), 'tasks'), { recursive: true });
    await writeFile(join(dir(), 'plan.md'), PLAN);
    await writeFile(join(dir(), 'tasks', 'T1.md'), taskFile('T1', 'src/registry.ts'));
    await writeFile(join(dir(), 'tasks', 'T2.md'), taskFile('T2', 'src/index.ts'));
  });
  after(async () => {
    for (const path of homes) await rm(path, { recursive: true, force: true });
  });

  test('(a) an accepted A goes to review, whatever the diff', async () => {
    await decided('- A1: accepted', '- B1: accepted');
    await edit('tasks/T1.md', 'a fact at', 'a checked fact at');
    assert.deepEqual(await next(), { step: `/pd:plan-review ${ISSUE}`, because: 'A1 accepted' });
  });

  test('(b) only B accepted, the diff only in Context: the approval', async () => {
    await decided('- B1: accepted');
    await edit('tasks/T2.md', 'a fact at', 'a checked fact at');
    assert.deepEqual(await next(), { step: APPROVAL, because: 'no A accepted, B1 accepted; text only — Context changed in T2' });
  });

  test('(c) only B accepted, the diff in Owns: review', async () => {
    await decided('- B1: accepted');
    await edit('plan.md', '- Owns: src/index.ts', '- Owns: src/index.ts, src/start.ts');
    assert.deepEqual(await next(), { step: `/pd:plan-review ${ISSUE}`, because: 'Owns changed in T2' });
  });

  test('an A left with no decision goes to review, with only text changed', async () => {
    await decided('- A1: no decision', '- B1: accepted');
    await edit('tasks/T2.md', 'a fact at', 'a checked fact at');
    assert.deepEqual(await next(), { step: `/pd:plan-review ${ISSUE}`, because: 'A1 left with no decision' });
  });

  test('(d) no snapshot of the round: review, as before', async () => {
    await writeFile(join(dir(), 'plan-review.md'), review('- B1: accepted'));
    await markRevised(ISSUE, 1, { home });
    assert.deepEqual(await next(), {
      step: `/pd:plan-review ${ISSUE}`,
      because: 'no snapshot of the plan round 1 read, so what the revision changed is not known',
    });
  });

  // The snapshot of an earlier round holds the revisions since as well, and
  // can hide an edit the last one made and undid; only the round's own counts.
  test('a snapshot of an earlier round only is no snapshot', async () => {
    await snapshot(ISSUE, { home });
    await writeFile(join(dir(), 'plan-review.r1.md'), review('- B1: accepted'));
    await writeFile(join(dir(), 'plan-review.md'), review('- B1: accepted').replaceAll('round 1', 'round 2'));
    await markRevised(ISSUE, 2, { home });
    assert.match((await next()).because ?? '', /^no snapshot of the plan round 2 read/);
  });

  test('a task added is structural, and goes to review', async () => {
    await decided('- B1: accepted');
    await edit('plan.md', '\n## Upstream compliance', '### T3: docs\n- Satisfies: R1\n- Owns: docs/a.md\n- Done when: `true`\n\n## Upstream compliance');
    assert.deepEqual(await next(), { step: `/pd:plan-review ${ISSUE}`, because: 'tasks added: T3' });
  });

  test('a waiting revision still comes first', async () => {
    await snapshot(ISSUE, { home });
    await writeFile(join(dir(), 'plan-review.md'), review('- B1: accepted'));
    const context = await nextContext(/** @type {any} */ (record), { home });
    assert.deepEqual(context, { revision: { round: 1 } });
  });

  test('outside planned, nothing', async () => {
    await decided('- B1: accepted');
    assert.deepEqual(await nextContext(/** @type {any} */ ({ ...record, state: 'plan-approved' }), { home }), {});
  });

  // End to end through bin/pdkit: what the revision prints is what `next` says.
  describe('pdkit plan revised', () => {
    async function pdkit(...args) {
      try {
        const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { cwd: home, env: { ...process.env, PDKIT_HOME: home }, encoding: 'utf8' });
        return { code: 0, stdout, stderr };
      } catch (error) {
        return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
      }
    }

    beforeEach(async () => {
      await transition(ISSUE, 'triaged', { home, route: 'standard' });
      await transition(ISSUE, 'planned', { home });
      await snapshot(ISSUE, { home });
      await writeFile(join(dir(), 'plan-review.md'), review('- B1: accepted'));
    });

    test('prints the approval and why, and moves nothing', async () => {
      await edit('tasks/T2.md', 'a fact at', 'a checked fact at');
      const revised = await pdkit('plan', 'revised', String(ISSUE));
      assert.equal(revised.code, 0, revised.stderr);
      assert.equal(
        revised.stdout,
        `round 1 of the review is in plan.md (B1)\n  next: ${APPROVAL}\n  why:  no A accepted, B1 accepted; text only — Context changed in T2\n`,
      );
      assert.equal((await pdkit('next', String(ISSUE))).stdout, `${APPROVAL}\n`);
      assert.match((await pdkit('state', String(ISSUE))).stdout, /state {8}: planned/);
    });

    test('prints the review and why', async () => {
      await edit('plan.md', '- After: T1', '- After: none');
      const revised = await pdkit('plan', 'revised', String(ISSUE));
      assert.match(revised.stdout, new RegExp(`\\n  next: /pd:plan-review ${ISSUE}\\n  why:  After changed in T2\\n$`));
    });
  });
});
