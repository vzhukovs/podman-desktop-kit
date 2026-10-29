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

// `pdkit preflight --body-from-pr`, end to end through bin/pdkit.
//
// After a rebase or a review round the body a reviewer reads is on GitHub and
// nowhere else. Two sessions on DESKTOP-19818 and DESKTOP-19901 improvised
// `gh pr view --json body > file` to feed --body; this is that, read by pdkit.
//
// POSIX only: the gh stub is a shell script.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { adopt } from '../lib/state.js';
import { cleanup, commitAll, git, initRepo, writeFiles } from './helpers/repo-fixture.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const ISSUE = 4243;
const POSIX = { skip: process.platform === 'win32' ? 'the gh stub is a shell script' : false };

let home;
let repo;
let tree;
let stubs;

/** @returns {Promise<{code: number, stdout: string, stderr: string}>} */
async function pdkit(...args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      cwd: tree,
      env: { ...process.env, PDKIT_HOME: home, PATH: `${stubs}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-preflight-body-'));
  stubs = await mkdtemp(join(tmpdir(), 'pdkit-preflight-body-bin-'));

  repo = await initRepo('pdkit-preflight-body-repo-');
  await writeFiles(repo, { 'README.md': 'x\n' });
  await commitAll(repo, 'chore: start');
  // The issue's own linked tree: preflight refuses to run in the main checkout.
  tree = await mkdtemp(join(tmpdir(), 'pdkit-preflight-body-tree-'));
  await rm(tree, { recursive: true });
  await git(['worktree', 'add', '-b', `DESKTOP-${ISSUE}/fix-thing`, tree], repo);
  await writeFiles(tree, { 'fix.ts': 'export const fixed = true;\n' });
  await commitAll(tree, 'fix(main): the thing');

  await writeFile(join(home, 'config.yaml'), 'repo:\n  fork: me/podman-desktop\n');
  await mkdir(join(home, 'issues'), { recursive: true });
  const adopted = await adopt(ISSUE, { home, state: 'quickfix', route: 'quickfix', reason: 'a fixture' });
  assert.ok(adopted.ok, adopted.error);

  // Answers `gh pr view <k> --json body` with a body, and records what it was asked.
  await writeFile(
    join(stubs, 'gh'),
    `#!/bin/sh\necho "$@" > "${join(stubs, 'asked')}"\necho '{"body":"### What does this PR do?\\\\n\\\\nFixes it."}'\n`,
  );
  await chmod(join(stubs, 'gh'), 0o755);
});

after(async () => {
  await cleanup(home, stubs, tree, repo);
});

describe('preflight --body-from-pr', () => {
  test('reads the body of the open pull request and judges it', POSIX, async () => {
    const result = await pdkit('preflight', String(ISSUE), '--body-only', '--body-from-pr', '90001', '--json');
    const report = JSON.parse(result.stdout);

    assert.equal(report.body, true, result.stderr);
    const template = report.results.find((entry) => entry.id === 'pr-body-template');
    assert.doesNotMatch(template.summary, /not drafted yet/, 'the body was read, so the check had something to judge');
  });

  test('--body and --body-from-pr together are refused', POSIX, async () => {
    await writeFile(join(home, 'body.md'), 'x\n');
    const result = await pdkit('preflight', String(ISSUE), '--body-only', '--body', join(home, 'body.md'), '--body-from-pr', '90001');

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /name two bodies; give one/);
  });
});
