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


// `pdkit publish`: /pd:pr step 8 as one command, end to end through bin/pdkit.
//
// The real git, against a bare repository standing in for the fork, so "was it
// pushed" is answered by the remote rather than by what the command printed.
// `gh` is a stub on PATH, because opening a pull request is the one write that
// cannot be made against a local stand-in — and its failure is the case that
// matters most: a public branch with no pull request to explain it.
//
// POSIX only: the stub is a shell script.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { COMMAND_FLAGS } from '../lib/cli.js';
import * as pr from '../lib/pr.js';
import { adopt, read as readState } from '../lib/state.js';
import { preflightGreen } from './helpers/preflight-evidence.js';
import { cleanup, commitAll, git, initRepo, writeFiles } from './helpers/repo-fixture.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const ISSUE = 4242;
const BRANCH = `DESKTOP-${ISSUE}/fix-thing`;
const POSIX = { skip: process.platform === 'win32' ? 'the gh stub is a shell script' : false };

let home;
let repo;
let remote;
let stubs;

/** @param {'ok'|'fail'} mode */
async function stubGh(mode) {
  const script =
    mode === 'ok'
      ? '#!/bin/sh\ncat > /dev/null\necho https://github.com/podman-desktop/podman-desktop/pull/90001\n'
      : '#!/bin/sh\ncat > /dev/null\necho "GraphQL: something went wrong" >&2\nexit 1\n';
  await writeFile(join(stubs, 'gh'), script);
  await chmod(join(stubs, 'gh'), 0o755);
}

/** @returns {Promise<{code: number, stdout: string, stderr: string}>} */
async function pdkit(...args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      cwd: repo,
      env: { ...process.env, PDKIT_HOME: home, PATH: `${stubs}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

/** What the fork has for the branch, or null. */
async function remoteHead() {
  try {
    return (await git(['rev-parse', `refs/heads/${BRANCH}`], remote)).trim();
  } catch {
    return null;
  }
}

async function token() {
  const files = await readdir(join(home, 'gates')).catch(() => []);
  if (files.length === 0) return null;
  return JSON.parse(await readFile(join(home, 'gates', files[0]), 'utf8'));
}

async function head() {
  return (await git(['rev-parse', 'HEAD'], repo)).trim();
}

const body = () => join(home, 'body.md');

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-publish-'));
  stubs = await mkdtemp(join(tmpdir(), 'pdkit-publish-bin-'));
  remote = await mkdtemp(join(tmpdir(), 'pdkit-publish-fork-'));
  await git(['init', '--bare', '-b', 'main'], remote);

  repo = await initRepo('pdkit-publish-repo-');
  await writeFiles(repo, { 'README.md': 'x\n' });
  await commitAll(repo, 'chore: start');
  await git(['remote', 'add', 'origin', remote], repo);
  await git(['checkout', '-b', BRANCH], repo);
  await writeFiles(repo, { 'fix.ts': 'export const fixed = true;\n' });
  await commitAll(repo, 'fix(main): the thing');

  await writeFile(join(home, 'config.yaml'), 'repo:\n  fork: me/podman-desktop\n');
  await writeFile(body(), '## What does this PR do?\n\nFixes it.\n');
  await mkdir(join(home, 'issues'), { recursive: true });
  const adopted = await adopt(ISSUE, { home, state: 'quickfix', route: 'quickfix', reason: 'a fixture' });
  assert.ok(adopted.ok, adopted.error);
});

afterEach(async () => {
  await cleanup(home, stubs, remote, repo);
});

describe('pdkit publish', () => {
  test('without a green preflight it stops before a token exists or anything is pushed', POSIX, async () => {
    await stubGh('ok');
    const result = await pdkit('publish', '--issue', String(ISSUE), '--branch', BRANCH, '--title', 't', '--body', body());

    assert.equal(result.code, 1);
    assert.match(result.stderr, /stopped before a token was issued or anything was pushed/);
    assert.match(result.stderr, /Run: pdkit preflight/);
    assert.match(result.stderr, /What is missing is a preflight run/);
    assert.equal(await token(), null);
    assert.equal(await remoteHead(), null);
    assert.equal((await readState(ISSUE, { home })).state, 'quickfix');
  });

  test('with one, it earns the state, pushes, opens the pull request, and spends the token whole', POSIX, async () => {
    await stubGh('ok');
    await preflightGreen(ISSUE, { home, head: await head(), branch: BRANCH });

    const result = await pdkit('publish', '--issue', String(ISSUE), '--branch', BRANCH, '--title', 't', '--body', body());

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /quickfix -> preflight-green/);
    assert.match(result.stdout, /pull\/90001/);
    assert.equal(await remoteHead(), await head());

    const spent = await token();
    assert.ok(spent.spent.push && spent.spent.pr && spent.spentAt, 'one token, both writes, once each');
    assert.equal((await readState(ISSUE, { home })).state, 'pr-open');
    assert.equal((await pr.read(ISSUE, { home })).prs[0].number, 90001);
  });

  test('a pushed branch whose pull request failed is said plainly, with the half of the token left', POSIX, async () => {
    await stubGh('fail');
    await preflightGreen(ISSUE, { home, head: await head(), branch: BRANCH });

    const result = await pdkit('publish', '--issue', String(ISSUE), '--branch', BRANCH, '--title', 'the title', '--body', body());

    assert.equal(result.code, 1);
    assert.match(result.stderr, /IS PUSHED .* the pull request was NOT opened/);
    assert.match(result.stderr, /half spent/);
    assert.match(result.stderr, /Do not push again/);
    assert.match(result.stderr, /pdkit pr create --issue 4242 --branch DESKTOP-4242\/fix-thing --title "the title"/);
    assert.equal(await remoteHead(), await head());

    const half = await token();
    assert.ok(half.spent.push);
    assert.equal(half.spent.pr, null);
    assert.equal((await readState(ISSUE, { home })).state, 'preflight-green');

    // The bricks still work: the half that is left opens the pull request.
    await stubGh('ok');
    const finished = await pdkit('pr', 'create', '--issue', String(ISSUE), '--branch', BRANCH, '--title', 'the title', '--body', body());
    assert.equal(finished.code, 0, finished.stderr);
    assert.equal((await readState(ISSUE, { home })).state, 'pr-open');
  });

  test('a failed push leaves preflight-green, and running it again re-reads the record rather than the state', POSIX, async () => {
    await stubGh('ok');
    await preflightGreen(ISSUE, { home, head: await head(), branch: BRANCH });
    await git(['remote', 'set-url', 'origin', join(remote, 'nowhere')], repo);

    const failed = await pdkit('publish', '--issue', String(ISSUE), '--branch', BRANCH, '--title', 't', '--body', body());
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /push is spent and the issue is still preflight-green; no pull request was opened/);
    assert.equal((await readState(ISSUE, { home })).state, 'preflight-green');

    // A commit preflight never saw: the second run must not ride the state.
    await writeFiles(repo, { 'later.ts': 'export {};\n' });
    await commitAll(repo, 'fix(main): later');
    await git(['remote', 'set-url', 'origin', remote], repo);
    const moved = await pdkit('publish', '--issue', String(ISSUE), '--branch', BRANCH, '--title', 't', '--body', body());
    assert.equal(moved.code, 1);
    assert.match(moved.stderr, /preflight has not shown this commit ready/);
    assert.equal(await remoteHead(), null);

    await preflightGreen(ISSUE, { home, head: await head(), branch: BRANCH });
    const again = await pdkit('publish', '--issue', String(ISSUE), '--branch', BRANCH, '--title', 't', '--body', body());
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /preflight's record still holds/);
    assert.equal(await remoteHead(), await head());
  });

  test('the checkout has to be the branch being published', POSIX, async () => {
    await stubGh('ok');
    await preflightGreen(ISSUE, { home, head: await head(), branch: BRANCH });
    await git(['checkout', 'main'], repo);

    const result = await pdkit('publish', '--issue', String(ISSUE), '--branch', BRANCH, '--title', 't', '--body', body());

    assert.equal(result.code, 1);
    assert.match(result.stderr, /the checkout is on main/);
    assert.equal(await token(), null);
    assert.equal(await remoteHead(), null);
  });

  test('--pr updates an open pull request: force-with-lease, and back to pr-open', POSIX, async () => {
    await stubGh('ok');
    await preflightGreen(ISSUE, { home, head: await head(), branch: BRANCH });
    assert.equal((await pdkit('publish', '--issue', String(ISSUE), '--branch', BRANCH, '--title', 't', '--body', body())).code, 0);

    // A review round: the branch is rewritten, as a cascade or an amend would.
    await writeFiles(repo, { 'fix.ts': 'export const fixed = 2;\n' });
    await git(['add', 'fix.ts'], repo);
    await git(['commit', '--amend', '--no-edit'], repo);
    await preflightGreen(ISSUE, { home, head: await head(), branch: BRANCH });

    const result = await pdkit('publish', '--issue', String(ISSUE), '--branch', BRANCH, '--pr', '90001');

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /--force-with-lease/);
    assert.equal(await remoteHead(), await head());
    assert.equal((await readState(ISSUE, { home })).state, 'pr-open');
  });

  test('--pr refuses a pull request that is not this branch\'s', POSIX, async () => {
    const result = await pdkit('publish', '--issue', String(ISSUE), '--branch', BRANCH, '--pr', '1');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /#1 is not registered under issue 4242/);
  });

  test('no flag that skips, forces or extends anything', () => {
    for (const weakening of ['yes', 'force', 'skip-preflight', 'ttl', 'no-verify', 'confirm']) {
      assert.ok(!COMMAND_FLAGS.publish.includes(weakening), weakening);
    }
  });
});
