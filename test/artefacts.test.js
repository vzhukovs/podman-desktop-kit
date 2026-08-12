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

import { checkPlan, parseAmendment, parsePlan, parseTask, setAmendmentStatus } from '../lib/artefacts.js';

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

  test('a task with no requirement is refused', async () => {
    const result = await check({
      requirements: 'R1',
      tasks: ['### T1: one', '- Satisfies: R1', '- Owns: a.ts', '- Done when: `x`', '', '### T2: two', '- Owns: b.ts', '- Done when: `y`'].join('\n'),
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'satisfies'));
  });

  test('a task owning nothing is refused', async () => {
    const result = await check({
      requirements: 'R1',
      tasks: ['### T1: one', '- Satisfies: R1', '- Done when: `x`'].join('\n'),
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

  // Judgement, not a defect: a task touching four files is a conversation.
  test('more than three files per task is a warning, not a refusal', async () => {
    const result = await check({
      requirements: 'R1',
      tasks: ['### T1: one', '- Satisfies: R1', '- Owns: a.ts, b.ts, c.ts, d.ts', '- Done when: `x`'].join('\n'),
    });

    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.ok(result.warnings.some((warning) => warning.check === 'owns'));
  });

  test('the plan is checked against the frozen requirement set when there is one', async () => {
    const result = await checkPlan({
      plan: parsePlan(plan()),
      record: { requirements: { ids: ['R1', 'R2', 'R3'], frozen: true } },
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.detail.includes('R3')));
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
