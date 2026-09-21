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

// What `pdkit close` says happened to the plan.
//
// The facts close collects get read once, by a person, at the moment the issue
// stops existing — so a wrong one is expensive in a way a wrong intermediate
// state is not: nothing downstream ever contradicts it. The amendments line was
// wrong for as long as it existed. It was built from the journal's
// `amendment-proposed` entry and printed its detail verbatim, and that detail is
// fixed at the moment of proposal: "awaiting approval", still, three days after
// somebody approved it. On DESKTOP-18835 the harvest reported two unapproved
// amendments, both of which had been approved.
//
// End to end through bin/pdkit, because the bug was in neither half alone:
// `amendment approve` recorded the decision correctly and `close` read a
// different record of it.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');

const ISSUE = 18835;

/** Everything the template needs and nothing this file is about. */
const VALUES = {
  source: 'review thread on #19001',
  trigger: 'upstream replaced the callback the plan built on',
  rid: 'R4',
  change: 'added',
  detail: 'the registry now reports its own readiness',
  slices: 'slice 2',
  rationale: 'the plan stood on a callback that no longer exists',
  approval: 'pending',
};

let home;
const homes = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-close-'));
  homes.push(home);
  await writeFile(join(home, 'values.json'), JSON.stringify(VALUES));
});

after(async () => {
  for (const dir of homes) await rm(dir, { recursive: true, force: true });
});

/**
 * Run the CLI the way a session does, against this test's own state directory.
 *
 * `cwd` is the state directory rather than the checkout because it is not a git
 * repository: `close` looks for worktrees of the issue, and standing it in a
 * real repository would make the result depend on whose machine is running.
 *
 * @param {...string} args
 * @returns {Promise<string>} stdout
 */
async function pdkit(...args) {
  const { stdout } = await exec(process.execPath, [BIN, ...args], {
    cwd: home,
    env: { ...process.env, PDKIT_HOME: home },
    encoding: 'utf8',
  });
  return stdout;
}

/** Propose one amendment and answer with its ID. */
async function propose() {
  const out = await pdkit('amendment', 'new', '--issue', String(ISSUE), '--values', join(home, 'values.json'), '--json');
  return JSON.parse(out).id;
}

/** The amendments line of the harvest. */
async function harvested() {
  return JSON.parse(await pdkit('close', String(ISSUE), '--json')).amendments;
}

describe('close --json: amendments', () => {
  test('an issue with no amendments harvests none', async () => {
    assert.deepEqual(await harvested(), []);
  });

  test('a proposed amendment says so', async () => {
    assert.equal(await propose(), 'A1');
    assert.deepEqual(await harvested(), ['A1 — proposed']);
  });

  // The bug. Both halves are asserted: that the status is right, and that the
  // sentence which was wrong is gone — a line reading "A1 — approved — awaiting
  // approval" would satisfy the first on its own.
  test('an approved amendment stops saying it is waiting', async () => {
    await propose();
    await pdkit('amendment', 'approve', 'A1', '--issue', String(ISSUE), '--by', 'Vladyslav Zhukovskyi');

    assert.deepEqual(await harvested(), ['A1 — approved (by Vladyslav Zhukovskyi)']);
    assert.doesNotMatch((await harvested()).join('\n'), /awaiting/);
  });

  // Who approved it is the one part of the decision the file does not keep, so
  // it has to come out of the journal or not at all.
  test('an approval with nobody named is still an approval', async () => {
    await propose();
    await pdkit('amendment', 'approve', 'A1', '--issue', String(ISSUE));

    assert.deepEqual(await harvested(), ['A1 — approved']);
  });

  // A rejected amendment leaves nothing behind except its reason, which is why
  // the command demands one — and why the harvest is the wrong place to drop it.
  test('the reason a plan did not move survives into the harvest', async () => {
    await propose();
    await pdkit('amendment', 'reject', 'A1', '--issue', String(ISSUE), '--reason', 'the plan already covered it');

    assert.deepEqual(await harvested(), ['A1 — rejected (the plan already covered it)']);
  });

  test('two amendments on one issue keep their own statuses', async () => {
    await propose();
    await pdkit('amendment', 'approve', 'A1', '--issue', String(ISSUE), '--by', 'a maintainer');
    assert.equal(await propose(), 'A2');

    assert.deepEqual(await harvested(), ['A1 — approved (by a maintainer)', 'A2 — proposed']);
  });

  // The property the status is read off the file for: the file is the artefact
  // a person opens and edits, and the journal has no entry for a hand-edit.
  test('a status settled by hand is read from the file', async () => {
    await propose();
    const path = join(home, 'issues', String(ISSUE), 'amendments', 'A1.md');
    await writeFile(path, (await readFile(path, 'utf8')).replace('- Status: proposed', '- Status: approved'));

    assert.deepEqual(await harvested(), ['A1 — approved']);
  });
});

describe('close: the human output', () => {
  // The harvest is the reason `close` exists, and until now the half of it that
  // said what happened to the plan was reachable only through --json.
  test('says what happened to the plan', async () => {
    await propose();
    await pdkit('amendment', 'approve', 'A1', '--issue', String(ISSUE), '--by', 'a maintainer');

    assert.match(await pdkit('close', String(ISSUE)), /^ {2}amendment: A1 — approved \(by a maintainer\)$/m);
  });

  test('stays quiet about amendments an issue never had', async () => {
    assert.doesNotMatch(await pdkit('close', String(ISSUE)), /amendment/);
  });
});
