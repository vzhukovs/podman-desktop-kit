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

// pdkit pr diff: what a push would change on an open pull request.
//
// The fixture is PR #19750's second round in miniature: the commit under review
// on GitHub, the same commit amended locally with the fix moved into a new file
// the slice does not list. The head is passed in rather than read from GitHub,
// which is the one part of pending() these tests do not exercise.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { issueDir } from '../lib/config.js';
import { pending } from '../lib/pr.js';
import { cleanup, commitAll, git, initRepo, writeFiles } from './helpers/repo-fixture.js';

const ISSUE = 18915;
const PR = 19750;
const BRANCH = `DESKTOP-${ISSUE}/1-quit-and-install-race`;
const INDEX = 'packages/main/src/index.ts';
const SPEC = 'packages/main/src/index.spec.ts';
const HANDLER = 'packages/main/src/before-quit-handler.ts';

let repo;
let home;
let reviewed;
let amended;

before(async () => {
  repo = await initRepo('pdkit-pr-diff-');
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-pr-diff-home-')));

  await writeFiles(repo, { [INDEX]: 'export const a = 1;\n', [SPEC]: 'test();\n' });
  await commitAll(repo, 'chore: base');

  await git(['switch', '-c', BRANCH], repo);
  await writeFiles(repo, { [INDEX]: 'export const a = 2;\n', [SPEC]: 'test(); test();\n' });
  reviewed = await commitAll(repo, 'fix(main): quit and install race');

  await writeFiles(repo, { [INDEX]: 'export { handler } from "./before-quit-handler";\n', [HANDLER]: 'export const handler = 1;\n' });
  await git(['add', '-A'], repo);
  await git(['commit', '--amend', '--no-edit'], repo);
  amended = await git(['rev-parse', 'HEAD'], repo);

  const dir = issueDir(home, ISSUE);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'prs.json'), JSON.stringify({ prs: [{ number: PR, slice: 1, branch: BRANCH, base: 'main' }] }));
  await writeFile(
    join(dir, 'slices.json'),
    JSON.stringify({ issue: ISSUE, slices: [{ index: 1, slug: 'quit-and-install-race', branch: BRANCH, files: [INDEX, SPEC], baseSlice: null }] }),
  );
});

after(async () => {
  await cleanup(repo, home);
});

const ask = (extra = {}) => pending({ issue: ISSUE, number: PR, cwd: repo, home, config: {}, head: reviewed, ...extra });

describe('pr diff', () => {
  test('an amended round is a rewrite: one ahead, one behind', async () => {
    const result = await ask();

    assert.equal(result.ok, true);
    assert.equal(result.head, reviewed);
    assert.equal(result.local, amended);
    assert.deepEqual([result.ahead, result.behind], [1, 1]);
  });

  test('the files this push changes, each said in or out of the slice', async () => {
    const result = await ask();

    assert.deepEqual(result.files, [
      { status: 'A', path: HANDLER, inSlice: false },
      { status: 'M', path: INDEX, inSlice: true },
    ]);
    assert.match(result.stat, /before-quit-handler\.ts/);
    assert.match(result.patch, /\+export const handler = 1;/);
  });

  // The whole pull request after the push, not only this round's delta.
  test('files the pull request would carry outside its slice are named', async () => {
    assert.deepEqual((await ask()).outside, [HANDLER]);
  });

  test('--stat leaves the patch out', async () => {
    assert.equal((await ask({ stat: true })).patch, null);
  });

  test('the same commit on both sides is nothing to push', async () => {
    const result = await ask({ head: amended });
    assert.deepEqual([result.ahead, result.behind], [0, 0]);
    assert.deepEqual(result.files, []);
  });

  test('a pull request nobody registered is refused, with the reason', async () => {
    const result = await pending({ issue: ISSUE, number: 1, cwd: repo, home, config: {}, head: reviewed });
    assert.equal(result.ok, false);
    assert.match(result.error, /#1 is not registered under DESKTOP-18915/);
  });

  test('a head this repository does not have, and cannot fetch, is refused', async () => {
    const result = await ask({ head: '0123456789abcdef0123456789abcdef01234567' });
    assert.equal(result.ok, false);
    assert.match(result.error, /is not in this repository/);
  });
});

// DESKTOP-18833: rebased onto upstream/main with the local main 43 commits
// behind. `outside` was measured from that main, and listed every file
// upstream had touched since as one the pull request would carry.
describe('pr diff, with the local main behind upstream', () => {
  const UPSTREAM_FILE = '.github/workflows/pr-check.yaml';
  let repo_;
  let home_;
  let pushed;

  before(async () => {
    repo_ = await initRepo('pdkit-pr-diff-stale-');
    home_ = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-pr-diff-stale-home-')));

    await writeFiles(repo_, { [INDEX]: 'export const a = 1;\n' });
    await commitAll(repo_, 'chore: base');

    await git(['switch', '-c', BRANCH], repo_);
    await writeFiles(repo_, { [INDEX]: 'export const a = 2;\n' });
    pushed = await commitAll(repo_, 'fix(main): quit and install race');

    // Upstream moves; only the remote-tracking ref sees it.
    await git(['switch', '-c', 'scratch', 'main'], repo_);
    await writeFiles(repo_, { [UPSTREAM_FILE]: 'on: pull_request\n' });
    await git(['update-ref', 'refs/remotes/upstream/main', await commitAll(repo_, 'ci: upstream work')], repo_);

    await git(['switch', BRANCH], repo_);
    await git(['branch', '-D', 'scratch'], repo_);
    await git(['rebase', '--quiet', 'upstream/main'], repo_);

    const dir = issueDir(home_, ISSUE);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'prs.json'), JSON.stringify({ prs: [{ number: PR, slice: 1, branch: BRANCH, base: 'main' }] }));
    await writeFile(
      join(dir, 'slices.json'),
      JSON.stringify({ issue: ISSUE, slices: [{ index: 1, slug: 'quit-and-install-race', branch: BRANCH, files: [INDEX], baseSlice: null }] }),
    );
  });

  after(async () => {
    await cleanup(repo_, home_);
  });

  test('what upstream landed is not outside the slice', async () => {
    const result = await pending({ issue: ISSUE, number: PR, cwd: repo_, home: home_, config: { repo: { upstream_remote: 'upstream' } }, head: pushed });

    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.outside, []);
  });
});
