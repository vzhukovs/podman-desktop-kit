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

// Commands with an issue number work on that issue's tree, not on whichever
// tree the shell is in.
//
// The fixture is DESKTOP-18915 in miniature: the main checkout stands on
// another issue's branch with that issue's change committed, and the issue
// asked about has its own registered worktree beside it. Every assertion about
// a refusal is also an assertion that nothing ran — a refusal that comes after
// the tests is the bug, not the fix.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

import { treeOf } from '../lib/commands/support.js';
import { buildPackageMap } from '../lib/repo.js';
import { forIssue, issueBranches } from '../lib/worktree.js';
import { cleanup, commitAll, git, initRepo, seedWorkspace, sh, writeFiles } from './helpers/repo-fixture.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');

const OURS = 100;
const OTHER = 200;
const OUR_BRANCH = `DESKTOP-${OURS}/fix-quit-race`;
const OTHER_BRANCH = `DESKTOP-${OTHER}/1-fix-reconnect`;

// An issue under review after slicing: the branch the slices were cut from is
// still here, beside the one its pull request is on.
const REVIEWED = 800;
const CUT_FROM = `DESKTOP-${REVIEWED}/before-slicing`;
const UNDER_REVIEW = `DESKTOP-${REVIEWED}/1-under-review`;

let repo;
let trees;
let tree;
let home;

/** Whether a path exists. */
async function present(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** @returns {Promise<{code: number, stdout: string, stderr: string}>} */
async function pdkit(cwd, ...args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, PDKIT_HOME: home },
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

before(async () => {
  repo = await initRepo('pdkit-issue-tree-');
  trees = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-issue-tree-trees-')));
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-issue-tree-home-')));

  await seedWorkspace(repo);
  // typecheck leaves a mark in whichever tree it ran in, which is how "nothing
  // was run" is checked rather than inferred from an exit code.
  const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  manifest.scripts.typecheck = 'node -e "require(\'node:fs\').writeFileSync(\'typecheck-ran.txt\', \'\')"';
  await writeFile(join(repo, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFiles(repo, { '.gitignore': 'typecheck-ran.txt\n' });
  await commitAll(repo, 'chore: seed');

  // Our issue, in its own registered worktree.
  tree = join(trees, `DESKTOP-${OURS}`);
  await git(['worktree', 'add', '-b', OUR_BRANCH, tree, 'main'], repo);
  await writeFiles(tree, { 'packages/main/src/exec.ts': '// SPDX-License-Identifier: Apache-2.0\nexport function exec() { return 1; }\n' });
  await commitAll(tree, 'fix(main): ours');

  // The other issue, checked out in the main checkout — where the shell is.
  await git(['switch', '-c', OTHER_BRANCH], repo);
  await writeFiles(repo, { 'packages/ui/src/registry.ts': '// SPDX-License-Identifier: Apache-2.0\nexport const registry = [];\n' });
  await commitAll(repo, 'fix(ui): theirs');

  await writeFile(
    join(home, 'config.yaml'),
    [`worktrees:`, `  root: ${trees}`, `repo:`, `  package_manager: npm`, ''].join('\n'),
  );
  await buildPackageMap(repo, { home, config: { slicing: { layer_order: ['extension-api', 'main', 'ui', 'tests'] } } });
});

after(async () => {
  await cleanup(repo, trees, home);
});

describe('forIssue', () => {
  test('the issue\'s own worktree is ours', async () => {
    const found = await forIssue({ issue: OURS, cwd: tree });
    assert.equal(found.verdict, 'ours');
    assert.equal(found.here.branch, OUR_BRANCH);
  });

  test('a tree on another issue\'s branch is foreign, and the registered worktree is named', async () => {
    const found = await forIssue({ issue: OURS, cwd: repo });
    assert.equal(found.verdict, 'foreign');
    assert.equal(found.here.issue, OTHER);
    assert.deepEqual(found.home, { source: 'worktree', path: tree, branch: OUR_BRANCH });
  });

  test('a branch checked out nowhere is the next source', async () => {
    await git(['branch', `DESKTOP-300/idle`, 'main'], repo);
    try {
      const found = await forIssue({ issue: 300, cwd: repo });
      assert.equal(found.verdict, 'foreign');
      assert.deepEqual(found.home, { source: 'branch', path: null, branch: 'DESKTOP-300/idle' });
    } finally {
      await git(['branch', '-D', 'DESKTOP-300/idle'], repo);
    }
  });

  test('standing on another issue\'s branch with nothing naming this one is still foreign', async () => {
    const found = await forIssue({ issue: 400, cwd: repo });
    assert.equal(found.verdict, 'foreign');
    assert.equal(found.home, null);
  });

  test('nothing naming the issue, on a branch that names none, is unclaimed', async () => {
    const plain = await initRepo('pdkit-issue-tree-plain-');
    try {
      await writeFiles(plain, { 'a.txt': 'a\n' });
      await commitAll(plain, 'init');
      const found = await forIssue({ issue: 500, cwd: plain });
      assert.equal(found.verdict, 'unclaimed');
    } finally {
      await cleanup(plain);
    }
  });

  test('a tree named for the issue counts only while its branch names no other issue', async () => {
    const detached = join(trees, 'DESKTOP-600');
    await git(['worktree', 'add', '--detach', detached, 'main'], repo);
    try {
      assert.equal((await forIssue({ issue: 600, cwd: detached })).verdict, 'ours');
      await git(['switch', '-c', 'DESKTOP-700/elsewhere'], detached);
      assert.equal((await forIssue({ issue: 600, cwd: detached })).verdict, 'foreign');
    } finally {
      await git(['worktree', 'remove', '--force', detached], repo);
      await git(['branch', '-D', 'DESKTOP-700/elsewhere'], repo);
    }
  });

  // DESKTOP-18915's second failure: the pull request's branch in the main
  // checkout made that checkout the issue's, and the review fixes landed there.
  test('the main checkout on the issue\'s own branch is not the issue\'s tree', async () => {
    const found = await forIssue({ issue: OTHER, cwd: repo });
    assert.equal(found.verdict, 'foreign');
    assert.equal(found.here.main, true);
    assert.deepEqual(found.home, { source: 'checkout', path: repo, branch: OTHER_BRANCH });
  });

  test('a branch the main checkout holds is not "checked out nowhere", from any tree', async () => {
    const found = await forIssue({ issue: OTHER, cwd: tree });
    assert.equal(found.verdict, 'foreign');
    assert.equal(found.here.main, false);
    assert.deepEqual(found.home, { source: 'checkout', path: repo, branch: OTHER_BRANCH });
  });

  test('the unsliced branch comes before slice branches', async () => {
    await git(['branch', `DESKTOP-${OURS}/1-part`, 'main'], repo);
    try {
      assert.deepEqual(await issueBranches(OURS, { cwd: repo }), [OUR_BRANCH, `DESKTOP-${OURS}/1-part`]);
    } finally {
      await git(['branch', '-D', `DESKTOP-${OURS}/1-part`], repo);
    }
  });

  test('an open pull request\'s branch outranks the branch its slices were cut from', async () => {
    await git(['branch', CUT_FROM, 'main'], repo);
    await git(['branch', UNDER_REVIEW, 'main'], repo);
    try {
      // By name alone the pre-slicing branch wins: what the record is for.
      assert.equal((await forIssue({ issue: REVIEWED, cwd: repo })).home?.branch, CUT_FROM);

      const found = await forIssue({ issue: REVIEWED, cwd: repo, recorded: [UNDER_REVIEW] });
      assert.equal(found.verdict, 'foreign');
      assert.deepEqual(found.home, { source: 'branch', path: null, branch: UNDER_REVIEW });
      assert.match(found.reason, /the branch of its open pull request/);
    } finally {
      await git(['branch', '-D', CUT_FROM, UNDER_REVIEW], repo);
    }
  });

  test('a recorded branch that is not here leaves the choice to the names', async () => {
    await git(['branch', CUT_FROM, 'main'], repo);
    try {
      const found = await forIssue({ issue: REVIEWED, cwd: repo, recorded: [UNDER_REVIEW] });
      assert.deepEqual(found.home, { source: 'branch', path: null, branch: CUT_FROM });
    } finally {
      await git(['branch', '-D', CUT_FROM], repo);
    }
  });

  test('a tree on an open pull request\'s branch is the issue\'s, whatever the branch is called', async () => {
    const adopted = join(trees, 'adopted-work');
    await git(['worktree', 'add', '-b', 'fix-adopted', adopted, 'main'], repo);
    try {
      assert.equal((await forIssue({ issue: 900, cwd: adopted })).verdict, 'unclaimed');
      assert.equal((await forIssue({ issue: 900, cwd: adopted, recorded: ['fix-adopted'] })).verdict, 'ours');
      assert.deepEqual((await forIssue({ issue: 900, cwd: repo, recorded: ['fix-adopted'] })).home, {
        source: 'worktree',
        path: adopted,
        branch: 'fix-adopted',
      });
    } finally {
      await git(['worktree', 'remove', '--force', adopted], repo);
      await git(['branch', '-D', 'fix-adopted'], repo);
    }
  });
});

describe('treeOf, for an issue with no tree', () => {
  test('a branch checked out nowhere gets a tree on it, not a new branch', async () => {
    await git(['branch', CUT_FROM, 'main'], repo);
    try {
      const { error } = await treeOf(REVIEWED, { root: repo, config: {} });
      assert.match(error, new RegExp(`its work is on ${CUT_FROM}, checked out nowhere`));
      assert.ok(error.includes(`pdkit worktree create --issue ${REVIEWED} --branch ${CUT_FROM}`), error);
      assert.doesNotMatch(error, /--slug/);
    } finally {
      await git(['branch', '-D', CUT_FROM], repo);
    }
  });

  test('nothing naming the issue still asks for a slug', async () => {
    const { error } = await treeOf(REVIEWED, { root: repo, config: {} });
    assert.match(error, /pdkit worktree create --issue 800 --slug <slug>/);
  });
});

describe('slice suggest from a tree on another issue\'s branch', () => {
  test('refuses, names the tree, and hands back the command to run there', async () => {
    const result = await pdkit(repo, 'slice', 'suggest', '--issue', String(OURS), '--json');

    assert.equal(result.code, 1);
    const said = JSON.parse(result.stdout);
    assert.equal(said.ok, false);
    assert.equal(said.here.branch, OTHER_BRANCH);
    assert.equal(said.home.path, tree);
    assert.equal(said.commands[0], `cd ${sh(tree)} && pdkit slice suggest --issue ${OURS} --json`);
    assert.ok(said.commands.includes(`pdkit slice suggest --issue ${OURS} --json --ref ${OUR_BRANCH}`));
    assert.equal(said.files, undefined, 'no file list is produced from the wrong diff');
  });

  test('without --json the refusal is on stderr, with the same command', async () => {
    const result = await pdkit(repo, 'slice', 'suggest', '--issue', String(OURS));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /this tree is not DESKTOP-100's, so nothing was run/);
    assert.ok(result.stderr.includes(`cd ${sh(tree)} && pdkit slice suggest --issue ${OURS}`));
  });

  test('from the issue\'s worktree it reads that diff, and names the branch beside refName', async () => {
    const result = await pdkit(tree, 'slice', 'suggest', '--issue', String(OURS), '--json');
    assert.equal(result.code, 0, result.stderr);

    const facts = JSON.parse(result.stdout);
    assert.equal(facts.refName, 'HEAD');
    assert.equal(facts.branch, OUR_BRANCH);
    assert.equal(facts.tree, tree);
    assert.deepEqual(
      facts.files.map((file) => file.path),
      ['packages/main/src/exec.ts'],
    );
  });

  test('--worktree reads the named tree from anywhere', async () => {
    const result = await pdkit(repo, 'slice', 'suggest', '--issue', String(OURS), '--worktree', `DESKTOP-${OURS}`, '--json');
    assert.equal(result.code, 0, result.stderr);

    const facts = JSON.parse(result.stdout);
    assert.equal(facts.branch, OUR_BRANCH);
    assert.deepEqual(
      facts.files.map((file) => file.path),
      ['packages/main/src/exec.ts'],
    );
  });

  test('--ref reads the branch without checking it out', async () => {
    const result = await pdkit(repo, 'slice', 'suggest', '--issue', String(OURS), '--ref', OUR_BRANCH, '--json');
    assert.equal(result.code, 0, result.stderr);

    const facts = JSON.parse(result.stdout);
    assert.equal(facts.refName, OUR_BRANCH);
    assert.equal(facts.branch, OUR_BRANCH);
    assert.deepEqual(
      facts.files.map((file) => file.path),
      ['packages/main/src/exec.ts'],
    );
  });

  test('--ref naming another issue\'s branch is refused', async () => {
    const result = await pdkit(tree, 'slice', 'suggest', '--issue', String(OURS), '--ref', OTHER_BRANCH, '--json');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /is issue 200's branch, and this run is for 100/);
  });
});

describe('preflight from a tree on another issue\'s branch', () => {
  test('refuses before a single check runs', async () => {
    const result = await pdkit(repo, 'preflight', String(OURS));

    assert.equal(result.code, 1);
    assert.match(result.stderr, /this tree is not DESKTOP-100's, so nothing was run/);
    assert.ok(result.stderr.includes(`cd ${sh(tree)} && pdkit preflight ${OURS}`));
    assert.equal(await present(join(repo, 'typecheck-ran.txt')), false, 'typecheck ran on the other issue\'s tree');
    assert.equal(await present(join(home, 'issues', String(OURS), 'preflight.json')), false, 'a run was recorded');
  });

  test('--json carries the refusal in the shape preflight already reports', async () => {
    const result = await pdkit(repo, 'preflight', String(OURS), '--json');
    assert.equal(result.code, 1);

    const said = JSON.parse(result.stdout);
    assert.equal(said.ok, false);
    assert.deepEqual(said.results, []);
    assert.equal(said.commands[0], `cd ${sh(tree)} && pdkit preflight ${OURS} --json`);
  });

  test('in the main checkout on the issue\'s own branch it refuses, and moves the branch out', async () => {
    const result = await pdkit(repo, 'preflight', String(OTHER), '--json');
    assert.equal(result.code, 1);

    const said = JSON.parse(result.stdout);
    assert.equal(said.home.source, 'checkout');
    assert.deepEqual(said.commands, [
      `git -C ${sh(repo)} switch main && pdkit worktree create --issue ${OTHER} --branch ${OTHER_BRANCH} && cd ${sh(join(trees, `DESKTOP-${OTHER}`))} && pdkit preflight ${OTHER} --json`,
    ]);
    assert.equal(await present(join(repo, 'typecheck-ran.txt')), false, 'typecheck ran in the main checkout');
  });

  test('from the issue\'s worktree the checks run there', async () => {
    const result = await pdkit(tree, 'preflight', String(OURS), '--only', 'typecheck,branch-name');

    assert.doesNotMatch(result.stderr, /nothing was run/);
    assert.match(result.stdout, /branch-name/);
    assert.equal(await present(join(tree, 'typecheck-ran.txt')), true, 'typecheck did not run in the issue\'s tree');
  });
});

describe('preflight for an issue under review, from the main checkout', () => {
  test('the tree it offers is on the pull request\'s branch', async () => {
    await git(['branch', CUT_FROM, 'main'], repo);
    await git(['branch', UNDER_REVIEW, 'main'], repo);
    const dir = join(home, 'issues', String(REVIEWED));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'prs.json'),
      JSON.stringify({
        issue: REVIEWED,
        prs: [
          { number: 4001, slice: 1, branch: UNDER_REVIEW, state: 'open' },
          { number: 4002, slice: 2, branch: `DESKTOP-${REVIEWED}/2-withdrawn`, state: 'closed' },
        ],
      }),
    );
    try {
      const result = await pdkit(repo, 'preflight', String(REVIEWED), '--json');
      assert.equal(result.code, 1);

      const said = JSON.parse(result.stdout);
      assert.deepEqual(said.home, { source: 'branch', path: null, branch: UNDER_REVIEW });
      assert.deepEqual(said.commands, [
        `pdkit worktree create --issue ${REVIEWED} --branch ${UNDER_REVIEW} && cd ${sh(join(trees, `DESKTOP-${REVIEWED}`))} && pdkit preflight ${REVIEWED} --json`,
      ]);
    } finally {
      await git(['branch', '-D', CUT_FROM, UNDER_REVIEW], repo);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('audit from a tree on another issue\'s branch', () => {
  test('refuses, and offers --ref', async () => {
    const result = await pdkit(repo, 'audit', String(OURS));
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes(`pdkit audit ${OURS} --ref ${OUR_BRANCH}`));
  });
});
