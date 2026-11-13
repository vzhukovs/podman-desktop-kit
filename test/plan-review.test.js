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

// The revision handoff, and the probe of every `Done when`.
//
// What these protect: a person asking three times how to start /pd:plan after
// a review, and getting a paragraph to paste each time; and a plan approved
// after four rounds whose tasks then stopped on commands nobody had run.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkPlan, parsePlan } from '../lib/artefacts.js';
import { decisionsIn, markRevised, pending, reviewIn } from '../lib/plan-review.js';
import * as probe from '../lib/probe.js';
import { nextSkill, nextStep } from '../lib/state.js';

const ISSUE = 17001;

describe('decisionsIn', () => {
  test('no decision section, nothing decided', () => {
    assert.deepEqual(decisionsIn('# PLAN REVIEW: DESKTOP-1 — round 2\n\n## A. Must change\n### A1. x\n'), {
      decided: false,
      round: null,
      items: [],
      decisions: [],
      accepted: { A: 0, B: 0 },
    });
  });

  test('the round from the heading, the items from its lines', () => {
    const text = '# PLAN REVIEW: DESKTOP-1 — round 2\n\n## A\n### A1. x\n\n## Operator decisions (round 3)\n- A1: accepted\n- B3: rejected — not now\n';
    assert.deepEqual(decisionsIn(text), {
      decided: true,
      round: 3,
      items: ['A1', 'B3'],
      decisions: [
        { id: 'A1', letter: 'A', decision: 'accepted' },
        { id: 'B3', letter: 'B', decision: 'rejected' },
      ],
      accepted: { A: 1, B: 0 },
    });
  });

  test('the heading the earlier reviews were written with counts, round from the title', () => {
    const text = '# PLAN REVIEW: DESKTOP-1 — раунд 2 (2026-11-11)\n\n## Решения оператора (2026-11-11)\n- **A1.** принято\n- **B2.** принято\n\n## Что дальше\nA9 is not a decision\n';
    const found = decisionsIn(text);
    assert.deepEqual([found.decided, found.round, found.items], [true, 2, ['A1', 'B2']]);
    assert.deepEqual(found.accepted, { A: 1, B: 1 });
  });

  test('the last of two decision sections is the one that counts', () => {
    const text = '## Operator decisions (round 1)\n- A1: accepted\n\n## Operator decisions (round 2)\n- A4: accepted\n';
    const found = decisionsIn(text);
    assert.deepEqual([found.decided, found.round, found.items], [true, 2, ['A4']]);
    assert.deepEqual(found.decisions, [{ id: 'A4', letter: 'A', decision: 'accepted' }]);
  });

  // What the step after a revision reads: whether any A was accepted. An A
  // counted as not accepted when it was is a revision sent to approval with a
  // must-change finding nobody reviewed the fix of.
  test('one decision per item, by its letter, and the A and B accepted counted', () => {
    const text = [
      '# PLAN REVIEW: DESKTOP-1 — round 4',
      '',
      '## Operator decisions (round 4)',
      '- A1: rejected — the critic misread the order',
      '- B1: accepted',
      '- B2: accepted, variant (b) — one helper',
      '- B3: no decision',
      '- B1 (amended during revision): the helper goes in the shared module',
      '- C1: accepted',
      '- A2: variant (a), as recommended',
      '',
    ].join('\n');
    const found = decisionsIn(text);
    assert.deepEqual(found.decisions, [
      { id: 'A1', letter: 'A', decision: 'rejected' },
      // The amendment opens with no verdict; the first line's stands.
      { id: 'B1', letter: 'B', decision: 'accepted' },
      { id: 'B2', letter: 'B', decision: 'accepted' },
      { id: 'B3', letter: 'B', decision: 'undecided' },
      { id: 'C1', letter: 'C', decision: 'accepted' },
      // No verdict word at all: read, and not guessed to be either.
      { id: 'A2', letter: 'A', decision: 'other' },
    ]);
    assert.deepEqual(found.accepted, { A: 0, B: 2 });
  });
});

// The critic's brief lists every round's rejections and the last round's
// acceptances. Read wrong, a rejected item is raised again in the next round —
// and the person spends it rejecting the same thing twice.
describe('reviewIn', () => {
  const REVIEW = [
    '# PLAN REVIEW: DESKTOP-1 — round 2',
    '',
    '## A — must change before approval',
    '### A1. The fixture is not loadable',
    '## B — worth discussing',
    '### B1. A second helper does the same',
    '### B2. Names of two tests mislead',
    '',
    '## Operator decisions (round 2)',
    '- A1: accepted, variant (a) — add the missing field',
    '- B1: accepted as recommended',
    '- B2: rejected — keep as is',
    '- C1: no decision',
    '- A1 (amended during revision): the field goes in the manifest instead',
    '',
  ].join('\n');

  test('each line with its verdict, its text and the heading of its item', () => {
    const { round, decisions } = reviewIn(REVIEW);
    assert.equal(round, 2);
    assert.deepEqual(
      decisions.map((decision) => [decision.id, decision.verdict, decision.title]),
      [
        ['A1', 'accepted', 'The fixture is not loadable'],
        ['B1', 'accepted', 'A second helper does the same'],
        ['B2', 'rejected', 'Names of two tests mislead'],
        ['C1', 'undecided', null],
        // An amendment written as a second line is kept, and not guessed at.
        ['A1', 'other', 'The fixture is not loadable'],
      ],
    );
    assert.equal(decisions[2].text, 'rejected — keep as is');
  });

  test('the form the earlier reviews were written in', () => {
    const text = '# PLAN REVIEW: DESKTOP-1 — раунд 3\n\n### B4. Лишний модуль\n\n## Решения оператора\n- **A1.** принято\n- **B4.** отклонено — не сейчас\n';
    const { round, decisions } = reviewIn(text);
    assert.equal(round, 3);
    assert.deepEqual(
      decisions.map((decision) => [decision.id, decision.verdict, decision.title]),
      [
        ['A1', 'accepted', null],
        ['B4', 'rejected', 'Лишний модуль'],
      ],
    );
  });

  test('no decision section: the title round, nothing decided', () => {
    assert.deepEqual(reviewIn('# PLAN REVIEW: DESKTOP-1 — round 4\n\n## A\n### A1. x\n'), { round: 4, decisions: [] });
  });
});

describe('the next step from planned', () => {
  const record = { issue: ISSUE, state: 'planned', route: 'standard' };

  test('with no revision waiting, the review', () => {
    assert.equal(nextStep(/** @type {any} */ (record)), `/pd:plan-review ${ISSUE}`);
  });

  test('with one waiting, the plan — with nothing to paste', () => {
    const context = { revision: { round: 2 } };
    assert.equal(nextSkill(/** @type {any} */ (record), context), 'plan');
    assert.match(nextStep(/** @type {any} */ (record), context), /^\/pd:plan 17001 — applies the operator decisions of review round 2 from plan-review\.md; nothing to paste/);
  });

  test('a revision context changes nothing outside planned', () => {
    assert.equal(nextStep(/** @type {any} */ ({ ...record, state: 'plan-approved' }), { revision: { round: 2 } }), `/pd:exec ${ISSUE}`);
  });

  describe('read from disk', () => {
    let home;
    const homes = [];
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'pdkit-review-'));
      homes.push(home);
      await mkdir(join(home, 'issues', String(ISSUE)), { recursive: true });
    });
    after(async () => {
      for (const dir of homes) await rm(dir, { recursive: true, force: true });
    });

    test('decisions recorded and not applied are pending until plan revised marks their round', async () => {
      await writeFile(join(home, 'issues', String(ISSUE), 'plan-review.md'), '# PLAN REVIEW — round 1\n\n## Operator decisions (round 1)\n- A1: accepted\n');
      const waiting = await pending(ISSUE, { home });
      assert.deepEqual([waiting.pending, waiting.round, waiting.accepted], [true, 1, { A: 1, B: 0 }]);

      await markRevised(ISSUE, 1, { home });
      const applied = await pending(ISSUE, { home });
      // Applied, and still read: the step after the revision needs them.
      assert.deepEqual([applied.pending, applied.round, applied.decisions], [false, 1, [{ id: 'A1', letter: 'A', decision: 'accepted' }]]);

      // A second round of decisions is a new revision.
      await writeFile(join(home, 'issues', String(ISSUE), 'plan-review.md'), '# PLAN REVIEW — round 2\n\n## Operator decisions (round 2)\n- A1: accepted\n');
      assert.deepEqual([(await pending(ISSUE, { home })).pending, (await pending(ISSUE, { home })).round], [true, 2]);
    });

    test('no review file, nothing pending', async () => {
      const found = await pending(ISSUE, { home });
      assert.deepEqual([found.pending, found.round], [false, null]);
    });
  });
});

describe('probe', () => {
  let home;
  const homes = [];
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-probe-'));
    homes.push(home);
    await mkdir(join(home, 'issues', String(ISSUE)), { recursive: true });
  });
  after(async () => {
    for (const dir of homes) await rm(dir, { recursive: true, force: true });
  });

  /** A capture that fails for a command mentioning `tsc`, and passes otherwise. */
  const capture = async ({ command }) => ({
    command,
    exitCode: command.includes('tsc') ? 2 : 0,
    stdout: command.includes('tsc') ? 'compiling\nerror TS6059: playwright.config.ts is not under rootDir\n' : 'ok\n',
    stderr: '',
    durationMs: 5,
    at: '2026-11-11T00:00:00.000Z',
    complete: true,
  });

  test('records one run per task, and keeps the newest', async () => {
    const runs = await probe.run({ issue: ISSUE, cwd: home, home, capture, tasks: [{ id: 'T1', command: 'npx vitest run a' }, { id: 'T2', command: 'npx tsc -p x' }] });
    assert.deepEqual(runs.map((run) => [run.task, run.exitCode]), [['T1', 0], ['T2', 2]]);
    assert.equal(runs[1].tail.at(-1), 'error TS6059: playwright.config.ts is not under rootDir');

    const stored = JSON.parse(await readFile(join(home, 'issues', String(ISSUE), 'probe.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored.runs), ['T1', 'T2']);
    assert.deepEqual(Object.keys(await probe.read(ISSUE, { home })), ['T1', 'T2']);
  });

  test('plan check says what was measured: never run, another command, a red exit with its last line', async () => {
    const plan = parsePlan(
      [
        '# PLAN: DESKTOP-17001',
        '- Requirements: R1',
        '- e2e coverage: no — x',
        '## Context',
        '- `a:1` — a',
        '## Tasks',
        '### T1: a',
        '- Satisfies: R1',
        '- Owns: a.ts',
        '- Done when: `npx vitest run a`',
        '### T2: b',
        '- Satisfies: R1',
        '- Owns: b.ts',
        '- Done when: `npx tsc -p x --rootDir .`',
        '### T3: c',
        '- Satisfies: R1',
        '- Owns: c.ts',
        '- Done when: `npx tsc -p y`',
        '### T4: d',
        '- Satisfies: R1',
        '- Owns: d.ts',
        '- Done when: `npx vitest run d`',
        '## Slice hypothesis',
        'one',
      ].join('\n'),
    );
    await probe.run({ issue: ISSUE, cwd: home, home, capture, tasks: [{ id: 'T1', command: 'npx vitest run a' }, { id: 'T2', command: 'npx tsc -p x' }, { id: 'T3', command: 'npx tsc -p y' }] });

    const result = await checkPlan({ plan, probe: await probe.read(ISSUE, { home }) });
    const warnings = result.warnings.filter((warning) => warning.check === 'done-when-run').map((warning) => warning.detail);
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /^T2's Done when changed since it was run; the run on record is of `npx tsc -p x`/);
    assert.match(warnings[1], /^T3's Done when exited 2 on .* — last line: error TS6059/);
    assert.match(warnings[2], /^T4's Done when has never been run/);

    // Without a probe record handed in, nothing is said about it either way.
    assert.equal((await checkPlan({ plan })).warnings.some((warning) => warning.check === 'done-when-run'), false);
  });
});
