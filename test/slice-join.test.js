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

// Contract for multi-commit slices and for joining slices that are already out.
//
// DESKTOP-19818 shipped three pull requests that only worked together, and the
// reviewer asked for one pull request with three commits. These tests walk
// that path: a published graph is joined, the joined slice keeps the commits
// and the subjects its parts were published under, records which pull
// requests it replaces, and is materialized as one branch with one commit per
// part. What it refuses is the case where review moved a branch away from the
// change set, because joining from the change set would drop that work.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';

import { cleanup, commitAll, git, initRepo, packageMap, seedWorkspace, writeFiles } from './helpers/repo-fixture.js';
import * as slice from '../lib/slice.js';
import * as state from '../lib/state.js';

const ISSUE = 4545;
const EXEC = 'packages/main/src/exec.ts';
const THEME = 'packages/ui/src/theme.ts';
const SPEC = 'tests/playwright/theme.spec.ts';

const CONFIG = {
  repo: { base_branch: 'main', package_manager: 'npm' },
  branches: { single: 'DESKTOP-{issue}/{slug}', sliced: 'DESKTOP-{issue}/{index}-{slug}' },
  slicing: { strategy: 'prefer-independent', max_files_per_slice: 12, layer_order: ['main', 'ui', 'tests'], verify: { worktree: 'reuse', install: 'never' } },
  worktrees: { root: null, copy_files: [] },
};

let repo;
let home;
let trees;
const config = () => ({ ...CONFIG, worktrees: { ...CONFIG.worktrees, root: trees } });
const facts = () => slice.facts({ issue: ISSUE, repoRoot: repo, home, config: config(), packageMap: packageMap(repo), ref: `DESKTOP-${ISSUE}/theme-by-layer` });

before(async () => {
  repo = await initRepo('pdkit-join-');
  home = await initRepo('pdkit-join-home-');
  trees = join(repo, '..', `${basename(repo)}-trees`);

  await seedWorkspace(repo);
  await commitAll(repo, 'chore: seed');

  await git(['checkout', '-b', `DESKTOP-${ISSUE}/theme-by-layer`], repo);
  await writeFiles(repo, {
    [EXEC]: '// SPDX-License-Identifier: Apache-2.0\nexport function exec(theme: string) { return theme; }\n',
    [THEME]: '// SPDX-License-Identifier: Apache-2.0\nexport const theme = "dark";\n',
    [SPEC]: '// SPDX-License-Identifier: Apache-2.0\n// dark theme smoke test\n',
  });
  await commitAll(repo, 'feat: the whole change set');

  for (const to of ['triaged', 'planned', 'plan-approved', 'implemented', 'validated', 'audited']) await state.transition(ISSUE, to, { home });

  const set = await slice.set({
    issue: ISSUE,
    config: config(),
    home,
    facts: await facts(),
    proposal: {
      slices: [
        { slug: 'main-exec', title: 'exec takes a theme', files: [EXEC] },
        { slug: 'ui-theme', title: 'dark theme', files: [THEME] },
        { slug: 'tests-theme', title: 'theme smoke test', files: [SPEC] },
      ],
    },
  });
  assert.equal(set.ok, true, JSON.stringify(set.problems));

  await state.transition(ISSUE, 'sliced', { home });
  await state.transition(ISSUE, 'slices-approved', { home, approvedBy: 'the owner' });

  for (const [index, subject] of [
    [1, 'refactor(main): exec takes a theme'],
    [2, 'feat(ui): dark theme'],
  ]) {
    const made = await slice.materialize({ issue: ISSUE, index, repoRoot: repo, subject, home, config: config() });
    assert.equal(made.ok, true, made.error);
    await git(['checkout', `DESKTOP-${ISSUE}/theme-by-layer`], repo);
  }

  // As though all three had been opened: the numbers are what a join replaces.
  for (const [index, pr] of [
    [1, 501],
    [2, 502],
    [3, 503],
  ]) {
    await slice.setPullRequest({ issue: ISSUE, index, pr, home });
  }
  await state.transition(ISSUE, 'preflight-green', { home });
  await state.transition(ISSUE, 'pr-open', { home });
});

after(async () => {
  await cleanup(repo, home, trees);
});

describe('commits in a proposal', () => {
  const build = (commits) =>
    slice.build({
      issue: ISSUE,
      config: CONFIG,
      facts: { files: [EXEC, THEME].map((path) => ({ path, layer: 'other', requirements: [] })), requirements: [], route: 'quickfix', base: 'main', ref: 'x' },
      proposal: { slices: [{ slug: 'all', title: 'all', files: [EXEC, THEME], commits }] },
    });

  test('a partition of the slice is stored, in order', () => {
    const result = build([
      { subject: 'refactor(main): exec takes a theme', files: [EXEC] },
      { subject: 'feat(ui): dark theme', files: [THEME] },
    ]);

    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.graph.slices[0].commits.map((commit) => commit.subject), ['refactor(main): exec takes a theme', 'feat(ui): dark theme']);
  });

  test('a commit per layer answers the spanning-layers warning; a mixed commit does not', () => {
    const layered = slice.build({
      issue: ISSUE,
      config: CONFIG,
      facts: {
        files: [
          { path: EXEC, layer: 'main', requirements: [] },
          { path: THEME, layer: 'ui', requirements: [] },
        ],
        requirements: [],
        route: 'quickfix',
        base: 'main',
        ref: 'x',
      },
      proposal: {
        slices: [
          {
            slug: 'all',
            title: 'all',
            files: [EXEC, THEME],
            commits: [
              { subject: 'refactor(main): exec takes a theme', files: [EXEC] },
              { subject: 'feat(ui): dark theme', files: [THEME] },
            ],
          },
        ],
      },
    });
    assert.equal(layered.warnings.filter((warning) => warning.check === 'layers').length, 0);

    const mixed = slice.build({
      issue: ISSUE,
      config: CONFIG,
      facts: { files: [{ path: EXEC, layer: 'main', requirements: [] }, { path: THEME, layer: 'ui', requirements: [] }], requirements: [], route: 'quickfix', base: 'main', ref: 'x' },
      proposal: { slices: [{ slug: 'all', title: 'all', files: [EXEC, THEME] }] },
    });
    assert.match(mixed.warnings.find((warning) => warning.check === 'layers').detail, /give it a commit per layer/);
  });

  test('a file in two commits, a file in none and a subject upstream rejects are each refused', () => {
    const problems = build([
      { subject: 'refactor(main): exec', files: [EXEC] },
      { subject: 'changed the theme', files: [EXEC] },
    ]).problems.map((problem) => problem.detail);

    assert.ok(problems.some((detail) => /is in commits 1 and 2/.test(detail)));
    assert.ok(problems.some((detail) => /files in no commit: packages\/ui\/src\/theme\.ts/.test(detail)));
    assert.ok(problems.some((detail) => /not a conventional commit subject/.test(detail)));
  });
});

describe('joinSlices', () => {
  test('refuses a slice with no branch to take its subject from', async () => {
    const result = await slice.joinSlices({ issue: ISSUE, indexes: [2, 3], repoRoot: repo, facts: await facts(), home, config: config() });

    assert.equal(result.ok, false);
    assert.match(result.problems[0].detail, /slice #3 has no branch/);
  });

  test('refuses a branch review moved away from the change set, and says how to bring it back', async () => {
    const branch = `DESKTOP-${ISSUE}/2-ui-theme`;
    await git(['checkout', branch], repo);
    await writeFiles(repo, { [THEME]: '// SPDX-License-Identifier: Apache-2.0\nexport const theme = "darker";\n' });
    await commitAll(repo, 'fix(ui): address review');
    await git(['checkout', `DESKTOP-${ISSUE}/theme-by-layer`], repo);

    const result = await slice.joinSlices({ issue: ISSUE, indexes: [1, 2], repoRoot: repo, facts: await facts(), home, config: config() });

    assert.equal(result.ok, false);
    const drift = result.problems.find((problem) => problem.check === 'drift');
    assert.match(drift.detail, /packages\/ui\/src\/theme\.ts on DESKTOP-4545\/2-ui-theme is not what the change set has/);
    assert.match(drift.detail, /git checkout DESKTOP-4545\/2-ui-theme -- packages\/ui\/src\/theme\.ts/);

    // Brought back the way it says, the join can go ahead.
    await git(['checkout', branch, '--', THEME], repo);
    await commitAll(repo, 'fix(ui): bring the review fix back');
  });

  test('joins into one slice with a commit per part, under the subjects they were published with', async () => {
    const result = await slice.joinSlices({ issue: ISSUE, indexes: [1, 2], repoRoot: repo, facts: await facts(), home, config: config() });

    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const [joined, rest] = result.graph.slices;

    assert.equal(result.graph.slices.length, 2);
    assert.equal(joined.slug, 'theme-by-layer');
    assert.deepEqual(joined.files, [EXEC, THEME].sort());
    assert.deepEqual(joined.commits, [
      { subject: 'refactor(main): exec takes a theme', files: [EXEC] },
      { subject: 'feat(ui): dark theme', files: [THEME] },
    ]);
    assert.deepEqual(joined.supersedes, [501, 502]);
    assert.equal(joined.pr, null);
    assert.equal(joined.verification, null);
  });

  // The slice that moved from #3 to #2 is still the one whose pull request is
  // open. Matched by index it would have taken #502's number; with a new
  // branch name, /pd:pr would open a second pull request for it.
  test('a published slice the join renumbers keeps its pull request and its branch', async () => {
    const graph = await slice.read(ISSUE, { home });
    const moved = graph.slices.find((entry) => entry.slug === 'tests-theme');

    assert.equal(moved.index, 2);
    assert.equal(moved.pr, 503);
    assert.equal(moved.branch, `DESKTOP-${ISSUE}/3-tests-theme`);
  });

  test('the graph says what it replaces and what each commit is', async () => {
    const text = slice.format(await slice.read(ISSUE, { home }));

    assert.match(text, /commit 1 {2}refactor\(main\): exec takes a theme/);
    assert.match(text, /replaces #501, #502/);
  });
});

describe('a joined slice, materialized', () => {
  before(async () => {
    const refused = await state.transition(ISSUE, 'sliced', { home });
    assert.equal(refused.ok, false, 'a re-cut without a reason is refused');

    const recut = await state.transition(ISSUE, 'sliced', { home, reason: 'review asked for one pull request with a commit per layer' });
    assert.equal(recut.ok, true, recut.error);
    await state.transition(ISSUE, 'slices-approved', { home, approvedBy: 'the owner' });
  });

  test('is one branch with one commit per part, each signed off, in order', async () => {
    const made = await slice.materialize({ issue: ISSUE, index: 1, repoRoot: repo, home, config: config() });
    assert.equal(made.ok, true, made.error);
    assert.equal(made.commits, 2);

    const branch = `DESKTOP-${ISSUE}/1-theme-by-layer`;
    const subjects = (await git(['log', '--reverse', '--format=%s', `main..${branch}`], repo)).split('\n');
    assert.deepEqual(subjects, ['refactor(main): exec takes a theme', 'feat(ui): dark theme']);

    const first = await git(['show', '--name-only', '--format=%B', `${branch}~1`], repo);
    assert.match(first, /^Signed-off-by: /m);
    assert.match(first, new RegExp(EXEC.replaceAll('/', '\\/')));
    assert.doesNotMatch(first, /theme\.ts\n/);

    await git(['checkout', `DESKTOP-${ISSUE}/theme-by-layer`], repo);
  });

  test('each intermediate commit can be built and recorded, beside the slice and not instead of it', async () => {
    const result = await slice.verifyCommits({ issue: ISSUE, index: 1, repoRoot: repo, home, config: config(), packageMap: packageMap(repo) });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].subject, 'refactor(main): exec takes a theme');
    assert.equal(result.checks[0].evidence, 'verify/S1-c1.md');

    const stored = (await slice.read(ISSUE, { home })).slices[0];
    assert.equal(stored.commitChecks.length, 1);
    assert.equal(stored.verification, null, 'the slice itself is still unverified: a commit check is not a verification');
  });

  test('a one-commit slice has nothing to check commit by commit', async () => {
    const result = await slice.verifyCommits({ issue: ISSUE, index: 2, repoRoot: repo, home, config: config() });
    assert.equal(result.ok, false);
    assert.match(result.error, /is one commit/);
  });
});
