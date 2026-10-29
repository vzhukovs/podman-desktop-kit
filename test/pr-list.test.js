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

// `pdkit pr list`, end to end through bin/pdkit.
//
// What the dashboard is defended against is printing something nobody
// measured. On DESKTOP-19818 it showed three replaced pull requests as
// `closed ci:pending review:none threads:0/0 read:never ←` — registration
// defaults, worded as a reading and flagged for attention — and `threads:4/5`
// on the live one was read as four of five resolved, when four were waiting.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as pr from '../lib/pr.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const ISSUE = 19818;

let home;

/**
 * @param {...string} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function pdkit(...args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { cwd: home, env: { ...process.env, PDKIT_HOME: home }, encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-pr-list-'));
  await writeFile(join(home, 'config.yaml'), 'repo:\n  upstream: podman-desktop/podman-desktop\n');

  for (const number of [19829, 19849]) {
    assert.equal((await pdkit('pr', 'register', String(number), '--issue', String(ISSUE))).code, 0);
  }
  await pr.markClosed({ issue: ISSUE, number: 19829, supersededBy: 19849, home });

  // A reading, as a refresh would leave it: four threads still open of five.
  const file = join(home, 'issues', String(ISSUE), 'prs.json');
  const book = JSON.parse(await readFile(file, 'utf8'));
  const live = book.prs.find((entry) => entry.number === 19849);
  live.refreshedAt = new Date().toISOString();
  live.ci = { verdict: 'pass', checkedAt: live.refreshedAt, jobs: [] };
  live.review = { ...live.review, decision: 'APPROVED', threadsOpen: 4, threadsTotal: 5 };
  await writeFile(file, JSON.stringify(book, null, 2));
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('pr list', () => {
  test('threads are spelled as open of total', async () => {
    const result = await pdkit('pr', 'list', '--issue', String(ISSUE));

    assert.equal(result.code, 0, result.stderr);
    const row = result.stdout.split('\n').find((line) => line.startsWith('  #19849'));
    assert.match(row, /threads:4 open of 5/);
    assert.equal(row.includes('←'), false, 'a fresh reading is not flagged');
  });

  test('a replaced pull request names its successor, and what was never read says so', async () => {
    const result = await pdkit('pr', 'list', '--issue', String(ISSUE));
    const row = result.stdout.split('\n').find((line) => line.startsWith('  #19829'));

    assert.match(row, /superseded by #19849/);
    assert.match(row, /ci:unread {2}review:unread {2}threads:unread/);
    assert.equal(/ci:pending|review:none/.test(row), false, 'registration defaults are not a reading');
    assert.equal(row.includes('←'), false, 'nothing to come back to on a closed pull request');
  });
});
