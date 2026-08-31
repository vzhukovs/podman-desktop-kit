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

// Tests for lib/drift.js and the git primitives under it.
//
// Against a real repository, because every claim here is a claim about git:
// where a branch left its base, which commits are on one side of that point,
// and which lines a commit actually touched. A fake git would only confirm what
// the fake believes.
//
// The load-bearing assertion is the last kind: a commit that touched the lines
// the plan cited is a candidate for a semantic conflict, and semantic means
// stop. Getting that wrong in the safe direction floods the report; getting it
// wrong in the other lets upstream rewrite what the plan stood on, quietly.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as drift from '../lib/drift.js';
import * as pr from '../lib/pr.js';
import * as slice from '../lib/slice.js';
import { branchPoint, drift as driftCommits, touchedRanges } from '../lib/repo.js';
import { cleanup, commitAll, git, initRepo, writeFiles } from './helpers/repo-fixture.js';

const ISSUE = 7303;
const CONFIG = {
  repo: { base_branch: 'main', upstream_remote: 'upstream' },
  branches: { sliced: 'DESKTOP-{issue}/{index}-{slug}' },
};

const HANDLER = 'packages/main/src/handler.ts';
const THEME = 'packages/ui/src/theme.ts';

let repo;
let home;

/** The line in HANDLER that the plan will cite. */
const CITED_LINE = 4;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-drift-'));
  repo = await initRepo('pdkit-drift-repo-');

  await writeFiles(repo, {
    [HANDLER]: ['// one', '// two', '// three', 'export const timeout = 500;', '// five', '// six'].join('\n'),
    [THEME]: 'export const dark = "#000";\n',
  });
  await commitAll(repo, 'chore: seed');

  // Our work: a branch off main, touching both files.
  await git(['checkout', '-b', 'DESKTOP-7303/1-handler'], repo);
  await writeFiles(repo, { [HANDLER]: ['// one', '// two', '// three', 'export const timeout = 900;', '// five', '// six'].join('\n') });
  await commitAll(repo, 'fix(main): raise the timeout');

  await git(['checkout', 'main'], repo);
  await git(['checkout', '-b', 'DESKTOP-7303/2-theme'], repo);
  await writeFiles(repo, { [THEME]: 'export const dark = "#111";\n' });
  await commitAll(repo, 'fix(ui): darken');

  // Upstream moves on, in a branch standing in for upstream/main.
  await git(['checkout', 'main'], repo);
  await git(['checkout', '-b', 'upstream-main'], repo);

  // Touches the cited line.
  await writeFiles(repo, { [HANDLER]: ['// one', '// two', '// three', 'export const timeout = 250;', '// five', '// six'].join('\n') });
  await commitAll(repo, 'refactor(main): retune the timeout');

  // Touches the same file, far from the cited line.
  await writeFiles(repo, {
    [HANDLER]: ['// one', '// two', '// three', 'export const timeout = 250;', '// five', '// six', '// seven'].join('\n'),
  });
  await commitAll(repo, 'chore(main): a trailing comment');

  // Touches a file nobody's slice owns.
  await writeFiles(repo, { 'packages/preload/src/index.ts': 'export const x = 1;\n' });
  await commitAll(repo, 'feat(preload): unrelated');

  await git(['checkout', 'main'], repo);

  await mkdir(join(home, 'issues', String(ISSUE)), { recursive: true });
  await writeFile(
    join(home, 'issues', String(ISSUE), 'plan.md'),
    [
      '# PLAN: DESKTOP-7303',
      '',
      '## Context',
      `- the timeout lives in \`${HANDLER}:${CITED_LINE}\` and everything below depends on it`,
      '- see section 4:2 of the spec for why',
      '',
    ].join('\n'),
  );

  await slice.set({
    issue: ISSUE,
    home,
    config: CONFIG,
    facts: {
      issue: ISSUE,
      files: [
        { path: HANDLER, package: null, layer: 'main', tasks: [], requirements: [] },
        { path: THEME, package: null, layer: 'ui', tasks: [], requirements: [] },
      ],
      changed: [
        { status: 'M', path: HANDLER },
        { status: 'M', path: THEME },
      ],
      requirements: [],
      route: 'quickfix',
      base: 'main',
      ref: 'HEAD',
      layerOrder: ['main', 'ui'],
    },
    proposal: {
      slices: [
        { index: 1, slug: 'handler', title: 'handler', files: [HANDLER], baseSlice: null },
        { index: 2, slug: 'theme', title: 'theme', files: [THEME], baseSlice: null },
      ],
    },
  });
});

after(async () => {
  await cleanup(repo, home);
});

describe('git primitives', () => {
  test('branchPoint is where the branch left, not where the base is now', async () => {
    const point = await branchPoint('DESKTOP-7303/1-handler', 'upstream-main', { cwd: repo });
    const seed = await git(['rev-parse', 'main'], repo);

    assert.equal(point, seed, 'the fork point is the seed commit, not upstream tip');
  });

  test('drift lists only commits touching the files it was asked about', async () => {
    const commits = await driftCommits({
      from: await git(['rev-parse', 'main'], repo),
      to: 'upstream-main',
      files: [HANDLER],
      cwd: repo,
    });

    assert.deepEqual(
      commits.map((commit) => commit.subject),
      ['chore(main): a trailing comment', 'refactor(main): retune the timeout'],
    );
    assert.ok(!commits.some((commit) => commit.subject.includes('preload')));
    assert.deepEqual(commits[0].files, [HANDLER]);
  });

  test('asking about no files answers nothing rather than everything', async () => {
    assert.deepEqual(await driftCommits({ from: 'main', to: 'upstream-main', files: [], cwd: repo }), []);
  });

  // With context lines a one-line change claims six, and every commit in the
  // file would look like it touched what the plan cited.
  test('touchedRanges reports the lines changed, not the lines nearby', async () => {
    const [retune] = await driftCommits({ from: 'main', to: 'upstream-main', files: [HANDLER], cwd: repo }).then((commits) =>
      commits.filter((commit) => commit.subject.startsWith('refactor')),
    );

    const ranges = await touchedRanges(retune.sha, HANDLER, { cwd: repo });
    assert.deepEqual(ranges, [[4, 4]]);
  });
});

describe('citations', () => {
  test('a file:line in the plan is picked up, prose with a colon is not', async () => {
    const found = await drift.citations(home, ISSUE);

    assert.deepEqual([...(found.get(HANDLER) ?? [])], [CITED_LINE]);
    // "section 4:2" is not a citation, and a map full of those would make every
    // commit look semantic.
    assert.equal(found.size, 1);
  });

  test('an issue with no plan cites nothing rather than failing', async () => {
    assert.equal((await drift.citations(home, 999999)).size, 0);
  });
});

describe('collecting drift', () => {
  test('each slice is measured from its own branch point', async () => {
    const report = await drift.collect({ issue: ISSUE, repoRoot: repo, home, config: CONFIG, upstream: 'upstream-main' });

    const handler = report.units.find((unit) => unit.slice === 1);
    const theme = report.units.find((unit) => unit.slice === 2);

    assert.equal(handler.commits.length, 2);
    assert.equal(theme.commits.length, 0, 'nothing upstream touched the theme slice');
    assert.equal(report.total, 2);
  });

  // The hint the whole module exists for: touching the file is mechanical,
  // touching the line the plan built on is a candidate for semantic.
  test('a commit on a cited line is separated from a commit merely in the file', async () => {
    const report = await drift.collect({ issue: ISSUE, repoRoot: repo, home, config: CONFIG, upstream: 'upstream-main' });

    assert.equal(report.semantic.length, 1);
    assert.match(report.semantic[0].subject, /retune the timeout/);
    assert.deepEqual(report.semantic[0].citedLinesTouched, [{ path: HANDLER, lines: [CITED_LINE] }]);

    const trailing = report.units[0].commits.find((commit) => commit.subject.includes('trailing'));
    assert.deepEqual(trailing.citedLinesTouched, [], 'a comment at the end of the file is not a semantic conflict');
  });

  test('a slice that was never cut has not drifted', async () => {
    await git(['branch', '-D', 'DESKTOP-7303/2-theme'], repo);

    const report = await drift.collect({ issue: ISSUE, repoRoot: repo, home, config: CONFIG, upstream: 'upstream-main' });
    const theme = report.units.find((unit) => unit.slice === 2);

    assert.equal(theme.branchPoint, null);
    assert.deepEqual(theme.commits, []);

    await git(['branch', 'DESKTOP-7303/2-theme', 'main'], repo);
  });

  test('the report says plainly what it does and does not prove', async () => {
    const report = await drift.collect({ issue: ISSUE, repoRoot: repo, home, config: CONFIG, upstream: 'upstream-main' });
    const text = drift.format(report);

    assert.match(text, /⚠ touches packages\/main\/src\/handler\.ts:4/);
    assert.match(text, /a semantic conflict that merges cleanly is the dangerous one/);
  });

  // Work can reach a pull request without ever being materialised — a branch
  // cut before the graph existed, or an issue adopted at pr-open — and then the
  // graph names a branch nobody has. On DESKTOP-18832 that produced "nothing
  // was measured" about a branch that was sitting right there under review, and
  // the recorded fix was a duplicate branch made by hand.
  describe('a slice published from a branch the graph did not name', () => {
    const PUBLISHED = 'DESKTOP-7303/store-handler';

    before(async () => {
      await git(['branch', PUBLISHED, 'DESKTOP-7303/1-handler'], repo);
      await git(['branch', '-D', 'DESKTOP-7303/1-handler'], repo);

      await pr.register({ issue: ISSUE, number: 4242, slice: 1, branch: PUBLISHED, base: 'main', home });
    });

    after(async () => {
      await git(['branch', 'DESKTOP-7303/1-handler', PUBLISHED], repo);
      await git(['branch', '-D', PUBLISHED], repo);
      await rm(join(home, 'issues', String(ISSUE), 'prs.json'), { force: true });
    });

    test('is measured from the branch its pull request is on', async () => {
      const report = await drift.collect({ issue: ISSUE, repoRoot: repo, home, config: CONFIG, upstream: 'upstream-main' });
      const handler = report.units.find((unit) => unit.slice === 1);

      assert.equal(handler.branch, PUBLISHED);
      assert.equal(handler.commits.length, 2, 'the drift the graph name could not see');
    });

    // A substitution nobody is told about is the shape of answering about the
    // wrong change, which is what this module exists not to do.
    test('and the report says which branch it used, and why', async () => {
      const report = await drift.collect({ issue: ISSUE, repoRoot: repo, home, config: CONFIG, upstream: 'upstream-main' });
      const text = drift.format(report);

      assert.match(text, /measured from the branch of #4242; the graph names DESKTOP-7303\/1-handler/);
    });
  });
});

describe('an issue with no slice graph', () => {
  // Found on #17577: a branch two months stale, and `pdkit drift` answered
  // "not cut yet — nothing to measure from", then closed with a line about
  // conflicts likely being mechanical. The module could take a ref and a file
  // list; the command passed neither, so every issue without slices measured
  // an empty set and reported it as an answer.
  const LONE = 7404;
  let lonely;
  let lonelyHome;

  before(async () => {
    lonely = await initRepo('pdkit-drift-lone-');
    lonelyHome = await mkdtemp(join(tmpdir(), 'pdkit-drift-lone-home-'));

    await writeFiles(lonely, { [HANDLER]: 'export const a = 1;\n' });
    await commitAll(lonely, 'chore: base');
    await git(['branch', 'upstream-main'], lonely);

    await git(['checkout', '-q', '-b', `DESKTOP-${LONE}/work`], lonely);
    await writeFiles(lonely, { [HANDLER]: 'export const a = 2;\n' });
    await commitAll(lonely, 'fix: ours');

    await git(['checkout', '-q', 'upstream-main'], lonely);
    await writeFiles(lonely, { [HANDLER]: 'export const a = 1;\n// upstream moved on\n' });
    await commitAll(lonely, 'chore: upstream change');
    await git(['checkout', '-q', `DESKTOP-${LONE}/work`], lonely);
  });

  after(async () => {
    await cleanup(lonely, lonelyHome);
  });

  test('the branch is found by name, and its files come from the diff', async () => {
    const report = await drift.collect({
      issue: LONE,
      repoRoot: lonely,
      home: lonelyHome,
      config: CONFIG,
      upstream: 'upstream-main',
    });

    assert.equal(report.units[0].branch, `DESKTOP-${LONE}/work`);
    assert.equal(report.units[0].commits.length, 1);
    assert.match(report.units[0].commits[0].subject, /upstream change/);
  });

  test('an explicit ref wins over the guess', async () => {
    const report = await drift.collect({
      issue: LONE,
      repoRoot: lonely,
      home: lonelyHome,
      config: CONFIG,
      upstream: 'upstream-main',
      ref: 'upstream-main',
    });

    assert.equal(report.units[0].branch, 'upstream-main');
  });

  test('with no branch at all it says nothing was measured, rather than nothing was found', async () => {
    const report = await drift.collect({
      issue: 9999,
      repoRoot: lonely,
      home: lonelyHome,
      config: CONFIG,
      upstream: 'upstream-main',
    });

    assert.equal(report.units[0].branch, null);
    const text = drift.format(report);
    assert.match(text, /no branch found for this issue/);
    assert.match(text, /nothing was measured/);
    assert.match(text, /not a clean bill of health/);
  });

  test('and it does not claim a plan it has not got', async () => {
    const report = await drift.collect({
      issue: LONE,
      repoRoot: lonely,
      home: lonelyHome,
      config: CONFIG,
      upstream: 'upstream-main',
    });

    assert.equal(report.citedAny, false);
    assert.match(drift.format(report), /this issue cites no lines/);
  });
});
