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

// The plan as each review round saw it, and what changed in it since.
//
// What these protect: a revision edited the plan in place and nothing kept the
// version the last round read, so every later round reviewed the whole plan
// again at the cost of the first. A snapshot named after the wrong round, or
// overwritten after its review, compares the plan with the wrong version; a
// diff that misses a part, or calls a change structural when it is not, sends
// a round to the wrong mode.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { diff, snapshot, snapshots } from '../lib/plan-rounds.js';

const exec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'pdkit');
const ISSUE = 17003;

/**
 * Four tasks. T2 waits on T1 and names `Registry`, which T1's frozen interface
 * declares; T3 and T4 share a contract their entry names them in; T4 waits on
 * T2 and T3.
 */
const PLAN = [
  `# PLAN: DESKTOP-${ISSUE}`,
  '',
  '- Requirements: R1, R2 (frozen on approval)',
  '- e2e coverage: no — a helper',
  '- Slice hypothesis: 2 slices',
  '',
  '## Context',
  '- `src/a.ts:1` — a',
  '',
  '## Frozen interfaces',
  '<!-- Real signatures shared between tasks. -->',
  '```ts',
  '// src/registry.ts (T1)',
  'export class Registry {',
  '  register(name: string): void;',
  '}',
  '',
  '// fixture contract (T3 ↔ T4): the status text is `ready`',
  '```',
  '',
  '## Tasks',
  '### T1: registry',
  '- Satisfies: R1',
  '- Owns: src/registry.ts',
  '- Done when: `npx vitest run src/registry.spec.ts`',
  '- Steps:',
  '  1. Write the registry.',
  '### T2: wiring',
  '- Satisfies: R1',
  '- Owns: src/index.ts',
  '- Done when: `npx vitest run src/index.spec.ts`',
  '- After: T1',
  '- Steps:',
  '  1. Call `Registry.register` at start.',
  '### T3: fixture',
  '- Satisfies: R2',
  '- Owns: tests/fixture/index.ts',
  '- Done when: `npx eslint tests/fixture/index.ts`',
  '- Steps:',
  '  1. Print the status.',
  '### T4: spec',
  '- Satisfies: R2',
  '- Owns: tests/specs/a.spec.ts',
  '- Done when: `npx eslint tests/specs/a.spec.ts`',
  '- After: T2, T3',
  '- Steps:',
  '  1. Wait for the status.',
  '',
  '## Upstream compliance',
  '- SPDX headers needed: yes',
  '',
  '## Slice hypothesis',
  '- S1: T1, T2',
  '- S2: T3, T4',
  '',
  '## Open decisions',
  'None.',
  '',
].join('\n');

/** A task file in the shape of templates/task.md. */
function taskFile(id, owns) {
  return [
    `# ${id}: a task`,
    '',
    `- Issue: ${ISSUE}`,
    '- Satisfies: R1',
    '- Status: planned',
    '- Attempts: 0',
    '  <!-- The live count is not this line. -->',
    '',
    '## Owns',
    `- ${owns}`,
    '',
    '## Done when',
    '```bash',
    'true',
    '```',
    'Expected: exit 0',
    '',
    '## Context',
    '- a fact at `src/a.ts:1`',
    '- another at `src/a.ts:2`',
    '',
    '## Steps',
    '1. Do it.',
    '',
    '## Notes',
    'None.',
    '',
  ].join('\n');
}

const OWNS = { T1: 'src/registry.ts', T2: 'src/index.ts', T3: 'tests/fixture/index.ts', T4: 'tests/specs/a.spec.ts' };

describe('plan rounds', () => {
  let home;
  const homes = [];
  const dir = () => join(home, 'issues', String(ISSUE));

  /** Replace one string in a file of the issue, and fail when it is not there. */
  async function edit(name, from, to) {
    const path = join(dir(), name);
    const text = await readFile(path, 'utf8');
    assert.ok(text.includes(from), `${name} has no "${from}"`);
    await writeFile(path, text.replace(from, to));
  }

  /** A review of the given round on disk, as /pd:plan-review leaves it. */
  async function review(round, name = 'plan-review.md') {
    await writeFile(join(dir(), name), `# PLAN REVIEW: DESKTOP-${ISSUE} — round ${round}\n\n## Operator decisions (round ${round})\n- A1: accepted\n`);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-rounds-'));
    homes.push(home);
    await mkdir(join(dir(), 'tasks'), { recursive: true });
    await writeFile(join(dir(), 'plan.md'), PLAN);
    for (const [id, owns] of Object.entries(OWNS)) await writeFile(join(dir(), 'tasks', `${id}.md`), taskFile(id, owns));
  });
  after(async () => {
    for (const path of homes) await rm(path, { recursive: true, force: true });
  });

  describe('snapshot', () => {
    test('is named after the round a review writes next, and holds plan.md and every task file', async () => {
      const first = await snapshot(ISSUE, { home });
      assert.equal(first.ok, true);
      if (!first.ok) return;
      assert.equal(first.round, 1);
      assert.equal(first.outcome, 'taken');
      assert.deepEqual(first.files, ['plan.md', 'tasks/T1.md', 'tasks/T2.md', 'tasks/T3.md', 'tasks/T4.md']);
      assert.equal(await readFile(join(dir(), 'reviews', 'r1', 'plan.md'), 'utf8'), PLAN);
      assert.equal(await readFile(join(dir(), 'reviews', 'r1', 'tasks', 'T3.md'), 'utf8'), taskFile('T3', OWNS.T3));

      // Round 2 is on disk, the earlier one moved aside: the next review is round 3.
      await review(1, 'plan-review.r1.md');
      await review(2);
      const third = await snapshot(ISSUE, { home });
      assert.equal(third.ok && third.round, 3);
    });

    test('again for the same round changes nothing; a plan changed before its review replaces it', async () => {
      await snapshot(ISSUE, { home });
      const again = await snapshot(ISSUE, { home });
      assert.equal(again.ok && again.outcome, 'unchanged');
      assert.deepEqual(await snapshots(ISSUE, { home }), [1]);

      await edit('plan.md', 'Write the registry.', 'Write the registry, typed.');
      await rm(join(dir(), 'tasks', 'T4.md'));
      const replaced = await snapshot(ISSUE, { home });
      assert.equal(replaced.ok && replaced.outcome, 'replaced');
      assert.match(await readFile(join(dir(), 'reviews', 'r1', 'plan.md'), 'utf8'), /typed/);
      assert.deepEqual((await readdir(join(dir(), 'reviews', 'r1', 'tasks'))).sort(), ['T1.md', 'T2.md', 'T3.md']);
      assert.deepEqual(await readdir(join(dir(), 'reviews')), ['r1'], 'no partial copy is left beside it');
    });

    test('once the round is reviewed, its snapshot is never touched again', async () => {
      await snapshot(ISSUE, { home });
      await review(1);
      await edit('plan.md', 'Write the registry.', 'Write the registry, typed.');

      const next = await snapshot(ISSUE, { home });
      assert.equal(next.ok && next.round, 2);
      assert.equal(await readFile(join(dir(), 'reviews', 'r1', 'plan.md'), 'utf8'), PLAN);
    });

    test('refuses an issue with no plan', async () => {
      await rm(join(dir(), 'plan.md'));
      const result = await snapshot(ISSUE, { home });
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.error, /plan\.md does not exist/);
    });
  });

  describe('diff', () => {
    /** Round 1 reviewed the plan as it is now; what follows is the revision. */
    async function reviewed() {
      await snapshot(ISSUE, { home });
      await review(1);
    }

    test('with no snapshot there is nothing to compare, and it says so rather than reporting no change', async () => {
      const result = await diff(ISSUE, { home });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.base, null);
      assert.equal(result.structural, null);
      assert.equal(result.plan, null);
    });

    test('a line of Context in a task file is that task, that part, that file, and not structural', async () => {
      await reviewed();
      await edit('tasks/T3.md', '- another at `src/a.ts:2`', '- another at `src/a.ts:3`');

      const result = await diff(ISSUE, { home });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(result.base, { round: 1, path: join(dir(), 'reviews', 'r1') });
      assert.equal(result.round, 2);
      assert.equal(result.lastRound, 1);
      assert.equal(result.structural, false);
      assert.deepEqual(result.because, []);
      assert.deepEqual(result.tasks.added, []);
      assert.deepEqual(result.tasks.removed, []);
      assert.deepEqual(
        result.tasks.changed.map((task) => [task.id, task.parts]),
        [['T3', [{ part: 'Context', in: ['tasks/T3.md'] }]]],
      );
      assert.deepEqual(result.plan, { frozenInterfaces: false, sliceHypothesis: false, upstreamCompliance: false });
      assert.deepEqual(result.other, []);
      assert.deepEqual(result.text.lines, ['--- r1/tasks/T3.md', '+++ tasks/T3.md', '@@ -19,3 +19,3 @@', ' - a fact at `src/a.ts:1`', '-- another at `src/a.ts:2`', '+- another at `src/a.ts:3`', ' ']);
    });

    test('Owns changed in both files is one part, in both', async () => {
      await reviewed();
      await edit('plan.md', '- Owns: tests/fixture/index.ts', '- Owns: tests/fixture/main.ts');
      await edit('tasks/T3.md', '- tests/fixture/index.ts', '- tests/fixture/main.ts');

      const result = await diff(ISSUE, { home });
      assert.equal(result.ok && result.structural, false);
      assert.deepEqual(result.ok && result.tasks.changed.map((task) => [task.id, task.parts]), [['T3', [{ part: 'Owns', in: ['plan.md', 'tasks/T3.md'] }]]]);
    });

    test('the header fields of a plan task are each their own part; a line in none of them is Other', async () => {
      await reviewed();
      await edit('plan.md', '- After: T2, T3', '- After: T3');
      await edit('plan.md', '- Satisfies: R2\n- Owns: tests/specs', '- Satisfies: R1, R2\n- Owns: tests/specs');
      await edit('plan.md', '### T1: registry', '### T1: the registry');
      await edit('tasks/T1.md', '- Status: planned', '- Status: planned, see notes');

      const result = await diff(ISSUE, { home });
      assert.equal(result.ok && result.structural, false);
      assert.deepEqual(result.ok && result.tasks.changed.map((task) => [task.id, task.parts.map((entry) => entry.part)]), [
        ['T1', ['Title', 'Other']],
        ['T4', ['Satisfies', 'After']],
      ]);
    });

    test('a task added or removed, a frozen interface or the slice hypothesis changed: structural, and why', async () => {
      await reviewed();
      await edit('plan.md', '## Upstream compliance', '### T5: docs\n- Satisfies: R1\n- Owns: docs/a.md\n- Done when: `test -f docs/a.md`\n\n## Upstream compliance');
      const added = await diff(ISSUE, { home });
      assert.equal(added.ok && added.structural, true);
      assert.deepEqual(added.ok && added.tasks.added, ['T5']);
      assert.deepEqual(added.ok && added.because, ['tasks added: T5']);

      await writeFile(join(dir(), 'plan.md'), PLAN);
      await rm(join(dir(), 'tasks', 'T4.md'));
      await edit('plan.md', /### T4: spec[\s\S]*?Wait for the status\.\n/.exec(PLAN)?.[0] ?? '', '');
      const removed = await diff(ISSUE, { home });
      assert.deepEqual(removed.ok && removed.tasks.removed, ['T4']);
      assert.equal(removed.ok && removed.structural, true);

      await writeFile(join(dir(), 'plan.md'), PLAN);
      await writeFile(join(dir(), 'tasks', 'T4.md'), taskFile('T4', OWNS.T4));
      await edit('plan.md', 'register(name: string): void;', 'register(name: string): Disposable;');
      const frozen = await diff(ISSUE, { home });
      assert.deepEqual(frozen.ok && frozen.because, ['Frozen interfaces changed']);
      assert.deepEqual(frozen.ok && frozen.tasks.changed, []);

      await writeFile(join(dir(), 'plan.md'), PLAN);
      await edit('plan.md', '- Slice hypothesis: 2 slices', '- Slice hypothesis: 3 slices');
      const count = await diff(ISSUE, { home });
      assert.deepEqual(count.ok && count.because, ['Slice hypothesis changed']);
      assert.deepEqual(count.ok && count.other, ['header'], 'the header line changed too, and is said');
    });

    test('Upstream compliance and the other sections are reported, and are not structural', async () => {
      await reviewed();
      await edit('plan.md', '- SPDX headers needed: yes', '- SPDX headers needed: yes, two files');
      await edit('plan.md', '- `src/a.ts:1` — a', '- `src/a.ts:2` — a');

      const result = await diff(ISSUE, { home });
      assert.equal(result.ok && result.structural, false);
      assert.deepEqual(result.ok && result.plan, { frozenInterfaces: false, sliceHypothesis: false, upstreamCompliance: true });
      assert.deepEqual(result.ok && result.other, ['Context']);
    });

    test('a template comment edited is not a change to any part', async () => {
      await reviewed();
      await edit('plan.md', '<!-- Real signatures shared between tasks. -->', '<!-- Shared signatures. -->');

      const result = await diff(ISSUE, { home });
      assert.equal(result.ok && result.structural, false);
      assert.deepEqual(result.ok && result.plan, { frozenInterfaces: false, sliceHypothesis: false, upstreamCompliance: false });
      assert.deepEqual(result.ok && result.other, []);
    });

    test('a changed task carries its After edges both ways and the frozen interfaces it shares', async () => {
      await reviewed();
      await edit('plan.md', '  1. Call `Registry.register` at start.', '  1. Call `Registry.register` once, at start.');
      await edit('plan.md', '  1. Print the status.', '  1. Print the status line.');

      const result = await diff(ISSUE, { home });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const [wiring, fixture] = result.tasks.changed;

      // T2 is in T1's entry by naming what it declares, though the entry names only T1.
      assert.equal(wiring.id, 'T2');
      assert.deepEqual(wiring.neighbors.after, ['T1']);
      assert.deepEqual(wiring.neighbors.waitedOnBy, ['T4']);
      assert.deepEqual(wiring.neighbors.interfaces, [{ line: 13, head: '// src/registry.ts (T1)', declares: ['Registry'], with: ['T1'] }]);

      // T3 is in the contract its entry names it in, beside T4.
      assert.equal(fixture.id, 'T3');
      assert.deepEqual(fixture.neighbors.after, []);
      assert.deepEqual(fixture.neighbors.waitedOnBy, ['T4']);
      assert.deepEqual(
        fixture.neighbors.interfaces.map((entry) => [entry.line, entry.declares, entry.with]),
        [[18, [], ['T4']]],
      );
    });

    // In a plan written to the template now, the block in plan.md is a header
    // and an intent, and what a task consumes is named in its task file. Read
    // from plan.md alone, T2 dropped out of the entry it uses, and a delta
    // round was handed a changed task without the contract it shares.
    test('a task that names an interface only in its task file is in its entry; an intent is its own part', async () => {
      await writeFile(
        join(dir(), 'plan.md'),
        PLAN.replace(/- Steps:\n {2}1\. [^\n]*\n/g, '').replace('- After: T1\n', '- After: T1\n- Intent: wire the registry in at start.\n'),
      );
      await edit('tasks/T2.md', '1. Do it.', '1. Call `Registry.register` at start.');
      await reviewed();
      await edit('plan.md', '- Intent: wire the registry in at start.', '- Intent: wire the registry in once, at start.');

      const result = await diff(ISSUE, { home });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const [wiring] = result.tasks.changed;
      assert.deepEqual(wiring.parts, [{ part: 'Intent', in: ['plan.md'] }]);
      assert.deepEqual(wiring.neighbors.interfaces, [{ line: 13, head: '// src/registry.ts (T1)', declares: ['Registry'], with: ['T1'] }]);
    });

    test('compares with the plan the last review read, not the snapshot taken for the round under way', async () => {
      await reviewed();
      await edit('tasks/T3.md', '- another at `src/a.ts:2`', '- another at `src/a.ts:3`');
      await snapshot(ISSUE, { home });

      const result = await diff(ISSUE, { home });
      assert.deepEqual(await snapshots(ISSUE, { home }), [1, 2]);
      assert.equal(result.ok && result.base?.round, 1);
      assert.deepEqual(result.ok && result.tasks.changed.map((task) => task.id), ['T3']);
    });

    test('with no snapshot of a reviewed round, the one taken for the round under way, and says which', async () => {
      await review(1);
      await snapshot(ISSUE, { home });
      await edit('tasks/T3.md', '- another at `src/a.ts:2`', '- another at `src/a.ts:3`');

      const result = await diff(ISSUE, { home });
      assert.equal(result.ok && result.base?.round, 2);
      assert.equal(result.ok && result.lastRound, 1);
      assert.deepEqual(result.ok && result.tasks.changed.map((task) => task.id), ['T3']);
    });

    test('the text is cut to the lines asked for, and the total is kept', async () => {
      await reviewed();
      for (const id of Object.keys(OWNS)) await edit(`tasks/${id}.md`, '1. Do it.', '1. Do it now.');

      const result = await diff(ISSUE, { home, maxLines: 5 });
      assert.equal(result.ok && result.text.lines.length, 5);
      assert.equal(result.ok && result.text.total, 4 * 7);
    });
  });

  describe('pdkit plan snapshot, plan diff and plan check', () => {
    async function pdkit(...args) {
      try {
        const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { cwd: home, env: { ...process.env, PDKIT_HOME: home }, encoding: 'utf8' });
        return { code: 0, stdout, stderr };
      } catch (error) {
        return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
      }
    }

    test('snapshot, a change, and the diff that names it', async () => {
      const taken = await pdkit('plan', 'snapshot', String(ISSUE));
      assert.equal(taken.code, 0, taken.stderr);
      assert.match(taken.stdout, /round 1 — taken\n.*reviews[/\\]r1: plan\.md and 4 task file\(s\)/);
      assert.match((await pdkit('plan', 'snapshot', String(ISSUE))).stdout, /already taken, and the plan is the same/);

      await edit('tasks/T3.md', '- another at `src/a.ts:2`', '- another at `src/a.ts:3`');
      const text = await pdkit('plan', 'diff', String(ISSUE));
      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /against r1, taken for round 1, which has no review yet/);
      assert.match(text.stdout, /structural {3}no\n/);
      assert.match(text.stdout, /T3 {11}Context \(tasks\/T3\.md\)\n/);
      assert.match(text.stdout, /^\+- another at `src\/a\.ts:3`$/m);

      const json = JSON.parse((await pdkit('plan', 'diff', String(ISSUE), '--json')).stdout);
      assert.equal(json.structural, false);
      assert.equal('ok' in json, false);
      assert.deepEqual(json.tasks.changed[0].parts, [{ part: 'Context', in: ['tasks/T3.md'] }]);
    });

    test('a diff with no snapshot says there is nothing to compare with', async () => {
      const result = await pdkit('plan', 'diff', String(ISSUE));
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /no snapshot to compare with/);
    });

    // What a round reads, as numbers: a plan many times the size of its
    // reconnaissance is mostly claims about the code nobody has checked yet.
    // Facts only — the check passes or fails exactly as it did without them.
    test('plan check states the size of plan.md, tasks/ and research.md, and judges none of them', async () => {
      const tasks = Object.keys(OWNS).reduce((sum, id) => sum + Buffer.byteLength(taskFile(id, OWNS[id])), 0);
      const kb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;

      const before = await pdkit('plan', 'check', String(ISSUE));
      assert.match(before.stdout, new RegExp(`^ {2}size {2}plan\\.md ${kb(Buffer.byteLength(PLAN))}; tasks/ ${kb(tasks)} in 4 file\\(s\\); research\\.md absent$`, 'm'));

      await writeFile(join(dir(), 'research.md'), 'x'.repeat(1500));
      const after = await pdkit('plan', 'check', String(ISSUE));
      assert.equal(after.code, before.code);
      assert.match(after.stdout, /; research\.md 1\.5 KB$/m);
      assert.deepEqual(JSON.parse((await pdkit('plan', 'check', String(ISSUE), '--json')).stdout).sizes, {
        plan: Buffer.byteLength(PLAN),
        tasks: { bytes: tasks, files: 4 },
        research: 1500,
      });
    });
  });
});
