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

// Tests for lib/hooks/task-completed.js and lib/hooks/session-start.js.
//
// Both hooks read the same pointer, so they share a fixture. What is asserted
// for the first is that "done" cannot be claimed: the three ways to arrive
// without evidence — no receipt, an edited one, a red one — are each a refusal
// with a different message, because "run this command" and "your tests fail"
// are different problems.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { start, stop } from '../lib/active.js';
import { record as recordAttempt, unblock as unblockTask } from '../lib/attempts.js';
import { issueDir } from '../lib/config.js';
import { writeReceipt } from '../lib/evidence.js';
import { handle as sessionStart } from '../lib/hooks/session-start.js';
import { handle as taskCompleted } from '../lib/hooks/task-completed.js';
import { read as readJournal } from '../lib/journal.js';
import { TRANSITIONS, setOwns, transition } from '../lib/state.js';

const execFileAsync = promisify(execFile);

const ISSUE = 18248;

let home;
// A real repository, because both hooks resolve the working tree by asking
// git which one a directory belongs to.
let WORKTREE;
const savedHome = process.env.PDKIT_HOME;

/** @param {{exitCode?: number, stdout?: string}} [over] */
const run = (over = {}) => ({
  command: 'pnpm test:main -- container-registry.spec.ts',
  exitCode: 0,
  stdout: 'Test Files  1 passed (1)\n',
  stderr: '',
  durationMs: 4210,
  at: '2026-07-31T10:00:00.000Z',
  complete: true,
  ...over,
});

const receiptPath = () => join(issueDir(home, ISSUE), 'receipts', 'T1.md');

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-taskdone-'));
  WORKTREE = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-taskdone-repo-')));
  process.env.PDKIT_HOME = home;

  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: WORKTREE });

  await transition(ISSUE, 'triaged', { home });
  await setOwns(ISSUE, 'T1', ['packages/main/src/plugin/container-registry.ts'], { home });

  await mkdir(join(issueDir(home, ISSUE), 'tasks'), { recursive: true });
  await writeFile(
    join(issueDir(home, ISSUE), 'tasks', 'T1.md'),
    '# T1: join the command arguments\n\n- Issue: 18248\n- Satisfies: R1\n\n## Owns\npackages/main/src/plugin/container-registry.ts\n',
  );
});

beforeEach(async () => {
  await rm(receiptPath(), { force: true });
  await start({ issue: ISSUE, taskId: 'T1', worktree: WORKTREE, home });
});

after(async () => {
  if (savedHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = savedHome;

  for (const dir of [home, WORKTREE]) await rm(dir, { recursive: true, force: true });
});

const complete = () => taskCompleted({ task_id: 'agent-7', cwd: WORKTREE }, { event: 'task-completed', pluginRoot: '' });

describe('completing a task', () => {
  test('a task with no receipt cannot be completed, and the refusal is the command', async () => {
    const decision = await complete();

    assert.equal(decision.block, true);
    assert.match(decision.reason, /there is no receipt/);
    assert.match(decision.reason, /pdkit receipt write --issue 18248 --task T1/);
  });

  test('a task with a genuine passing receipt completes', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });

    const decision = await complete();
    assert.equal(decision.block, false);
    assert.match(decision.message, /T1 has a receipt/);
  });

  test('an edited receipt is refused', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });
    const content = await readFile(receiptPath(), 'utf8');
    await writeFile(receiptPath(), content.replace('1 passed (1)', '9 passed (9)'));

    const decision = await complete();
    assert.equal(decision.block, true);
    assert.match(decision.reason, /edited after it was captured/);
  });

  // The receipt is valid; the run failed. Those are different problems and the
  // message has to say which, or the fix is guessed at.
  test('a genuine receipt for a failing run refuses the completion, not the receipt', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });

    const decision = await complete();
    assert.equal(decision.block, true);
    assert.match(decision.reason, /valid receipt for a command that failed/);
    assert.match(decision.reason, /report it rather than editing/);
  });

  // Twice, "fix it and capture again" is the right advice. The third time it is
  // the advice that built the loop, and the hook has to say something else.
  test('at the ceiling the refusal stops being about the receipt', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) {
      await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    }

    const decision = await complete();
    assert.equal(decision.block, true);
    assert.equal(decision.rule, 'attempts');
    assert.match(decision.reason, /is blocked: 3 failed captures/);
    assert.match(decision.reason, /pdkit task unblock/);
  });

  test('and an unblock puts the ordinary refusal back', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) {
      await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    }
    await unblockTask({ issue: ISSUE, taskId: 'T1', reason: 'plan amended: A1', home });

    const decision = await complete();
    assert.equal(decision.block, true);
    assert.equal(decision.rule, 'receipt');
    assert.match(decision.reason, /valid receipt for a command that failed/);
  });

  test('acceptance is journalled with the agent’s own task id', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });
    await complete();

    const entry = (await readJournal({ issue: ISSUE, event: 'task-receipt' }, { home })).at(-1);
    assert.match(entry.detail, /T1 accepted/);
    assert.match(entry.detail, /agent-7/);
  });

  // Outside a tree that is executing a planned task, this hook has no business
  // holding up anything.
  test('with no active task the event passes through', async () => {
    await stop({ worktree: WORKTREE, home });

    const decision = await complete();
    assert.equal(decision.block, false);
  });
});

describe('re-anchoring', () => {
  const startSession = () => sessionStart({ cwd: WORKTREE }, { event: 'session-start', pluginRoot: '' });

  test('the summary names the issue, the task, its files and where it can go next', async () => {
    const decision = await startSession();

    assert.equal(decision.block, false);
    assert.match(decision.message, /issue 18248 — triaged/);
    assert.match(decision.message, /T1 \(join the command arguments\)/);
    assert.match(decision.message, /packages\/main\/src\/plugin\/container-registry\.ts/);
    // Read from the transition table rather than pinned as a string: this line
    // exists to prove the summary offers the moves the machine allows, and a
    // literal copy of them turns every edge added to section 1 into a failing
    // test about nothing. `answered` was the edge that showed it (0.27).
    assert.match(decision.message, new RegExp(`next {4}: ${TRANSITIONS['triaged'].join(', ')}`));
  });

  test('the journal is summarized, not injected whole', async () => {
    const decision = await startSession();

    assert.match(decision.message, /recent/);
    assert.ok(decision.message.split('\n').length < 20, 'the summary should stay small enough to be worth injecting');
  });

  // A fresh session is exactly where a blocked task gets tried a fourth time:
  // the three failures are in the context that just went away.
  test('a blocked task survives the restart that lost the reason it is blocked', async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    }

    const decision = await startSession();
    assert.match(decision.message, /tried {3}: 3 of 3 failed capture\(s\) — BLOCKED/);
    assert.match(decision.message, /pdkit task unblock/);
  });

  // An empty session should not open with plugin noise: the first thing a user
  // reads sets what they learn to skip.
  test('no active task means no output at all', async () => {
    await stop({ worktree: WORKTREE, home });

    const decision = await startSession();
    assert.equal(decision.block, false);
    assert.equal(decision.message, undefined);
  });
});

describe('before compaction', () => {
  test('the active task is written to the journal rather than injected', async () => {
    const decision = await sessionStart({ cwd: WORKTREE }, { event: 'pre-compact', pluginRoot: '' });

    assert.equal(decision.block, false);
    assert.equal(decision.message, undefined);

    const entry = (await readJournal({ issue: ISSUE, event: 'compact' }, { home })).at(-1);
    assert.match(entry.detail, /T1 active, issue triaged/);
  });
});
