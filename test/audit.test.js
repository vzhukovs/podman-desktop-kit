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

// Tests for lib/audit.js.
//
// The finding this exists for is a file changed outside every task's Owns set.
// The pre-write hook is silent when no task was ever started, so this is the
// only place such a change is certain to be seen — which makes it the one case
// worth building a real repository and a real diff for.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { collect, format } from '../lib/audit.js';
import { issueDir } from '../lib/config.js';
import { writeReceipt } from '../lib/evidence.js';
import { append } from '../lib/journal.js';
import { transition, withdrawTask } from '../lib/state.js';

const execFileAsync = promisify(execFile);

const ISSUE = 18248;

let home;
let repo;

const run = (over = {}) => ({
  command: 'pnpm test:main',
  exitCode: 0,
  stdout: 'ok\n',
  stderr: '',
  durationMs: 10,
  at: '2026-07-31T10:00:00.000Z',
  complete: true,
  ...over,
});

/**
 * @param {string} id
 * @param {string} owns
 * @param {string} satisfies
 */
async function task(id, owns, satisfies) {
  await mkdir(join(issueDir(home, ISSUE), 'tasks'), { recursive: true });
  await writeFile(
    join(issueDir(home, ISSUE), 'tasks', `${id}.md`),
    [`# ${id}: work`, '', `- Issue: ${ISSUE}`, `- Satisfies: ${satisfies}`, '', '## Owns', owns, '', '## Done when', '```bash', 'pnpm test:main', '```', ''].join('\n'),
  );
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-audit-home-'));
  repo = await mkdtemp(join(tmpdir(), 'pdkit-audit-repo-'));

  const git = (args) => execFileAsync('git', args, { cwd: repo });

  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'commit.gpgsign', 'false']);

  await mkdir(join(repo, 'packages/main/src'), { recursive: true });
  await mkdir(join(repo, 'packages/renderer/src'), { recursive: true });
  await writeFile(join(repo, 'packages/main/src/registry.ts'), 'export const a = 1;\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'chore: base']);

  await git(['checkout', '-q', '-b', 'DESKTOP-18248/fix']);
  await writeFile(join(repo, 'packages/main/src/registry.ts'), 'export const a = 2;\n');
  // The one nobody planned for.
  await writeFile(join(repo, 'packages/renderer/src/App.svelte'), '<div />\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'fix(main): join arguments']);

  await transition(ISSUE, 'triaged', { home });
  await writeFile(
    join(issueDir(home, ISSUE), 'plan.md'),
    [
      '# PLAN: DESKTOP-18248',
      '',
      '- Requirements: R1, R2 (frozen on approval)',
      '- e2e coverage: no — quickfix route',
      '',
      '## Context',
      '- `packages/main/src/registry.ts:1`',
      '',
      '## Frozen interfaces',
      '```ts',
      'none',
      '```',
      '',
      '## Tasks',
      '### T1: fix it',
      '- Satisfies: R1',
      '- Owns: packages/main/src/registry.ts',
      '- Done when: `pnpm test:main`',
      '',
      '## Upstream compliance',
      '- SPDX headers needed: no',
      '',
      '## Slice hypothesis',
      'One slice.',
      '',
      '## Open decisions',
      'none',
      '',
    ].join('\n'),
  );

  await task('T1', 'packages/main/src/registry.ts', 'R1');
});

after(async () => {
  for (const dir of [home, repo]) await rm(dir, { recursive: true, force: true });
});

describe('collect', () => {
  const audit = () => collect({ issue: ISSUE, repoRoot: repo, base: 'main', home });

  // The finding the hook cannot make.
  // It diffed against the literal 'main' — not even repo.base_branch — so a
  // fork whose base branch is named anything else audited against a ref that
  // may not exist. And a branch name is the wrong thing to diff against on a
  // fork at all: the same defect preflight had, where a stale local copy turned
  // three files into 805.
  test('the base is resolved, and the configured branch is the one it starts from', async () => {
    const report = await collect({
      issue: ISSUE,
      repoRoot: repo,
      config: { repo: { base_branch: 'main', upstream_remote: 'upstream' } },
      home,
    });

    // No upstream remote in the fixture, so it falls back to the local branch —
    // and reports which ref it read rather than assuming one.
    assert.equal(report.diff.base, 'main');
    assert.ok(report.diff.files.length > 0, 'the diff was actually taken');
  });

  test('a file changed outside every task’s ownership is reported', async () => {
    const report = await audit();

    assert.deepEqual(report.unowned, ['packages/renderer/src/App.svelte']);
    assert.equal(report.diff.files.length, 2);
  });

  test('a requirement with no task is reported', async () => {
    const report = await audit();

    assert.deepEqual(report.uncovered, ['R2']);
  });

  test('a task with no receipt is reported as missing, not as done', async () => {
    const report = await audit();

    assert.deepEqual(report.receipts.missing, ['T1']);
    assert.equal(report.tasks[0].receipt, 'missing');
  });

  test('a receipt for a failing run is not counted as evidence of a finished task', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    const report = await audit();

    assert.deepEqual(report.receipts.failed, ['T1']);
    assert.equal(report.receipts.missing.length, 0);
  });

  test('a genuine passing receipt is accepted', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });
    const report = await audit();

    assert.equal(report.tasks[0].receipt, 'ok');
    assert.equal(report.tasks[0].command, 'pnpm test:main');
  });

  test('the plan is run through the same mechanical checks as plan-review', async () => {
    const report = await audit();

    assert.equal(report.plan.found, true);
    assert.ok(report.plan.problems.some((problem) => problem.check === 'coverage'));
  });

  // No verdict field, no overall ok: a collector that graded its own findings
  // would be the second opinion the audit is meant to be getting.
  test('the report states facts and passes no judgement', async () => {
    const report = await audit();

    assert.equal(report.verdict, undefined);
    assert.equal(report.ok, undefined);
  });

  test('without a repository the artefacts are still reported', async () => {
    const report = await collect({ issue: ISSUE, home });

    assert.deepEqual(report.diff.files, []);
    assert.equal(report.tasks.length, 1);
  });
});

// Whether a task went to a worker or was done in the session is read from the
// journal, never from the agent: `agent-done` names the task that was active
// in the agent's tree. And a task from before the hook recorded anything is
// "not recorded", not "no implementer" — the hook sat on an event subagents
// never raise for four months, and a count over that silence would be a claim
// nobody measured.
describe('who did each task', () => {
  const OTHER = 18300;
  let own;

  before(async () => {
    own = await mkdtemp(join(tmpdir(), 'pdkit-audit-workers-'));
    const dir = join(issueDir(own, OTHER), 'tasks');
    await mkdir(dir, { recursive: true });
    for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T10']) {
      await writeFile(join(dir, `${id}.md`), [`# ${id}: work`, '', `- Issue: ${OTHER}`, '- Satisfies: R1', '', '## Owns', `packages/main/src/${id}.ts`, ''].join('\n'));
    }

    const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00Z`;
    const entries = [
      // T1 ran before the journal recorded any subagent at all.
      { at: at(0), event: 'task-start', detail: 'T1 in /w' },
      { at: at(1), event: 'agent-done', issue: 99999, detail: 'agent task a0; pd:pd-scout' },
      // T2: an implementer, restarted in a second session, and a scout.
      { at: at(2), event: 'task-start', detail: 'T2 in /w' },
      { at: at(3), event: 'agent-done', detail: 'agent task a1; pd:pd-scout; while T2 was active' },
      { at: at(4), event: 'agent-done', detail: 'agent task a2; pd:pd-implementer; while T2 was active' },
      { at: at(5), event: 'task-start', detail: 'T2 in /w' },
      { at: at(6), event: 'agent-done', detail: 'agent task a3; pd:pd-implementer; while T2 was active' },
      // T3: only a scout — the work was done in the session.
      { at: at(7), event: 'task-start', detail: 'T3 in /w' },
      { at: at(8), event: 'agent-done', detail: 'agent task a4; pd:pd-scout; while T3 was active' },
      // T4: started, nothing ran. T10's run must not be credited to T1.
      { at: at(9), event: 'task-start', detail: 'T4 in /w' },
      { at: at(10), event: 'task-start', detail: 'T10 in /w' },
      { at: at(11), event: 'agent-done', detail: 'agent task a5; while T10 was active' },
    ];
    for (const entry of entries) await append({ issue: OTHER, ...entry }, { home: own });
  });

  after(() => rm(own, { recursive: true, force: true }));

  const workers = async () => Object.fromEntries((await collect({ issue: OTHER, home: own })).tasks.map((task) => [task.id, task.worker]));

  test('implementer runs are counted across every start of the task', async () => {
    assert.deepEqual((await workers()).T2, { seen: 'implementer', implementerRuns: 2, others: ['pd:pd-scout'] });
  });

  test('a task only other agents ran for is reported with what did run', async () => {
    assert.deepEqual((await workers()).T3, { seen: 'other', implementerRuns: 0, others: ['pd:pd-scout'] });
  });

  test('a run the host sent no type for is not taken for an implementer', async () => {
    assert.deepEqual((await workers()).T10, { seen: 'other', implementerRuns: 0, others: ['type not recorded'] });
  });

  test('a task started before the journal recorded any subagent is not recorded, not none', async () => {
    const all = await workers();
    assert.equal(all.T1.seen, 'unrecorded');
    assert.equal(all.T4.seen, 'none');
    assert.equal(all.T5.seen, 'not-started');
  });

  test('the summary lists the tasks no implementer ran for, and the text says how many', async () => {
    const report = await collect({ issue: OTHER, home: own });

    assert.deepEqual(report.workers, { withoutImplementer: ['T3', 'T4', 'T10'], unrecorded: ['T1'], notStarted: ['T5'] });
    assert.match(format(report), /tasks no pd-implementer ran for: T3, T4, T10 \(3 of 6\)/);
    assert.match(format(report), /T2 .*worker pd-implementer ×2/);
  });
});

describe('format', () => {
  test('leads with what is machine-checkable and says where judgement starts', async () => {
    const text = format(await collect({ issue: ISSUE, repoRoot: repo, base: 'main', home }));

    assert.match(text, /audit: issue 18248/);
    assert.match(text, /changed outside every task’s ownership/);
    assert.match(text, /App\.svelte/);
    assert.match(text, /facts, not a verdict/);
  });
});

// On 18915 A1 replaced T2–T4 and the audit reported "receipts not ok: T2, T3,
// T4" — the same words it uses for a task somebody forgot to finish. The two
// are different findings: one is owed, the other was taken out of the plan.
describe('a withdrawn task and a forgotten one', () => {
  const AMENDED = 18915;

  /**
   * @param {string} id
   * @param {string} owns
   * @param {string} status
   */
  async function amendedTask(id, owns, status) {
    await mkdir(join(issueDir(home, AMENDED), 'tasks'), { recursive: true });
    await writeFile(
      join(issueDir(home, AMENDED), 'tasks', `${id}.md`),
      [`# ${id}: work`, '', `- Issue: ${AMENDED}`, '- Satisfies: R1', `- Status: ${status}`, '', '## Owns', owns, '', '## Done when', '```bash', 'pnpm test:main', '```', ''].join('\n'),
    );
  }

  before(async () => {
    await transition(AMENDED, 'triaged', { home });
    // Forgotten: live, and nobody wrote its receipt.
    await amendedTask('T1', 'packages/main/src/registry.ts', 'pending');
    // Withdrawn in its own file, the way `amendment approve` marks it.
    await amendedTask('T2', 'packages/main/src/other.ts', 'withdrawn by A1 (replaced by T5)');
    // Withdrawn in the record only, owning the file the diff changed outside the plan.
    await amendedTask('T3', 'packages/renderer/src/App.svelte', 'pending');
    await withdrawTask(AMENDED, { task: 'T3', amendment: 'A1', replacedBy: ['T5'], home });
    await amendedTask('T5', 'packages/main/src/registry.ts', 'pending');
    await writeReceipt({ issue: AMENDED, taskId: 'T5', run: run(), home });
  });

  const audit = () => collect({ issue: AMENDED, repoRoot: repo, base: 'main', home });

  test('only the live task without a receipt is counted as missing', async () => {
    const report = await audit();

    assert.deepEqual(report.receipts.missing, ['T1']);
    assert.deepEqual(
      report.withdrawn,
      [
        { id: 'T2', amendment: 'A1', replacedBy: ['T5'] },
        { id: 'T3', amendment: 'A1', replacedBy: ['T5'] },
      ],
    );
  });

  test('a file only a withdrawn task owned is changed outside every task\'s ownership', async () => {
    const report = await audit();
    assert.deepEqual(report.unowned, ['packages/renderer/src/App.svelte']);
  });

  test('the text names the withdrawal and its amendment, and marks the forgotten task red', async () => {
    const text = format(await audit());

    assert.match(text, /– T2 {2}withdrawn by A1 \(amendments\/A1\.md\), replaced by T5 {2}receipt not owed/);
    assert.match(text, /– T3 {2}withdrawn by A1/);
    assert.match(text, /✘ T1 .*receipt missing/);
  });
});
