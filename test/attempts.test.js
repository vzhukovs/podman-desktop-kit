// SPDX-License-Identifier: Apache-2.0

// Tests for lib/attempts.js.
//
// The mechanism is small and the ways it can be wrong are all the same shape:
// counting something other than failed captures. A count that includes an old
// streak blocks a task that is working; a count that resets on the wrong event
// blocks nothing at all; a count an agent can write is not a count.
//
// So what is pinned here is the arithmetic and its inputs — where the counting
// starts, what ends it, and that the only thing that increments it is a capture
// with a non-zero exit.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_MAX, all, blockedMessage, ceiling, passed, record, status, taskOf, unblock } from '../lib/attempts.js';
import { append } from '../lib/journal.js';

const ISSUE = 18248;
const CONFIG = { exec: { max_attempts: 3 } };

let home;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-attempts-'));
});

beforeEach(async () => {
  await rm(join(home, 'journal'), { recursive: true, force: true });
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

/** @param {string} taskId */
const of = (taskId, config = CONFIG) => status({ issue: ISSUE, taskId, config, home });

/** @param {number} times */
async function fail(times, taskId = 'T1') {
  let last;
  for (let i = 0; i < times; i += 1) {
    last = await record({ issue: ISSUE, taskId, exitCode: 1, config: CONFIG, home });
  }
  return last;
}

describe('what an attempt is', () => {
  test('the task is read off the front of the journal detail', () => {
    assert.equal(taskOf('T1 exit 1'), 'T1');
    assert.equal(taskOf('T12 accepted; agent task agent-7'), 'T12');
    assert.equal(taskOf('slice 2 rebased'), null);
    assert.equal(taskOf(undefined), null);
  });

  test('a failed capture is one attempt, and it records the exit code', async () => {
    const state = await record({ issue: ISSUE, taskId: 'T1', exitCode: 137, config: CONFIG, home });

    assert.equal(state.attempts, 1);
    assert.equal(state.blocked, false);
    assert.deepEqual(state.details, ['T1 exit 137']);
  });

  test('a killed run says so rather than reporting exit null', async () => {
    const state = await record({ issue: ISSUE, taskId: 'T1', exitCode: null, config: CONFIG, home });

    assert.match(state.details[0], /killed/);
  });

  test('attempts belong to their own task', async () => {
    await fail(2, 'T1');
    await fail(1, 'T2');

    assert.equal((await of('T1')).attempts, 2);
    assert.equal((await of('T2')).attempts, 1);
    assert.equal((await of('T3')).attempts, 0);
  });

  test('nothing else in the journal counts', async () => {
    // Everything the plugin writes about a task passes through the same log.
    // Only the capture is evidence that a try happened and did not work.
    await append({ issue: ISSUE, event: 'task-start', detail: 'T1 in /tmp/tree' }, { home });
    await append({ issue: ISSUE, event: 'compact', detail: 'T1 active, issue implemented' }, { home });

    assert.equal((await of('T1')).attempts, 0);
  });
});

describe('the ceiling', () => {
  test('three by default, and the default is the one flow-next uses', () => {
    assert.equal(DEFAULT_MAX, 3);
    assert.equal(ceiling({}), 3);
  });

  test('a task is blocked when it reaches it, not before', async () => {
    assert.equal((await fail(2)).blocked, false);
    assert.equal((await fail(1)).blocked, true);
  });

  test('zero switches blocking off', async () => {
    await fail(5);

    const state = await of('T1', { exec: { max_attempts: 0 } });
    assert.equal(state.attempts, 5);
    assert.equal(state.blocked, false);
  });
});

describe('what makes counting start over', () => {
  test('a green capture ends the streak', async () => {
    await fail(2);
    await passed({ issue: ISSUE, taskId: 'T1', home });

    const state = await of('T1');
    assert.equal(state.attempts, 0);
    assert.ok(state.since, 'the reset point is reported');
  });

  test('failures before a green capture do not add to failures after it', async () => {
    // The question is about now: two in March, then it passed, then one today
    // is one, not three.
    await fail(2);
    await passed({ issue: ISSUE, taskId: 'T1', home });
    await fail(1);

    assert.equal((await of('T1')).attempts, 1);
  });

  test('an unblock ends it too, and the reason is what the journal keeps', async () => {
    await fail(3);
    assert.equal((await of('T1')).blocked, true);

    await unblock({ issue: ISSUE, taskId: 'T1', reason: 'plan amended: A1 splits the fixture', home });

    const state = await of('T1');
    assert.equal(state.attempts, 0);
    assert.equal(state.blocked, false);

    const entry = (await (await import('../lib/journal.js')).read({ issue: ISSUE, event: 'task-unblocked' }, { home })).at(-1);
    assert.match(entry.detail, /plan amended: A1 splits the fixture/);
  });

  test('the acceptance the hook writes resets the same way', async () => {
    // Two writers, one meaning: `pdkit receipt write` records the green run and
    // the completion hook records the acceptance. A duplicate is harmless
    // because the walk stops at the first reset it meets.
    await fail(2);
    await append({ issue: ISSUE, event: 'task-receipt', detail: 'T1 accepted; agent task agent-7' }, { home });

    assert.equal((await of('T1')).attempts, 0);
  });
});

describe('reporting', () => {
  test('all() lists every task that has failed, and only those', async () => {
    await fail(1, 'T2');
    await fail(3, 'T1');
    await append({ issue: ISSUE, event: 'task-start', detail: 'T9 in /tmp/tree' }, { home });

    const report = await all({ issue: ISSUE, config: CONFIG, home });

    assert.deepEqual(
      report.map((entry) => [entry.taskId, entry.attempts, entry.blocked]),
      [
        ['T1', 3, true],
        ['T2', 1, false],
      ],
    );
  });

  test('the refusal names the way out, and the way out needs a sentence', async () => {
    const state = await fail(3);
    const message = blockedMessage({ issue: ISSUE }, state);

    assert.match(message, /pdkit task unblock --issue 18248 --task T1 --reason/);
    assert.match(message, /the plan is wrong rather than the code/);
  });

  test('an issue nobody has tried reports zero rather than failing', async () => {
    assert.deepEqual(await all({ issue: 999, config: CONFIG, home }), []);
    assert.equal((await of('T1')).attempts, 0);
  });
});
