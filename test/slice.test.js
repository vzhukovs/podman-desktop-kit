// SPDX-License-Identifier: Apache-2.0

// Contract for lib/slice.js — the graph half.
//
// What is defended here is that the mechanical refusals actually refuse. Every
// rule in build() exists because the shape it rejects produces a pull request
// that cannot be reviewed, merged or reverted on its own, and every one of them
// is the kind of set arithmetic a model can get subtly wrong while sounding
// certain. If these tests pass, the slicer is free to spend its judgement on
// the question no grep answers: whether the slice justifies itself at all.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanup, commitAll, git, initRepo, packageMap, seedWorkspace, writeFiles, writeTask } from './helpers/repo-fixture.js';
import { issueDir } from '../lib/config.js';
import { validateReceipt } from '../lib/evidence.js';
import * as ids from '../lib/ids.js';
import { fetchPullRequestHead } from '../lib/repo.js';
import * as slice from '../lib/slice.js';
import * as state from '../lib/state.js';

const ISSUE = 4242;

const CONFIG = {
  // npm rather than pnpm: the fixture's scripts are plain node, and the
  // verification has to actually run them.
  repo: { base_branch: 'main', package_manager: 'npm' },
  branches: { single: 'DESKTOP-{issue}/{slug}', sliced: 'DESKTOP-{issue}/{index}-{slug}' },
  slicing: {
    strategy: 'prefer-independent',
    max_files_per_slice: 12,
    layer_order: ['extension-api', 'main', 'ui', 'tests'],
    // Installing is covered in the worktree suite; here it would be minutes of
    // npm for a workspace with no dependencies.
    verify: { worktree: 'reuse', install: 'never' },
  },
  worktrees: { root: null, copy_files: [] },
};

const API = 'packages/extension-api/src/api.ts';
const EXEC = 'packages/main/src/exec.ts';
const THEME = 'packages/ui/src/theme.ts';
const SPEC = 'tests/playwright/theme.spec.ts';

let repo;
let home;
let trees;
let collected;

/** @returns {object} CONFIG with the worktree root pointing beside the fixture */
function config() {
  return { ...CONFIG, worktrees: { ...CONFIG.worktrees, root: trees } };
}

/**
 * @param {string} id
 * @param {string[]} satisfies
 * @param {string[]} owns
 */
function task(id, satisfies, owns) {
  return writeTask({ home, issue: ISSUE, id, satisfies, owns });
}

before(async () => {
  repo = await initRepo('pdkit-slice-');
  home = await initRepo('pdkit-slice-home-');
  trees = join(repo, '..', `${repo.split('/').pop()}-trees`);

  await seedWorkspace(repo);
  await commitAll(repo, 'chore: seed');

  await git(['checkout', '-b', `DESKTOP-${ISSUE}/work`], repo);
  await writeFiles(repo, {
    [API]: '// SPDX-License-Identifier: Apache-2.0\nexport const version = 1;\nexport interface RunOptions { env?: string }\n',
    [EXEC]: '// SPDX-License-Identifier: Apache-2.0\nimport type { RunOptions } from "@fixture/api";\nexport function exec(_options: RunOptions) {}\n',
    [THEME]: '// SPDX-License-Identifier: Apache-2.0\nexport const theme = "high-contrast";\n',
    [SPEC]: '// SPDX-License-Identifier: Apache-2.0\n// contrast smoke test\n',
  });
  await commitAll(repo, 'feat: the whole change set');

  await state.transition(ISSUE, 'triaged', { home });
  await state.transition(ISSUE, 'planned', { home });
  for (let i = 0; i < 4; i += 1) await ids.allocateRequirement(ISSUE, { home });
  await ids.freezeRequirements(ISSUE, { home });

  await task('T1', ['R1'], [API]);
  await task('T2', ['R2'], [EXEC]);
  await task('T3', ['R3', 'R4'], ['packages/ui/**', 'tests/playwright/**']);

  collected = await slice.facts({ issue: ISSUE, repoRoot: repo, home, config: CONFIG, packageMap: packageMap(repo) });
});

after(async () => {
  await cleanup(repo, home, trees);
});

/**
 * @param {Array<object>} slices
 * @param {object} [extra]
 */
function proposal(slices, extra = {}) {
  return { strategy: 'prefer-independent', slices, ...extra };
}

/**
 * @param {object} input
 */
function build(input) {
  return slice.build({ issue: ISSUE, facts: collected, config: CONFIG, ...input });
}

/** The graph the rest of the suite treats as correct. */
const GOOD = [
  { slug: 'extension-api-run-options', title: 'add RunOptions', files: [API], baseSlice: null },
  { slug: 'main-exec-plumbing', title: 'thread RunOptions', files: [EXEC], baseSlice: 1 },
  { slug: 'ui-contrast', title: 'high contrast', files: [THEME, SPEC], baseSlice: null },
];

describe('facts', () => {
  test('maps every changed file to its package, layer, tasks and R-IDs', () => {
    const byPath = new Map(collected.files.map((file) => [file.path, file]));

    assert.deepEqual(byPath.get(API), { path: API, status: 'M', package: '@fixture/api', layer: 'extension-api', tasks: ['T1'], requirements: ['R1'] });
    assert.deepEqual(byPath.get(SPEC).requirements, ['R3', 'R4']);
    assert.equal(byPath.get(SPEC).layer, 'tests');
    assert.equal(byPath.get(SPEC).status, 'A');
  });

  test('carries the frozen requirement set and the route', () => {
    assert.deepEqual(collected.requirements, ['R1', 'R2', 'R3', 'R4']);
    assert.equal(collected.route, 'standard');
  });
});

describe('draft', () => {
  test('groups by layer, in merge order', () => {
    const drafted = slice.draft(collected);

    assert.deepEqual(
      drafted.slices.map((entry) => entry.files),
      [[API], [EXEC], [THEME], [SPEC]],
    );
  });
});

describe('build', () => {
  test('accepts a graph that holds, and derives what it can derive', () => {
    const result = build({ proposal: proposal(GOOD) });

    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);

    const [first, second, third] = result.graph.slices;
    assert.equal(first.index, 1);
    assert.equal(first.branch, `DESKTOP-${ISSUE}/1-extension-api-run-options`);
    assert.deepEqual(first.requirements, ['R1']);
    assert.equal(second.baseSlice, 1);
    assert.deepEqual(third.layers, ['tests', 'ui']);
    assert.deepEqual(third.requirements, ['R3', 'R4']);
    assert.deepEqual(third.files, [THEME, SPEC].sort());
  });

  test('two slices claiming the same file is refused, by name', () => {
    const result = build({
      proposal: proposal([
        { slug: 'a', files: [API, EXEC], baseSlice: null },
        { slug: 'b', files: [EXEC, THEME, SPEC], baseSlice: null },
      ]),
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'exclusive-files' && problem.detail.includes(EXEC)));
  });

  // The other direction of the rule lib/audit.js applies to Owns. A file in no
  // slice never reaches a pull request, and nothing downstream would notice.
  test('a changed file in no slice is refused', () => {
    const result = build({ proposal: proposal([{ slug: 'partial', files: [API], baseSlice: null }]) });

    assert.equal(result.ok, false);
    const coverage = result.problems.find((problem) => problem.check === 'coverage');
    assert.ok(coverage);
    assert.match(coverage.detail, /packages\/main\/src\/exec\.ts/);
  });

  test('a file that is not in the diff at all is refused', () => {
    const result = build({
      proposal: proposal([
        { slug: 'a', files: [API, 'packages/main/src/imagined.ts'], baseSlice: null },
        { slug: 'b', files: [EXEC, THEME, SPEC], baseSlice: null },
      ]),
    });

    assert.ok(result.problems.some((problem) => problem.detail.includes('imagined.ts')));
  });

  test('a cycle between bases is refused', () => {
    const result = build({
      proposal: proposal([
        { slug: 'a', files: [API], baseSlice: 2 },
        { slug: 'b', files: [EXEC], baseSlice: 1 },
        { slug: 'c', files: [THEME, SPEC], baseSlice: null },
      ]),
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.check === 'base' && problem.detail.includes('cycle')));
  });

  test('a base that is not a slice is refused', () => {
    const result = build({
      proposal: proposal([
        { slug: 'a', files: [API], baseSlice: null },
        { slug: 'b', files: [EXEC, THEME, SPEC], baseSlice: 9 },
      ]),
    });

    assert.ok(result.problems.some((problem) => problem.check === 'base' && problem.detail.includes('#9')));
  });

  describe('the public API change goes alone and goes first (section 10, scenario 12)', () => {
    test('mixed with another layer: refused', () => {
      const result = build({
        proposal: proposal([
          { slug: 'a', files: [API, EXEC], baseSlice: null },
          { slug: 'b', files: [THEME, SPEC], baseSlice: null },
        ]),
      });

      assert.ok(result.problems.some((problem) => problem.check === 'extension-api' && problem.detail.includes(EXEC)));
    });

    test('merging after another slice: refused', () => {
      const result = build({
        proposal: proposal([
          { slug: 'ui', files: [THEME, SPEC], baseSlice: null },
          { slug: 'api', files: [API], baseSlice: null },
          { slug: 'main', files: [EXEC], baseSlice: 2 },
        ]),
      });

      assert.ok(result.problems.some((problem) => problem.check === 'extension-api' && problem.detail.includes('merges after')));
    });
  });

  test('a requirement that reaches no slice is refused', () => {
    // T3 owns the ui and tests files, so dropping them drops R3 and R4 —
    // exactly the shape where a requirement is planned and never shipped.
    const narrowed = { ...collected, files: collected.files.filter((file) => file.path === API || file.path === EXEC) };
    const result = build({
      facts: narrowed,
      proposal: proposal([
        { slug: 'a', files: [API], baseSlice: null },
        { slug: 'b', files: [EXEC], baseSlice: 1 },
      ]),
    });

    assert.ok(result.problems.some((problem) => problem.check === 'requirements' && problem.detail.includes('R3, R4')));
  });

  test('on quickfix there are no R-IDs to miss', () => {
    const quickfix = {
      ...collected,
      route: 'quickfix',
      files: collected.files.filter((file) => file.path === API || file.path === EXEC),
    };
    const result = build({
      facts: quickfix,
      proposal: proposal([
        { slug: 'a', files: [API], baseSlice: null },
        { slug: 'b', files: [EXEC], baseSlice: 1 },
      ]),
    });

    assert.equal(result.problems.some((problem) => problem.check === 'requirements'), false);
  });

  test('spanning layers and going over the size threshold warn rather than refuse', () => {
    const result = build({
      proposal: proposal(GOOD),
      config: { ...CONFIG, slicing: { ...CONFIG.slicing, max_files_per_slice: 1 } },
    });

    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((warning) => warning.check === 'layers'));
    assert.ok(result.warnings.some((warning) => warning.check === 'size'));
  });

  test('an empty slice and a duplicate slug are refused', () => {
    const result = build({
      proposal: proposal([
        { slug: 'same', files: [API], baseSlice: null },
        { slug: 'same', files: [], baseSlice: null },
        { slug: 'rest', files: [EXEC, THEME, SPEC], baseSlice: null },
      ]),
    });

    assert.ok(result.problems.some((problem) => problem.check === 'files' && problem.detail.includes('no files')));
    assert.ok(result.problems.some((problem) => problem.check === 'slug'));
  });

  // A verification is about a set of files. Carrying it onto a slice whose
  // files changed would be a green tick for a build that never happened.
  test('a stored verification survives only while the files are the same', () => {
    const previous = {
      issue: ISSUE,
      strategy: 'prefer-independent',
      updatedAt: new Date().toISOString(),
      source: { base: 'main', ref: 'HEAD', repo: repo },
      slices: [
        { index: 1, files: [API], verification: { ok: true, standalone: true, diffDigest: 'sha256:x' } },
        { index: 2, files: [EXEC], verification: { ok: true, standalone: false, diffDigest: 'sha256:y' } },
      ],
    };

    const kept = build({ proposal: proposal(GOOD), previous });
    assert.deepEqual(kept.graph.slices[0].verification, previous.slices[0].verification);

    const moved = build({
      previous,
      proposal: proposal([
        { slug: 'api', files: [API, EXEC], baseSlice: null },
        { slug: 'ui', files: [THEME, SPEC], baseSlice: null },
      ]),
    });
    assert.equal(moved.graph, null, 'the moved graph is refused for other reasons; the point is it is not stored');

    const regrouped = build({
      previous,
      proposal: proposal([
        { slug: 'api', files: [API], baseSlice: null },
        { slug: 'main-and-ui', files: [EXEC, THEME, SPEC], baseSlice: 1 },
      ]),
    });
    assert.equal(regrouped.graph.slices[1].verification, null);
  });
});

describe('mergeOrder and chainTo', () => {
  test('a base always comes before what is stacked on it', () => {
    const { order, cycle } = slice.mergeOrder([
      { index: 1, baseSlice: 2 },
      { index: 2, baseSlice: null },
      { index: 3, baseSlice: null },
    ]);

    assert.deepEqual(order, [2, 3, 1]);
    assert.deepEqual(cycle, []);
  });

  test('a cycle is reported rather than ordered around', () => {
    const { order, cycle } = slice.mergeOrder([
      { index: 1, baseSlice: 2 },
      { index: 2, baseSlice: 1 },
    ]);

    assert.deepEqual(order, []);
    assert.deepEqual(cycle, [1, 2]);
  });

  test('chainTo lists what has to be applied first, base first', () => {
    const graph = build({ proposal: proposal(GOOD) }).graph;

    assert.deepEqual(slice.chainTo(graph, 2).map((entry) => entry.index), [1, 2]);
    assert.deepEqual(slice.chainTo(graph, 3).map((entry) => entry.index), [3]);
  });

  test('baseRefOf names the base branch or the parent branch', () => {
    const graph = build({ proposal: proposal(GOOD) }).graph;

    assert.equal(slice.baseRefOf(graph, graph.slices[0], 'main'), 'main');
    assert.equal(slice.baseRefOf(graph, graph.slices[1], 'main'), `DESKTOP-${ISSUE}/1-extension-api-run-options`);
  });
});

describe('sliceDiff', () => {
  test('contains the slice and nothing else', async () => {
    const diff = await slice.sliceDiff({ repoRoot: repo, base: 'main', files: [API] });

    assert.match(diff, /packages\/extension-api\/src\/api\.ts/);
    assert.equal(diff.includes('exec.ts'), false);
    assert.match(diff, /\+export interface RunOptions/);
  });

  test('is stable, so its digest means something', async () => {
    const first = await slice.sliceDiff({ repoRoot: repo, base: 'main', files: [THEME, SPEC] });
    const second = await slice.sliceDiff({ repoRoot: repo, base: 'main', files: [THEME, SPEC] });

    assert.equal(slice.digestOf(first), slice.digestOf(second));
    assert.notEqual(slice.digestOf(first), slice.digestOf(await slice.sliceDiff({ repoRoot: repo, base: 'main', files: [THEME] })));
  });
});

describe('set and read', () => {
  test('stores a valid graph and writes what it did to the journal', async () => {
    const result = await slice.set({ issue: ISSUE, proposal: proposal(GOOD), facts: collected, config: CONFIG, home });
    assert.equal(result.ok, true, JSON.stringify(result.problems));

    const stored = await slice.read(ISSUE, { home });
    assert.equal(stored.slices.length, 3);
    assert.equal(stored.slices[1].baseSlice, 1);
    assert.equal(stored.source.base, 'main');

    const journal = await readFile(join(home, 'journal', `${new Date().toISOString().slice(0, 7)}.md`), 'utf8');
    assert.match(journal, /event:slices-set\s+3 slice\(s\), merge order #1 → #2 → #3/);
  });

  test('a refused proposal is not stored', async () => {
    const before = await slice.read(ISSUE, { home });
    const result = await slice.set({
      issue: ISSUE,
      proposal: proposal([{ slug: 'everything', files: [API, EXEC, THEME, SPEC], baseSlice: null }]),
      facts: collected,
      config: CONFIG,
      home,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(await slice.read(ISSUE, { home }), before);
  });

  test('reading an issue with no graph is null, not an error', async () => {
    assert.equal(await slice.read(999999, { home }), null);
  });
});

describe('verify', () => {
  before(async () => {
    const result = await slice.set({ issue: ISSUE, proposal: proposal(GOOD), facts: collected, config: config(), home });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
  });

  test('a slice that stands on its own comes back green, with the run attached', async () => {
    const result = await slice.verifySlice({
      issue: ISSUE,
      index: 1,
      repoRoot: repo,
      home,
      config: config(),
      packageMap: packageMap(repo),
    });

    assert.equal(result.ok, true, result.error ?? result.output);
    assert.equal(result.verification.standalone, true);
    assert.equal(result.verification.exitCode, 0);
    assert.equal(result.verification.revertsCleanly, true);
    assert.match(result.verification.command, /npm run typecheck && npm run lint:check && npm run test:unit/);

    // The evidence is a receipt in the same format, and it validates — which
    // is what stops the output block being edited into a green one afterwards.
    const artefact = await readFile(join(issueDir(home, ISSUE), 'verify', 'S1.md'), 'utf8');
    assert.equal(validateReceipt(artefact).ok, true, validateReceipt(artefact).reason);
    assert.match(artefact, /typecheck ok/);
  });

  // Symbol dependence: nothing in the file lists says slice #2 needs #1, and
  // this is the only thing that does.
  test('a slice that needs another one is red standalone, and the redness is the evidence', async () => {
    const result = await slice.verifySlice({
      issue: ISSUE,
      index: 2,
      repoRoot: repo,
      standalone: true,
      home,
      config: config(),
      packageMap: packageMap(repo),
    });

    assert.equal(result.ok, false);
    assert.equal(result.verification.standalone, true);
    assert.equal(result.verification.exitCode, 2);

    const artefact = await readFile(join(issueDir(home, ISSUE), 'verify', 'S2.md'), 'utf8');
    assert.equal(validateReceipt(artefact).ok, true, 'a failed run still produces a valid capture');
    assert.match(artefact, /cannot find name RunOptions/);
  });

  test('the same slice on top of what it is based on is green', async () => {
    const result = await slice.verifySlice({
      issue: ISSUE,
      index: 2,
      repoRoot: repo,
      home,
      config: config(),
      packageMap: packageMap(repo),
    });

    assert.equal(result.ok, true, result.error ?? result.output);
    assert.equal(result.verification.standalone, false);
  });

  test('the result is stored on the slice, not returned and forgotten', async () => {
    const stored = await slice.read(ISSUE, { home });
    const second = stored.slices.find((entry) => entry.index === 2);

    assert.equal(second.verification.ok, true);
    assert.equal(second.verification.evidence, 'verify/S2.md');
    assert.match(second.verification.diffDigest, /^sha256:[0-9a-f]{64}$/);
  });

  test('verifyAll walks in merge order and reports what is left standing', async () => {
    const result = await slice.verifyAll({ issue: ISSUE, repoRoot: repo, home, config: config(), packageMap: packageMap(repo) });

    // A stack stays contiguous: #2 follows the slice it is based on rather
    // than waiting for every independent slice to go first.
    assert.deepEqual(result.results.map((entry) => entry.index), [1, 2, 3]);
    assert.equal(result.ok, true, JSON.stringify(result.results));
    assert.deepEqual(result.problems, []);
  });

  test('a slice that claims main and fails there is named by independenceProblems', async () => {
    // #3 promoted to branch from main while it is really the ui work — flip its
    // stored verification to red and ask the same question verifyAll asks.
    const graph = await slice.read(ISSUE, { home });
    graph.slices[2].verification.ok = false;

    const problems = slice.independenceProblems(graph);
    assert.equal(problems.length, 1);
    assert.match(problems[0].detail, /#3 does not build from main/);
  });
});

describe('checkFreshness', () => {
  test('a verification of the current diff is fresh', async () => {
    const graph = await slice.read(ISSUE, { home });
    const fresh = await slice.checkFreshness({ graph, index: 1, repoRoot: repo, base: 'main' });

    assert.equal(fresh.fresh, true);
  });

  // The property the whole gate leans on: "verified" must not decay into
  // "was verified once".
  test('a diff that moved since the run is not fresh, and says why', async () => {
    await writeFiles(repo, { [API]: '// SPDX-License-Identifier: Apache-2.0\nexport const version = 2;\nexport interface RunOptions { env?: string }\n' });
    await commitAll(repo, 'fix(api): bump the version');

    const graph = await slice.read(ISSUE, { home });
    const checked = await slice.checkFreshness({ graph, index: 1, repoRoot: repo, base: 'main' });

    assert.equal(checked.fresh, false);
    assert.match(checked.reason, /changed since it was verified/);
    assert.notEqual(checked.digest, checked.expected);

    await git(['revert', '--no-edit', 'HEAD'], repo);
  });

  test('a slice that was never verified is not fresh either', async () => {
    const graph = await slice.read(ISSUE, { home });
    graph.slices[0].verification = null;

    const checked = await slice.checkFreshness({ graph, index: 1, repoRoot: repo, base: 'main' });
    assert.equal(checked.fresh, false);
    assert.match(checked.reason, /never been verified/);
  });
});

describe('independenceProblems', () => {
  test('flags a slice that claims main but failed to build there', () => {
    const graph = build({ proposal: proposal(GOOD) }).graph;
    graph.slices[2].verification = { ok: false, standalone: true, diffDigest: 'sha256:x' };

    const problems = slice.independenceProblems(graph);
    assert.equal(problems.length, 1);
    assert.match(problems[0].detail, /#3 does not build from main/);
  });

  test('says nothing about a stacked slice that failed standalone', () => {
    const graph = build({ proposal: proposal(GOOD) }).graph;
    graph.slices[1].verification = { ok: false, standalone: true, diffDigest: 'sha256:y' };

    assert.deepEqual(slice.independenceProblems(graph), []);
  });
});

describe('materialize', () => {
  test('refuses before a human has approved the graph', async () => {
    const result = await slice.materialize({
      issue: ISSUE,
      index: 1,
      repoRoot: repo,
      subject: 'feat(api): add RunOptions',
      home,
      config: config(),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /is planned; branches are cut from slices-approved/);
  });

  test('refuses a commit subject upstream would reject', async () => {
    await state.transition(ISSUE, 'plan-approved', { home });
    await state.transition(ISSUE, 'implemented', { home });
    await state.transition(ISSUE, 'validated', { home });
    await state.transition(ISSUE, 'audited', { home });
    await state.transition(ISSUE, 'sliced', { home });
    await state.transition(ISSUE, 'slices-approved', { home, approvedBy: 'the owner' });

    const result = await slice.materialize({
      issue: ISSUE,
      index: 1,
      repoRoot: repo,
      subject: 'added RunOptions',
      home,
      config: config(),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /not a conventional commit subject/);
  });

  test('cuts a branch from the base and puts the slice on it, in one commit', async () => {
    const result = await slice.materialize({
      issue: ISSUE,
      index: 1,
      repoRoot: repo,
      subject: 'feat(extension-api): add RunOptions',
      home,
      config: config(),
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.created, true);
    assert.equal(result.base, 'main');

    const changed = await git(['diff', '--name-only', 'main...HEAD'], repo);
    assert.deepEqual(changed.split('\n'), [API]);
    assert.equal(await git(['log', '-1', '--format=%s'], repo), 'feat(extension-api): add RunOptions');
    assert.equal(await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo), `DESKTOP-${ISSUE}/1-extension-api-run-options`);
  });

  // The reason materializing is safe to get wrong: it adds branches and
  // touches nothing else.
  // The husky hook adds it in a tree where pnpm install has run, and rejects
  // the duplicate that -s would then produce. In a tree where it has not — a
  // fresh worktree, which is where slicing works — nothing adds it, and
  // preflight would reject a branch this command just made.
  test('the commit carries a sign-off when no hook is there to add one', async () => {
    const message = await git(['log', '-1', '--format=%B', `DESKTOP-${ISSUE}/1-extension-api-run-options`], repo);
    assert.match(message, /^Signed-off-by: .+ <.+>$/m);
  });

  test('the working branch is exactly where it was', async () => {
    const files = await git(['diff', '--name-only', `main...DESKTOP-${ISSUE}/work`], repo);
    assert.deepEqual(files.split('\n').sort(), [API, EXEC, THEME, SPEC].sort());
  });

  test('a stacked slice branches from its parent, and carries only its own files', async () => {
    const result = await slice.materialize({
      issue: ISSUE,
      index: 2,
      repoRoot: repo,
      subject: 'feat(main): thread RunOptions through exec',
      home,
      config: config(),
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.base, `DESKTOP-${ISSUE}/1-extension-api-run-options`);

    const own = await git(['diff', '--name-only', `${result.base}...HEAD`], repo);
    assert.deepEqual(own.split('\n'), [EXEC]);
  });

  test('re-running adopts an unchanged branch rather than failing', async () => {
    const again = await slice.materialize({
      issue: ISSUE,
      index: 1,
      repoRoot: repo,
      subject: 'feat(extension-api): add RunOptions',
      home,
      config: config(),
    });

    assert.equal(again.ok, true, again.error);
    assert.equal(again.adopted, true);
    assert.equal(again.created, false);
  });

  test('and refuses when the branch no longer matches the slice', async () => {
    const branch = `DESKTOP-${ISSUE}/1-extension-api-run-options`;
    await git(['checkout', branch], repo);
    await writeFiles(repo, { [API]: '// SPDX-License-Identifier: Apache-2.0\nexport const version = 99;\n' });
    await commitAll(repo, 'fix(extension-api): something a reviewer asked for');

    const result = await slice.materialize({
      issue: ISSUE,
      index: 1,
      repoRoot: repo,
      subject: 'feat(extension-api): add RunOptions',
      home,
      config: config(),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /--force/);

    await git(['reset', '--hard', 'HEAD~1'], repo);
  });

  test('and leaves it to the hook when one will run', async () => {
    const hooks = join(repo, '.fixture-hooks');
    await mkdir(hooks, { recursive: true });
    // A hook that adds nothing: what matters is that materialize sees it and
    // does not sign, since a second trailer is what husky rejects.
    await writeFile(join(hooks, 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await git(['config', 'core.hooksPath', '.fixture-hooks'], repo);

    const result = await slice.materialize({
      issue: ISSUE,
      index: 3,
      repoRoot: repo,
      subject: 'feat(ui): high contrast themes',
      home,
      config: config(),
    });
    assert.equal(result.ok, true, result.error);

    const message = await git(['log', '-1', '--format=%B', `DESKTOP-${ISSUE}/3-ui-contrast`], repo);
    assert.equal(/Signed-off-by:/.test(message), false);

    await git(['config', '--unset', 'core.hooksPath'], repo);
  });

  test('a dirty tree stops it, because the mess would ride along', async () => {
    await writeFiles(repo, { 'packages/ui/src/theme.ts': 'export const theme = "half-done";\n' });

    const result = await slice.materialize({
      issue: ISSUE,
      index: 3,
      repoRoot: repo,
      subject: 'feat(ui): high contrast themes',
      home,
      config: config(),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /1 uncommitted change/);

    await git(['checkout', '--', '.'], repo);
  });
});

describe('cascade', () => {
  before(async () => {
    // A review fix lands in slice #1, the way one does: on the branch, after
    // the pull request is open.
    await git(['checkout', `DESKTOP-${ISSUE}/1-extension-api-run-options`], repo);
    await writeFiles(repo, {
      [API]: '// SPDX-License-Identifier: Apache-2.0\nexport const version = 1;\nexport interface RunOptions { env?: string; cwd?: string }\n',
    });
    await commitAll(repo, 'fix(extension-api): add cwd, as review asked');
  });

  test('rebases what is stacked on the changed slice and verifies it again', async () => {
    const result = await slice.cascade({
      issue: ISSUE,
      from: 1,
      repoRoot: repo,
      home,
      config: config(),
      packageMap: packageMap(repo),
    });

    assert.deepEqual(result.conflicted, []);
    assert.deepEqual(result.rebased, [2]);
    assert.equal(result.ok, true, JSON.stringify(result.results));

    // #2 now sits on top of the fixed #1 rather than the version it was cut on.
    const merged = await git(['merge-base', '--is-ancestor', `DESKTOP-${ISSUE}/1-extension-api-run-options`, `DESKTOP-${ISSUE}/2-main-exec-plumbing`], repo).then(
      () => true,
      () => false,
    );
    assert.equal(merged, true);
  });

  test('the verification stored for a rebased slice is from its branch', async () => {
    const graph = await slice.read(ISSUE, { home });
    const second = graph.slices.find((entry) => entry.index === 2);

    assert.equal(second.verification.ok, true);
    assert.equal(second.verification.standalone, false);

    const fresh = await slice.checkFreshness({ graph, index: 2, repoRoot: repo, ref: second.branch });
    assert.equal(fresh.fresh, true, 'what was verified is what the branch now contains');
  });

  test('a slice that stopped being green is reported, not rebased into a lie', async () => {
    // The fix withdraws what #2 depends on. Nothing about the file lists
    // changes; only the build knows.
    await git(['checkout', `DESKTOP-${ISSUE}/1-extension-api-run-options`], repo);
    await writeFiles(repo, { [API]: '// SPDX-License-Identifier: Apache-2.0\nexport const version = 1;\n' });
    await commitAll(repo, 'revert(extension-api): drop RunOptions again');

    const result = await slice.cascade({
      issue: ISSUE,
      from: 1,
      repoRoot: repo,
      home,
      config: config(),
      packageMap: packageMap(repo),
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.regressed, [2]);

    const journal = await readFile(join(home, 'journal', `${new Date().toISOString().slice(0, 7)}.md`), 'utf8');
    assert.match(journal, /event:slice-regressed.*no longer green: #2/);
  });

  test('dependentsOf follows the stack, not just the first step', () => {
    const graph = {
      slices: [
        { index: 1, baseSlice: null },
        { index: 2, baseSlice: 1 },
        { index: 3, baseSlice: 2 },
        { index: 4, baseSlice: null },
      ],
    };

    assert.deepEqual(slice.dependentsOf(graph, 1), [2, 3]);
    assert.deepEqual(slice.dependentsOf(graph, 3), []);
  });
});

// A red run has two causes and they are different findings: the slice broke
// something, or the base does not pass this command either. The live run
// against the fork produced the second twice — a missing build step, then a
// binary the install had not fetched — and every slice came back red for it.
//
// Its own repository, because the case is "main itself does not build", and a
// fixture that shared main with the suites above would be telling them that.
describe('a base that fails the same command', () => {
  let broken;
  let brokenHome;
  let brokenTrees;

  const FILE = 'packages/ui/src/theme.ts';

  before(async () => {
    broken = await initRepo('pdkit-slice-broken-');
    brokenHome = await initRepo('pdkit-slice-broken-home-');
    brokenTrees = join(broken, '..', `${broken.split('/').pop()}-trees`);

    await seedWorkspace(broken);
    // Broken on main, before any slice exists.
    await writeFiles(broken, {
      'scripts/typecheck.mjs': 'console.error("the toolchain itself is broken here");\nprocess.exit(9);\n',
    });
    await commitAll(broken, 'chore: seed, with a base that does not typecheck');

    await git(['checkout', '-b', 'DESKTOP-7777/work'], broken);
    await writeFiles(broken, { [FILE]: '// SPDX-License-Identifier: Apache-2.0\nexport const theme = "dark";\n' });
    await commitAll(broken, 'feat(ui): dark');

    await state.transition(7777, 'triaged', { home: brokenHome });
    await state.transition(7777, 'planned', { home: brokenHome });
  });

  after(async () => {
    await cleanup(broken, brokenHome, brokenTrees);
  });

  const brokenConfig = () => ({ ...CONFIG, worktrees: { ...CONFIG.worktrees, root: brokenTrees } });

  test('the verification is inconclusive, and says which command', async () => {
    const facts = await slice.facts({ issue: 7777, repoRoot: broken, home: brokenHome, config: brokenConfig(), packageMap: packageMap(broken) });
    const stored = await slice.set({
      issue: 7777,
      proposal: { slices: [{ slug: 'ui', title: 'dark', files: [FILE], baseSlice: null }] },
      facts,
      config: brokenConfig(),
      home: brokenHome,
    });
    assert.equal(stored.ok, true, JSON.stringify(stored.problems));

    const result = await slice.verifySlice({
      issue: 7777,
      index: 1,
      repoRoot: broken,
      home: brokenHome,
      config: brokenConfig(),
      packageMap: packageMap(broken),
    });

    assert.equal(result.ok, false);
    assert.equal(result.verification.baselineOk, false, 'the base fails it too');

    // And the slice is not accused of failing to be independent, which would
    // send somebody re-cutting a graph that was never the problem.
    assert.deepEqual(slice.independenceProblems(result.graph), []);
  });

  test('the measurement is cached per base and command', async () => {
    const cache = JSON.parse(await readFile(join(issueDir(brokenHome, 7777), 'verify', 'baseline.json'), 'utf8'));

    assert.equal(Object.keys(cache).length, 1);
    assert.equal(Object.values(cache)[0].ok, false);
    assert.match(Object.values(cache)[0].command, /typecheck/);
  });

  test('and slices.md says inconclusive rather than a cross', async () => {
    const graph = await slice.read(7777, { home: brokenHome });
    const values = slice.renderValues(graph);

    assert.match(values.rows, /inconclusive/);
  });
});

// Scenario 13: upstream asks for an already-published pull request to be split.
// The slicer does not change — what changes is where the diff comes from.
describe('--from-pr', () => {
  let upstream;
  let clone;

  before(async () => {
    upstream = await initRepo('pdkit-upstream-');
    await writeFiles(upstream, { 'packages/main/src/a.ts': 'export const a = 1;\n' });
    await commitAll(upstream, 'chore: seed');

    // Somebody's pull request, published the way GitHub serves one.
    await git(['checkout', '-b', 'their-work'], upstream);
    await writeFiles(upstream, { 'packages/main/src/a.ts': 'export const a = 2;\n', 'packages/ui/src/b.ts': 'export const b = 1;\n' });
    const head = await commitAll(upstream, 'feat: their change');
    await git(['update-ref', 'refs/pull/7/head', head], upstream);

    // Upstream moves on after the pull request was opened.
    await git(['checkout', 'main'], upstream);
    await writeFiles(upstream, { 'packages/preload/src/c.ts': 'export const c = 1;\n' });
    await commitAll(upstream, 'chore: unrelated upstream work');

    clone = await initRepo('pdkit-clone-');
    await git(['remote', 'add', 'upstream', upstream], clone);
    await git(['fetch', 'upstream', 'main'], clone);
  });

  after(async () => {
    await cleanup(upstream, clone);
  });

  test('the head is fetched and the base is where it branched, not where upstream is now', async () => {
    const fetched = await fetchPullRequestHead({
      pr: 7,
      repoRoot: clone,
      config: { repo: { upstream_remote: 'upstream', base_branch: 'main' } },
    });

    const seed = await git(['rev-parse', 'upstream/main~1'], clone);
    assert.equal(fetched.base, seed, 'the base is the fork point');

    // Against the tip, the diff would carry the unrelated upstream commit and
    // the slicer would be asked to place a file nobody in this PR touched.
    const files = await slice.sliceDiff({
      repoRoot: clone,
      base: fetched.base,
      ref: fetched.ref,
      files: ['packages/main/src/a.ts', 'packages/ui/src/b.ts'],
    });
    assert.match(files, /packages\/ui\/src\/b\.ts/);
    assert.equal(files.includes('packages/preload/src/c.ts'), false);
  });

  test('a pull request the remote does not serve is an error, not an empty slice', async () => {
    await assert.rejects(
      () => fetchPullRequestHead({ pr: 999, repoRoot: clone, config: { repo: { upstream_remote: 'upstream' } } }),
      /999/,
    );
  });
});
