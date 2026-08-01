// SPDX-License-Identifier: Apache-2.0

// Tests for lib/pr.js.
//
// Two things here are load-bearing and the rest is bookkeeping.
//
// The merge rollup: `merged` is terminal in the state machine, so an issue that
// moved there on its first merged slice could never push the second. The rollup
// is what keeps that decision out of state.json.
//
// The CI verdict: a red job either means the change broke something or means
// the job is red anyway, and the whole point of measuring is that nobody has to
// guess which.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as pr from '../lib/pr.js';
import * as slice from '../lib/slice.js';
import { read as readJournal } from '../lib/journal.js';

const ISSUE = 7101;

let home;

/**
 * A two-slice graph, one file each, without a git fixture.
 *
 * Only the back-reference is under test here; what makes a graph valid has its
 * own tests against a real repository in test/slice.test.js.
 *
 * @param {string[]} paths one per slice, in order
 */
async function storeGraph(paths) {
  const result = await slice.set({
    issue: ISSUE,
    home,
    config: { branches: { sliced: 'DESKTOP-{issue}/{index}-{slug}' } },
    facts: {
      issue: ISSUE,
      files: paths.map((path) => ({ path, package: null, layer: 'main', tasks: [], requirements: [] })),
      changed: paths.map((path) => ({ status: 'M', path })),
      requirements: [],
      route: 'quickfix',
      base: 'main',
      ref: 'abc123',
      layerOrder: ['main'],
    },
    proposal: {
      slices: paths.map((path, index) => ({ index: index + 1, slug: `part-${index + 1}`, title: `part ${index + 1}`, files: [path], baseSlice: null })),
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result.problems));
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-pr-'));
});

beforeEach(async () => {
  // The journal is global, so it has to go too: entries from the previous
  // test would otherwise be counted as this one's.
  await rm(join(home, 'issues'), { recursive: true, force: true });
  await rm(join(home, 'journal'), { recursive: true, force: true });
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('registering', () => {
  test('an issue with nothing registered reads as nothing, not as an error', async () => {
    assert.equal(await pr.read(ISSUE, { home }), null);
  });

  test('a pull request is recorded against its slice and branch', async () => {
    const record = await pr.register({
      issue: ISSUE,
      number: 2871,
      slice: 1,
      branch: 'DESKTOP-7101/1-extension-api',
      base: 'main',
      url: 'https://example/2871',
      home,
    });

    assert.equal(record.state, 'open');
    assert.equal(record.slice, 1);
    assert.equal(record.ci.verdict, 'pending', 'nothing has been read yet, and that is not a pass');

    const book = await pr.read(ISSUE, { home });
    assert.deepEqual(book.prs.map((entry) => entry.number), [2871]);
  });

  // Re-running /pd:pr after a preflight failure is the normal case, and being
  // punished for it would push people to work around the command. Two records
  // for one number would make every rollup below ambiguous.
  test('registering the same number twice updates rather than duplicates', async () => {
    await pr.register({ issue: ISSUE, number: 2871, slice: 1, branch: 'a', home });
    await pr.register({ issue: ISSUE, number: 2871, base: 'main', home });

    const book = await pr.read(ISSUE, { home });
    assert.equal(book.prs.length, 1);
    assert.equal(book.prs[0].branch, 'a', 'what was known is not erased by what was omitted');
    assert.equal(book.prs[0].base, 'main');

    const entries = await readJournal({ issue: ISSUE }, { home });
    assert.equal(entries.filter((entry) => entry.event === 'pr-registered').length, 1);
  });

  test('records are kept in number order', async () => {
    await pr.register({ issue: ISSUE, number: 2900, slice: 3, home });
    await pr.register({ issue: ISSUE, number: 2871, slice: 1, home });

    const book = await pr.read(ISSUE, { home });
    assert.deepEqual(book.prs.map((entry) => entry.number), [2871, 2900]);
  });

  test('amending a pull request nobody registered says so', async () => {
    await assert.rejects(() => pr.markMerged({ issue: ISSUE, number: 999, home }), /no pull request #999/);
  });

  test('the slice graph learns which pull request its slice became', async () => {
    await storeGraph(['packages/main/src/a.ts', 'packages/ui/src/b.svelte']);

    await pr.register({ issue: ISSUE, number: 2871, slice: 1, home });

    const graph = await slice.read(ISSUE, { home });
    assert.equal(graph.slices.find((entry) => entry.index === 1).pr, 2871);
    assert.equal(graph.slices.find((entry) => entry.index === 2).pr, null);
  });

  // Two files disagreeing is worse than a refusal: prs.json would say slice #5
  // exists and the graph would not, and nothing downstream could tell which is
  // wrong.
  test('registering against a slice the graph does not have is refused', async () => {
    await storeGraph(['packages/main/src/a.ts', 'packages/ui/src/b.svelte']);

    await assert.rejects(() => pr.register({ issue: ISSUE, number: 2871, slice: 5, home }), /no slice #5/);
    assert.equal(await pr.read(ISSUE, { home }), null, 'nothing was written');
  });
});

describe('the merge rollup', () => {
  beforeEach(async () => {
    for (const [number, slice] of [[2871, 1], [2872, 2], [2873, 3]]) {
      await pr.register({ issue: ISSUE, number, slice, home });
    }
  });

  // The finding this whole invariant comes from: upstream merges slices one at
  // a time, `merged` is terminal, and recording the first one on the issue
  // would lock it before the second slice could reach preflight-green.
  test('one merged slice of three does not finish the issue', async () => {
    await pr.markMerged({ issue: ISSUE, number: 2871, home });

    const summary = await pr.rollup(ISSUE, { home });
    assert.deepEqual(summary.merged, [2871]);
    assert.deepEqual(summary.open, [2872, 2873]);
    assert.equal(summary.allMerged, false);
  });

  test('all three merged does', async () => {
    for (const number of [2871, 2872, 2873]) await pr.markMerged({ issue: ISSUE, number, home });

    const summary = await pr.rollup(ISSUE, { home });
    assert.equal(summary.allMerged, true);
    assert.deepEqual(summary.open, []);
  });

  // Scenario 10: a maintainer closing a PR is the entry to the redo route. It
  // is not the same as merging, and it must not read as "done".
  test('a closed pull request is neither merged nor open', async () => {
    await pr.markMerged({ issue: ISSUE, number: 2871, home });
    await pr.markClosed({ issue: ISSUE, number: 2872, reason: 'maintainer asked to split it', home });
    await pr.markMerged({ issue: ISSUE, number: 2873, home });

    const summary = await pr.rollup(ISSUE, { home });
    assert.deepEqual(summary.closed, [2872]);
    assert.equal(summary.allMerged, false, 'a closed slice is unfinished work, not finished work');

    const entries = await readJournal({ issue: ISSUE }, { home });
    assert.ok(entries.some((entry) => entry.event === 'pr-closed' && entry.detail.includes('split')));
  });

  test('an issue with no pull requests has not finished', async () => {
    assert.equal((await pr.rollup(9999, { home })).allMerged, false);
  });
});

describe('judging a red job', () => {
  const check = (conclusion, status = 'COMPLETED') => ({ name: 'Windows', status, conclusion });

  test('green is green and a run in flight is not a verdict', () => {
    assert.equal(pr.judge(check('SUCCESS')).verdict, 'pass');
    assert.equal(pr.judge(check('SKIPPED')).verdict, 'pass');
    assert.equal(pr.judge(check(null, 'IN_PROGRESS')).verdict, 'pending');
    assert.equal(pr.judge(check('CANCELLED')).verdict, 'cancelled');
  });

  // Twenty-five seconds after #18561 opened: twenty-three jobs in progress,
  // nothing red, and the rollup said `fail`. A third-party status context
  // spells "not yet" as a state rather than by having no conclusion, and a
  // status context always normalises to COMPLETED — so it arrived as "finished,
  // and not green", which is what failure looks like everywhere else here.
  test('a status context that says PENDING has not answered yet', () => {
    assert.equal(pr.judge({ name: 'CodeRabbit', status: 'COMPLETED', conclusion: 'PENDING' }).verdict, 'pending');
    assert.equal(pr.judge(check('QUEUED')).verdict, 'pending');
    assert.equal(pr.judge(check('EXPECTED')).verdict, 'pending');
  });

  // Reaching "red" by elimination means every conclusion nobody thought of is
  // reported as a broken build on somebody's pull request.
  test('a conclusion that is not a known red is not called a failure', () => {
    assert.equal(pr.judge(check('SOMETHING_NEW')).verdict, 'inconclusive');
    assert.equal(pr.judge(check('FAILURE')).verdict, 'fail');
    assert.equal(pr.judge(check('TIMED_OUT')).verdict, 'fail');
  });

  test('the rollup of a freshly opened pull request is pending, not fail', () => {
    const jobs = [
      { name: 'CodeRabbit', verdict: 'pending' },
      { name: 'unit tests', verdict: 'pending' },
      { name: 'typecheck', verdict: 'pass' },
    ];

    assert.equal(pr.rollupOf(jobs), 'pending');
  });

  test('red with green peers is ours', () => {
    const verdict = pr.judge(check('FAILURE'), { peers: new Map([['Linux', [1, 2]]]) });
    assert.equal(verdict.verdict, 'fail');
    assert.deepEqual(verdict.peers, []);
  });

  // Blocking on something the change did not do teaches people to route around
  // the gate; passing it is a lie. The third outcome is the honest one.
  test('red on other people\'s pull requests too is inconclusive, and names them', () => {
    const verdict = pr.judge(check('FAILURE'), { peers: new Map([['Windows', [18550, 18486]]]) });
    assert.equal(verdict.verdict, 'inconclusive');
    assert.deepEqual(verdict.peers, [18550, 18486]);
  });

  test('one other pull request is not yet a population', () => {
    // Still reported, so a human can weigh it — but one coincidence is not a
    // measurement, and calling it one would excuse real breakage.
    const verdict = pr.judge(check('FAILURE'), { peers: new Map([['Windows', [18550]]]) });
    assert.equal(verdict.verdict, 'fail');
    assert.deepEqual(verdict.peers, [18550]);
  });

  // `pr view` reports the latest run per job, so a re-run that went green is
  // exactly what hides a flake. Reading every run for the commit is what makes
  // this measurable instead of a hunch.
  test('the same job answering twice on one commit is a flake', () => {
    const verdict = pr.judge(check('FAILURE'), {
      runs: [
        { name: 'Windows', conclusion: 'FAILURE' },
        { name: 'Windows', conclusion: 'SUCCESS' },
        { name: 'Linux', conclusion: 'SUCCESS' },
      ],
    });
    assert.equal(verdict.verdict, 'flake');
  });

  test('the rollup is the worst thing any job said', () => {
    const jobs = (...verdicts) => verdicts.map((verdict) => ({ verdict }));

    assert.equal(pr.rollupOf(jobs('pass', 'inconclusive', 'fail')), 'fail');
    assert.equal(pr.rollupOf(jobs('pass', 'inconclusive', 'flake')), 'flake');
    assert.equal(pr.rollupOf(jobs('pass', 'inconclusive')), 'inconclusive');
    assert.equal(pr.rollupOf(jobs('pass', 'pass')), 'pass');
    assert.equal(pr.rollupOf([]), 'pending', 'no jobs read is not a pass');
  });
});

describe('refreshing from GitHub', () => {
  /**
   * A fake gh that answers each call by matching its argv.
   *
   * @param {Record<string, unknown>} answers
   */
  function fakeGh(answers) {
    return (file, args, options, callback) => {
      const argv = args.join(' ');
      const key = argv.includes('graphql')
        ? 'threads'
        : argv.includes('check-runs')
          ? 'runs'
          : argv.includes('pr list')
            ? 'peers'
            : argv.includes('reviews,comments')
              ? 'discussion'
              : 'pr';

      queueMicrotask(() => callback(null, JSON.stringify(answers[key] ?? {}), ''));
      return { stdin: { end: () => {} } };
    };
  }

  const CONFIG = { repo: { upstream: 'podman-desktop/podman-desktop', fork: 'vzhukovs/podman-desktop' } };

  const threadPage = (nodes) => ({
    data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } },
  });

  const thread = (id, resolved) => ({
    id,
    isResolved: resolved,
    isOutdated: false,
    path: 'packages/main/src/x.ts',
    line: 10,
    comments: { nodes: [{ author: { login: 'coderabbitai' }, body: 'b', createdAt: '2026-05-20T00:00:00Z', url: 'u' }] },
  });

  test('what GitHub said is what gets stored', async () => {
    await pr.register({ issue: ISSUE, number: 17577, slice: null, home });

    const record = await pr.refresh({
      issue: ISSUE,
      number: 17577,
      config: CONFIG,
      home,
      exec: fakeGh({
        pr: {
          number: 17577,
          state: 'OPEN',
          reviewDecision: 'CHANGES_REQUESTED',
          headRefName: 'DESKTOP-7101/fix',
          headRefOid: 'abc123',
          baseRefName: 'main',
          url: 'https://example/17577',
          updatedAt: '2026-06-05T05:58:37Z',
          statusCheckRollup: [
            { name: 'Windows', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'pr-check' },
            { name: 'Linux', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'pr-check' },
          ],
        },
        threads: threadPage([thread('t1', false), thread('t2', true)]),
        discussion: { reviews: [{ author: { login: 'benoitf' }, state: 'CHANGES_REQUESTED', body: 'split it', submittedAt: '2026-06-05T05:58:37Z' }], comments: [] },
        peers: [{ number: 18550, statusCheckRollup: [{ name: 'Linux', status: 'COMPLETED', conclusion: 'FAILURE' }] }],
        runs: { check_runs: [{ name: 'Linux', conclusion: 'failure' }] },
      }),
    });

    assert.equal(record.review.decision, 'CHANGES_REQUESTED');
    assert.equal(record.review.threadsOpen, 1, 'resolved threads are counted but not as open');
    assert.equal(record.review.threadsTotal, 2);
    assert.equal(record.branch, 'DESKTOP-7101/fix');

    // One peer is not a population, so this stays ours.
    assert.equal(record.ci.verdict, 'fail');
    assert.deepEqual(record.ci.jobs.map((job) => job.verdict), ['pass', 'fail']);

    const stored = JSON.parse(await readFile(join(home, 'issues', String(ISSUE), 'prs.json'), 'utf8'));
    assert.equal(stored.prs[0].ci.verdict, 'fail');
  });

  test('a merged pull request is recorded as merged, not as open', async () => {
    await pr.register({ issue: ISSUE, number: 17577, home });

    const record = await pr.refresh({
      issue: ISSUE,
      number: 17577,
      config: CONFIG,
      home,
      exec: fakeGh({
        pr: { number: 17577, state: 'MERGED', mergedAt: '2026-06-10T00:00:00Z', statusCheckRollup: [] },
        threads: threadPage([]),
        discussion: { reviews: [], comments: [] },
      }),
    });

    assert.equal(record.state, 'merged');
    assert.equal((await pr.rollup(ISSUE, { home })).allMerged, true);
  });

  // A green pull request has no red job to explain, so it should not pay for
  // the population read that only a red job needs.
  test('a green run does not go looking for peers', async () => {
    await pr.register({ issue: ISSUE, number: 17577, home });

    const seen = [];
    await pr.refresh({
      issue: ISSUE,
      number: 17577,
      config: CONFIG,
      home,
      exec: (file, args, options, callback) => {
        seen.push(args.join(' '));
        const argv = args.join(' ');
        const body = argv.includes('graphql')
          ? threadPage([])
          : argv.includes('reviews,comments')
            ? { reviews: [], comments: [] }
            : { number: 17577, state: 'OPEN', statusCheckRollup: [{ name: 'Linux', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
        queueMicrotask(() => callback(null, JSON.stringify(body), ''));
        return { stdin: { end: () => {} } };
      },
    });

    assert.ok(!seen.some((argv) => argv.includes('pr list')), 'the peer population was read for nothing');
    assert.ok(!seen.some((argv) => argv.includes('check-runs')));
  });
});

describe('staleness and rendering', () => {
  const record = (extra) => ({
    number: 17577,
    slice: null,
    branch: 'DESKTOP-7101/fix',
    base: 'main',
    state: 'open',
    registeredAt: '2026-05-01T00:00:00Z',
    refreshedAt: '2026-07-31T00:00:00Z',
    review: { decision: 'CHANGES_REQUESTED', threadsOpen: 2, threadsTotal: 4, lastActivityAt: '2026-06-05T00:00:00Z' },
    ci: { verdict: 'inconclusive', checkedAt: null, jobs: [] },
    ...extra,
  });

  test('staleness measures from the last activity of any kind', () => {
    const now = new Date('2026-07-31T00:00:00Z');

    const stale = pr.staleness(record(), { now });
    assert.equal(stale.days, 56);
    assert.equal(stale.stale, true);

    // Someone else commenting yesterday is still activity: the PR is being
    // looked at, and calling it stale would be wrong about who is waiting.
    const fresh = pr.staleness(record({ review: { lastActivityAt: '2026-07-30T00:00:00Z' } }), { now });
    assert.equal(fresh.stale, false);
  });

  test('a merged pull request is never stale', () => {
    const merged = pr.staleness(record({ state: 'merged' }), { now: new Date('2026-07-31T00:00:00Z') });
    assert.equal(merged.stale, false);
  });

  test('the threshold is configurable, because it is a guess', () => {
    const now = new Date('2026-07-31T00:00:00Z');
    const config = { review: { stale_after_days: 90 } };
    assert.equal(pr.staleness(record(), { now, config }).stale, false);
  });

  test('an unread pull request renders as unread rather than as green', () => {
    const values = pr.renderValues(record(), { issue: ISSUE });

    assert.equal(values.ciVerdict, 'inconclusive');
    assert.deepEqual(values.jobs, ['| — | — | — | not read yet | — |']);
    assert.equal(values.threads, '_Not read yet._');
    assert.equal(values.slice, 'single PR');
  });

  test('the job table names the pull requests a red job is shared with', () => {
    const values = pr.renderValues(
      record({
        slice: 2,
        ci: {
          verdict: 'inconclusive',
          checkedAt: null,
          jobs: [{ name: 'Windows', workflow: 'pr-check', conclusion: 'FAILURE', verdict: 'inconclusive', peers: [18550, 18486], url: null }],
        },
      }),
      { issue: ISSUE },
    );

    assert.equal(values.slice, '#2');
    assert.match(values.jobs[0], /\| Windows \| pr-check \| FAILURE \| inconclusive \| #18550, #18486 \|/);
  });
});
