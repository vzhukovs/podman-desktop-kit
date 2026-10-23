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

// `pdkit pr supersede`, end to end through bin/pdkit.
//
// Closing a pull request upstream is a write to somebody else's repository,
// so what is defended here is everything that happens before one: the dry run
// is the default and prints the exact comment, `--confirm` without a token
// sends nothing and records nothing, and the old pull request cannot be closed
// before its replacement exists. The close itself, with a token, is covered in
// test/gh.test.js against a fake gh.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  home = await mkdtemp(join(tmpdir(), 'pdkit-supersede-'));
  await writeFile(join(home, 'config.yaml'), 'repo:\n  upstream: podman-desktop/podman-desktop\n');
  await writeFile(join(home, 'close.md'), 'Replaced by #19900, which carries this change as one of three commits.\n');

  for (const number of [19829, 19830]) {
    assert.equal((await pdkit('pr', 'register', String(number), '--issue', String(ISSUE))).code, 0);
  }
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('pr supersede', () => {
  test('refuses before the replacement exists', async () => {
    const result = await pdkit('pr', 'supersede', '19829', '--issue', String(ISSUE), '--by', '19900', '--body', join(home, 'close.md'));

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /#19900 is not a live pull request of DESKTOP-19818; open and register it first/);
  });

  test('without --confirm it prints the comment it would post, and changes nothing', async () => {
    await pdkit('pr', 'register', '19900', '--issue', String(ISSUE));
    const result = await pdkit('pr', 'supersede', '19829', '--issue', String(ISSUE), '--by', '19900', '--body', join(home, 'close.md'));

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /would close #19829 on podman-desktop\/podman-desktop/);
    assert.match(result.stdout, /> Replaced by #19900/);
    assert.match(result.stdout, /gate open --issue 19818 --pr 19829 --kind reply/);

    const book = await pr.read(ISSUE, { home });
    assert.equal(book.prs.find((entry) => entry.number === 19829).state, 'open');
  });

  test('--confirm without a reply token sends nothing and records nothing', async () => {
    const result = await pdkit('pr', 'supersede', '19829', '--issue', String(ISSUE), '--by', '19900', '--body', join(home, 'close.md'), '--confirm');

    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}${result.stderr}`, /refusing to close #19829/);

    const book = await pr.read(ISSUE, { home });
    assert.equal(book.prs.find((entry) => entry.number === 19829).state, 'open');
  });
});
