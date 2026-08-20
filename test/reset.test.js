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

// Tests for lib/reset.js.
//
// The command deletes things, so most of this file is about what it does NOT
// delete. Two of those are promises rather than conveniences — the neighbouring
// issue and the append-only journal — and a regression in either would be found
// by the person it happened to, after it happened, with nothing to restore.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as active from '../lib/active.js';
import { issueDir, paths } from '../lib/config.js';
import { defer, open as openDeferrals } from '../lib/deferrals.js';
import * as gate from '../lib/gate.js';
import { append as appendJournal, read as readJournal } from '../lib/journal.js';
import { register } from '../lib/pr.js';
import { EVENT, apply, belongsTo, collect, format } from '../lib/reset.js';
import { read as readState, transition } from '../lib/state.js';
import { status as attemptStatus } from '../lib/attempts.js';
import { preflightGreen } from './helpers/preflight-evidence.js';

let home;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-reset-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/**
 * An issue with something in every store: a record, artefacts, a pull request,
 * a consent token, an active pointer and journal history.
 *
 * @param {number} issue
 * @returns {Promise<void>}
 */
async function furnish(issue) {
  await transition(issue, 'triaged', { home, route: 'quickfix' });
  await transition(issue, 'quickfix', { home });
  await preflightGreen(issue, { home });
  await transition(issue, 'preflight-green', { home });

  const dir = issueDir(home, issue);
  await mkdir(join(dir, 'receipts'), { recursive: true });
  await writeFile(join(dir, 'research.md'), `scouts for ${issue}\n`);
  await writeFile(join(dir, 'plan.md'), `plan for ${issue}\n`);
  await writeFile(join(dir, 'receipts', 'T1.md'), 'captured\n');

  await register({ issue, number: 1000 + issue, branch: `DESKTOP-${issue}/fix`, home });
  await gate.open({ issue, branch: `DESKTOP-${issue}/fix`, home });
  await active.start({ issue, taskId: 'T1', worktree: join(home, 'trees', String(issue)), home });
}

describe('what a reset finds before it touches anything', () => {
  test('an issue nobody has worked on has nothing to clear', async () => {
    const facts = await collect({ issue: 4242, home });

    assert.equal(facts.state, 'new');
    assert.equal(facts.anything, false);
    assert.equal(facts.dir, null);
    assert.match(format(facts), /nothing to clear/);
  });

  test('the artefacts, tokens, pointers and pull requests are all listed', async () => {
    await furnish(18548);
    const facts = await collect({ issue: 18548, home });

    assert.equal(facts.state, 'preflight-green');
    assert.equal(facts.route, 'quickfix');
    assert.equal(facts.anything, true);
    // preflight.json is in the list because reaching preflight-green now
    // requires it, and a reset that left it behind would hand the next cycle a
    // green run of a diff that no longer exists.
    assert.deepEqual(
      facts.artefacts.sort(),
      ['plan.md', 'preflight.json', 'receipts/ (1)', 'research.md', 'prs.json', 'state.json'].sort(),
    );
    assert.deepEqual(facts.tokens, ['push:DESKTOP-18548/fix']);
    assert.deepEqual(
      facts.active.map((pointer) => pointer.taskId),
      ['T1'],
    );
    assert.deepEqual(facts.openPullRequests, [19548]);
  });

  test('the dry run says the open pull request is not closed by this', async () => {
    await furnish(18548);
    const text = format(await collect({ issue: 18548, home }));

    assert.match(text, /#19548 — OPEN UPSTREAM/);
    assert.match(text, /does not close them/);
  });
});

describe('what a reset removes', () => {
  test('the record is gone, so the machine reads the issue as new again', async () => {
    await furnish(18548);
    await apply({ issue: 18548, home });

    const record = await readState(18548, { home });
    assert.equal(record.state, 'new');
    assert.equal(record.createdAt, null);
    assert.deepEqual(record.history, []);
  });

  test('the artefacts are archived outside issues/, and can be moved back', async () => {
    await furnish(18548);
    const outcome = await apply({ issue: 18548, home });

    assert.equal(outcome.removed, true);
    assert.ok(outcome.archived, 'an archive path is reported');
    assert.ok(!outcome.archived.startsWith(paths(home).issues), 'the archive is not inside issues/');

    // Inside issues/ it would be found by the two commands that resolve an
    // issue by calling Number.parseInt on a directory name.
    assert.deepEqual(await readdir(paths(home).issues), []);
    assert.equal(await readFile(join(outcome.archived, 'plan.md'), 'utf8'), 'plan for 18548\n');
    assert.equal(await readFile(join(outcome.archived, 'receipts', 'T1.md'), 'utf8'), 'captured\n');
  });

  test('--purge leaves no archive', async () => {
    await furnish(18548);
    const outcome = await apply({ issue: 18548, home, purge: true });

    assert.equal(outcome.archived, null);
    assert.equal(outcome.purged, true);
    assert.deepEqual(await readdir(paths(home).archive).catch(() => []), []);
  });

  test('two resets of the same issue do not land on one another', async () => {
    await furnish(18548);
    const first = await apply({ issue: 18548, home });

    await furnish(18548);
    const second = await apply({ issue: 18548, home });

    assert.notEqual(first.archived, second.archived);
    assert.equal(await readFile(join(first.archived, 'plan.md'), 'utf8'), 'plan for 18548\n');
    assert.equal((await readdir(join(paths(home).archive, '18548'))).length, 2);
  });

  test('the consent token goes, so it cannot outlive the record that justified it', async () => {
    await furnish(18548);
    assert.equal((await gate.verify({ branch: 'DESKTOP-18548/fix', home })).valid, true);

    await apply({ issue: 18548, home });

    assert.equal((await gate.verify({ branch: 'DESKTOP-18548/fix', home })).valid, false);
    assert.deepEqual(await gate.issuedFor(18548, { home }), []);
  });

  test('the active pointer goes, so no hook is left holding a task whose file is gone', async () => {
    await furnish(18548);
    const worktree = join(home, 'trees', '18548');
    assert.ok(await active.current({ worktree, home }));

    await apply({ issue: 18548, home });

    assert.equal(await active.current({ worktree, home }), null);
  });
});

describe('what a reset must not touch', () => {
  test('the neighbouring issue keeps its record, its artefacts and its token', async () => {
    await furnish(18548);
    await furnish(18549);

    await apply({ issue: 18548, home, purge: true });

    const neighbour = await readState(18549, { home });
    assert.equal(neighbour.state, 'preflight-green');
    assert.equal(await readFile(join(issueDir(home, 18549), 'plan.md'), 'utf8'), 'plan for 18549\n');
    assert.equal((await gate.verify({ branch: 'DESKTOP-18549/fix', home })).valid, true);
    assert.ok(await active.current({ worktree: join(home, 'trees', '18549'), home }));
  });

  test('the journal keeps every entry, and gains one saying what happened', async () => {
    await furnish(18548);
    const before = await readJournal({ issue: 18548 }, { home });
    assert.ok(before.length > 0);

    await apply({ issue: 18548, home });

    const after = await readJournal({ issue: 18548 }, { home });
    // Every earlier entry survives; `task-stop` and the reset are what is new.
    for (const entry of before) {
      assert.ok(
        after.some((kept) => kept.at === entry.at && kept.event === entry.event && kept.detail === entry.detail),
        `the journal lost ${entry.event}`,
      );
    }

    const written = after.filter((entry) => entry.event === EVENT);
    assert.equal(written.length, 1);
    assert.match(written[0].detail, /was preflight-green \(quickfix\)/);
    assert.match(written[0].detail, /#19548 left open upstream/);
    assert.match(written[0].detail, /record archived to /);
  });

  test('a deferral survives, because a promise to a reviewer is not ours to withdraw', async () => {
    await furnish(18548);
    await defer({ issue: 18548, id: 'D1', what: 'truncate long commands', pr: 19548, raisedBy: 'someone', home });

    await apply({ issue: 18548, home, purge: true });

    const still = await openDeferrals({ issue: 18548, home });
    assert.equal(still.length, 1);
    assert.equal(still[0].id, 'D1');
  });
});

describe('the journal is read differently after a reset', () => {
  test('a task numbered T1 again is not born blocked by the old T1', async () => {
    const config = { exec: { max_attempts: 3 } };
    await furnish(18548);

    for (let n = 0; n < 3; n += 1) {
      await appendJournal({ issue: 18548, event: 'task-attempt', detail: `T1 failed (${n})` }, { home });
    }
    const before = await attemptStatus({ issue: 18548, taskId: 'T1', config, home });
    assert.equal(before.blocked, true);

    await apply({ issue: 18548, home, purge: true });

    const after = await attemptStatus({ issue: 18548, taskId: 'T1', config, home });
    assert.equal(after.attempts, 0);
    assert.equal(after.blocked, false);
  });

  test('failures after the reset still count', async () => {
    const config = { exec: { max_attempts: 3 } };
    await furnish(18548);
    await appendJournal({ issue: 18548, event: 'task-attempt', detail: 'T1 failed (old)' }, { home });

    await apply({ issue: 18548, home, purge: true });
    await appendJournal({ issue: 18548, event: 'task-attempt', detail: 'T1 failed (new)' }, { home });

    const status = await attemptStatus({ issue: 18548, taskId: 'T1', config, home });
    assert.equal(status.attempts, 1);
    assert.deepEqual(status.details, ['T1 failed (new)']);
  });
});

describe('which working trees belong to an issue', () => {
  test('a prefix of another issue number is not a match', () => {
    // The whole promise of the command is that it touches one issue, and
    // `path.includes("DESKTOP-1854")` is true of `.../DESKTOP-18548`.
    assert.equal(belongsTo({ path: '/w/DESKTOP-18548', branch: null, head: null, main: false }, 1854), false);
    assert.equal(belongsTo({ path: '/w/DESKTOP-18548', branch: null, head: null, main: false }, 18548), true);
  });

  test('the detached verification tree is matched by its name', () => {
    assert.equal(belongsTo({ path: '/w/verify-DESKTOP-18548', branch: null, head: null, main: false }, 18548), true);
  });

  test('a tree under any name is matched by the branch it holds', () => {
    assert.equal(belongsTo({ path: '/w/scratch', branch: 'DESKTOP-18548/2-fix', head: null, main: false }, 18548), true);
    assert.equal(belongsTo({ path: '/w/scratch', branch: 'DESKTOP-18549/2-fix', head: null, main: false }, 18548), false);
  });
});
