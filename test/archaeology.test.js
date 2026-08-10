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

// Tests for lib/archaeology.js.
//
// Both fixtures below are the shape of podman-desktop#12775, because the two
// ways this report can be confidently wrong were found there and neither
// looked wrong:
//
//   - the revert references the PULL REQUEST it reverts, not the issue, so
//     asking the issue's timeline alone returned a merged attempt and no
//     revert — which reads as "this landed and is still there";
//   - picking "latest merge" and "latest revert" independently paired #17900
//     with #17829, an attempt its own revert predates. Every number in that
//     report was real and the relationship between them was invented, which is
//     the failure mode worth the most assertions.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collect, format, read, save } from '../lib/archaeology.js';

const CONFIG = {
  repo: { upstream: 'podman-desktop/podman-desktop' },
  review: { bots_collapsed: ['coderabbitai'] },
};

const REPO = { nameWithOwner: 'podman-desktop/podman-desktop' };

/** @param {object} over */
const prNode = (over = {}) => ({
  number: 16294,
  title: 'feat: add scrollable left navigation bar (Closes #12775)',
  state: 'MERGED',
  url: 'https://github.com/podman-desktop/podman-desktop/pull/16294',
  mergedAt: '2026-05-19T12:45:04Z',
  repository: REPO,
  ...over,
});

/**
 * A fake gh that answers by what is being asked, so a wrong question is
 * visible as a wrong answer rather than as the same canned payload.
 *
 * @param {{issueTimeline?: object[], prTimelines?: Record<number, object[]>, views?: Record<number, object>}} data
 * @param {object[]} [calls]
 */
function fakeGh(data, calls = []) {
  /** The `-F number=<n>` argument of a GraphQL call. */
  const numberOf = (args) => Number((args.find((arg) => String(arg).startsWith('number=')) ?? '').slice('number='.length));

  return (file, args, options, callback) => {
    calls.push({ args });
    const joined = args.join(' ');

    /** @param {unknown} payload */
    const answer = (payload) => queueMicrotask(() => callback(null, JSON.stringify(payload), ''));

    // reviewThreads is checked first: its query also selects
    // `pullRequest(number: $number)`, so the generic branch would swallow it
    // and answer with a timeline.
    if (joined.includes('reviewThreads')) {
      answer({
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: {}, nodes: data.views?.[numberOf(args)]?.threads ?? [] } } } },
      });
      // Same reason: the discussion query selects `pullRequest(number: $number)`
      // too. It moved off `pr view --json reviews,comments` in 0.20, because
      // that call reports an app account as a plain login and every bot it did
      // not know by name arrived looking like a person.
    } else if (joined.includes('reviews(first:')) {
      const view = data.views?.[numberOf(args)] ?? {};
      answer({
        data: {
          repository: {
            pullRequest: {
              reviews: { nodes: view.reviews ?? [] },
              comments: { nodes: view.comments ?? [] },
            },
          },
        },
      });
    } else if (joined.includes('pullRequest(number: $number)')) {
      answer({ data: { repository: { pullRequest: { timelineItems: { nodes: data.prTimelines?.[numberOf(args)] ?? [] } } } } });
    } else if (joined.includes('issue(number: $number)')) {
      answer({ data: { repository: { issue: { timelineItems: { nodes: data.issueTimeline ?? [] } } } } });
    } else if (args[0] === 'pr' && args[1] === 'view') {
      answer(data.views?.[Number(args[2])] ?? {});
    } else {
      answer({});
    }

    return { stdin: { end: () => {} } };
  };
}

/** The live shape: an attempt, a revert that references the attempt, a follow-up. */
const LIVE = {
  issueTimeline: [{ source: prNode() }, { source: prNode({ number: 17900, title: 'fix(renderer): remove overflow-hidden from nav', mergedAt: '2026-06-16T09:00:00Z' }) }],
  prTimelines: {
    16294: [
      { source: prNode({ number: 17829, title: 'revert: #16294', mergedAt: '2026-06-11T07:37:21Z' }) },
      { source: prNode({ number: 17900, title: 'fix(renderer): remove overflow-hidden from nav', mergedAt: '2026-06-16T09:00:00Z' }) },
    ],
    17900: [],
  },
  views: {
    16294: {
      number: 16294,
      title: 'feat: add scrollable left navigation bar (Closes #12775)',
      state: 'MERGED',
      body: 'Adds a scrollable area to the left navigation bar.',
      author: { login: 'AlexonOliveiraRH' },
      createdAt: '2026-05-01T00:00:00Z',
      mergedAt: '2026-05-19T12:45:04Z',
      mergeCommit: { oid: '99bf76412460956f187776935256429b51a25855' },
      changedFiles: 1,
      additions: 130,
      deletions: 12,
      reviews: [
        { author: { login: 'benoitf' }, state: 'CHANGES_REQUESTED', body: 'typecheck is failing, css is used rather than class attributes', submittedAt: '2026-05-10T00:00:00Z' },
        { author: { login: 'someone' }, state: 'APPROVED', body: 'looks fine', submittedAt: '2026-05-18T00:00:00Z' },
      ],
      comments: [{ author: { login: 'coderabbitai' }, body: 'Walkthrough of the changes', createdAt: '2026-05-02T00:00:00Z' }],
      threads: [
        {
          id: 'T1',
          isResolved: false,
          path: 'packages/renderer/src/AppNavigation.svelte',
          line: 10,
          comments: { nodes: [{ author: { login: 'simonrey1' }, body: 'issue(blocking): this seems really hacky to me', createdAt: '2026-05-11T00:00:00Z' }] },
        },
      ],
    },
    17829: {
      number: 17829,
      title: 'revert: #16294',
      state: 'MERGED',
      body: 'Reverting https://github.com/podman-desktop/podman-desktop/pull/16294 as per discussion.\n\nThis reverts commit 99bf764. Regression in #17800.',
      author: { login: 'axel7083' },
      mergedAt: '2026-06-11T07:37:21Z',
      mergeCommit: { oid: 'aaaa111' },
    },
    17900: {
      number: 17900,
      title: 'fix(renderer): remove overflow-hidden from nav',
      state: 'MERGED',
      author: { login: 'vancura' },
      mergedAt: '2026-06-16T09:00:00Z',
    },
  },
};

const dig = (over = {}) => collect({ issue: 12775, config: CONFIG, repoRoot: null, ...over });

describe('finding the attempt and what backed it out', () => {
  test('the revert is found through the pull request, not the issue', async () => {
    // #17829 appears nowhere in the timeline of #12775. An archaeology that
    // asked only the issue reported a merged attempt and no revert.
    const report = await dig({ exec: fakeGh(LIVE) });

    assert.equal(report.attempt.number, 16294);
    assert.equal(report.revert.number, 17829);
  });

  test('the pair is established rather than assembled from two latest picks', async () => {
    // The newest merge here is #17900, six days after the revert. Pairing by
    // date gives an attempt its own revert predates.
    const report = await dig({ exec: fakeGh(LIVE) });

    assert.notEqual(report.attempt.number, 17900);
    assert.equal(report.attempt.livedDays, 23);
  });

  test('what merged in the meantime is surfaced, whichever it references', async () => {
    const report = await dig({ exec: fakeGh(LIVE) });

    assert.deepEqual(
      report.after.map((pull) => pull.number),
      [17900],
    );
    assert.match(format(report), /part of this may already be redone/);
  });

  test('the revert body is read for the issue it names', async () => {
    const report = await dig({ exec: fakeGh(LIVE) });

    assert.deepEqual(report.revert.references, [17800]);
  });
});

describe('what the reviewers said', () => {
  test('changes-requested reviews are kept and approvals are not', async () => {
    const report = await dig({ exec: fakeGh(LIVE) });

    assert.deepEqual(
      report.discussion.changesRequested.map((review) => review.author),
      ['benoitf'],
    );
    assert.match(report.discussion.changesRequested[0].summary, /use.*class attributes|typecheck is failing/);
  });

  test('a blocking thread survives to the report, and bots are marked rather than dropped', async () => {
    const report = await dig({ exec: fakeGh(LIVE) });

    const blocking = report.discussion.threads.find((thread) => thread.author === 'simonrey1');
    assert.match(blocking.summary, /really hacky/);
    assert.equal(blocking.isBot, false);

    const bot = report.discussion.comments.find((comment) => comment.author === 'coderabbitai');
    assert.equal(bot.isBot, true, 'folded, not discarded');
  });
});

describe('honesty about what is missing', () => {
  test('a merge with no revert says so instead of implying one', async () => {
    const report = await dig({
      exec: fakeGh({ issueTimeline: [{ source: prNode() }], prTimelines: { 16294: [] }, views: LIVE.views }),
    });

    assert.equal(report.revert, null);
    assert.ok(report.gaps.some((gap) => /nothing reverts it/.test(gap)));
  });

  test('nothing merged at all is an answer: there may be nothing to redo', async () => {
    const report = await dig({ exec: fakeGh({ issueTimeline: [], prTimelines: {}, views: {} }) });

    assert.equal(report.attempt, null);
    assert.ok(report.gaps.some((gap) => /nothing to redo/.test(gap)));
  });

  test('without a local repository the files are unknown, and it says which', async () => {
    const report = await dig({ exec: fakeGh(LIVE) });

    assert.deepEqual(report.attempt.files, []);
    assert.ok(report.gaps.some((gap) => /no local repository/.test(gap)));
    assert.match(format(report), /not established:/);
  });
});

describe('the facts file', () => {
  test('round-trips, and read() is null before the lookup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pdkit-arch-'));

    try {
      assert.equal(await read(12775, { home }), null);

      const report = await dig({ exec: fakeGh(LIVE) });
      const path = await save(report, { home });

      assert.match(path, /issues\/12775\/archaeology\.json$/);
      assert.equal((await read(12775, { home })).attempt.number, 16294);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
