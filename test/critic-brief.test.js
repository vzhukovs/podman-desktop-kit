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

// The brief pd-plan-critic is handed, rendered from facts.
//
// What these protect: a critic prompt composed anew each round, whose hints
// decided what the critic found; a rejected item raised again because nothing
// told the critic it had been rejected; and probe results retold by hand
// rather than handed over as `plan check` printed them.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parsePlan } from '../lib/artefacts.js';
import { AXES, COVERAGE_CHECKS, brief } from '../lib/critic-brief.js';
import { allocateRequirement, freezeRequirements } from '../lib/ids.js';
import { diff, snapshot } from '../lib/plan-rounds.js';
import * as probe from '../lib/probe.js';
import { transition } from '../lib/state.js';

const exec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'pdkit');
const ISSUE = 17002;

/** Three tasks; T2 replaced by T3, so T2 is no longer work anybody will do. */
const PLAN = [
  `# PLAN: DESKTOP-${ISSUE}`,
  '',
  '- Requirements: R1 (frozen on approval)',
  '- e2e coverage: no — a helper',
  '- Slice hypothesis: 1 slices',
  '',
  '## Context',
  '- `src/a.ts:1` — a',
  '',
  '## Tasks',
  '### T1: a',
  '- Satisfies: R1',
  '- Owns: src/a.ts',
  '- Done when: `npx vitest run src/a.spec.ts`',
  '### T2: b',
  '- Satisfies: R1',
  '- Owns: src/b.ts',
  '- Done when: `npx vitest run src/b.spec.ts`',
  '### T3: b again',
  '- Satisfies: R1',
  '- Owns: src/b.ts',
  '- Replaces: T2',
  '- Done when: `npx tsc --noEmit -p src`',
  '',
  '## Slice hypothesis',
  'one',
  '',
].join('\n');

const ROUND_1 = [
  `# PLAN REVIEW: DESKTOP-${ISSUE} — round 1`,
  '### A1. The order of T1 and T3 is reversed',
  '### B1. A helper in another package does the same',
  '### B2. The test names mislead',
  '## Operator decisions (round 1)',
  '- A1: accepted — T3 after T1',
  '- B1: accepted as recommended',
  '- B2: rejected — keep the names',
  '- A1 (amended during revision): T3 waits on T1 in After, not in prose',
  '',
].join('\n');

const ROUND_2 = [
  `# PLAN REVIEW: DESKTOP-${ISSUE} — round 2`,
  '### A1. The fixture lacks a field its loader requires',
  '### B1. The directory rules ask for an inventory update',
  '### B2. A second runner is not handled',
  '### C1. The docs build was never run',
  '## Operator decisions (round 2)',
  '- A1: accepted',
  '- B1: rejected — not in this change',
  '- B2: accepted, variant (b) — skip under the second runner',
  '- C1: no decision',
  '- B3: deferred to the slice',
  '',
].join('\n');

/** Two packages, tests and a gate: T1 spans both packages, everything else waits on it. */
const SPLIT = [
  `# PLAN: DESKTOP-${ISSUE}`,
  '',
  '- Requirements: R1',
  '',
  '## Tasks',
  '### T1: api and registry',
  '- Owns: packages/extension-api/src/api.d.ts, packages/main/src/registry.ts',
  '- Done when: `npx vitest run packages/main/src/registry.spec.ts`',
  '### T2: wiring',
  '- Owns: packages/main/src/index.ts',
  '- After: T1',
  '- Done when: `npx vitest run packages/main/src/index.spec.ts`',
  '### T3: spec',
  '- Owns: tests/playwright/src/specs/registry.spec.ts',
  '- After: T1',
  '- Done when: `npx eslint tests/playwright/src/specs/registry.spec.ts`',
  '### T4: gate',
  '- Owns: (none — verification only, writes no files)',
  '- After: T1, T2, T3',
  '- Done when: `pnpm typecheck`',
  '',
].join('\n');

/** The task IDs of the coverage map's rows, in order. */
function coverageRows(text) {
  return [...text.matchAll(/^\| (T\d+) \|/gm)].map((row) => row[1]);
}

describe('brief', () => {
  let home;
  const homes = [];
  const dir = () => join(home, 'issues', String(ISSUE));

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-brief-'));
    homes.push(home);
    await mkdir(join(dir(), 'tasks'), { recursive: true });
  });
  after(async () => {
    for (const path of homes) await rm(path, { recursive: true, force: true });
  });

  /** The brief, with what every case shares filled in. */
  const render = (extra = {}) =>
    brief({
      issue: ISSUE,
      home,
      mode: 'full',
      area: null,
      plan: parsePlan(PLAN),
      record: {},
      check: [`plan check: issue ${ISSUE} — passes`],
      worktree: { error: 'not inside a git repository' },
      tree: null,
      ...extra,
    });

  test('every round rejected is listed; only the last round is listed to check', async () => {
    await writeFile(join(dir(), 'plan-review.r1.md'), ROUND_1);
    await writeFile(join(dir(), 'plan-review.md'), ROUND_2);

    const result = await render();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [, toCheck] = /### Accepted in the last round[^\n]*\n([\s\S]*?)\n### /.exec(result.text) ?? [];
    const [, rejected] = /### Rejected[^\n]*\n([\s\S]*?)\n## /.exec(result.text) ?? [];

    assert.equal(result.round, 3);
    assert.match(result.text, new RegExp(`^# PLAN CRITIC BRIEF: DESKTOP-${ISSUE} — round 3$`, 'm'));

    // Rejections from both rounds, each with the item it was about.
    assert.match(rejected, /- B2 \(round 1\) — The test names mislead\n {2}rejected — keep the names/);
    assert.match(rejected, /- B1 \(round 2\) — The directory rules ask for an inventory update\n {2}rejected — not in this change/);

    // Round 2's acceptances, and its line in no known form; round 1's
    // acceptances were checked by round 2 and are not handed over again.
    assert.match(toCheck, /- A1 \(round 2\) — The fixture lacks a field its loader requires\n {2}accepted/);
    assert.match(toCheck, /- B2 \(round 2\) — A second runner is not handled\n {2}accepted, variant \(b\)/);
    assert.match(toCheck, /- B3 \(round 2\)\n {2}deferred to the slice/);
    assert.doesNotMatch(toCheck, /round 1/);
    assert.doesNotMatch(toCheck, /C1/);

    // Round 1's amended line is in no list, and the caller is told so.
    assert.deepEqual(
      result.unread.map((entry) => [entry.round, entry.decision.id]),
      [[1, 'A1']],
    );
  });

  test('a first round has nothing earlier, and a delta round is refused', async () => {
    const result = await render();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.round, 1);
    assert.match(result.text, /### Accepted in the last round[^\n]*\n\nNone: this is the first round\./);
    assert.match(result.text, /### Rejected[^\n]*\n\n[^\n]*\n\nNone\./);

    const delta = await render({ mode: 'delta' });
    assert.equal(delta.ok, false);
    if (delta.ok) return;
    assert.match(delta.error, /needs an earlier round/);
  });

  // A delta round is handed the change since the plan the last round read:
  // what changed in each task and where, its neighbors, and the diff. Without
  // a snapshot of that plan, or over a structural change, it would claim the
  // rest of the plan was reviewed when nothing measured that.
  describe('delta', () => {
    /** Round 1 on disk, the plan snapshotted for round 2, round 2 written, then the plan revised. */
    async function revise(revised) {
      await writeFile(join(dir(), 'plan.md'), PLAN);
      await writeFile(join(dir(), 'plan-review.r1.md'), ROUND_1);
      await snapshot(ISSUE, { home });
      await writeFile(join(dir(), 'plan-review.md'), ROUND_2);
      await writeFile(join(dir(), 'plan.md'), revised);
      const found = await diff(ISSUE, { home });
      assert.equal(found.ok, true);
      return found.ok ? found : null;
    }

    /** T1's Done when changed, and a fenced step added to it. */
    const REVISED = PLAN.replace(
      '- Done when: `npx vitest run src/a.spec.ts`',
      '- Done when: `npx vitest run src/a.spec.ts --run`\n- Steps:\n  ```bash\n  npx vitest run src/a.spec.ts\n  ```',
    );

    test('its scope is the changed tasks with their neighbors, and its changes the diff', async () => {
      const delta = await revise(REVISED);
      const result = await render({ mode: 'delta', plan: parsePlan(REVISED), delta });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.match(result.text, /^Delta: what changed since round 2 read the plan, and its neighbors\. The change is not structural/m);
      assert.match(result.text, /## Scope\n\nThe tasks changed since round 2 read the plan: T1 — 1 of 2 live task\(s\)\./);
      assert.match(result.text, /- T1 — a\n {2}Changed: Done when \(plan\.md\); Steps \(plan\.md\)\n {2}After: none\. Waited on by: none\./);
      assert.match(result.text, /Compared with `[^`]*reviews[/\\]r2`, the plan round 2 read\./);
      assert.match(result.text, /- Frozen interfaces: unchanged\. Slice hypothesis: unchanged\. Upstream compliance: unchanged\./);
      // Longer than the fence the diff carries, so that one does not close it.
      assert.match(result.text, /^````diff\n--- r2\/plan\.md\n\+\+\+ plan\.md\n[\s\S]*^\+ {2}```bash$[\s\S]*^````$/m);
      assert.deepEqual(coverageRows(result.text), ['T1']);
      // The decisions to check are listed in a delta round as in a full one.
      assert.match(result.text, /- A1 \(round 2\) — The fixture lacks a field its loader requires/);
    });

    test('is refused without a snapshot of the plan the last round read', async () => {
      await writeFile(join(dir(), 'plan-review.md'), ROUND_2);
      const result = await render({ mode: 'delta', delta: null });
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.error, /no snapshot of that plan \(reviews\/r2\/\): this round is a full one/);

      const full = await render({ delta: null });
      assert.match(full.ok ? full.text : '', /^Full: the whole scope below — the plan round 2 read has no snapshot in `reviews\/`/m);
    });

    test('is refused over a structural change, and the full brief says why it is full', async () => {
      const added = `${REVISED}### T4: c\n- Satisfies: R1\n- Owns: src/c.ts\n- Done when: \`true\`\n`;
      const delta = await revise(added);
      const result = await render({ mode: 'delta', plan: parsePlan(added), delta });
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.error, /structural — tasks added: T4: a delta round does not cover it/);

      const full = await render({ plan: parsePlan(added), delta });
      assert.match(full.ok ? full.text : '', /^Full: the whole scope below — the change since round 2 is structural: tasks added: T4\.$/m);
      assert.match(full.ok ? full.text : '', /## Changes since the last round\n\nNone: a full round reviews the whole scope\./);
    });

    test('takes no area and no axis: it is one critic over what changed', async () => {
      const delta = await revise(REVISED);
      for (const extra of [{ area: ['src'] }, { axis: 'duplication' }]) {
        const result = await render({ mode: 'delta', plan: parsePlan(REVISED), delta, ...extra });
        assert.match(result.ok ? '' : result.error, /takes no --area or --axis/);
      }
    });

    test('a full round that could have been a delta says so, and a first round says it is the first', async () => {
      const delta = await revise(REVISED);
      const full = await render({ plan: parsePlan(REVISED), delta });
      assert.match(full.ok ? full.text : '', /^Full: the whole scope below — the change since round 2 is not structural, and a full round was asked for\.$/m);

      await rm(join(dir(), 'plan-review.md'));
      await rm(join(dir(), 'plan-review.r1.md'));
      const first = await render();
      assert.match(first.ok ? first.text : '', /^Full: the whole scope below — this is the first round\.$/m);
    });
  });

  test('with no area, the scope is the whole plan, its live tasks named, each a row of the coverage map', async () => {
    const result = await render({ record: { withdrawn: {} } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /## Scope\n\nThe whole plan: T1, T3\.\n/);
    assert.deepEqual(coverageRows(result.text), ['T1', 'T3']);

    const withdrawn = await render({ record: { withdrawn: { T1: { by: 'A1' } } } });
    assert.match(withdrawn.ok ? withdrawn.text : '', /The whole plan: T3\.\n/);
  });

  // A plan split between critics: each sees its own tasks whole, and every
  // edge that leaves its scope with where it goes — the dependency the other
  // side's critic would not mention.
  test('an area narrows the scope to its tasks, with the edges that leave it', async () => {
    const result = await render({ plan: parsePlan(SPLIT), area: ['packages/main', 'packages/extension-api'] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [, scope] = /## Scope\n\n([\s\S]*?)\n## /.exec(result.text) ?? [];

    assert.match(scope, /^The areas `packages\/main`, `packages\/extension-api`: T1, T2 — 2 of 4 live task\(s\)\.$/m);
    assert.match(scope, /^Outside it: T3, T4\.$/m);
    // Every file a task owns, those in another area too: a task is one change.
    assert.match(scope, /^ {2}Owns: `packages\/extension-api\/src\/api\.d\.ts`, `packages\/main\/src\/registry\.ts`$/m);
    assert.match(scope, /^ {2}After: none\. Waited on by: T2, T3 \(tests — outside\), T4 \(gate — outside\)\.$/m);
    assert.deepEqual(coverageRows(result.text), ['T1', 'T2']);

    const gate = await render({ plan: parsePlan(SPLIT), area: ['gate'] });
    assert.match(gate.ok ? gate.text : '', /^ {2}Owns: nothing — a verification$/m);
    assert.match(gate.ok ? gate.text : '', /^ {2}After: T1 \(packages\/extension-api, packages\/main — outside\), T2 \(packages\/main — outside\), T3 \(tests — outside\)\. Waited on by: none\.$/m);
  });

  test('an axis runs across the whole plan, every live task a row of its map', async () => {
    const result = await render({ plan: parsePlan(SPLIT), axis: 'duplication' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /## Scope\n\nThe axis `duplication` — duplication and maintainer rules — across the whole plan: T1, T2, T3, T4\.\n/);
    assert.deepEqual(coverageRows(result.text), ['T1', 'T2', 'T3', 'T4']);
  });

  // A brief headed "e2e" over a plan with no task there would claim a scope
  // nothing measured; an axis over an area would be neither.
  test('refuses an area the plan has none of, an axis it does not know, and both together', async () => {
    const plan = parsePlan(SPLIT);
    const unknown = await render({ plan, area: ['e2e'] });
    assert.match(unknown.ok ? '' : unknown.error, /the plan has no area e2e; its areas are packages\/extension-api, packages\/main, tests, gate/);
    const empty = await render({ plan, area: [] });
    assert.match(empty.ok ? '' : empty.error, /--area needs the name of an area/);
    const axis = await render({ plan, axis: 'naming' });
    assert.match(axis.ok ? '' : axis.error, /--axis is one of duplication, not "naming"/);
    const both = await render({ plan, area: ['tests'], axis: 'duplication' });
    assert.match(both.ok ? '' : both.error, /an area or an axis, not both/);
  });

  // The brief prints the columns; the critic's definition says what each one
  // is. A column renamed in one and not the other is a check nobody makes.
  test('the critic\'s definition names every coverage check and every axis', async () => {
    const agent = await readFile(join(ROOT, 'agents', 'pd-plan-critic.md'), 'utf8');
    for (const check of COVERAGE_CHECKS) assert.ok(agent.includes(`**${check}**`), `agents/pd-plan-critic.md does not define the check "${check}"`);
    for (const axis of Object.keys(AXES)) assert.ok(agent.includes(`\`${axis}\``), `agents/pd-plan-critic.md does not define the axis "${axis}"`);

    const result = await render();
    const header = `| Task | ${COVERAGE_CHECKS.join(' | ')} |`;
    assert.ok(result.ok && result.text.includes(header));
  });

  test('says which of the paths it names are absent', async () => {
    await writeFile(join(dir(), 'plan.md'), PLAN);
    const result = await render();
    assert.match(result.ok ? result.text : '', /- Plan: `[^`]+plan\.md`\n/);
    assert.match(result.ok ? result.text : '', /- Tasks: `[^`]+tasks` — 0 task file\(s\)\n/);
    assert.match(result.ok ? result.text : '', /- Research: `[^`]+research\.md` — absent\n/);
    assert.match(result.ok ? result.text : '', /- Worktree: none — not inside a git repository\n/);
  });

  test('the guidance comments do not reach the critic', async () => {
    const result = await render();
    assert.doesNotMatch(result.ok ? result.text : '<!--', /<!--/);
  });
});

// End to end through bin/pdkit: the probe lines in the brief are the ones
// `plan check` prints, red exit and last line included.
describe('pdkit plan brief', () => {
  let home;
  const homes = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-brief-cli-'));
    homes.push(home);
    await transition(ISSUE, 'triaged', { home, route: 'standard' });
    await allocateRequirement(ISSUE, { home });
    await freezeRequirements(ISSUE, { home });
    await writeFile(join(home, 'issues', String(ISSUE), 'plan.md'), PLAN);
  });
  after(async () => {
    for (const path of homes) await rm(path, { recursive: true, force: true });
  });

  async function pdkit(...args) {
    try {
      const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { cwd: home, env: { ...process.env, PDKIT_HOME: home }, encoding: 'utf8' });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
  }

  /** T1 passes; T3's typecheck fails before its code exists, with a last line worth reading. */
  const capture = async ({ command }) => ({
    command,
    exitCode: command.includes('tsc') ? 2 : 0,
    stdout: command.includes('tsc') ? 'compiling\nerror TS5058: the specified path does not exist: src\n' : 'ok\n',
    stderr: '',
    durationMs: 5,
    at: '2026-11-11T00:00:00.000Z',
    complete: true,
  });

  test('the check report, with each red probe and its last line', async () => {
    await probe.run({
      issue: ISSUE,
      cwd: home,
      home,
      capture,
      tasks: [
        { id: 'T1', command: 'npx vitest run src/a.spec.ts' },
        { id: 'T3', command: 'npx tsc --noEmit -p src' },
      ],
    });

    const out = await pdkit('plan', 'brief', String(ISSUE));
    assert.equal(out.code, 0, out.stderr);
    const [, report] = /## `pdkit plan check`[\s\S]*?```text\n([\s\S]*?)\n```/.exec(out.stdout) ?? [];
    // Whatever the check prints, problems included: this plan lacks the
    // template's later sections, and the brief says so as the check does.
    assert.match(report, new RegExp(`^plan check: issue ${ISSUE} — \\d+ problem\\(s\\)$`, 'm'));
    assert.match(report, /^ {2}✘ sections {9}the plan has no "Open decisions" section$/m);
    assert.match(report, /^ {2}! done-when-run {4}T3's Done when exited 2 on .* — last line: error TS5058: the specified path does not exist: src$/m);
    assert.doesNotMatch(report, /T1's Done when/);
    // The closing paragraph of `plan check` is advice to a person, not a fact.
    assert.doesNotMatch(out.stdout, /What is left is the question no grep answers/);
  });

  test('refuses an area the plan has none of, a mode it does not know, and an issue with no plan', async () => {
    assert.match((await pdkit('plan', 'brief', String(ISSUE), '--area', 'e2e')).stderr, /the plan has no area e2e; its areas are src/);
    assert.match((await pdkit('plan', 'brief', String(ISSUE), '--mode', 'partial')).stderr, /--mode is one of full, delta/);
    const none = await pdkit('plan', 'brief', '17003');
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /plan\.md does not exist/);
  });
});
