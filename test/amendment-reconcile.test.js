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

// lib/amendment.js on its own, without bin/pdkit in between.
//
// test/amendment.test.js drives approve, sync and `task start` end to end and
// reads back what they printed and wrote. What it cannot pin down from there is
// the part a command only formats: which decision an outcome line credits, the
// order amendments and task files are read in, and the wording of a withdrawn
// task's refusal. Those are pure, or nearly, and are held here directly.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { amendmentOutcomes, describeSynced, readAmendments, syncTasks, withdrawalFor, withdrawnMessage } from '../lib/amendment.js';
import { transition, withdrawTask } from '../lib/state.js';

const ISSUE = 18915;

/**
 * @param {string} id
 * @param {string} status
 * @returns {{id: string, status: string}}
 */
const amendment = (id, status) => ({ id, status });

/**
 * @param {string} event
 * @param {string} detail
 * @returns {{event: string, detail: string}}
 */
const entry = (event, detail) => ({ event, detail });

describe('amendmentOutcomes', () => {
  test('one line per amendment, with the status off the file', () => {
    assert.deepEqual(amendmentOutcomes([amendment('A1', 'approved'), amendment('A2', 'proposed')], []), ['A1 — approved', 'A2 — proposed']);
  });

  test('the decision entry supplies who decided, and why', () => {
    const entries = [entry('amendment-approved', 'A1 — by vlad'), entry('amendment-rejected', 'A2 — by vlad: not the failing path')];
    assert.deepEqual(amendmentOutcomes([amendment('A1', 'approved'), amendment('A2', 'rejected')], entries), [
      'A1 — approved (by vlad)',
      'A2 — rejected (by vlad: not the failing path)',
    ]);
  });

  test('the status comes from the file even when the journal says otherwise', () => {
    assert.deepEqual(amendmentOutcomes([amendment('A1', 'approved')], [entry('amendment-rejected', 'A1 — by vlad')]), ['A1 — approved (by vlad)']);
  });

  test('the last of two decisions is the one that stands', () => {
    const entries = [entry('amendment-rejected', 'A1 — first'), entry('amendment-approved', 'A1 — second')];
    assert.deepEqual(amendmentOutcomes([amendment('A1', 'approved')], entries), ['A1 — approved (second)']);
  });

  test('an ID inside the free text is not taken for the amendment decided', () => {
    assert.deepEqual(amendmentOutcomes([amendment('A1', 'proposed')], [entry('amendment-approved', 'A2 — supersedes A1')]), ['A1 — proposed']);
  });

  test('other events, and a decision with no free text, add no attribution', () => {
    const entries = [entry('amendment-proposed', 'A1 — awaiting approval'), entry('amendment-approved', 'A2')];
    assert.deepEqual(amendmentOutcomes([amendment('A1', 'proposed'), amendment('A2', 'approved')], entries), ['A1 — proposed', 'A2 — approved']);
  });

  test('a file with no status line says so instead of an empty word', () => {
    assert.deepEqual(amendmentOutcomes([amendment('A1', '')], []), ['A1 — in no recognised status']);
  });
});

describe('describeSynced', () => {
  test('a live task lists what it owns', () => {
    assert.equal(describeSynced({ task: 'T1', owns: ['a.ts', 'b.ts'], withdrawn: null }), 'T1  a.ts, b.ts');
  });

  test('a live task with an empty Owns says so', () => {
    assert.equal(describeSynced({ task: 'T1', owns: [], withdrawn: null }), 'T1  owns nothing');
  });

  test('a withdrawn task names the amendment that withdrew it, when there is one', () => {
    assert.equal(describeSynced({ task: 'T2', owns: [], withdrawn: { amendment: 'A1', replacedBy: ['T5'] } }), 'T2  withdrawn by A1 — owns nothing');
    assert.equal(describeSynced({ task: 'T2', owns: [], withdrawn: { amendment: null, replacedBy: [] } }), 'T2  withdrawn — owns nothing');
  });
});

describe('withdrawnMessage', () => {
  test('names the amendment, its file and the tasks that took the work', () => {
    assert.equal(
      withdrawnMessage('task start', ISSUE, 'T2', { amendment: 'A1', replacedBy: ['T5', 'T6'] }),
      `pdkit task start: T2 of issue ${ISSUE} was withdrawn by A1 (amendments/A1.md) and is not part of the plan. Its work is T5, T6 now.\n`,
    );
  });

  test('a hand-marked withdrawal with no amendment and no replacement says only that', () => {
    assert.equal(
      withdrawnMessage('receipt write', ISSUE, 'T2', { amendment: null, replacedBy: [] }),
      `pdkit receipt write: T2 of issue ${ISSUE} was withdrawn and is not part of the plan.\n`,
    );
  });
});

describe('reading off disk', () => {
  let home;
  const homes = [];
  const issueFile = (...parts) => join(home, 'issues', String(ISSUE), ...parts);

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-amendment-reconcile-'));
    homes.push(home);
    await transition(ISSUE, 'triaged', { home, route: 'standard' });
  });

  after(async () => {
    for (const dir of homes) await rm(dir, { recursive: true, force: true });
  });

  test('readAmendments reads A-files in numeric order and nothing else', async () => {
    await mkdir(issueFile('amendments'), { recursive: true });
    for (const id of ['A10', 'A2', 'A1']) {
      await writeFile(issueFile('amendments', `${id}.md`), `# AMENDMENT ${id}: DESKTOP-${ISSUE}\n\n- Status: proposed\n`);
    }
    await writeFile(issueFile('amendments', 'notes.md'), '# not an amendment\n');

    const found = await readAmendments(ISSUE, home);
    assert.deepEqual(
      found.map((one) => [one.id, one.status, one.path]),
      ['A1', 'A2', 'A10'].map((id) => [id, 'proposed', issueFile('amendments', `${id}.md`)]),
    );
  });

  test('readAmendments with no amendments directory is an empty list', async () => {
    assert.deepEqual(await readAmendments(ISSUE, home), []);
  });

  test('syncTasks with no tasks directory is null, not an empty sync', async () => {
    assert.equal(await syncTasks(ISSUE, home), null);
  });

  test('withdrawalFor: neither the record nor the file says so', async () => {
    assert.equal(await withdrawalFor(ISSUE, 'T2', home), null);
  });

  test('withdrawalFor: the task file alone is enough, before any sync', async () => {
    await mkdir(issueFile('tasks'), { recursive: true });
    await writeFile(issueFile('tasks', 'T2.md'), '# T2: the close handler\n\n- Status: withdrawn by A1 (replaced by T5)\n');
    assert.deepEqual(await withdrawalFor(ISSUE, 'T2', home), { amendment: 'A1', replacedBy: ['T5'] });
  });

  test('withdrawalFor: the record alone is enough, with no file rendered', async () => {
    await withdrawTask(ISSUE, { task: 'T2', amendment: 'A1', replacedBy: ['T5'], home });
    const withdrawal = await withdrawalFor(ISSUE, 'T2', home);
    assert.equal(withdrawal.amendment, 'A1');
    assert.deepEqual(withdrawal.replacedBy, ['T5']);
  });
});
