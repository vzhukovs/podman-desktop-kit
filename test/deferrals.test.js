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

// Tests for lib/deferrals.js.
//
// The property worth asserting here has no runtime symptom, which is why it is
// the first test in the file: a deferral has to survive the issue reaching a
// terminal state. That is the entire reason the record lives in the append-only
// journal rather than on the issue, and if it ever stopped being true the
// failure would look like nothing at all — a promise made to a reviewer, and an
// issue that closed quietly without it.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defer, deferredEntry, list, open, settle } from '../lib/deferrals.js';
import { transition } from '../lib/state.js';
import { preflightGreen } from './helpers/preflight-evidence.js';

const ISSUE = 18248;

let home;
const homes = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-deferrals-'));
  homes.push(home);
});

after(async () => {
  for (const dir of homes) await rm(dir, { recursive: true, force: true });
});

describe('deferredEntry', () => {
  test('what was set aside is required', () => {
    const composed = deferredEntry({ id: 'D1', what: '   ' });

    assert.equal(composed.ok, false);
    assert.match(composed.error, /--what/);
  });

  test('an unallocated id is refused', () => {
    assert.equal(deferredEntry({ id: 'D', what: 'x' }).ok, false);
    assert.equal(deferredEntry({ id: '1', what: 'x' }).ok, false);
  });

  // A deferral raised at planning has no reviewer and no pull request, and
  // requiring them would make the command useless in half the cases it is for.
  test('the reviewer and the pull request are optional', () => {
    const bare = deferredEntry({ id: 'D1', what: 'the renderer needs an ellipsis' });

    assert.equal(bare.ok, true);
    assert.equal(bare.detail, 'D1 — the renderer needs an ellipsis');
  });

  test('where it came from is carried when there is a where', () => {
    const composed = deferredEntry({ id: 'D1', what: 'the renderer needs an ellipsis', pr: 18561, raisedBy: 'simonrey1', url: 'https://x/1' });

    assert.match(composed.detail, /^D1 — the renderer needs an ellipsis \(simonrey1, #18561\) https:\/\/x\/1$/);
  });
});

describe('list and open', () => {
  test('a deferral is open until something settles it', async () => {
    await defer({ issue: ISSUE, id: 'D1', what: 'the renderer needs an ellipsis', pr: 18561, raisedBy: 'simonrey1', home });

    const [entry] = await list({ issue: ISSUE, home });
    assert.equal(entry.id, 'D1');
    assert.equal(entry.status, 'open');
    assert.equal(entry.followUp, null);
    assert.equal(entry.what, 'the renderer needs an ellipsis');
    assert.equal(entry.raisedBy, 'simonrey1');
    assert.equal(entry.pr, 18561);

    assert.equal((await open({ issue: ISSUE, home })).length, 1);
  });

  test('resolving records the issue that took it on', async () => {
    await defer({ issue: ISSUE, id: 'D1', what: 'x', home });
    await settle({ issue: ISSUE, id: 'D1', followUp: 18604, home });

    const [entry] = await list({ issue: ISSUE, home });
    assert.equal(entry.status, 'resolved');
    assert.equal(entry.followUp, 18604);
    assert.deepEqual(await open({ issue: ISSUE, home }), []);
  });

  test('dropping records why, and why is required', async () => {
    await defer({ issue: ISSUE, id: 'D1', what: 'x', home });

    const refused = await settle({ issue: ISSUE, id: 'D1', home });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /--reason/);

    await settle({ issue: ISSUE, id: 'D1', reason: 'asks about a path the fix removed', home });
    const [entry] = await list({ issue: ISSUE, home });

    assert.equal(entry.status, 'dropped');
    assert.equal(entry.outcome, 'asks about a path the fix removed');
  });

  test('several deferrals on one issue keep their own identities', async () => {
    await defer({ issue: ISSUE, id: 'D1', what: 'first', home });
    await defer({ issue: ISSUE, id: 'D2', what: 'second', home });
    await settle({ issue: ISSUE, id: 'D1', followUp: 18604, home });

    const found = await list({ issue: ISSUE, home });
    assert.deepEqual(found.map((entry) => `${entry.id}:${entry.status}`), ['D1:resolved', 'D2:open']);
  });

  test('an unknown or already settled deferral is refused, not settled twice', async () => {
    await defer({ issue: ISSUE, id: 'D1', what: 'x', home });
    await settle({ issue: ISSUE, id: 'D1', followUp: 18604, home });

    assert.match((await settle({ issue: ISSUE, id: 'D9', followUp: 1, home })).error, /has no D9/);
    assert.match((await settle({ issue: ISSUE, id: 'D1', followUp: 2, home })).error, /already resolved/);
  });

  test('the deferrals of one issue are not the deferrals of another', async () => {
    await defer({ issue: ISSUE, id: 'D1', what: 'ours', home });
    await defer({ issue: 17221, id: 'D1', what: 'theirs', home });

    const [entry] = await list({ issue: ISSUE, home });
    assert.equal(entry.what, 'ours');
  });
});

// The reason the record is a journal entry and not a field on the issue. An
// issue that reaches `merged` is finished, and a promise made to a reviewer is
// not — so the promise has to be stored somewhere the terminal state cannot
// erase, and read back afterwards by a command that still answers.
describe('a deferral outlives the issue', () => {
  test('it is still listed after the issue is closed as merged', async () => {
    await transition(ISSUE, 'triaged', { home, reason: 'seed' });
    await defer({ issue: ISSUE, id: 'D1', what: 'the renderer needs an ellipsis', pr: 18561, home });

    // The path an issue actually takes to merged does not matter here; what
    // matters is that it is terminal when it arrives.
    await transition(ISSUE, 'quickfix', { home, reason: 'seed' });
    await preflightGreen(ISSUE, { home });
    await transition(ISSUE, 'preflight-green', { home, reason: 'seed' });
    await transition(ISSUE, 'pr-open', { home, reason: 'seed' });
    await transition(ISSUE, 'merged', { home, reason: 'seed' });

    const outstanding = await open({ issue: ISSUE, home });
    assert.equal(outstanding.length, 1, 'the deferral did not survive the terminal state');
    assert.equal(outstanding[0].id, 'D1');
  });
});
