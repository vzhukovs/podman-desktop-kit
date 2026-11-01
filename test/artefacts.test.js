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

// Tests for lib/artefacts.js.
//
// Two halves. The parser has to read back what render.js writes, so the fixture
// is a plan in the shape the template produces rather than a convenient one.
// checkPlan is the mechanical review, and every case here is a failure section
// 4 says gets a plan redone — the point of putting them in code is that a grep
// cannot be talked out of finding them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  addPlanTasks,
  amendmentCoverageProblems,
  amendmentTaskProblems,
  checkPlan,
  parseAmendment,
  parsePlan,
  parseTask,
  requirementRows,
  setAmendmentStatus,
  setPlanRequirements,
  setTaskStatus,
  withdrawalOf,
  withdrawnStatus,
} from '../lib/artefacts.js';

/**
 * A plan in template shape, with the pieces a case needs replaced.
 *
 * @param {{requirements?: string, e2e?: string, tasks?: string, sliceHypothesis?: string, decisions?: string}} [over]
 */
function plan(over = {}) {
  return [
    '# PLAN: DESKTOP-18248',
    '',
    `- Requirements: ${over.requirements ?? 'R1, R2'} (frozen on approval)`,
    `- e2e coverage: ${over.e2e ?? 'no — a one-line fix on a route where e2e is off'}`,
    '- Slice hypothesis: 1 slices',
    '',
    '## Context',
    '<!-- Every point cites file:line. -->',
    '- `packages/main/src/plugin/container-registry.ts:559` — the offending line',
    '',
    '## Frozen interfaces',
    '```ts',
    'none',
    '```',
    '',
    '## Tasks',
    over.tasks ??
      [
        '### T1: join the command arguments',
        '- Satisfies: R1',
        '- Owns: packages/main/src/plugin/container-registry.ts',
        '- Done when: `pnpm test:main -- container-registry.spec.ts`',
        '- Steps:',
        '  1. Replace Command[0] with Command.join(" ")',
        '',
        '### T2: cover it with a test',
        '- Satisfies: R2',
        '- Owns: packages/main/src/plugin/container-registry.spec.ts',
        '- Done when: `pnpm test:main -- container-registry.spec.ts`',
        '- Steps:',
        '  1. Add a case with three arguments',
      ].join('\n'),
    '',
    '## Upstream compliance',
    '- SPDX headers needed: no new files',
    '- Schemas touched: no',
    '- `extension-api.d.ts` touched: no',
    '- Commit scope: main',
    '',
    '## Slice hypothesis',
    over.sliceHypothesis ?? 'One slice: the fix and its test ship together.',
    '',
    '## Open decisions',
    over.decisions ?? 'none',
    '',
  ].join('\n');
}

describe('parsePlan', () => {
  test('reads the header, the tasks and the sections', () => {
    const parsed = parsePlan(plan());

    assert.equal(parsed.issue, 18248);
    assert.deepEqual(parsed.requirements, ['R1', 'R2']);
    assert.match(parsed.e2eCoverage, /^no —/);
    assert.equal(parsed.tasks.length, 2);
    assert.equal(parsed.needsDecision, false);
    assert.match(parsed.sliceHypothesis, /One slice/);
  });

  test('a task carries its ownership, its requirements and its command', () => {
    const [task] = parsePlan(plan()).tasks;

    assert.equal(task.id, 'T1');
    assert.equal(task.title, 'join the command arguments');
    assert.deepEqual(task.satisfies, ['R1']);
    assert.deepEqual(task.owns, ['packages/main/src/plugin/container-registry.ts']);
    assert.equal(task.command, 'pnpm test:main -- container-registry.spec.ts');
  });

  // The guidance in a template is written for whoever fills it in. A parser
  // that read it back would find every rule the comment describes stated as
  // though it had been followed.
  test('template comments are not read as content', () => {
    const parsed = parsePlan(plan({ tasks: '<!-- ### T9: a task that only exists in a comment -->\n### T1: real\n- Satisfies: R1\n- Owns: a.ts\n- Done when: `x`' }));

    assert.deepEqual(parsed.tasks.map((task) => task.id), ['T1']);
  });

  // What `Owns` says when a task writes nothing. Split on its comma, this
  // sentence became two paths that match no file, and every rule downstream
  // read the task as owning two files nobody could find (18835).
  test('an ownership written as prose is no files, not two of them', () => {
    const parsed = parsePlan(
      plan({ tasks: ['### T1: whole-suite gate', '- Satisfies: R1', '- Owns: (none — verification only, writes no files)', '- Done when: `pnpm test`'].join('\n') }),
    );

    assert.deepEqual(parsed.tasks[0].owns, []);
  });

  test('an empty plan parses to an empty plan rather than throwing', () => {
    const parsed = parsePlan('');

    assert.equal(parsed.issue, null);
    assert.deepEqual(parsed.tasks, []);
  });
});

describe('parseTask', () => {
  const file = [
    '# T1: join the command arguments',
    '',
    '- Issue: 18248',
    '- Satisfies: R1',
    '- Status: in progress',
    '- Attempts: 1',
    '',
    '## Owns',
    'packages/main/src/plugin/container-registry.ts',
    'packages/main/src/plugin/container-registry.spec.ts',
    '',
    '## Done when',
    '```bash',
    'pnpm test:main -- container-registry.spec.ts',
    '```',
    'Expected: 1 passed',
    '',
    '## Context',
    'line 559, not 684 as the issue says',
    '',
    '## Steps',
    '1. Replace Command[0]',
    '',
    '## Notes',
    '',
  ].join('\n');

  test('reads the fields the hooks and the receipt writer need', () => {
    const task = parseTask(file);

    assert.equal(task.id, 'T1');
    assert.equal(task.issue, 18248);
    assert.deepEqual(task.satisfies, ['R1']);
    assert.equal(task.command, 'pnpm test:main -- container-registry.spec.ts');
    assert.equal(task.expected, '1 passed');
  });

  // This list is what `pdkit task sync` puts into state.json for the pre-write
  // hook, so the task file is the authority on what a task may write.
  test('the Owns section is a list of paths, one per line', () => {
    assert.deepEqual(parseTask(file).owns, [
      'packages/main/src/plugin/container-registry.ts',
      'packages/main/src/plugin/container-registry.spec.ts',
    ]);
  });

  // The task file is what `pdkit task sync` writes state.json from, so this is
  // where the sentence turned into ownership: `"T8": ["(none — verification
  // only", "writes no files)"]` in the record the pre-write hook reads, and a
  // non-empty list everywhere anything asked (18834 and 18835, both of them).
  test('an Owns section that says none owns nothing, and says so as an empty list', () => {
    const gate = file.replace(/## Owns\n[\s\S]*?\n\n/, '## Owns\n(none — verification only, writes no files)\n\n');

    assert.deepEqual(parseTask(gate).owns, []);
  });

  // Two runs of the same skill wrote this section two ways: bare paths one day,
  // ``- `path` `` bullets the next. The bullet was already stripped and the code
  // span was not, so `task sync` stored entries that match no file — and the
  // pre-write hook refused a write to a file it named as owned in the same
  // breath. Every task, every file, on 18832.
  test('markdown decoration around a path is stripped, bullet and code span alike', () => {
    const decorated = file.replace(
      /## Owns\n[\s\S]*?\n\n/,
      '## Owns\n' +
        '- `packages/main/src/plugin/container-registry.ts`\n' +
        '- `packages/main/src/plugin/container-registry.spec.ts`\n\n',
    );

    assert.deepEqual(parseTask(decorated).owns, [
      'packages/main/src/plugin/container-registry.ts',
      'packages/main/src/plugin/container-registry.spec.ts',
    ]);
  });
});

describe('checkPlan', () => {
  /** @param {object} [over] */
  const check = (over) => checkPlan({ plan: parsePlan(plan(over)) });

  test('a plan that follows the rules passes', async () => {
    const result = await check();

    assert.equal(result.ok, true, JSON.stringify(result.problems));
  });

  // The failure the pre-write hook cannot catch and the whole ownership model
  // depends on: if two tasks claim a file, they cannot run in parallel and the
  // hook will refuse whichever of them writes second.
  test('two tasks claiming the same file is refused', async () => {
    const result = await check({
      tasks: [
        '### T1: one',
        '- Satisfies: R1',
        '- Owns: packages/main/src/plugin/container-registry.ts',
        '- Done when: `pnpm test:main`',
        '',
        '### T2: two',
        '- Satisfies: R2',
        '- Owns: packages/main/src/plugin/container-registry.ts',
        '- Done when: `pnpm test:main`',
      ].join('\n'),
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'exclusive-owns'));
  });

  test('a pattern that swallows another task’s file is refused too', async () => {
    const result = await check({
      tasks: [
        '### T1: one',
        '- Satisfies: R1',
        '- Owns: packages/main/**',
        '- Done when: `pnpm test:main`',
        '',
        '### T2: two',
        '- Satisfies: R2',
        '- Owns: packages/main/src/plugin/container-registry.ts',
        '- Done when: `pnpm test:main`',
      ].join('\n'),
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'exclusive-owns'));
  });

  test('“Done when” written as prose is refused', async () => {
    const result = await check({
      tasks: ['### T1: one', '- Satisfies: R1, R2', '- Owns: a.ts', '- Done when: the dropdown works correctly'].join('\n'),
    });

    assert.equal(result.ok, false);
    const problem = result.problems.find((entry) => entry.check === 'done-when');
    assert.match(problem.detail, /works correctly/);
  });

  test('a requirement with no task is refused', async () => {
    const result = await check({
      tasks: ['### T1: one', '- Satisfies: R1', '- Owns: a.ts', '- Done when: `x`'].join('\n'),
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'coverage' && problem.detail.startsWith('R2')));
  });

  // 18835: T8 was the whole-suite gate, the only task claiming R7, R8 and R15,
  // and it writes nothing by design. The rule it used to break is the one that
  // pushed two runs into writing a sentence where paths go.
  test('a task that owns nothing but runs something is a verification, and passes', async () => {
    const result = await check({
      requirements: 'R1, R2',
      tasks: [
        '### T1: the change itself',
        '- Satisfies: R1',
        '- Owns: packages/main/src/plugin/container-registry.ts',
        '- Done when: `pnpm test:main`',
        '',
        '### T2: whole-suite gate',
        '- Satisfies: R2',
        '- Owns: (none — verification only, writes no files)',
        '- Done when: `pnpm typecheck && pnpm test:unit`',
      ].join('\n'),
    });

    assert.equal(result.ok, true, JSON.stringify(result.problems));
  });

  test('a task with no requirement is refused', async () => {
    const result = await check({
      requirements: 'R1',
      tasks: ['### T1: one', '- Satisfies: R1', '- Owns: a.ts', '- Done when: `x`', '', '### T2: two', '- Owns: b.ts', '- Done when: `y`'].join('\n'),
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'satisfies'));
  });

  // The other half of the pair above: writing nothing is a shape a plan may
  // take, running nothing is not. A task that does neither does nothing.
  test('a task that owns nothing and runs nothing is refused', async () => {
    const result = await check({
      requirements: 'R1',
      tasks: ['### T1: one', '- Satisfies: R1', '- Done when: it looks right'].join('\n'),
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'owns'));
  });

  test('an unanswered decision blocks the plan', async () => {
    const result = await check({ decisions: '[NEEDS DECISION] which theme tokens to reuse' });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'decisions'));
  });

  test('e2e coverage left undecided blocks the plan', async () => {
    const result = await check({ e2e: '' });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'e2e'));
  });

  test('a missing slice hypothesis blocks the plan', async () => {
    const result = await check({ sliceHypothesis: '' });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'slice-hypothesis'));
  });

  // Judgment, not a defect: a task touching four files is a conversation.
  test('more than three files per task is a warning, not a refusal', async () => {
    const result = await check({
      requirements: 'R1',
      tasks: ['### T1: one', '- Satisfies: R1', '- Owns: a.ts, b.ts, c.ts, d.ts', '- Done when: `x`'].join('\n'),
    });

    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.ok(result.warnings.some((warning) => warning.check === 'owns'));
  });

  test('the plan is checked against the allocated requirement set when there is one', async () => {
    const result = await checkPlan({
      plan: parsePlan(plan()),
      record: { requirements: { ids: ['R1', 'R2', 'R3'], frozen: true } },
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.detail.includes('R3')));
  });

  // The freeze flag is not the trigger, and the test above was named as if it
  // were. Freezing happens at plan approval, so a check that waited for it would
  // be inert during the only phase that writes a plan. On 18832 a replan
  // introduced R9 for work moved into scope; had it been written into the plan
  // without `pdkit ids requirement` allocating it, this is what refuses it —
  // before anybody approves, not after.
  test('and against an unfrozen set too, because that is when a plan is written', async () => {
    const invented = await checkPlan({
      plan: parsePlan(plan({ requirements: 'R1, R2, R9' })),
      record: { requirements: { ids: ['R1', 'R2'], frozen: false } },
    });

    assert.equal(invented.ok, false);
    assert.ok(
      invented.problems.some((problem) => problem.check === 'requirements' && problem.detail.includes('R9')),
      JSON.stringify(invented.problems),
    );
  });

  test('a dropped section is reported when the content is given', async () => {
    const withoutContext = plan().replace(/## Context[\s\S]*?\n## Frozen/, '## Frozen');
    const result = await checkPlan({ plan: parsePlan(withoutContext), content: withoutContext });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'sections' && problem.detail.includes('Context')));
  });
});

// An amendment is the one artefact whose status a command has to change after
// the fact. Everything else here is written once and read back; this one records
// a decision that is taken later, by a person, and the file has to agree with it.
describe('parseAmendment', () => {
  const amendment = (status = 'proposed') => `# AMENDMENT A2: DESKTOP-18548

- Raised by: validation finding — local reproduction on macOS     <!-- review thread, upstream drift -->
- Date: 2026-08-06
- Status: ${status}        <!-- proposed | approved | rejected -->

## What changed upstream or in review
The instrumentation fired twice, and both reports are false positives.
`;

  test('reads the id, the issue, what raised it and its status', () => {
    const parsed = parseAmendment(amendment());

    assert.equal(parsed.id, 'A2');
    assert.equal(parsed.issue, 18548);
    assert.equal(parsed.date, '2026-08-06');
    assert.equal(parsed.status, 'proposed');
    assert.match(parsed.source, /validation finding/);
  });

  // The template puts a comment after the value on that line. Reading it as part
  // of the status is how `proposed <!-- proposed | approved | rejected -->`
  // becomes a status nothing matches.
  test('the trailing template comment is not part of the status', () => {
    assert.equal(parseAmendment(amendment('approved')).status, 'approved');
  });

  test('a file that is not an amendment parses to empty rather than throwing', () => {
    const parsed = parseAmendment('# PLAN: DESKTOP-1\n\nnothing here\n');

    assert.equal(parsed.id, '');
    assert.equal(parsed.issue, null);
    assert.equal(parsed.status, '');
  });
});

describe('setAmendmentStatus', () => {
  const amendment = `# AMENDMENT A1: DESKTOP-18548

- Raised by: a reviewer
- Date: 2026-08-06
- Status: proposed        <!-- proposed | approved | rejected -->

## Why the original plan no longer holds
The maintainer runs AdGuard, so the telemetry lines prove nothing.
`;

  test('replaces the status and nothing else', () => {
    const next = setAmendmentStatus(amendment, 'approved');

    assert.equal(parseAmendment(next).status, 'approved');
    // Everything a person wrote by hand is the record. Re-rendering from the
    // template would need values nobody kept, and would drop exactly this.
    assert.match(next, /The maintainer runs AdGuard/);
    assert.match(next, /<!-- proposed \| approved \| rejected -->/);
    assert.equal(next.split('\n').length, amendment.split('\n').length);
  });

  test('a status outside the vocabulary is refused', () => {
    assert.equal(setAmendmentStatus(amendment, 'superseded'), null);
    assert.equal(setAmendmentStatus(amendment, 'APPROVED'), null);
  });

  // Null rather than an appended line: a caller told "written" about a file with
  // no status line would report a decision the file does not carry.
  test('a file with no status line returns null instead of gaining one', () => {
    assert.equal(setAmendmentStatus('# AMENDMENT A1: DESKTOP-1\n\nno status here\n', 'approved'), null);
  });
});

// The table `amendment approve` applies to a frozen requirement set. On 18915 A1
// said R7 and R8 were added and R2, R4, R6 left the set, and nothing read that:
// the record kept R1–R6 for twenty hours. The rows are copied from that file.
describe('parseAmendment: Requirements affected', () => {
  const amendment = (rows) => `# AMENDMENT A1: DESKTOP-18915

- Raised by: validation finding
- Date: 2026-10-18
- Status: proposed        <!-- proposed | approved | rejected -->

## Requirements affected
<!-- New R-IDs continue the existing numbering.
     | R9 | added | in a comment, and not a row | -->

| R-ID | Change | Detail |
|------|--------|--------|
${rows}

## Slices affected
| R99 | added | under the next heading, and not this table's |
`;

  const A1 = [
    '| R7 | added | Once the quit chain has started, no `before-quit` may let the app proceed. |',
    '| R8 | added | Unit tests in index.spec.ts. |',
    '| R2, R6 | withdrawn | Close-handler ordering guarded against H1. IDs are kept, not renumbered. |',
    '| R4 | superseded by R8 | R8 covers the path that failed. |',
    // The trailing empty cell is in the real file.
    '| R1, R3, R5 | unchanged | R5 stands as written except for R7. | |',
  ].join('\n');

  test('reads every row, several IDs to a cell, and nothing outside the section', () => {
    const rows = parseAmendment(amendment(A1)).requirements;

    assert.deepEqual(
      rows.map(({ ids, change, by, problem }) => ({ ids, change, by, problem })),
      [
        { ids: ['R7'], change: 'added', by: null, problem: null },
        { ids: ['R8'], change: 'added', by: null, problem: null },
        { ids: ['R2', 'R6'], change: 'withdrawn', by: null, problem: null },
        { ids: ['R4'], change: 'superseded', by: 'R8', problem: null },
        { ids: ['R1', 'R3', 'R5'], change: 'unchanged', by: null, problem: null },
      ],
    );
    assert.equal(rows[4].detail, 'R5 stands as written except for R7.');
  });

  test('says which line each row is on, comments counted', () => {
    const text = amendment(A1);
    const rows = parseAmendment(text).requirements;

    assert.equal(text.split('\n')[rows[3].line - 1], '| R4 | superseded by R8 | R8 covers the path that failed. |');
  });

  test('every word of the vocabulary, in any case, with code spans', () => {
    const rows = parseAmendment(
      amendment(['| `R1` | Added | x |', '| R2 | WITHDRAWN. | x |', '| R3 | unchanged | x |', '| R4 | replaced by `R1` | x |', '| R5 | Superseded by r1 | x |'].join('\n')),
    ).requirements;

    assert.deepEqual(
      rows.map((row) => [row.ids.join(), row.change, row.by]),
      [
        ['R1', 'added', null],
        ['R2', 'withdrawn', null],
        ['R3', 'unchanged', null],
        ['R4', 'replaced', 'R1'],
        ['R5', 'superseded', 'R1'],
      ],
    );
    assert.ok(rows.every((row) => row.problem === null));
  });

  // Not guessed at. "dropped" probably means withdrawn, and "probably" is not a
  // standard for removing a requirement from a frozen set.
  test('a word outside the vocabulary is returned unrecognized, with what it said', () => {
    const [row] = parseAmendment(amendment('| R2 | dropped | not needed after all |')).requirements;

    assert.equal(row.change, null);
    assert.deepEqual(row.ids, ['R2']);
    assert.equal(row.wrote, 'dropped');
    assert.match(row.problem, /"dropped" is not a change/);
  });

  test('so is "superseded" with nothing to supersede it', () => {
    const [row] = parseAmendment(amendment('| R4 | superseded | by the new tests |')).requirements;

    assert.equal(row.change, null);
    assert.ok(row.problem);
  });

  test('an R-ID cell that is not R-IDs is a problem, not an empty row', () => {
    const rows = parseAmendment(amendment(['| {{rid}} | added | the template, unfilled |', '|  | added | nothing |'].join('\n'))).requirements;

    assert.match(rows[0].problem, /"\{\{rid\}\}" is not an R-ID/);
    assert.match(rows[1].problem, /empty/);
  });

  test('an amendment with no such section has no rows', () => {
    assert.deepEqual(parseAmendment('# AMENDMENT A2: DESKTOP-18548\n\n- Status: proposed\n').requirements, []);
  });

  // The template renders from these, and the parser has to read back exactly
  // what was rendered — or the table gets finished by hand again.
  test('requirementRows round-trips through the parser, pipes and newlines included', () => {
    const rendered = requirementRows([
      { rid: ['R2', 'R6'], change: 'withdrawn', detail: 'a | b\nc' },
      { rid: 'R7', change: 'added', detail: 'new' },
    ]);
    const rows = parseAmendment(amendment(rendered)).requirements;

    assert.deepEqual(rows.map((row) => row.ids), [['R2', 'R6'], ['R7']]);
    assert.equal(rows[0].detail, 'a | b c');
    assert.ok(rows.every((row) => row.problem === null));
  });
});

describe('setPlanRequirements', () => {
  test('rewrites the line to the live set and names the amendments, nothing else', () => {
    const before = plan({ requirements: 'R1, R2' });
    const after = setPlanRequirements(before, ['R1', 'R3'], ['A1']);

    assert.equal(parsePlan(after).requirements.join(), 'R1,R3');
    assert.match(after, /^- Requirements: R1, R3 \(frozen on approval\) \(amended by A1\)$/m);
    assert.equal(after.split('\n').length, before.split('\n').length);
  });

  // `(frozen on approval)` is fixed text of the template, and validateSections
  // reports a plan without it as missing a section.
  test('the plan still has every section its template asks for', async () => {
    const after = setPlanRequirements(plan(), ['R1', 'R2'], ['A1', 'A2']);
    const result = await checkPlan({ plan: parsePlan(after), content: after });

    assert.ok(!result.problems.some((problem) => problem.check === 'sections'), JSON.stringify(result.problems));
  });

  test('a plan with no Requirements line returns null instead of gaining one', () => {
    assert.equal(setPlanRequirements('# PLAN: DESKTOP-1\n', ['R1'], ['A1']), null);
  });
});

// The tasks section of DESKTOP-18915's A1, abridged only in the long lines. The
// shape is the point: free text, two task blocks whose headings carry
// `(replaces …)`, and a heading after them that is not a task.
const A1_TASKS = [
  '# AMENDMENT A1: DESKTOP-18915',
  '',
  '- Raised by: validation finding',
  '- Date: 2026-10-18',
  '- Status: approved        <!-- proposed | approved | rejected -->',
  '',
  '## Requirements affected',
  '| R-ID | Change | Detail |',
  '|------|--------|--------|',
  '| R7 | added | a second before-quit is vetoed |',
  '',
  '## Slices affected',
  'Still 1 slice. T2/T3 (mainWindow.ts, updater.ts) are NOT shipped; they are replaced by:',
  '',
  '### T5 (replaces T2 and T3): the before-quit handler outlives the first quit request',
  '- Satisfies: R1, R7, R8',
  '- Owns: packages/main/src/index.ts, packages/main/src/index.spec.ts',
  '- Done when: `npx vitest run packages/main/src/index.spec.ts && npx eslint packages/main/src/index.ts` -> exit 0; test count = baseline + 4',
  '- Steps:',
  '  1. index.ts (:65-82): replace `app.once(\'before-quit\', ...)` with `app.on(...)`.',
  '  2. index.spec.ts: add the four R8 tests.',
  '',
  "### T6 (replaces T4's gate): whole-change gate, close handler and updater untouched",
  '- Satisfies: R5, R7',
  '- Owns: (none, verification only)',
  '- Done when: `pnpm typecheck:main && echo R5-OK` -> exit 0, last line `R5-OK`',
  '',
  '### Validation (manual, by /pd:validate): rebuild vN-1 with T5 and run 20 attempts.',
  '',
  '## Why the original plan no longer holds',
  '### T9: not a task — outside the section',
  '',
].join('\n');

describe('the tasks of an amendment', () => {
  test('are read from "Slices affected" by the plan parser, with what they replace', () => {
    const amendment = parseAmendment(A1_TASKS);

    assert.deepEqual(
      amendment.tasks.map((task) => [task.id, task.replaces, task.satisfies, task.owns, task.command]),
      [
        ['T5', ['T2', 'T3'], ['R1', 'R7', 'R8'], ['packages/main/src/index.ts', 'packages/main/src/index.spec.ts'], 'npx vitest run packages/main/src/index.spec.ts && npx eslint packages/main/src/index.ts'],
        ['T6', ['T4'], ['R5', 'R7'], [], 'pnpm typecheck:main && echo R5-OK'],
      ],
    );
    assert.equal(amendment.tasks[0].title, 'the before-quit handler outlives the first quit request');
    assert.equal(amendment.tasks[0].steps, "1. index.ts (:65-82): replace `app.once('before-quit', ...)` with `app.on(...)`.\n2. index.spec.ts: add the four R8 tests.");
    assert.deepEqual(amendment.unreadTasks, []);
  });

  test('a heading that starts like a task and is not in the shape is returned, not skipped', () => {
    const amendment = parseAmendment(A1_TASKS.replace('### T6 (replaces T4\'s gate):', '### T6 — replaces T4 —'));

    assert.deepEqual(amendment.tasks.map((task) => task.id), ['T5']);
    assert.equal(amendment.unreadTasks.length, 1);
    assert.match(amendmentTaskProblems({ amendment })[0], /"### T6 — replaces T4 — whole-change gate.*" in "Slices affected" is not a task heading/);
  });

  test('an amendment without the section has no tasks and no problems', () => {
    const amendment = parseAmendment('# AMENDMENT A2: DESKTOP-1\n\n- Status: proposed\n');
    assert.deepEqual([amendment.tasks, amendment.unreadTasks], [[], []]);
  });

  test('problems: no command, a requirement outside the set, a withdrawn task the plan lacks, and a file still owned', () => {
    const plan = parsePlan(
      ['# PLAN: DESKTOP-18915', '', '- Requirements: R1', '', '## Tasks', '### T1: x', '- Satisfies: R1', '- Owns: packages/main/src/index.ts', '- Done when: `true`', '', '### T2: y', '- Satisfies: R1', '- Owns: a.ts', '- Done when: `true`', ''].join('\n'),
    );
    const amendment = parseAmendment(A1_TASKS.replace('- Done when: `pnpm typecheck:main && echo R5-OK` -> exit 0, last line `R5-OK`', '- Done when: the gate passes'));

    const problems = amendmentTaskProblems({ amendment, plan, requirements: ['R1', 'R7', 'R8'] });

    assert.ok(problems.includes('T6 has no executable "Done when": "the gate passes"'), problems.join('\n'));
    assert.ok(problems.includes('T6 satisfies R5, which is not in the requirement set once A1 applies'));
    assert.ok(problems.includes('T3 is withdrawn by A1, and the plan has no T3'));
    assert.ok(problems.some((problem) => /T1 and T5 both claim packages\/main\/src\/index\.ts/.test(problem)), problems.join('\n'));
  });
});

describe('amendmentCoverageProblems', () => {
  const PLAN = parsePlan(
    ['# PLAN: DESKTOP-18833', '', '- Requirements: R1, R2', '', '## Tasks', '### T1: x', '- Satisfies: R1', '- Owns: a.ts', '- Done when: `true`', '', '### T2: y', '- Satisfies: R2', '- Owns: b.ts', '- Done when: `true`', ''].join('\n'),
  );
  const amendment = (tasks) => ({ id: 'A3', tasks, unreadTasks: [], requirements: [] });
  const task = (id, satisfies, replaces = []) => ({ id, title: id, satisfies, owns: [], command: 'true', doneWhen: '`true`', steps: '', replaces, block: '' });

  test('an added requirement with no task is reported', () => {
    assert.deepEqual(amendmentCoverageProblems({ amendment: amendment([]), plan: PLAN, before: ['R1', 'R2'], after: ['R1', 'R2', 'R3'] }), ['R3']);
  });

  test('an added requirement a new task satisfies is not', () => {
    assert.deepEqual(amendmentCoverageProblems({ amendment: amendment([task('T3', ['R3'])]), plan: PLAN, before: ['R1', 'R2'], after: ['R1', 'R2', 'R3'] }), []);
  });

  test('withdrawing the only task behind a requirement orphans it', () => {
    assert.deepEqual(amendmentCoverageProblems({ amendment: amendment([task('T3', ['R1'], ['T2'])]), plan: PLAN, before: ['R1', 'R2'], after: ['R1', 'R2'] }), ['R2']);
  });

  // Not this amendment's doing, so not this amendment's refusal.
  test('a requirement already uncovered before it is left alone', () => {
    assert.deepEqual(amendmentCoverageProblems({ amendment: amendment([]), plan: PLAN, before: ['R1', 'R2', 'R9'], after: ['R1', 'R2', 'R9'] }), []);
  });
});

describe('a plan with replaced tasks', () => {
  const PLAN = [
    '# PLAN: DESKTOP-18915',
    '',
    '- Requirements: R1, R7 (frozen on approval) (amended by A1)',
    '- e2e coverage: no — manual',
    '',
    '## Tasks',
    '### T2: updater marks an update-quit',
    '- Satisfies: R2',
    '- Owns: packages/main/src/plugin/updater.ts',
    '- Done when: `npx vitest run updater.spec.ts`',
    '',
    '### T5 (replaces T2): the before-quit handler outlives the first quit request',
    '- Satisfies: R1, R7',
    '- Owns: packages/main/src/plugin/updater.ts',
    '- Done when: `npx vitest run index.spec.ts`',
    '',
    '## Slice hypothesis',
    'One slice.',
    '',
  ].join('\n');

  test('the replaced task knows what replaced it', () => {
    const tasks = parsePlan(PLAN).tasks;
    assert.deepEqual(tasks.map((task) => [task.id, task.replaces, task.replacedBy]), [['T2', [], 'T5'], ['T5', ['T2'], null]]);
  });

  // On 18915 the hand-copied T5/T6 were not read at all, and plan check said
  // R7 had no task while T2 cited a withdrawn R2.
  test('plan check leaves the replaced task out: no withdrawn requirement cited, no shared file', async () => {
    const result = await checkPlan({ plan: parsePlan(PLAN), record: { requirements: { ids: ['R1', 'R7'], frozen: true } } });
    assert.deepEqual(result.problems, []);
  });

  test('a task the record holds as withdrawn is left out the same way', async () => {
    const plan = parsePlan(PLAN.replace('### T5 (replaces T2):', '### T5:'));
    const without = await checkPlan({ plan, record: { requirements: { ids: ['R1', 'R7'], frozen: true } } });
    assert.ok(without.problems.some((problem) => problem.check === 'exclusive-owns'));

    const withdrawn = await checkPlan({ plan, record: { requirements: { ids: ['R1', 'R7'], frozen: true }, withdrawn: { T2: {} } } });
    assert.deepEqual(withdrawn.problems, []);
  });

  test('addPlanTasks puts the blocks the plan lacks at the end of "## Tasks", and only those', () => {
    const tasks = parseAmendment(A1_TASKS).tasks;
    const result = addPlanTasks(PLAN.replace('### T5 (replaces T2): the before-quit', '### T5 (replaces T2 and T3): the before-quit'), tasks);

    assert.deepEqual(result.added, ['T6']);
    assert.match(result.text, /R5-OK`\n\n## Slice hypothesis/);
    assert.deepEqual(parsePlan(result.text).tasks.map((task) => task.id), ['T2', 'T5', 'T6']);
    assert.deepEqual(addPlanTasks(result.text, tasks).added, []);
    assert.equal(addPlanTasks('# PLAN: DESKTOP-1\n', tasks), null);
  });
});

describe('a withdrawn task file', () => {
  const TASK = ['# T2: updater marks an update-quit', '', '- Issue: 18915', '- Satisfies: R2, R6', '- Status: pending', '- Attempts: 0', '', '## Owns', '- packages/main/src/plugin/updater.ts', ''].join('\n');

  test('the status round-trips through the file, and everything else stays byte for byte', () => {
    const status = withdrawnStatus({ amendment: 'A1', replacedBy: ['T5'] });
    const text = setTaskStatus(TASK, status);

    assert.equal(status, 'withdrawn by A1 (replaced by T5)');
    assert.equal(text, TASK.replace('- Status: pending', '- Status: withdrawn by A1 (replaced by T5)'));
    assert.deepEqual(parseTask(text).withdrawn, { amendment: 'A1', replacedBy: ['T5'] });
    // Still parses as T2 with what it owned: the ID and the record are kept.
    assert.deepEqual([parseTask(text).id, parseTask(text).owns], ['T2', ['packages/main/src/plugin/updater.ts']]);
  });

  test('a live status is not a withdrawal, and a bare "withdrawn" written by hand is one', () => {
    assert.equal(parseTask(TASK).withdrawn, null);
    assert.deepEqual(withdrawalOf('withdrawn'), { amendment: null, replacedBy: [] });
    assert.equal(setTaskStatus('# T2: x\n', 'withdrawn'), null);
  });
});
