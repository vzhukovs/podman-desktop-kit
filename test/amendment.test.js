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

// What `pdkit amendment approve` does to the plan, and not only to its own file.
//
// On DESKTOP-18915 A1 was approved and the word in its header was the only thing
// that changed: the record kept R1–R6 frozen, plan.md kept listing them, `slice
// set` refused because withdrawn requirements reached no slice, and both were
// mended by hand. End to end through bin/pdkit, because the defect was between
// the commands — `plan check` read a set that `approve` never wrote.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { allocateRequirement, freezeRequirements, read, transition } from '../lib/state.js';
import { read as readJournal } from '../lib/journal.js';

const exec = promisify(execFile);

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');

const ISSUE = 18915;

/** R2 gives way to R3, which the amendment adds; R1 stands. */
const ROWS = [
  { rid: 'R3', change: 'added', detail: 'a second before-quit is vetoed while disposal runs' },
  { rid: 'R2', change: 'superseded by R3', detail: 'the close handler was never the failing path' },
  { rid: ['R1'], change: 'unchanged', detail: 'still the symptom' },
];

const VALUES = {
  source: 'validation finding',
  trigger: 'T1 attributed the stall to H2',
  rows: ROWS,
  slices: 'still 1 slice',
  rationale: 'the plan fixed an ordering that never occurred',
  approval: 'pending',
};

/**
 * A plan whose tasks already follow the amendment — writing those is a separate
 * step — and whose Requirements line is the one approval has to move.
 *
 * @param {string} requirements
 * @returns {string}
 */
function plan(requirements) {
  return [
    `# PLAN: DESKTOP-${ISSUE}`,
    '',
    `- Requirements: ${requirements} (frozen on approval)`,
    '- e2e coverage: no — the path is the macOS updater, validated by hand',
    '- Slice hypothesis: 1 slices',
    '',
    '## Context',
    '- `packages/main/src/index.ts:65` — `app.once(\'before-quit\')`',
    '',
    '## Frozen interfaces',
    '```ts',
    'none',
    '```',
    '',
    '## Tasks',
    '### T1: the before-quit handler outlives the first quit request',
    '- Satisfies: R1, R3',
    '- Owns: packages/main/src/index.ts, packages/main/src/index.spec.ts',
    '- Done when: `npx vitest run packages/main/src/index.spec.ts`',
    '',
    '## Upstream compliance',
    '- SPDX headers needed: no new files',
    '- Schemas touched: no',
    '- `extension-api.d.ts` touched: no',
    '- Commit scope: main',
    '',
    '## Slice hypothesis',
    'One slice.',
    '',
    '## Open decisions',
    'none',
    '',
  ].join('\n');
}

let home;
const homes = [];

const issueFile = (...parts) => join(home, 'issues', String(ISSUE), ...parts);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-amendment-'));
  homes.push(home);

  await transition(ISSUE, 'triaged', { home, route: 'standard' });
  await allocateRequirement(ISSUE, { home });
  await allocateRequirement(ISSUE, { home });
  await freezeRequirements(ISSUE, { home });

  await writeFile(join(home, 'values.json'), JSON.stringify(VALUES));
  await writeFile(issueFile('plan.md'), plan('R1, R2'));
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
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      cwd: home,
      env: { ...process.env, PDKIT_HOME: home },
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

/** Propose the amendment and answer with its ID. */
async function propose() {
  const out = await pdkit('amendment', 'new', '--issue', String(ISSUE), '--values', join(home, 'values.json'), '--json');
  assert.equal(out.code, 0, out.stderr);
  return JSON.parse(out.stdout).id;
}

const requirements = async () => (await read(ISSUE, { home })).requirements;
const amended = async () => readJournal({ issue: ISSUE, event: 'requirements-amended' }, { home });

describe('amendment approve', () => {
  test('applies the table to the frozen set and to plan.md, and says what moved', async () => {
    const id = await propose();

    const out = await pdkit('amendment', 'approve', id, '--issue', String(ISSUE));

    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /was R1, R2\n\s+now R1, R3\n/);
    assert.deepEqual(await requirements(), { ids: ['R1', 'R3'], next: 4, frozen: true, amendments: ['A1'] });
    assert.match(await readFile(issueFile('plan.md'), 'utf8'), /^- Requirements: R1, R3 \(frozen on approval\) \(amended by A1\)$/m);
    assert.equal((await amended()).length, 1);
  });

  // What used to fail: the plan check reads the set off the record, and the
  // record never heard of the amendment.
  test('plan check passes after it, and did not before', async () => {
    const id = await propose();
    assert.notEqual((await pdkit('plan', 'check', String(ISSUE))).code, 0);

    await pdkit('amendment', 'approve', id, '--issue', String(ISSUE));

    const check = await pdkit('plan', 'check', String(ISSUE));
    assert.equal(check.code, 0, check.stdout);
    assert.match(check.stdout, /passes/);
  });

  test('a table the record cannot take leaves the amendment proposed and the set alone', async () => {
    const id = await propose();
    const path = issueFile('amendments', `${id}.md`);
    await writeFile(path, (await readFile(path, 'utf8')).replace('| superseded by R3 |', '| dropped |'));

    const out = await pdkit('amendment', 'approve', id, '--issue', String(ISSUE));

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /line \d+: "dropped" is not a change/);
    assert.match(out.stderr, /stays proposed/);
    assert.match(await readFile(path, 'utf8'), /^- Status: proposed/m);
    assert.deepEqual((await requirements()).ids, ['R1', 'R2']);
  });

  test('reject changes the status and nothing else', async () => {
    const id = await propose();
    const before = await readFile(issueFile('plan.md'), 'utf8');

    const out = await pdkit('amendment', 'reject', id, '--issue', String(ISSUE), '--reason', 'H1 is still possible');

    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(await requirements(), { ids: ['R1', 'R2'], next: 3, frozen: true });
    assert.equal(await readFile(issueFile('plan.md'), 'utf8'), before);
    assert.equal((await amended()).length, 0);
  });

  test('the state of the issue does not move', async () => {
    await pdkit('amendment', 'approve', await propose(), '--issue', String(ISSUE));

    assert.equal((await read(ISSUE, { home })).state, 'triaged');
  });
});

describe('amendment new', () => {
  test('several rows render into one table that approve reads back', async () => {
    const id = await propose();
    const text = await readFile(issueFile('amendments', `${id}.md`), 'utf8');

    assert.match(text, /^\| R3 \| added \| /m);
    assert.match(text, /^\| R2 \| superseded by R3 \| /m);
    assert.match(text, /^\| R1 \| unchanged \| /m);
  });

  test('a Change word outside the vocabulary is refused before an A-ID is spent', async () => {
    await writeFile(join(home, 'values.json'), JSON.stringify({ ...VALUES, rows: [{ rid: 'R2', change: 'dropped' }] }));

    const out = await pdkit('amendment', 'new', '--issue', String(ISSUE), '--values', join(home, 'values.json'));

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /"dropped" is not a change/);
    assert.match(out.stderr, /No A-ID has been spent/);
    assert.equal((await read(ISSUE, { home })).counters.amendment, 1);
  });
});

// Two writes, and either can be the one that fails. What matters is that a
// failure says which half is behind, and that there is a way to finish without
// applying the other half twice.
describe('a half-applied amendment', () => {
  test('a missing plan.md is reported, not passed over, and sync finishes it', async () => {
    const id = await propose();
    await rm(issueFile('plan.md'));

    const out = await pdkit('amendment', 'approve', id, '--issue', String(ISSUE));

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /A1 is approved, and this did not follow it/);
    assert.match(out.stderr, /plan\.md: there is none/);
    assert.match(out.stderr, /pdkit amendment sync A1 --issue 18915/);
    assert.deepEqual((await requirements()).ids, ['R1', 'R3'], 'the set half did apply');

    await writeFile(issueFile('plan.md'), plan('R1, R2'));
    const synced = await pdkit('amendment', 'sync', id, '--issue', String(ISSUE));

    assert.equal(synced.code, 0, synced.stderr);
    assert.match(synced.stdout, /A1 was applied already/);
    assert.match(await readFile(issueFile('plan.md'), 'utf8'), /^- Requirements: R1, R3 /m);
    assert.deepEqual((await requirements()).ids, ['R1', 'R3']);
    assert.equal((await amended()).length, 1, 'the set was not amended twice');
    assert.equal((await pdkit('plan', 'check', String(ISSUE))).code, 0);
  });

  test('neither approving again nor syncing again applies anything twice', async () => {
    const id = await propose();
    await pdkit('amendment', 'approve', id, '--issue', String(ISSUE));
    const plan = await readFile(issueFile('plan.md'), 'utf8');

    const again = await pdkit('amendment', 'approve', id, '--issue', String(ISSUE));
    assert.notEqual(again.code, 0);
    assert.match(again.stderr, /A1 is already approved/);

    const synced = await pdkit('amendment', 'sync', id, '--issue', String(ISSUE));
    assert.equal(synced.code, 0, synced.stderr);
    assert.match(synced.stdout, /nothing to bring into line/);

    assert.deepEqual(await requirements(), { ids: ['R1', 'R3'], next: 4, frozen: true, amendments: ['A1'] });
    assert.equal(await readFile(issueFile('plan.md'), 'utf8'), plan);
    assert.equal((await amended()).length, 1);
  });

  test('sync refuses an amendment nobody approved', async () => {
    const out = await pdkit('amendment', 'sync', await propose(), '--issue', String(ISSUE));

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /proposed, not approved/);
    assert.deepEqual((await requirements()).ids, ['R1', 'R2']);
  });
});
