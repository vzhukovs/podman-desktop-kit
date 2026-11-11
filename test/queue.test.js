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

// The order tasks run in and the queue `pdkit task list` prints.
//
// What these protect: an exec session started at T1 when the plan wrote a
// safety-net task first, and a later one ran the reviewer's order differently
// from the way the reviewer wrote it in chat. The order now comes from the plan
// — `After`, then block position, a replacement standing where the task it
// replaced stood — and the queue says which task is next.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { amendmentTaskProblems, checkPlan, parseAmendment, parsePlan, taskOrder } from '../lib/artefacts.js';
import { build } from '../lib/queue.js';

/**
 * A plan with the given task blocks and everything else `plan check` wants.
 *
 * @param {string[]} blocks
 * @returns {string}
 */
function plan(blocks) {
  return [
    '# PLAN: DESKTOP-17000',
    '',
    '- Requirements: R1 (frozen on approval)',
    '- e2e coverage: no — unit tests cover it',
    '- Slice hypothesis: 1 slices',
    '',
    '## Context',
    '- `a.ts:1` — where it lives',
    '',
    '## Tasks',
    ...blocks,
    '',
    '## Slice hypothesis',
    'One slice.',
    '',
    '## Open decisions',
    'none',
    '',
  ].join('\n');
}

/**
 * One task block.
 *
 * @param {string} heading   `T1` or `T5 (replaces T2)`
 * @param {{after?: string, slice?: string, owns?: string, command?: string}} [fields]
 * @returns {string}
 */
function block(heading, fields = {}) {
  const id = heading.split(' ')[0];
  return [
    `### ${heading}: task ${id}`,
    '- Satisfies: R1',
    `- Owns: ${fields.owns ?? `${id.toLowerCase()}.ts`}`,
    `- Done when: \`${fields.command ?? `npx vitest run ${id.toLowerCase()}.spec.ts`}\``,
    ...(fields.after ? [`- After: ${fields.after}`] : []),
    ...(fields.slice ? [`- Slice: ${fields.slice}`] : []),
    '',
  ].join('\n');
}

const ok = { receipt: 'ok' };

describe('the After and Slice fields', () => {
  test('are read off a task block, every T-ID on the line', () => {
    const parsed = parsePlan(plan([block('T1'), block('T2', { after: 'T1 and T1 (its type)', slice: 'S3' })]));
    assert.deepEqual(parsed.tasks[1].after, ['T1']);
    assert.equal(parsed.tasks[1].slice, 'S3');
    assert.deepEqual(parsed.tasks[0].after, []);
    assert.equal(parsed.tasks[0].slice, null);
  });

  test('an em dash or (none) names no task', () => {
    const parsed = parsePlan(plan([block('T1', { after: '—' }), block('T2', { after: '(none)' })]));
    assert.deepEqual(parsed.tasks.map((task) => task.after), [[], []]);
  });
});

describe('taskOrder', () => {
  test('with no After, the order the blocks are written in — T10 first if it is written first', () => {
    const { order } = taskOrder(parsePlan(plan([block('T10'), block('T1'), block('T4')])).tasks);
    assert.deepEqual(order, ['T10', 'T1', 'T4']);
  });

  test('After moves a task behind what it waits for, and nothing else', () => {
    const { order, dependsOn } = taskOrder(parsePlan(plan([block('T1', { after: 'T3' }), block('T2'), block('T3')])).tasks);
    assert.deepEqual(order, ['T2', 'T3', 'T1']);
    assert.deepEqual(dependsOn.get('T1'), ['T3']);
  });

  test('a replacement stands where the task it replaces stood, not at the end where the amendment put it', () => {
    const { order } = taskOrder(parsePlan(plan([block('T1'), block('T2'), block('T9'), block('T5 (replaces T1)')])).tasks);
    assert.deepEqual(order, ['T5', 'T2', 'T9']);
  });

  test('After naming a replaced task means its replacement, through the plan or the record', () => {
    const viaPlan = taskOrder(parsePlan(plan([block('T1'), block('T2', { after: 'T1' }), block('T5 (replaces T1)')])).tasks);
    assert.deepEqual(viaPlan.dependsOn.get('T2'), ['T5']);
    assert.deepEqual(viaPlan.problems, []);

    const viaRecord = taskOrder(parsePlan(plan([block('T1'), block('T2', { after: 'T1' }), block('T5')])).tasks, {
      T1: { replacedBy: ['T5'] },
    });
    assert.deepEqual(viaRecord.dependsOn.get('T2'), ['T5']);
  });

  test('a task withdrawn with no replacement leaves nothing to wait for', () => {
    const { dependsOn, problems } = taskOrder(parsePlan(plan([block('T1'), block('T2', { after: 'T1' })])).tasks, { T1: { replacedBy: [] } });
    assert.deepEqual(dependsOn.get('T2'), []);
    assert.deepEqual(problems, []);
  });

  test('an unknown task, a task waiting on itself, and a loop are problems plan check reports', async () => {
    const text = plan([block('T1', { after: 'T9' }), block('T2', { after: 'T2' }), block('T3', { after: 'T4' }), block('T4', { after: 'T3' })]);
    const result = await checkPlan({ plan: parsePlan(text) });
    const after = result.problems.filter((problem) => problem.check === 'after').map((problem) => problem.detail);
    assert.deepEqual(after, [
      'T1 waits on T9, which the plan does not have',
      'T2 waits on itself',
      'T3, T4 wait on each other through "After" — no order runs them',
    ]);
    assert.equal(result.ok, false);
  });
});

describe('amendmentTaskProblems and After', () => {
  const amended = (blocks) =>
    parseAmendment(['# AMENDMENT A1: DESKTOP-17000', '', '- Status: proposed', '', '## Slices affected', ...blocks, '', '## Why the original plan no longer holds', 'x'].join('\n'));

  test('a new task may wait on a plan task or on another new task', () => {
    const problems = amendmentTaskProblems({ amendment: amended([block('T5 (replaces T1)', { after: 'T2, T6' }), block('T6', { owns: 'six.ts' })]), plan: parsePlan(plan([block('T1'), block('T2')])), requirements: ['R1'] });
    assert.deepEqual(problems, []);
  });

  test('a new task waiting on a task nobody has is refused before approval', () => {
    const problems = amendmentTaskProblems({ amendment: amended([block('T5 (replaces T1)', { after: 'T42' })]), plan: parsePlan(plan([block('T1')])), requirements: ['R1'] });
    assert.deepEqual(problems, ['T5 waits on T42, which the plan does not have']);
  });
});

describe('build: the queue', () => {
  const parsed = () => parsePlan(plan([block('T10'), block('T1'), block('T2', { after: 'T1' }), block('T3'), block('T5 (replaces T3)')]));

  test('the next task is the first one ready in the order, not the lowest number', () => {
    const queue = build({ plan: parsed(), receipts: new Map() });
    assert.equal(queue.next, 'T10');
    assert.deepEqual(
      queue.tasks.map((task) => [task.id, task.status]),
      [
        ['T10', 'ready'],
        ['T1', 'ready'],
        ['T2', 'waiting'],
        ['T5', 'ready'],
        ['T3', 'withdrawn'],
      ],
    );
    assert.deepEqual(queue.tasks.find((task) => task.id === 'T3').replacedBy, ['T5']);
  });

  test('done from a passing receipt; a waiting task frees up when what it waits on is done', () => {
    const queue = build({ plan: parsed(), receipts: new Map([['T10', ok], ['T1', ok]]) });
    assert.equal(queue.tasks.find((task) => task.id === 'T2').status, 'ready');
    assert.equal(queue.next, 'T2');
  });

  test('a failed receipt is not done, and says so', () => {
    const queue = build({ plan: parsed(), receipts: new Map([['T1', { receipt: 'failed', receiptDetail: 'exit 2' }]]) });
    const t1 = queue.tasks.find((task) => task.id === 'T1');
    assert.equal(t1.status, 'ready');
    assert.equal(t1.receiptDetail, 'exit 2');
    assert.deepEqual(queue.tasks.find((task) => task.id === 'T2').waitingOn, ['T1']);
  });

  test('an open stop report wins over a green receipt, and holds back what waits on the task', () => {
    const reports = [{ id: 'T1-1', names: ['T1'], status: 'open' }];
    const queue = build({ plan: parsed(), receipts: new Map([['T10', ok], ['T1', ok]]), reports: /** @type {any} */ (reports) });
    assert.equal(queue.tasks.find((task) => task.id === 'T1').status, 'stopped');
    assert.deepEqual(queue.tasks.find((task) => task.id === 'T1').stops, ['T1-1']);
    assert.equal(queue.tasks.find((task) => task.id === 'T2').status, 'waiting');
    assert.equal(queue.next, 'T5');
  });

  test('a resolved report holds nothing back', () => {
    const reports = [{ id: 'T1-1', names: ['T1'], status: 'resolved' }];
    const queue = build({ plan: parsed(), receipts: new Map([['T1', ok]]), reports: /** @type {any} */ (reports) });
    assert.equal(queue.tasks.find((task) => task.id === 'T1').status, 'done');
  });

  test('running and blocked are said as such, and are not next', () => {
    const queue = build({ plan: parsed(), receipts: new Map(), running: ['T10'], blocked: new Map([['T1', { attempts: 3, max: 3 }]]) });
    assert.equal(queue.tasks.find((task) => task.id === 'T10').status, 'running');
    assert.equal(queue.tasks.find((task) => task.id === 'T1').status, 'blocked');
    assert.equal(queue.next, 'T5');
  });

  test('when everything is done there is no next', () => {
    const queue = build({ plan: parsed(), receipts: new Map(['T10', 'T1', 'T2', 'T5'].map((id) => [id, ok])) });
    assert.equal(queue.next, null);
  });
});
