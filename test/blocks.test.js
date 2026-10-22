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

// Tests for lib/blocks.js and the places that print a block.
//
// What has no runtime symptom is the reason a block exists at all: an issue
// waiting on another one looked exactly like an issue nobody was moving. So
// the commands that say where an issue stands are tested to say it.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { block, list, open, unblock } from '../lib/blocks.js';
import { transition } from '../lib/state.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');

const ISSUE = 18833;

let home;
const homes = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-blocks-'));
  homes.push(home);
});

after(async () => {
  for (const dir of homes) await rm(dir, { recursive: true, force: true });
});

/** @param {...string} args */
async function pdkit(...args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { cwd: home, env: { ...process.env, PDKIT_HOME: home }, encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

describe('block and unblock', () => {
  test('a block is open until it is lifted, and the lift keeps its reason', async () => {
    assert.equal((await block({ issue: ISSUE, by: 18950, reason: 'checker API by engine and id', home })).ok, true);
    assert.deepEqual((await open({ issue: ISSUE, home })).map((entry) => entry.by), [18950]);

    assert.equal((await unblock({ issue: ISSUE, by: 18950, reason: 'merged as #19801', home })).ok, true);

    assert.deepEqual(await open({ issue: ISSUE, home }), []);
    const [lifted] = await list({ issue: ISSUE, home });
    assert.equal(lifted.status, 'lifted');
    assert.equal(lifted.liftReason, 'merged as #19801');
    assert.equal(lifted.reason, 'checker API by engine and id');
  });

  test('a reason is required, and an issue cannot wait on itself', async () => {
    assert.match((await block({ issue: ISSUE, by: 18950, reason: ' ', home })).error, /--reason/);
    assert.match((await block({ issue: ISSUE, by: ISSUE, reason: 'x', home })).error, /cannot wait on itself/);
  });

  test('blocking twice on the same issue and lifting what was never blocked are refused', async () => {
    await block({ issue: ISSUE, by: 18950, reason: 'x', home });

    assert.match((await block({ issue: ISSUE, by: 18950, reason: 'x', home })).error, /already waits on #18950/);
    assert.match((await unblock({ issue: ISSUE, by: 18951, home })).error, /does not wait on #18951/);
  });

  // The journal is append-only, so the record must survive the issue moving on.
  test('a block survives a state change', async () => {
    await block({ issue: ISSUE, by: 18950, reason: 'x', home });
    await transition(ISSUE, 'triaged', { home, route: 'standard' });

    assert.equal((await open({ issue: ISSUE, home })).length, 1);
  });
});

describe('where a block is said', () => {
  test('next says what the issue waits on before the step, and how it ends', async () => {
    await transition(ISSUE, 'triaged', { home, route: 'standard' });
    assert.equal((await pdkit('issue', 'block', String(ISSUE), '--by', '18950', '--reason', 'the checker API')).code, 0);

    const out = await pdkit('next', String(ISSUE));

    assert.match(out.stdout, /^waiting on #18950 — the checker API\n/);
    assert.match(out.stdout, /pdkit issue unblock 18833 --by 18950, then \/pd:resume 18833/);
    assert.match(out.stdout, /\/pd:plan 18833/, 'the step still prints: what does not depend on the blocker can move');
  });

  test('state carries it, and unblock takes it away', async () => {
    await transition(ISSUE, 'triaged', { home, route: 'standard' });
    await pdkit('issue', 'block', String(ISSUE), '--by', '#18950', '--reason', 'the checker API');

    assert.match((await pdkit('state', String(ISSUE))).stdout, /waits on {5}: #18950 — the checker API/);

    assert.equal((await pdkit('issue', 'unblock', String(ISSUE), '--by', '18950', '--reason', 'merged')).code, 0);
    assert.doesNotMatch((await pdkit('state', String(ISSUE))).stdout, /waits on/);
    assert.match((await pdkit('issue', 'blocks', String(ISSUE), '--all')).stdout, /#18950 {2}lifted .* — merged/);
  });
});

describe('draft-blocker', () => {
  // The draft is what a person copies into GitHub, so it has to carry the
  // dependency and the next two commands, not just the request.
  test('writes the upstream draft under blockers/, with the dependency and the commands that follow', async () => {
    await transition(ISSUE, 'triaged', { home, route: 'standard' });

    const out = await pdkit(
      'issue', 'draft-blocker', String(ISSUE),
      '--what', 'resolve images by engine and id for the checker API',
      '--pr', '19375', '--raised-by', 'benoitf', '--prior', 'DESKTOP-18833/2-image-check-by-id',
    );

    assert.equal(out.code, 0, out.stderr);
    const path = out.stdout.split('\n')[0];
    // The path is printed as the platform writes it: backslashes on Windows.
    assert.match(path, /blockers[\\/]resolve-images-by-engine-and-id.*\.md$/);
    const draft = await readFile(path, 'utf8');
    assert.match(draft, /^# BLOCKER DRAFT: DESKTOP-18833 waits on this/m);
    assert.match(draft, /- Prior work: DESKTOP-18833\/2-image-check-by-id/);
    assert.match(draft, /#19375 depends on this and will be rebased once it merges/);
    assert.match(out.stdout, /pdkit issue block 18833 --by <the number it got>/);
  });

  test('what it carries is required', async () => {
    assert.match((await pdkit('issue', 'draft-blocker', String(ISSUE))).stderr, /--what <text> is required/);
  });
});
