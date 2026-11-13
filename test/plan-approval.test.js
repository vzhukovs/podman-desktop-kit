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

// The approval of a plan could be typed: no rule read the plan or the freeze,
// and the freeze was held by the `&&` in the approval line alone. These hold
// the two places that read them now — the move to `plan-approved` and
// `pdkit ids freeze`, which runs first in that line — to the same answer.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { issueDir } from '../lib/config.js';
import { read, transition } from '../lib/state.js';
import { approvablePlan } from './helpers/approvable-plan.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const ISSUE = 17101;

let home;
const homes = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-plan-approval-'));
  homes.push(home);
  await transition(ISSUE, 'triaged', { home, route: 'standard' });
  await transition(ISSUE, 'planned', { home });
});

after(async () => {
  for (const dir of homes) await rm(dir, { recursive: true, force: true });
});

/**
 * Run the CLI against this test's own state directory, refusals included.
 *
 * @param {...string} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function pdkit(...args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { env: { ...process.env, PDKIT_HOME: home } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** The helper's plan with its one `Done when` written as prose, which `plan check` refuses. */
async function proseDoneWhen() {
  const path = join(issueDir(home, ISSUE), 'plan.md');
  const text = await readFile(path, 'utf8');
  assert.ok(text.includes('- Done when: `pnpm test:main`'));
  await writeFile(path, text.replace('- Done when: `pnpm test:main`', '- Done when: the registry works'));
}

describe('the move to plan-approved', () => {
  test('is refused with no plan, and says where it looked', async () => {
    const moved = await transition(ISSUE, 'plan-approved', { home });

    assert.equal(moved.ok, false);
    assert.match(moved.error, /^issue 17101: the plan fails its mechanical checks, so it cannot be approved:/);
    assert.match(moved.error, /plan: there is no plan at .*plan\.md/);
    assert.equal((await read(ISSUE, { home })).state, 'planned');
  });

  test('is refused on a plan `plan check` refuses, with what failed and the command that shows it', async () => {
    await approvablePlan(ISSUE, { home });
    await proseDoneWhen();

    const moved = await transition(ISSUE, 'plan-approved', { home });

    assert.equal(moved.ok, false);
    assert.match(moved.error, /done-when: T1 has no executable "Done when": "the registry works"/);
    assert.match(moved.error, /Run: pdkit plan check 17101\./);
  });

  test('is refused while the requirement set is open', async () => {
    await approvablePlan(ISSUE, { home, freeze: false });

    const moved = await transition(ISSUE, 'plan-approved', { home });

    assert.equal(moved.ok, false);
    assert.match(moved.error, /the requirement set is not frozen/);
    assert.match(moved.error, /Run: pdkit ids freeze 17101, then this move again\./);
  });

  test('goes through on a plan that passes, over a frozen set', async () => {
    await approvablePlan(ISSUE, { home });

    const moved = await transition(ISSUE, 'plan-approved', { home });

    assert.equal(moved.ok, true, moved.error);
  });
});

describe('pdkit ids freeze', () => {
  // Frozen on a refused plan, the set could not take the requirement a fix
  // needs, and nothing unfreezes it short of a rework.
  test('refuses on a plan that fails its checks, and leaves the set open', async () => {
    await approvablePlan(ISSUE, { home, freeze: false });
    await proseDoneWhen();

    const out = await pdkit('ids', 'freeze', String(ISSUE));

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /the plan fails its mechanical checks, so its requirement set is not frozen/);
    assert.equal((await read(ISSUE, { home })).requirements.frozen, false);
    assert.equal((await pdkit('ids', 'requirement', String(ISSUE))).code, 0, 'a requirement can still be allocated');
  });

  test('freezes on a plan that passes, and the approval line then goes through', async () => {
    await approvablePlan(ISSUE, { home, freeze: false });

    const out = await pdkit('ids', 'freeze', String(ISSUE));
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, 'R1\n');

    const moved = await pdkit('state', String(ISSUE), '--to', 'plan-approved');
    assert.equal(moved.code, 0, moved.stderr);
  });
});
