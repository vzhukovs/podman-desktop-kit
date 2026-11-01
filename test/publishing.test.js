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

// Tests for lib/publishing.js.
//
// Neither function takes an `exec`, so gh cannot be injected the way
// test/gh.test.js injects it. `gh` is a stub on PATH instead, as in
// test/publish.test.js: it records its argv to a file and answers with canned
// output. What is asserted is which base a pull request opens against, whether
// upstream was asked about it, and the three writes that follow the opening.
//
// POSIX only: the stub is a shell script.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { issueDir } from '../lib/config.js';
import * as gate from '../lib/gate.js';
import * as pr from '../lib/pr.js';
import { openPullRequest, pullRequestBase } from '../lib/publishing.js';
import { read as readState, transition } from '../lib/state.js';
import { preflightGreen } from './helpers/preflight-evidence.js';

const POSIX = { skip: process.platform === 'win32' ? 'the gh stub is a shell script' : false };

const ISSUE = 6101;
const CONFIG = {
  repo: { upstream: 'podman-desktop/podman-desktop', fork: 'vzhukovs/podman-desktop', base_branch: 'main' },
};
const FIRST = `DESKTOP-${ISSUE}/1-api`;
const SECOND = `DESKTOP-${ISSUE}/2-plumbing`;
const CREATED = 'https://github.com/podman-desktop/podman-desktop/pull/90002';

let home;
let stubs;
let log;
let savedPath;

/**
 * Put a `gh` on PATH that appends its argv to `log` and answers as told.
 *
 * @param {{stdout?: string, stderr?: string, code?: number}} answer
 */
async function stubGh(answer) {
  const script =
    '#!/bin/sh\n' +
    `printf '%s\\n' "$*" >> '${log}'\n` +
    // Only `pr create` is given a body; gh() leaves stdin open otherwise, and a
    // stub that read it would wait forever.
    'if [ "$1" = pr ]; then cat > /dev/null; fi\n' +
    (answer.stdout ? `printf '%s\\n' '${answer.stdout}'\n` : '') +
    (answer.stderr ? `printf '%s\\n' '${answer.stderr}' >&2\n` : '') +
    `exit ${answer.code ?? 0}\n`;
  await writeFile(join(stubs, 'gh'), script);
  await chmod(join(stubs, 'gh'), 0o755);
}

/** Every argv the stub received, one string per call. */
async function calls() {
  try {
    return (await readFile(log, 'utf8')).split('\n').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-publishing-'));
  stubs = await mkdtemp(join(tmpdir(), 'pdkit-publishing-bin-'));
  log = join(stubs, 'calls.log');
  savedPath = process.env.PATH;
  process.env.PATH = `${stubs}:${savedPath}`;

  // Two slices, the second stacked on the first. Written as the file slice.read
  // reads: slices.json has one writer, and no named operation records a graph
  // without the proposal machinery this suite is not about.
  await mkdir(issueDir(home, ISSUE), { recursive: true });
  await writeFile(
    join(issueDir(home, ISSUE), 'slices.json'),
    `${JSON.stringify({
      issue: ISSUE,
      updatedAt: null,
      slices: [
        { index: 1, slug: 'api', branch: FIRST, baseSlice: null, files: [] },
        { index: 2, slug: 'plumbing', branch: SECOND, baseSlice: 1, files: [] },
      ],
    })}\n`,
  );
});

after(async () => {
  process.env.PATH = savedPath;
  await rm(home, { recursive: true, force: true });
  await rm(stubs, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(log, { force: true });
});

describe('the base a pull request opens against', () => {
  test('a stacked slice opens against the branch of the slice under it, once upstream has it', POSIX, async () => {
    await stubGh({ stdout: FIRST });

    const result = await pullRequestBase({ issue: ISSUE, branch: SECOND, config: CONFIG, home });

    assert.deepEqual(result, { ok: true, base: FIRST, index: 2 });
    const [call, ...rest] = await calls();
    assert.equal(rest.length, 0);
    assert.equal(call, `api repos/podman-desktop/podman-desktop/branches/${encodeURIComponent(FIRST)} --jq .name`);
  });

  test('a stacked slice whose base upstream does not have is refused, and says why', POSIX, async () => {
    await stubGh({ stderr: 'gh: Not Found (HTTP 404)', code: 1 });

    const result = await pullRequestBase({ issue: ISSUE, branch: SECOND, config: CONFIG, home });

    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(`^${FIRST} is not a branch of podman-desktop/podman-desktop`));
    assert.match(result.error, /Slice #2 is stacked on it/);
    assert.match(result.error, /--base main/);
  });

  test('an explicit base wins over the stack, and is checked like any other', POSIX, async () => {
    await stubGh({ stdout: 'release-1.0' });

    const result = await pullRequestBase({ issue: ISSUE, branch: SECOND, base: 'release-1.0', config: CONFIG, home });

    assert.deepEqual(result, { ok: true, base: 'release-1.0', index: 2 });
    assert.equal((await calls()).length, 1);
  });

  test('an explicit base upstream does not have is refused without the stack advice', POSIX, async () => {
    await stubGh({ stderr: 'gh: Not Found (HTTP 404)', code: 1 });

    const result = await pullRequestBase({ issue: ISSUE, branch: SECOND, base: 'nope', config: CONFIG, home });

    assert.equal(result.ok, false);
    assert.match(result.error, /A base is a branch of the repository the pull request opens against/);
    assert.doesNotMatch(result.error, /stacked/);
  });

  test('a failed lookup is not read as absence', POSIX, async () => {
    await stubGh({ stderr: 'could not resolve host', code: 1 });

    const result = await pullRequestBase({ issue: ISSUE, branch: SECOND, config: CONFIG, home });

    assert.deepEqual(result, { ok: false, error: `could not check whether ${FIRST} exists in podman-desktop/podman-desktop\n` });
  });

  test('by default it is repo.base_branch, and upstream is not asked', POSIX, async () => {
    await stubGh({ stdout: 'x' });

    assert.deepEqual(await pullRequestBase({ issue: ISSUE, branch: FIRST, config: CONFIG, home }), { ok: true, base: 'main', index: 1 });

    // A branch with no graph entry, and a config with another default.
    const other = { repo: { ...CONFIG.repo, base_branch: 'develop' } };
    assert.deepEqual(await pullRequestBase({ issue: ISSUE, branch: 'DESKTOP-6101/elsewhere', config: other, home }), {
      ok: true,
      base: 'develop',
      index: null,
    });

    assert.deepEqual(await calls(), []);
  });
});

describe('opening a pull request', () => {
  test('it opens through the gate, registers the record, and moves the issue to pr-open', POSIX, async () => {
    await preflightGreen(ISSUE, { home });
    for (const to of ['triaged', 'planned', 'plan-approved', 'implemented', 'validated', 'audited', 'sliced', 'slices-approved', 'preflight-green']) {
      const moved = await transition(ISSUE, to, { home });
      assert.ok(moved.ok, moved.error);
    }
    await gate.open({ issue: ISSUE, branch: FIRST, home });
    await stubGh({ stdout: CREATED });

    const { result, unrecorded } = await openPullRequest({
      issue: ISSUE,
      branch: FIRST,
      base: 'main',
      index: 1,
      title: 'feat(api): the api',
      body: 'b\n',
      config: CONFIG,
      home,
    });

    assert.deepEqual(result, { number: 90002, url: CREATED, base: 'main' });
    assert.equal(unrecorded, null);

    const [call] = await calls();
    assert.match(call, /^pr create --repo podman-desktop\/podman-desktop --base main --head vzhukovs:DESKTOP-6101\/1-api /);

    const record = (await pr.read(ISSUE, { home })).prs.find((entry) => entry.number === 90002);
    assert.equal(record.slice, 1);
    assert.equal(record.branch, FIRST);
    assert.equal(record.base, 'main');
    assert.equal(record.url, CREATED);

    assert.equal((await readState(ISSUE, { home })).state, 'pr-open');

    // The token's pr half is spent: one consent, one pull request.
    assert.equal((await gate.verify({ branch: FIRST, use: 'pr', home })).valid, false);
  });
});
