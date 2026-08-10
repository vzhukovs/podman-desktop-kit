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

// Tests for lib/active.js.
//
// The property under test is isolation between working trees. Everything else
// here is bookkeeping; the case that matters is two trees sharing one
// $PDKIT_HOME and not seeing each other's task, because that is the whole
// reason the pointer is not a field on the issue record.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { current, keyFor, list, start, stop } from '../lib/active.js';
import { paths } from '../lib/config.js';
import { read as readJournal } from '../lib/journal.js';

let home;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-active-'));
});

beforeEach(async () => {
  await rm(paths(home).active, { recursive: true, force: true });
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('the pointer', () => {
  test('records what is running and reads it back', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });

    const found = await current({ worktree: '/work/fork', home });
    assert.equal(found.issue, 18248);
    assert.equal(found.taskId, 'T1');
    assert.equal(found.worktree, '/work/fork');
    assert.ok(Date.parse(found.startedAt) > 0);
  });

  test('a tree with nothing running has no pointer', async () => {
    assert.equal(await current({ worktree: '/work/untouched', home }), null);
  });

  test('starting again replaces the pointer rather than adding one', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    await start({ issue: 18248, taskId: 'T2', worktree: '/work/fork', home });

    assert.equal((await current({ worktree: '/work/fork', home })).taskId, 'T2');
    assert.equal((await readdir(paths(home).active)).length, 1);
  });

  test('stop clears it', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });

    const stopped = await stop({ worktree: '/work/fork', home });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.record.taskId, 'T1');
    assert.equal(await current({ worktree: '/work/fork', home }), null);
  });
});

describe('working trees are isolated', () => {
  // The reason this module exists rather than a field on the issue record.
  // Two worktrees on the same issue at different slices is the normal shape of
  // stage 3, and one field could not hold both answers.
  test('two trees on the same issue keep their own task', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/slice-1', home });
    await start({ issue: 18248, taskId: 'T3', worktree: '/work/slice-3', home });

    assert.equal((await current({ worktree: '/work/slice-1', home })).taskId, 'T1');
    assert.equal((await current({ worktree: '/work/slice-3', home })).taskId, 'T3');
  });

  test('stopping one does not stop the other', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/slice-1', home });
    await start({ issue: 18248, taskId: 'T3', worktree: '/work/slice-3', home });

    await stop({ worktree: '/work/slice-1', home });

    assert.equal(await current({ worktree: '/work/slice-1', home }), null);
    assert.equal((await current({ worktree: '/work/slice-3', home })).taskId, 'T3');
  });

  test('keyFor is stable and distinguishes trees', () => {
    assert.equal(keyFor('/work/fork'), keyFor('/work/fork'));
    assert.equal(keyFor('/work/fork'), keyFor('/work/fork/'));
    assert.notEqual(keyFor('/work/fork'), keyFor('/work/other'));
  });
});

describe('unreadable pointers', () => {
  // A corrupt pointer must not block every write in the tree. The audit counts
  // files written outside any Owns set regardless, so a hook that goes quiet
  // is caught later rather than never.
  test('a file that does not parse reads as no active task', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    await writeFile(join(paths(home).active, `${keyFor('/work/fork')}.json`), 'not json');

    assert.equal(await current({ worktree: '/work/fork', home }), null);
  });

  // The file is named after the tree; trusting the name over the contents
  // would apply one tree's ownership rules to another.
  test('a pointer naming a different tree is not honoured', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    await writeFile(
      join(paths(home).active, `${keyFor('/work/fork')}.json`),
      JSON.stringify({ issue: 1, taskId: 'T9', worktree: '/work/elsewhere', startedAt: new Date().toISOString() }),
    );

    assert.equal(await current({ worktree: '/work/fork', home }), null);
  });
});

describe('list and journal', () => {
  test('list reports every tree with something running', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/slice-1', home });
    await start({ issue: 17221, taskId: 'T2', worktree: '/work/other', home });

    const running = await list({ home });
    assert.equal(running.length, 2);
    assert.deepEqual(running.map((entry) => entry.taskId).sort(), ['T1', 'T2']);
  });

  test('start and stop are journalled', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    await stop({ worktree: '/work/fork', home });

    const events = (await readJournal({ issue: 18248 }, { home })).map((entry) => entry.event);
    assert.ok(events.includes('task-start'));
    assert.ok(events.includes('task-stop'));
  });
});
