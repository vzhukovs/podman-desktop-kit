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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanup, commitAll, git, initRepo, packageMap, seedWorkspace, writeFiles } from './helpers/repo-fixture.js';
import { issueDir } from '../lib/config.js';
import * as ids from '../lib/ids.js';
import * as slice from '../lib/slice.js';
import * as state from '../lib/state.js';

const ISSUE = 4242;

const CONFIG = {
  repo: { base_branch: 'main' },
  branches: { single: 'DESKTOP-{issue}/{slug}', sliced: 'DESKTOP-{issue}/{index}-{slug}' },
  slicing: { strategy: 'prefer-independent', max_files_per_slice: 12, layer_order: ['extension-api', 'main', 'ui', 'tests'] },
};

const API = 'packages/extension-api/src/api.ts';
const EXEC = 'packages/main/src/exec.ts';
const THEME = 'packages/ui/src/theme.ts';
const SPEC = 'tests/playwright/theme.spec.ts';

let repo;
let home;
let collected;

/**
 * A task file, in the shape templates/task.md renders.
 *
 * @param {string} id
 * @param {string[]} satisfies
 * @param {string[]} owns
 */
async function task(id, satisfies, owns) {
  const directory = join(issueDir(home, ISSUE), 'tasks');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${id}.md`),
    [
      `# ${id}: work`,
      '',
      `- Issue: ${ISSUE}`,
      `- Satisfies: ${satisfies.join(', ')}`,
      '- Status: done',
      '',
      '## Owns',
      ...owns.map((path) => `- ${path}`),
      '',
      '## Done when',
      '```bash',
      'true',
      '```',
      'Expected: nothing',
      '',
    ].join('\n'),
  );
}

before(async () => {
  repo = await initRepo('pdkit-slice-');
  home = await initRepo('pdkit-slice-home-');

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
  await cleanup(repo, home);
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
