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

// Tests for lib/checkpoint.js.
//
// What a rollback must never do is lose work or fake history, so those are
// asserted first: a reset branch's tip stays reachable, the artefacts it
// replaces are archived rather than deleted, and a phase that moved the issue
// to another state is refused rather than written back.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import * as active from '../lib/active.js';
import * as checkpoint from '../lib/checkpoint.js';
import { read as readJournal } from '../lib/journal.js';
import { allocateRequirement, read, transition } from '../lib/state.js';
import { cleanup, commitAll, git, initRepo, writeFiles } from './helpers/repo-fixture.js';

const ISSUE = 18833;
const BRANCH = `DESKTOP-${ISSUE}/1-store-image-info-ui`;

let home;
let repo;
const made = [];

const issueFile = (...parts) => join(home, 'issues', String(ISSUE), ...parts);
const head = async (ref) => (await git(['rev-parse', ref], repo)).trim();

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-checkpoint-'));
  repo = await initRepo('pdkit-checkpoint-repo-');
  made.push(home, repo);

  await writeFiles(repo, { 'a.ts': 'one\n' });
  await commitAll(repo, 'chore: base');
  await git(['branch', BRANCH], repo);

  await transition(ISSUE, 'triaged', { home, route: 'standard' });
  await allocateRequirement(ISSUE, { home });
  await writeFile(issueFile('plan.md'), 'plan as approved\n');
});

after(async () => {
  await cleanup(...made);
});

/** What 18833's pr-sync did: commits on the branch, a new branch, an amendment. */
async function wanderOff() {
  await git(['checkout', '-q', BRANCH], repo);
  await writeFiles(repo, { 'a.ts': 'two\n' });
  await commitAll(repo, 'refactor: stacked');
  await git(['checkout', '-q', 'main'], repo);
  await git(['branch', `DESKTOP-${ISSUE}/2-image-check-by-id`], repo);

  await writeFile(issueFile('plan.md'), 'plan with A3 applied\n');
  await mkdir(issueFile('amendments'), { recursive: true });
  await writeFile(issueFile('amendments', 'A3.md'), 'A3\n');
  await allocateRequirement(ISSUE, { home });
}

describe('checkpoint and rollback', () => {
  test('brings back branches, artefacts and the record, and loses nothing', async () => {
    const before = await head(BRANCH);
    const taken = await checkpoint.take({ issue: ISSUE, phase: 'pr-sync', repoRoot: repo, home });
    assert.equal(taken.meta.id, 'C1');

    await wanderOff();
    const wandered = await head(BRANCH);
    const report = await checkpoint.plan({ issue: ISSUE, repoRoot: repo, home });

    assert.equal(report.stateMoved, null);
    assert.deepEqual(report.branches.reset.map((entry) => entry.branch), [BRANCH]);
    assert.deepEqual(report.branches.drop.map((entry) => entry.branch), [`DESKTOP-${ISSUE}/2-image-check-by-id`]);
    assert.deepEqual(report.artefacts.map((entry) => `${entry.change} ${entry.file}`).sort(), ['archived amendments/A3.md', 'reverted plan.md']);

    const outcome = await checkpoint.apply({ issue: ISSUE, plan: report, repoRoot: repo, home });
    assert.equal(outcome.ok, true, outcome.error);

    assert.equal(await head(BRANCH), before);
    assert.equal(await head(outcome.backups[0]), wandered, 'the tip the phase left is still reachable');
    assert.equal(await readFile(issueFile('plan.md'), 'utf8'), 'plan as approved\n');
    assert.equal(await readFile(join(outcome.archived, 'amendments', 'A3.md'), 'utf8'), 'A3\n', 'archived, not deleted');
    assert.equal((await read(ISSUE, { home })).requirements.ids.length, 1, 'the record is back as it was');
    await assert.rejects(head(`refs/heads/DESKTOP-${ISSUE}/2-image-check-by-id`), 'a branch made during the phase is deleted');
    assert.equal(outcome.backups.length, 2, 'and its tip is kept with the reset one');

    const [entry] = await readJournal({ issue: ISSUE, event: checkpoint.EVENTS.rolledBack }, { home });
    assert.match(entry.detail, /^to C1 \(start of pr-sync\)/);
  });

  // No edge goes backwards in the machine, and a rollback must not invent one.
  test('a phase that moved the issue to another state is refused, and nothing moves', async () => {
    await checkpoint.take({ issue: ISSUE, phase: 'pr-sync', repoRoot: repo, home });
    await wanderOff();
    await transition(ISSUE, 'planned', { home });

    const report = await checkpoint.plan({ issue: ISSUE, repoRoot: repo, home });
    assert.deepEqual(report.stateMoved, { from: 'triaged', to: 'planned' });

    const outcome = await checkpoint.apply({ issue: ISSUE, plan: report, repoRoot: repo, home });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /a transition is not undone by rewriting the record/);
    assert.equal(await readFile(issueFile('plan.md'), 'utf8'), 'plan with A3 applied\n');
  });

  test('a branch with uncommitted changes in its tree is refused, by name', async () => {
    await checkpoint.take({ issue: ISSUE, phase: 'pr-sync', repoRoot: repo, home });
    await wanderOff();
    await git(['checkout', '-q', BRANCH], repo);
    await writeFiles(repo, { 'a.ts': 'dirty\n' });

    const report = await checkpoint.plan({ issue: ISSUE, repoRoot: repo, home });

    assert.match(report.branches.refused[0].reason, /uncommitted changes/);
    assert.equal((await checkpoint.apply({ issue: ISSUE, plan: report, repoRoot: repo, home })).ok, false);
  });

  test('an unknown phase is refused, and checkpoints number up', async () => {
    assert.match((await checkpoint.take({ issue: ISSUE, phase: 'whatever', repoRoot: repo, home })).error, /--phase must be one of/);
    await checkpoint.take({ issue: ISSUE, phase: 'exec', repoRoot: repo, home });
    await checkpoint.take({ issue: ISSUE, phase: 'slice', repoRoot: repo, home });

    assert.deepEqual((await checkpoint.list({ issue: ISSUE, home })).map((entry) => entry.id), ['C1', 'C2']);
  });
});

// DESKTOP-19818: exec ran in the main checkout, created a branch there by hand
// and committed T1, with T2 still running when the rollback was wanted. The
// checkpoint, taken first, had no branch and no tree to record.
describe('a phase that worked in the main checkout', () => {
  const HAND = 'DESKTOP-18833';

  // git keeps `DESKTOP-18833` and `DESKTOP-18833/…` apart only by not allowing
  // both, and 19818 had no branch of its own before exec made one.
  beforeEach(async () => {
    await git(['branch', '-D', BRANCH], repo);
  });

  async function strayIntoMain() {
    await git(['switch', '-q', '-c', HAND], repo);
    await writeFiles(repo, { 'a.ts': 'T1\n' });
    await commitAll(repo, 'feat(main): T1');
    await active.start({ issue: ISSUE, taskId: 'T2', worktree: repo, session: null, home });
  }

  test('the branch it named by hand is seen, deleted with its tip kept, and the checkout goes back', async () => {
    await checkpoint.take({ issue: ISSUE, phase: 'exec', repoRoot: repo, home });
    await strayIntoMain();
    const t1 = await head(HAND);

    const report = await checkpoint.plan({ issue: ISSUE, repoRoot: repo, home });
    assert.deepEqual(report.branches.drop.map((entry) => entry.branch), [HAND]);
    assert.deepEqual(report.trees.switchMain && [report.trees.switchMain.from, report.trees.switchMain.to], [HAND, 'main']);
    assert.deepEqual(report.tasks.map((task) => task.taskId), ['T2']);
    assert.match(checkpoint.format(report), /main checkout {2}DESKTOP-18833 -> main/);

    const outcome = await checkpoint.apply({ issue: ISSUE, plan: report, repoRoot: repo, home });
    assert.equal(outcome.ok, true, outcome.error);

    assert.equal((await git(['branch', '--show-current'], repo)).trim(), 'main');
    await assert.rejects(head(`refs/heads/${HAND}`));
    assert.equal(await head(outcome.backups.find((ref) => ref.endsWith(`/${HAND}`))), t1, 'T1 is still reachable');
    assert.equal(await active.current({ worktree: repo, home }), null, 'the running task is stopped');
  });

  test('uncommitted work in the main checkout refuses it, and nothing moves', async () => {
    await checkpoint.take({ issue: ISSUE, phase: 'exec', repoRoot: repo, home });
    await strayIntoMain();
    await writeFiles(repo, { 'a.ts': 'T2 in progress\n' });

    const report = await checkpoint.plan({ issue: ISSUE, repoRoot: repo, home });
    assert.match(report.branches.refused[0].reason, /main checkout .* uncommitted changes/);

    assert.equal((await checkpoint.apply({ issue: ISSUE, plan: report, repoRoot: repo, home })).ok, false);
    assert.equal((await git(['branch', '--show-current'], repo)).trim(), HAND);
    assert.ok(await active.current({ worktree: repo, home }), 'the task is not stopped by a refused rollback');
  });
});

// How exec starts since 0.10.3: the issue's tree first, then the checkpoint.
describe('a phase that worked in the issue\'s tree', () => {
  let tree;
  const SLICE = `DESKTOP-${ISSUE}/2-image-check-by-id`;

  beforeEach(async () => {
    tree = join(dirname(repo), `${basename(repo)}-trees`, `DESKTOP-${ISSUE}`);
    await git(['worktree', 'add', '-q', tree, BRANCH], repo);
  });

  test('the tree stays, and its branch goes back to its base', async () => {
    const base = await head(BRANCH);
    const taken = await checkpoint.take({ issue: ISSUE, phase: 'exec', repoRoot: repo, home });
    assert.deepEqual(taken.meta.trees.map((entry) => [entry.path, entry.branch]), [[await realpathOf(tree), BRANCH]]);
    assert.equal(taken.meta.main.branch, 'main');

    await writeFiles(tree, { 'a.ts': 'T1\n' });
    await commitAll(tree, 'feat(main): T1');

    const report = await checkpoint.plan({ issue: ISSUE, repoRoot: repo, home });
    assert.equal(report.branches.reset[0].tree, await realpathOf(tree));
    assert.equal((await checkpoint.apply({ issue: ISSUE, plan: report, repoRoot: repo, home })).ok, true);

    assert.equal(await head(BRANCH), base);
    assert.equal((await readFile(join(tree, 'a.ts'), 'utf8')), 'one\n', 'the tree is on the base, not just the ref');
  });

  test('a tree the phase created goes with its branch, and one it removed comes back', async () => {
    await checkpoint.take({ issue: ISSUE, phase: 'slice', repoRoot: repo, home });
    const extra = join(dirname(tree), `DESKTOP-${ISSUE}-2`);
    await git(['worktree', 'add', '-q', '-b', SLICE, extra, BRANCH], repo);
    await git(['worktree', 'remove', tree], repo);

    const report = await checkpoint.plan({ issue: ISSUE, repoRoot: repo, home });
    assert.deepEqual(report.trees.remove.map((entry) => entry.branch), [SLICE]);
    assert.deepEqual(report.trees.add.map((entry) => entry.branch), [BRANCH]);
    assert.equal((await checkpoint.apply({ issue: ISSUE, plan: report, repoRoot: repo, home })).ok, true);

    const listed = await git(['worktree', 'list', '--porcelain'], repo);
    assert.match(listed, new RegExp(`branch refs/heads/${BRANCH}`));
    assert.doesNotMatch(listed, /2-image-check-by-id/);
    await assert.rejects(head(`refs/heads/${SLICE}`));
  });

  test('a tree created during the phase with untracked work in it refuses the rollback', async () => {
    await checkpoint.take({ issue: ISSUE, phase: 'slice', repoRoot: repo, home });
    const extra = join(dirname(tree), `DESKTOP-${ISSUE}-2`);
    await git(['worktree', 'add', '-q', '-b', SLICE, extra, BRANCH], repo);
    await writeFiles(extra, { 'notes.txt': 'not committed anywhere\n' });

    const report = await checkpoint.plan({ issue: ISSUE, repoRoot: repo, home });
    assert.match(report.branches.refused[0].reason, /untracked files/);
  });
});

/** git reports trees by their real path, and a temp dir on macOS is a symlink. */
async function realpathOf(path) {
  const { realpath } = await import('node:fs/promises');
  return realpath(path);
}
