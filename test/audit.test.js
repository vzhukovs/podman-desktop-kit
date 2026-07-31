// SPDX-License-Identifier: Apache-2.0

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
import { transition } from '../lib/state.js';

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

describe('format', () => {
  test('leads with what is machine-checkable and says where judgement starts', async () => {
    const text = format(await collect({ issue: ISSUE, repoRoot: repo, base: 'main', home }));

    assert.match(text, /audit: issue 18248/);
    assert.match(text, /changed outside every task’s ownership/);
    assert.match(text, /App\.svelte/);
    assert.match(text, /facts, not a verdict/);
  });
});
