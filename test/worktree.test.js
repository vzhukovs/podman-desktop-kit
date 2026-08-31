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

// Contract for lib/worktree.js.
//
// Two properties carry weight here and neither is about convenience:
//
//   removal must not lose commits — a worktree holding an unmerged branch takes
//   the branch with it, and nothing afterwards says it happened;
//
//   prepare must leave a tree that contains the base and nothing else, with the
//   single exception of node_modules. A standalone verification that passed
//   because of a leftover file from the previous slice is a false green, and
//   false greens are the only kind of failure this whole design cannot survive.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanup, commitAll, git, initRepo, seedWorkspace, writeFiles } from './helpers/repo-fixture.js';
import { create, list, prepare, remove, rootFor, verifyName } from '../lib/worktree.js';
import { read as readJournal } from '../lib/journal.js';

let repo;
let home;
let trees;

/** package_manager: echo turns "install" into a command that exists everywhere. */
const CONFIG = {
  repo: { base_branch: 'main', package_manager: 'echo' },
  worktrees: { enabled: true, root: null, copy_files: ['.env', '.env.local'] },
  slicing: { verify: { worktree: 'reuse', install: 'on-lockfile-change' } },
};

/** @returns {object} the config with worktrees.root pointing beside the fixture */
function config() {
  return { ...CONFIG, worktrees: { ...CONFIG.worktrees, root: trees } };
}

before(async () => {
  repo = await initRepo('pdkit-worktree-');
  home = await initRepo('pdkit-worktree-home-');
  trees = join(repo, '..', `${repo.split('/').pop()}-trees`);

  await seedWorkspace(repo);
  await writeFiles(repo, { '.env': 'SECRET=1\n' });
  await writeFile(join(repo, '.gitignore'), '.env\nnode_modules/\n');
  await commitAll(repo, 'chore: seed');
});

after(async () => {
  await cleanup(repo, home, trees);
});

describe('create', () => {
  test('makes a detached tree at the configured root and copies the extras', async () => {
    const result = await create({ repoRoot: repo, name: 'wt-basic', config: config(), home });

    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.path, join(await rootFor({ repoRoot: repo, config: config() }), 'wt-basic'));
    assert.deepEqual(result.copied, ['.env']);

    await access(join(result.path, '.env'));
    assert.equal(await readFile(join(result.path, 'packages/main/src/exec.ts'), 'utf8'), await readFile(join(repo, 'packages/main/src/exec.ts'), 'utf8'));
  });

  // The tree the work actually happens in is the one that needs a branch, and
  // finding that out at preflight costs an amend: by then there are commits on a
  // detached HEAD and the gate is the next step. Found on DESKTOP-18778 that way.
  test('starts on the branch it is given, and says so in the journal', async () => {
    const result = await create({
      repoRoot: repo,
      name: 'wt-on-branch',
      branch: 'DESKTOP-18778/wrap-long-details-values',
      issue: 18778,
      config: config(),
      home,
    });

    assert.equal(result.ok, true);

    assert.equal(await git(['rev-parse', '--abbrev-ref', 'HEAD'], result.path), 'DESKTOP-18778/wrap-long-details-values');

    const [entry] = (await readJournal({ issue: 18778 }, { home })).filter((line) => line.event === 'worktree-create');
    assert.match(entry.detail, /on DESKTOP-18778\/wrap-long-details-values/);
  });

  // Asked for a branch that is already there, check it out. `-b` creates, and
  // creating one twice is a fatal from git — which is what somebody rebasing
  // work already under review got on DESKTOP-18832, having named the only
  // branch the issue had.
  test('a branch that already exists is checked out, not created again', async () => {
    await git(['branch', 'DESKTOP-18781/already-here', 'main'], repo);

    const result = await create({ repoRoot: repo, name: 'wt-existing', branch: 'DESKTOP-18781/already-here', issue: 18781, config: config(), home });

    assert.equal(result.ok, true, result.error);
    assert.equal(await git(['rev-parse', '--abbrev-ref', 'HEAD'], result.path), 'DESKTOP-18781/already-here');

    const [entry] = (await readJournal({ issue: 18781 }, { home })).filter((line) => line.event === 'worktree-create');
    assert.match(entry.detail, /on DESKTOP-18781\/already-here \(existing\)/, 'the journal says it was adopted, not cut');
  });

  // Detached stays available: looking around before naming the work is a
  // legitimate thing to want, so this reports rather than refuses. What changed
  // is that the journal says which it was.
  test('a tree with no branch is recorded as detached', async () => {
    await create({ repoRoot: repo, name: 'wt-detached', issue: 18779, config: config(), home });

    const [entry] = (await readJournal({ issue: 18779 }, { home })).filter((line) => line.event === 'worktree-create');
    assert.match(entry.detail, /\(detached\)/);
  });

  // Re-running a flow after fixing something is the normal case. A command that
  // only works once gets worked around rather than used.
  test('adopts a tree that is already there instead of failing', async () => {
    const again = await create({ repoRoot: repo, name: 'wt-basic', config: config(), home });

    assert.equal(again.ok, true);
    assert.equal(again.created, false);
  });

  // git reports trees with symlinks resolved and the configured root usually is
  // not. Comparing the strings makes an existing tree invisible, and the next
  // `worktree add` fails with "already exists" for a tree just declared absent.
  // Found by running the CLI, not by this suite — the fixtures resolve their
  // own paths, so both sides used to agree by accident.
  test('finds a tree again through a symlinked root', async () => {
    const real = await create({ repoRoot: repo, name: 'wt-symlink', config: config(), home });
    assert.equal(real.created, true);

    const link = join(repo, '..', 'trees-by-another-name');
    await rm(link, { recursive: true, force: true });
    await symlink(trees, link);

    const viaLink = await create({
      repoRoot: repo,
      name: 'wt-symlink',
      config: { ...CONFIG, worktrees: { ...CONFIG.worktrees, root: link } },
      home,
    });

    assert.equal(viaLink.ok, true, viaLink.error);
    assert.equal(viaLink.created, false, 'the same tree, reached by another name');
    await rm(link, { force: true });
  });

  test('reports git errors rather than swallowing them', async () => {
    const result = await create({ repoRoot: repo, name: 'wt-nonsense', ref: 'refs/heads/does-not-exist', config: config(), home });

    assert.equal(result.ok, false);
    assert.match(result.error, /does-not-exist/);
  });
});

describe('list', () => {
  test('reports the main tree first and marks it', async () => {
    const trees = await list(repo);

    assert.equal(trees[0].path, repo);
    assert.equal(trees[0].main, true);
    assert.equal(trees[0].branch, 'main');
  });

  test('a detached tree has no branch', async () => {
    const entry = (await list(repo)).find((tree) => tree.path.endsWith('wt-basic'));

    assert.ok(entry);
    assert.equal(entry.branch, null);
    assert.equal(entry.main, false);
    assert.match(entry.head, /^[0-9a-f]{40}$/);
  });
});

describe('remove', () => {
  test('refuses while the tree holds a branch that has not landed', async () => {
    await create({ repoRoot: repo, name: 'wt-branch', branch: 'DESKTOP-1/work', config: config(), home });
    await writeFiles(join(trees, 'wt-branch'), { 'packages/ui/src/theme.ts': 'export const theme = "dark";\n' });
    await commitAll(join(trees, 'wt-branch'), 'feat(ui): dark');

    const refused = await remove({ repoRoot: repo, name: 'wt-branch', config: config(), home });

    assert.equal(refused.ok, false);
    assert.match(refused.error, /not an ancestor of main and has no merged pull request recorded/);
    // And it is still there: a refusal that removed the tree anyway would be
    // the worst of both.
    assert.ok((await list(repo)).some((tree) => tree.path.endsWith('wt-branch')));
  });

  // The other half of "landed", and the only one that works upstream: a
  // squash-merged branch is never an ancestor of the base, so ancestry can
  // never say yes about one. On DESKTOP-18832 `close --finish` reported one
  // merged pull request and then kept the worktree it had just finished with.
  test('a branch whose pull request landed is removable without --force', async () => {
    await create({ repoRoot: repo, name: 'wt-landed', branch: 'DESKTOP-2/shipped', config: config(), home });
    await writeFiles(join(trees, 'wt-landed'), { 'packages/ui/src/shipped.ts': 'export const shipped = true;\n' });
    await commitAll(join(trees, 'wt-landed'), 'feat(ui): shipped');

    const removed = await remove({ repoRoot: repo, name: 'wt-landed', landed: true, issue: 2, config: config(), home });

    assert.equal(removed.ok, true, removed.error);
    assert.equal(removed.removed, true);
    assert.equal(
      (await list(repo)).some((tree) => tree.path.endsWith('wt-landed')),
      false,
    );
  });

  test('--force removes it, and says so in the journal', async () => {
    const forced = await remove({ repoRoot: repo, name: 'wt-branch', force: true, issue: 1, config: config(), home });

    assert.equal(forced.ok, true);
    assert.equal(forced.removed, true);
    assert.equal((await list(repo)).some((tree) => tree.path.endsWith('wt-branch')), false);

    const journal = await readFile(join(home, 'journal', `${new Date().toISOString().slice(0, 7)}.md`), 'utf8');
    assert.match(journal, /event:worktree-remove\s+wt-branch \(DESKTOP-1\/work\)/);
  });

  test('a merged branch goes without a fight', async () => {
    await create({ repoRoot: repo, name: 'wt-merged', branch: 'merged-already', config: config(), home });

    const result = await remove({ repoRoot: repo, name: 'wt-merged', config: config(), home });
    assert.equal(result.ok, true);
  });

  test('removing what is not there is not an error', async () => {
    const result = await remove({ repoRoot: repo, name: 'wt-never-existed', config: config(), home });

    assert.equal(result.ok, true);
    assert.equal(result.removed, false);
  });
});

describe('prepare', () => {
  const name = verifyName(4242);
  let path;

  test('creates the tree at the base and installs once', async () => {
    const result = await prepare({ repoRoot: repo, name, base: 'main', issue: 4242, config: config(), home });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.installed, true);
    path = result.path;

    assert.match(await readFile(join(path, 'node_modules/.pdkit-install'), 'utf8'), /^pnpm-lock\.yaml:19:lockfileVersion: 1\n$/);
  });

  test('the second run installs nothing, because the lockfile did not move', async () => {
    const result = await prepare({ repoRoot: repo, name, base: 'main', issue: 4242, config: config(), home });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.installed, false);
  });

  // The whole reason the tree is reused rather than recreated.
  test('resets and cleans, and node_modules survives it', async () => {
    await mkdir(join(path, 'node_modules', 'left-alone'), { recursive: true });
    await writeFile(join(path, 'node_modules', 'left-alone', 'index.js'), 'module.exports = 1;\n');
    // Two kinds of debris the previous slice could leave: a tracked file edited
    // and an untracked file no commit contains.
    await writeFile(join(path, 'packages/ui/src/theme.ts'), 'export const theme = "leftover";\n');
    await writeFile(join(path, 'packages/ui/src/stray.ts'), 'export const stray = true;\n');

    const result = await prepare({ repoRoot: repo, name, base: 'main', config: config(), home });
    assert.equal(result.ok, true, result.error);

    assert.equal(
      await readFile(join(path, 'packages/ui/src/theme.ts'), 'utf8'),
      '// SPDX-License-Identifier: Apache-2.0\nexport const theme = "light";\n',
    );
    await assert.rejects(access(join(path, 'packages/ui/src/stray.ts')));
    assert.equal(await readFile(join(path, 'node_modules/left-alone/index.js'), 'utf8'), 'module.exports = 1;\n');
  });

  test('the extras clean took away are copied back', async () => {
    await access(join(path, '.env'));
  });

  test('a moved lockfile installs again', async () => {
    await writeFile(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 2\nchanged: true\n');
    await commitAll(repo, 'chore: bump the lockfile');

    const result = await prepare({ repoRoot: repo, name, base: 'main', config: config(), home });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.installed, true);
  });

  test('install: never skips it whatever the lockfile says', async () => {
    await writeFile(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 3\n');
    await commitAll(repo, 'chore: bump again');

    const never = { ...config(), slicing: { verify: { install: 'never' } } };
    const result = await prepare({ repoRoot: repo, name, base: 'main', config: never, home });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.installed, false);
  });

  // The build a fresh tree needs before anything in it can be checked. Runs
  // after every clean rather than after every install: the output is untracked,
  // so `clean -fdx` takes it each time.
  test('prepare scripts run, and only the ones the repository defines', async () => {
    const withPrepare = {
      ...config(),
      repo: { base_branch: 'main', package_manager: 'npm' },
      slicing: { verify: { install: 'never', prepare: ['build:marker', 'build:does-not-exist'] } },
    };

    const result = await prepare({ repoRoot: repo, name, base: 'main', config: withPrepare, home });

    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.prepared, ['build:marker']);
    assert.equal(await readFile(join(path, 'built-marker.txt'), 'utf8'), 'built\n');
  });

  test('a prepare script that fails stops the tree from being used', async () => {
    const broken = {
      ...config(),
      repo: { base_branch: 'main', package_manager: 'npm' },
      slicing: { verify: { install: 'never', prepare: ['build:broken'] } },
    };

    const result = await prepare({ repoRoot: repo, name, base: 'main', config: broken, home });

    assert.equal(result.ok, false);
    assert.match(result.error, /cannot verify anything in this state/);
  });

  test('a failing install is reported, not passed over', async () => {
    const broken = {
      ...config(),
      repo: { base_branch: 'main', package_manager: 'exit 7 #' },
      slicing: { verify: { install: 'always' } },
    };

    const result = await prepare({ repoRoot: repo, name, base: 'main', config: broken, home });

    assert.equal(result.ok, false);
    assert.match(result.error, /exit 7/);
  });
});
