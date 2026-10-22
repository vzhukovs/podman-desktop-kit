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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseTask } from '../lib/artefacts.js';
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

  // DESKTOP-18833: A3 added R18 and R19, lost its task headings to get past
  // the ownership refusal, and was approved. slice set found the hole hours
  // later. Approval is where it has to be found.
  test('a requirement it adds that no live task satisfies leaves it proposed', async () => {
    await writeFile(issueFile('plan.md'), plan('R1, R2').replace('- Satisfies: R1, R3', '- Satisfies: R1'));
    const id = await propose();

    const out = await pdkit('amendment', 'approve', id, '--issue', String(ISSUE));

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /after A1, R3 is satisfied by no live task, so it stays proposed/);
    assert.match(out.stderr, /an issue of its own, and this one waits for it \(`pdkit issue block`\)/);
    assert.match(await readFile(issueFile('amendments', `${id}.md`), 'utf8'), /^- Status: proposed/m);
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

// The other half of an amendment: the tasks it writes and the ones it replaces.
// On 18915 A1 replaced T2/T3 with T5 and T4 with T6, and after approval T5 and
// T6 were only text in A1.md — `/pd:exec` wrote their files by hand with a
// heredoc — while T2–T4 stayed live: the audit asked for their receipts and
// `owns.T2` kept updater.ts, a file A1 says nobody touches.
describe('the tasks an amendment writes', () => {
  /** A task in plan.md's shape. */
  const T1 = ['### T1: reproduce the stall', '- Satisfies: R1', '- Owns: packages/main/src/index.ts', '- Done when: `npx vitest run packages/main/src/index.spec.ts`', ''];
  const T2 = ['### T2: close handler honours the update flag', '- Satisfies: R2', '- Owns: packages/main/src/mainWindow.ts', '- Done when: `npx vitest run packages/main/src/mainWindow.spec.ts`', ''];

  /** A1's "Slices affected", as A1 wrote its own: free text, then a task block, then more text. */
  const SLICES = [
    'Still one slice. T2 (mainWindow.ts) is NOT shipped; it is replaced by:',
    '',
    '### T3 (replaces T2): a second before-quit is vetoed',
    '- Satisfies: R3',
    '- Owns: packages/main/src/index.spec.ts',
    '- Done when: `npx vitest run packages/main/src/index.spec.ts` -> exit 0; test count = baseline + 4',
    '- Steps:',
    '  1. add the four tests',
    '     with a deferred dispose',
    '  2. run them',
    '',
    '### Validation (manual, by /pd:validate): rebuild and retry twenty times.',
  ].join('\n');

  const withTasks = (requirements) => plan(requirements).replace(/### T1:[\s\S]*?\n\n## Upstream/, `${[...T1, ...T2].join('\n')}\n## Upstream`);

  /**
   * @param {string} id
   * @param {string} title
   * @param {string} satisfies
   * @param {string} owns
   */
  async function taskFile(id, title, satisfies, owns) {
    await mkdir(issueFile('tasks'), { recursive: true });
    await writeFile(
      issueFile('tasks', `${id}.md`),
      [`# ${id}: ${title}`, '', `- Issue: ${ISSUE}`, `- Satisfies: ${satisfies}`, '- Status: pending', '- Attempts: 0', '', '## Owns', `- ${owns}`, '', '## Done when', '```bash', 'npx vitest run', '```', 'Expected: exit 0', ''].join('\n'),
    );
  }

  beforeEach(async () => {
    await writeFile(join(home, 'values.json'), JSON.stringify({ ...VALUES, slices: SLICES }));
    await writeFile(issueFile('plan.md'), withTasks('R1, R2'));
    await taskFile('T1', 'reproduce the stall', 'R1', 'packages/main/src/index.ts');
    await taskFile('T2', 'close handler honours the update flag', 'R2', 'packages/main/src/mainWindow.ts');
    assert.equal((await pdkit('task', 'sync', '--issue', String(ISSUE))).code, 0);
  });

  const record = () => read(ISSUE, { home });

  test('approve renders the new task file from the amendment, with the plan parser\'s reading of it', async () => {
    const out = await pdkit('amendment', 'approve', await propose(), '--issue', String(ISSUE));

    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /wrote tasks\/T3\.md/);

    const t3 = parseTask(await readFile(issueFile('tasks', 'T3.md'), 'utf8'));
    assert.equal(t3.title, 'a second before-quit is vetoed');
    assert.deepEqual(t3.satisfies, ['R3']);
    assert.deepEqual(t3.owns, ['packages/main/src/index.spec.ts']);
    assert.equal(t3.command, 'npx vitest run packages/main/src/index.spec.ts');
    assert.equal(t3.expected, 'exit 0; test count = baseline + 4');
    assert.equal(t3.withdrawn, null);

    const text = await readFile(issueFile('tasks', 'T3.md'), 'utf8');
    assert.match(text, /## Steps\n1\. add the four tests\n {3}with a deferred dispose\n2\. run them\n/);
    assert.match(text, /From A1 \(amendments\/A1\.md; replaces T2\)/);
  });

  test('the replaced task is marked withdrawn in its file and in the record, and owns nothing', async () => {
    assert.deepEqual((await record()).owns.T2, ['packages/main/src/mainWindow.ts']);

    const out = await pdkit('amendment', 'approve', await propose(), '--issue', String(ISSUE));

    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /withdrawn {5}T2 \(replaced by T3\) — no longer owns packages\/main\/src\/mainWindow\.ts/);

    const t2 = parseTask(await readFile(issueFile('tasks', 'T2.md'), 'utf8'));
    assert.equal(t2.status, 'withdrawn by A1 (replaced by T3)');
    assert.deepEqual(t2.withdrawn, { amendment: 'A1', replacedBy: ['T3'] });

    const after = await record();
    assert.equal('T2' in after.owns, false, 'one claim on mainWindow.ts, not two');
    assert.deepEqual(after.owns.T3, ['packages/main/src/index.spec.ts']);
    assert.deepEqual(after.owns.T1, ['packages/main/src/index.ts']);
    assert.equal(after.withdrawn.T2.amendment, 'A1');
    assert.deepEqual(after.withdrawn.T2.replacedBy, ['T3']);

    // The ID is not reused or renumbered: the file is still there, still T2.
    assert.equal(t2.id, 'T2');
  });

  test('plan.md gains the block, and plan check passes on the amended plan', async () => {
    assert.doesNotMatch(await readFile(issueFile('plan.md'), 'utf8'), /### T3/);

    await pdkit('amendment', 'approve', await propose(), '--issue', String(ISSUE));

    const text = await readFile(issueFile('plan.md'), 'utf8');
    assert.match(text, /### T2: close handler[\s\S]*### T3 \(replaces T2\): a second before-quit is vetoed[\s\S]*\n\n## Upstream compliance/);
    const check = await pdkit('plan', 'check', String(ISSUE));
    assert.equal(check.code, 0, check.stdout);
  });

  test('task sync keeps a withdrawn task withdrawn rather than giving it its files back', async () => {
    await pdkit('amendment', 'approve', await propose(), '--issue', String(ISSUE));

    const out = await pdkit('task', 'sync', '--issue', String(ISSUE));

    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /^T2 {2}withdrawn by A1 — owns nothing$/m);
    assert.equal('T2' in (await record()).owns, false);
  });

  test('task start on the withdrawn task is refused, and says what replaced it', async () => {
    await pdkit('amendment', 'approve', await propose(), '--issue', String(ISSUE));
    const repo = join(home, 'repo');
    await mkdir(repo);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });

    const out = await pdkit('task', 'start', '--issue', String(ISSUE), '--task', 'T2', '--repo', repo);

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /T2 of issue 18915 was withdrawn by A1 \(amendments\/A1\.md\) and is not part of the plan\. Its work is T3 now\./);

    const live = await pdkit('task', 'start', '--issue', String(ISSUE), '--task', 'T3', '--repo', repo);
    assert.equal(live.code, 0, live.stderr);
  });

  test('a task heading the plan parser cannot read leaves the amendment proposed and nothing written', async () => {
    await writeFile(join(home, 'values.json'), JSON.stringify({ ...VALUES, slices: SLICES.replace('### T3 (replaces T2):', '### T3 - replaces T2 -') }));
    const id = await propose();

    const out = await pdkit('amendment', 'approve', id, '--issue', String(ISSUE));

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /tasks in "Slices affected" cannot be written, so it stays proposed/);
    assert.match(out.stderr, /"### T3 - replaces T2 - a second before-quit is vetoed" .* is not a task heading the plan parser reads/);
    assert.match(await readFile(issueFile('amendments', `${id}.md`), 'utf8'), /^- Status: proposed/m);
    await assert.rejects(readFile(issueFile('tasks', 'T3.md'), 'utf8'));
    assert.deepEqual((await requirements()).ids, ['R1', 'R2'], 'the requirement half did not apply either');
  });

  test('a new task that would take an existing ID is refused', async () => {
    await writeFile(join(home, 'values.json'), JSON.stringify({ ...VALUES, slices: SLICES.replace('### T3 (replaces T2)', '### T1 (replaces T2)') }));

    const out = await pdkit('amendment', 'approve', await propose(), '--issue', String(ISSUE));

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /T1 is already a task in the plan \("reproduce the stall"\)/);
  });

  // 18915 as it stands: A1 approved before approval wrote tasks, T5.md typed in
  // by hand. `sync` finishes the job without overwriting what was typed.
  test('sync on an amendment approved before tasks were written keeps a hand-made task file and withdraws the rest', async () => {
    const id = await propose();
    const path = issueFile('amendments', `${id}.md`);
    await writeFile(path, (await readFile(path, 'utf8')).replace(/^- Status: proposed/m, '- Status: approved'));
    await taskFile('T3', 'A second before-quit is vetoed', 'R3', 'packages/main/src/index.spec.ts');
    const handMade = await readFile(issueFile('tasks', 'T3.md'), 'utf8');

    const out = await pdkit('amendment', 'sync', id, '--issue', String(ISSUE));

    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /tasks\/T3\.md already there, kept as written/);
    assert.equal(await readFile(issueFile('tasks', 'T3.md'), 'utf8'), handMade);
    assert.equal('T2' in (await record()).owns, false);
    assert.deepEqual((await record()).owns.T3, ['packages/main/src/index.spec.ts']);

    const again = await pdkit('amendment', 'sync', id, '--issue', String(ISSUE));
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /nothing to bring into line/);
    assert.equal((await readJournal({ issue: ISSUE, event: 'amendment-tasks' }, { home })).length, 1);
  });

  test('a task file already there as a different task is reported, not overwritten', async () => {
    await taskFile('T3', 'something else entirely', 'R3', 'packages/main/src/other.ts');

    const out = await pdkit('amendment', 'approve', await propose(), '--issue', String(ISSUE));

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /tasks[\\/]T3\.md: already there as "something else entirely"/);
    assert.equal(parseTask(await readFile(issueFile('tasks', 'T3.md'), 'utf8')).title, 'something else entirely');
  });
});
