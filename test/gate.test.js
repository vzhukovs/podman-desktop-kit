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

// Tests for lib/gate.js.
//
// Every case here is a way consent could be reused when it should not be:
// carried over to another branch, held past its expiry, spent twice, or issued
// before preflight ran. A gate that fails any of them is not a gate, it is a
// confirmation dialog that remembers its answer.
//
// The tests drive the clock through the `now` parameter rather than sleeping,
// so expiry is asserted rather than approximated.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_TTL_MS, close, open, parseDuration, revokeAll, verify } from '../lib/gate.js';
import { paths } from '../lib/config.js';
import { read as readJournal } from '../lib/journal.js';
import { transition } from '../lib/state.js';

let home;

/** Walk an issue to preflight-green, the only state a token is issued from. */
async function readyIssue(issue, { route = 'standard' } = {}) {
  const path =
    route === 'quickfix'
      ? ['triaged', 'quickfix', 'preflight-green']
      : [
          'triaged',
          'planned',
          'plan-approved',
          'implemented',
          'validated',
          'audited',
          'sliced',
          'slices-approved',
          'preflight-green',
        ];

  for (const to of path) {
    const result = await transition(issue, to, { home });
    assert.ok(result.ok, `could not reach ${to}: ${result.error}`);
  }
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-gate-'));
});

beforeEach(async () => {
  await revokeAll({ home });
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('parseDuration', () => {
  test('reads the units the config uses', () => {
    assert.equal(parseDuration('10m'), 600000);
    assert.equal(parseDuration('30s'), 30000);
    assert.equal(parseDuration('1h'), 3600000);
    assert.equal(parseDuration('250ms'), 250);
    assert.equal(parseDuration(1500), 1500);
  });

  test('refuses what it cannot read rather than guessing', () => {
    assert.equal(parseDuration('soon'), null);
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration(undefined), null);
  });
});

describe('issuing', () => {
  test('a token is issued from preflight-green', async () => {
    await readyIssue(1001);
    const result = await open({ issue: 1001, branch: 'DESKTOP-1001/fix-the-thing', home });

    assert.equal(result.ok, true);
    assert.match(result.token, /^[0-9a-f]{32}$/);
    assert.ok(Date.parse(result.expiresAt) > Date.now());
  });

  // The hard rule of section 1. Everything else in the flow is advice by
  // comparison: this is what stops a push that skipped preflight.
  test('no token before preflight-green', async () => {
    await transition(1002, 'triaged', { home });
    const result = await open({ issue: 1002, branch: 'DESKTOP-1002/fix-the-thing', home });

    assert.equal(result.ok, false);
    assert.match(result.error, /triaged/);
    assert.match(result.error, /preflight-green/);
  });

  test('the branch has to belong to the issue', async () => {
    await readyIssue(1003);
    const result = await open({ issue: 1003, branch: 'DESKTOP-999/someone-elses-work', home });

    assert.equal(result.ok, false);
    assert.match(result.error, /belongs to issue 999/);
  });

  test('a branch that is not ours is refused outright', async () => {
    await readyIssue(1004);
    for (const branch of ['main', 'feature/x', 'DESKTOP-1004', '']) {
      const result = await open({ issue: 1004, branch, home });
      assert.equal(result.ok, false, `${branch} should not get a token`);
    }
  });

  test('the slice index is taken from the branch when not given', async () => {
    await readyIssue(1005);
    await open({ issue: 1005, branch: 'DESKTOP-1005/2-main-plumbing', home });

    const checked = await verify({ branch: 'DESKTOP-1005/2-main-plumbing', home });
    assert.equal(checked.record.slice, 2);
  });
});

describe('verifying', () => {
  test('a branch with no token is not valid', async () => {
    const checked = await verify({ branch: 'DESKTOP-1010/nothing-here', home });
    assert.equal(checked.valid, false);
    assert.match(checked.reason, /no consent token/);
  });

  // Consent for slice #1 is not consent for slice #2. One file per branch is
  // what makes this structural rather than a check someone has to remember.
  test('a token does not carry to another branch', async () => {
    await readyIssue(1011);
    await open({ issue: 1011, branch: 'DESKTOP-1011/1-first', home });

    assert.equal((await verify({ branch: 'DESKTOP-1011/1-first', home })).valid, true);
    assert.equal((await verify({ branch: 'DESKTOP-1011/2-second', home })).valid, false);
  });

  test('a token expires', async () => {
    await readyIssue(1012);
    const issued = await open({ issue: 1012, branch: 'DESKTOP-1012/expires', ttlMs: 1000, home });
    const expiry = Date.parse(issued.expiresAt);

    assert.equal((await verify({ branch: 'DESKTOP-1012/expires', home, now: expiry - 1 })).valid, true);
    const after = await verify({ branch: 'DESKTOP-1012/expires', home, now: expiry });
    assert.equal(after.valid, false);
    assert.match(after.reason, /expired/);
  });

  test('a token string that does not match is refused', async () => {
    await readyIssue(1013);
    await open({ issue: 1013, branch: 'DESKTOP-1013/mismatch', home });

    const checked = await verify({ branch: 'DESKTOP-1013/mismatch', token: 'deadbeef', home });
    assert.equal(checked.valid, false);
    assert.match(checked.reason, /does not match/);
  });

  // An unreadable token file is the one case where guessing is tempting and
  // wrong: it must mean "no consent", never "probably fine".
  test('a corrupt token file fails closed', async () => {
    await readyIssue(1014);
    await open({ issue: 1014, branch: 'DESKTOP-1014/corrupt', home });

    const file = join(paths(home).gates, `${encodeURIComponent('push:DESKTOP-1014/corrupt')}.json`);
    await writeFile(file, '{ not json');

    assert.equal((await verify({ branch: 'DESKTOP-1014/corrupt', home })).valid, false);
  });

  test('a token whose stored branch disagrees with its name fails closed', async () => {
    await readyIssue(1015);
    await open({ issue: 1015, branch: 'DESKTOP-1015/tampered', home });

    const file = join(paths(home).gates, `${encodeURIComponent('push:DESKTOP-1015/tampered')}.json`);
    await writeFile(
      file,
      JSON.stringify({
        token: 'x',
        kind: 'push',
        branch: 'DESKTOP-1015/something-else',
        issue: 1015,
        slice: null,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
        spentAt: null,
      }),
    );

    const checked = await verify({ branch: 'DESKTOP-1015/tampered', home });
    assert.equal(checked.valid, false);
    assert.match(checked.reason, /names DESKTOP-1015\/something-else/);
  });
});

describe('spending', () => {
  test('one token, one push', async () => {
    await readyIssue(1020);
    await open({ issue: 1020, branch: 'DESKTOP-1020/spend-once', home });

    assert.equal((await close('DESKTOP-1020/spend-once', { home })).ok, true);

    const second = await close('DESKTOP-1020/spend-once', { home });
    assert.equal(second.ok, false);
    assert.match(second.error, /already spent/);

    assert.equal((await verify({ branch: 'DESKTOP-1020/spend-once', home })).valid, false);
  });

  test('spending a branch that has no token fails', async () => {
    const result = await close('DESKTOP-1021/never-issued', { home });
    assert.equal(result.ok, false);
  });

  test('an expired token cannot be spent', async () => {
    await readyIssue(1022);
    const issued = await open({ issue: 1022, branch: 'DESKTOP-1022/stale', ttlMs: 1000, home });

    const result = await close('DESKTOP-1022/stale', { home, now: Date.parse(issued.expiresAt) + 1 });
    assert.equal(result.ok, false);
    assert.match(result.error, /expired/);
  });
});

describe('revoking', () => {
  // A token that survives a crash into the next session undoes the TTL: the
  // whole point is that consent cannot be accumulated.
  test('revokeAll drops every outstanding token and reports how many', async () => {
    await readyIssue(1030);
    await open({ issue: 1030, branch: 'DESKTOP-1030/1-one', home });
    await open({ issue: 1030, branch: 'DESKTOP-1030/2-two', home });

    assert.equal(await revokeAll({ home }), 2);
    assert.equal((await verify({ branch: 'DESKTOP-1030/1-one', home })).valid, false);
    assert.equal((await readdir(paths(home).gates)).filter((f) => f.endsWith('.json')).length, 0);
  });

  test('revoking nothing is not an error', async () => {
    assert.equal(await revokeAll({ home }), 0);
  });
});

describe('the journal', () => {
  test('issuing and spending are both recorded', async () => {
    await readyIssue(1040);
    await open({ issue: 1040, branch: 'DESKTOP-1040/journalled', home });
    await close('DESKTOP-1040/journalled', { home });

    const events = (await readJournal({ issue: 1040 }, { home })).map((entry) => entry.event);
    assert.ok(events.includes('gate-open'), 'gate-open was not journalled');
    assert.ok(events.includes('gate-spent'), 'gate-spent was not journalled');
  });
});

describe('kinds of write', () => {
  /** Walk an issue to a state where a pull request exists to reply on. */
  async function openedPr(issue) {
    await readyIssue(issue);
    await transition(issue, 'pr-open', { home });
  }

  // The finding that made kinds necessary: replying to a review thread is a
  // write to someone else's repository, it belongs to no branch, and the issue
  // is in review rather than preflight-green when it happens. Before this there
  // was no token that could be issued for it at all.
  test('a reply token is issued for a pull request, from a review state', async () => {
    await openedPr(1050);

    const issued = await open({ issue: 1050, pr: 17577, kind: 'reply', home });
    assert.equal(issued.ok, true, issued.error);
    assert.equal(issued.kind, 'reply');

    assert.equal((await verify({ pr: 17577, kind: 'reply', home })).valid, true);
  });

  test('a reply token is not a push token, in either direction', async () => {
    await openedPr(1051);
    await open({ issue: 1051, pr: 17577, kind: 'reply', home });

    // The branch key and the pull request key cannot collide, so a reply token
    // can never stand in for consent to publish code.
    const asPush = await verify({ branch: 'DESKTOP-1051/whatever', home });
    assert.equal(asPush.valid, false);
    assert.match(asPush.reason, /no consent token for push/);
  });

  test('a push token cannot be issued from a review state, and a reply token cannot be issued before preflight', async () => {
    await openedPr(1052);

    const push = await open({ issue: 1052, branch: 'DESKTOP-1052/late', kind: 'push', home });
    assert.equal(push.ok, false);
    assert.match(push.error, /push token is only issued from preflight-green/);

    await readyIssue(1053);
    const reply = await open({ issue: 1053, pr: 2871, kind: 'reply', home });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /reply token is only issued from pr-open, review-in-progress, merged/);
  });

  // A reviewer asking a question a week after the merge is an ordinary
  // continuation of the same conversation, and the gate used to refuse it — the
  // failure section 6 names for the tracker rules, except here there is no route
  // saying a human posts it instead.
  test('a reply token is issued after the pull request has merged', async () => {
    await openedPr(1058);
    await transition(1058, 'merged', { home, reason: 'the pull request landed' });

    const reply = await open({ issue: 1058, pr: 18561, kind: 'reply', home });
    assert.equal(reply.ok, true, reply.error);

    // And it still authorises only a sentence. Keys of different kinds are not
    // found for one another, which is the hole stage 4 closed.
    assert.equal((await verify({ pr: 18561, kind: 'reply', home })).valid, true);
    assert.equal((await verify({ branch: 'DESKTOP-1058/x', kind: 'push', home })).valid, false);
  });

  test('a token for one pull request does not cover another', async () => {
    await openedPr(1054);
    await open({ issue: 1054, pr: 17577, kind: 'reply', home });

    assert.equal((await verify({ pr: 17578, kind: 'reply', home })).valid, false);
  });

  test('a reply token needs a pull request number, and says so', async () => {
    await openedPr(1055);

    const issued = await open({ issue: 1055, kind: 'reply', home });
    assert.equal(issued.ok, false);
    assert.match(issued.error, /needs --pr/);
  });

  // The batch, not the thread, is the unit of consent: a human reads eight
  // drafted replies in one go, and a token per thread would mean confirming
  // eight times. It still expires with the TTL.
  test('a reply token covers the batch it was shown for, until it is spent or expires', async () => {
    await openedPr(1056);
    const issued = await open({ issue: 1056, pr: 17577, kind: 'reply', home });

    assert.equal((await verify({ pr: 17577, kind: 'reply', token: issued.token, home })).valid, true);
    assert.equal((await verify({ pr: 17577, kind: 'reply', token: issued.token, home })).valid, true);

    assert.equal((await close({ pr: 17577, kind: 'reply' }, { home })).ok, true);
    assert.equal((await verify({ pr: 17577, kind: 'reply', home })).valid, false);
  });

  test('a kind nobody defined is refused rather than treated as a push', async () => {
    await openedPr(1057);

    const issued = await open({ issue: 1057, pr: 1, kind: 'merge', home });
    assert.equal(issued.ok, false);
    assert.match(issued.error, /not a kind of write/);
  });
});
