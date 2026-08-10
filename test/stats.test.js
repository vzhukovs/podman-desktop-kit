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

// Tests for lib/stats.js.
//
// The command exists to replace four numbers taken from common sense with a
// measurement, so the thing worth pinning is that the measurement is honest:
// percentiles that are real observations rather than interpolations, shares
// computed over the sample that was actually fetched, and — the part that took
// a live run to notice — a sampling window reported rather than assumed away.
//
// `gh pr list` orders by creation date, so a hundred merged pull requests are
// the last few weeks of work, not a hundred merges. That systematically drops
// the slow tail, which is precisely the population the staleness threshold is
// about. A report that stayed quiet about it would answer "0% took longer than
// fourteen days" over a window eleven days wide.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { collect, distribution, format, shareWithin } from '../lib/stats.js';

const CONFIG = {
  repo: { upstream: 'podman-desktop/podman-desktop' },
  quickfix: { max_files: 3, max_changed_lines: 20 },
  review: { stale_after_days: 14 },
};

const NOW = Date.parse('2026-08-01T00:00:00Z');

/**
 * A stand-in for execFile that answers per state, so one call cannot be
 * mistaken for the other.
 *
 * @param {{merged: object[], open: object[]}} data
 * @param {object[]} [calls]
 */
function fakeGh(data, calls = []) {
  return (file, args, options, callback) => {
    calls.push({ file, args });
    const state = args[args.indexOf('--state') + 1];
    queueMicrotask(() => callback(null, JSON.stringify(state === 'merged' ? data.merged : data.open), ''));
    return { stdin: { end: () => {} } };
  };
}

/** @param {object} over */
const pr = (over = {}) => ({
  number: 1,
  title: 'fix: the thing',
  author: { login: 'someone' },
  additions: 10,
  deletions: 5,
  changedFiles: 2,
  createdAt: '2026-07-25T00:00:00Z',
  updatedAt: '2026-07-26T00:00:00Z',
  mergedAt: '2026-07-26T00:00:00Z',
  state: 'MERGED',
  ...over,
});

describe('percentiles', () => {
  test('nearest rank: every number reported is one some pull request had', () => {
    // Interpolation would put p50 at 3.5, and no pull request changed three and
    // a half files. This report exists to be argued with, so its numbers have
    // to be findable.
    const dist = distribution([1, 2, 3, 4, 5, 6]);

    assert.equal(dist.p50, 3);
    assert.equal(dist.p75, 5);
    assert.equal(dist.p90, 6);
    assert.equal(dist.max, 6);
    assert.equal(dist.n, 6);
  });

  test('an empty sample is null everywhere rather than zero', () => {
    // Zero would read as "the median pull request changed no files".
    assert.deepEqual(distribution([]), { n: 0, p50: null, p75: null, p90: null, max: null });
  });

  test('non-numbers are dropped, not counted as zero', () => {
    const dist = distribution([5, undefined, Number.NaN, 7, null]);

    assert.equal(dist.n, 2);
    assert.equal(dist.p50, 5);
  });

  test('shares are over the usable sample', () => {
    assert.equal(shareWithin([1, 2, 3, 40], 3), 0.75);
    assert.equal(shareWithin([], 3), null);
  });
});

describe('collect', () => {
  test('two calls, both without the CI rollup', async () => {
    const calls = [];
    await collect({ config: CONFIG, now: NOW, exec: fakeGh({ merged: [pr()], open: [] }, calls) });

    assert.equal(calls.length, 2);
    for (const call of calls) {
      const fields = call.args[call.args.indexOf('--json') + 1];
      // Asking for it would turn a question about sizes into one rollup fetch
      // per pull request, which is what makes a sample of a hundred affordable.
      assert.ok(!fields.includes('statusCheckRollup'), 'the sample must stay cheap');
      assert.ok(fields.includes('changedFiles') && fields.includes('mergedAt'));
      assert.ok(call.args.includes('--repo') && call.args.includes('podman-desktop/podman-desktop'));
    }
    assert.deepEqual(
      calls.map((call) => call.args[call.args.indexOf('--state') + 1]).sort(),
      ['merged', 'open'],
    );
  });

  test('the sample size is clamped to what one page can answer', async () => {
    const calls = [];
    await collect({ config: CONFIG, limit: 5000, now: NOW, exec: fakeGh({ merged: [], open: [] }, calls) });

    assert.equal(calls[0].args[calls[0].args.indexOf('--limit') + 1], '100');
  });

  test('sizes and latency come out of the merged sample', async () => {
    const report = await collect({
      config: CONFIG,
      now: NOW,
      exec: fakeGh({
        merged: [
          pr({ changedFiles: 1, additions: 3, deletions: 1, createdAt: '2026-07-20T00:00:00Z', mergedAt: '2026-07-20T12:00:00Z' }),
          pr({ changedFiles: 9, additions: 400, deletions: 100, createdAt: '2026-07-01T00:00:00Z', mergedAt: '2026-07-21T00:00:00Z' }),
        ],
        open: [pr({ state: 'OPEN', updatedAt: '2026-07-01T00:00:00Z', mergedAt: null })],
      }),
    });

    assert.equal(report.merged.files.p50, 1);
    assert.equal(report.merged.lines.max, 500);
    assert.equal(report.merged.daysToMerge.max, 20);
    assert.equal(report.open.idleDays.p50, 31);
  });

  test('the window the sample covers is reported, because it bounds the answer', async () => {
    const report = await collect({
      config: CONFIG,
      now: NOW,
      exec: fakeGh({
        merged: [pr({ createdAt: '2026-07-20T00:00:00Z' }), pr({ createdAt: '2026-07-31T00:00:00Z' })],
        open: [],
      }),
    });

    assert.deepEqual(report.merged.window, { from: '2026-07-20T00:00:00Z', to: '2026-07-31T00:00:00Z' });
    assert.match(format(report), /merged sample opened between 2026-07-20 and 2026-07-31/);
  });

  test('each configured threshold is stated against what the population did', async () => {
    const report = await collect({
      config: CONFIG,
      now: NOW,
      exec: fakeGh({
        merged: [pr({ changedFiles: 2 }), pr({ changedFiles: 2 }), pr({ changedFiles: 2 }), pr({ changedFiles: 40 })],
        open: [],
      }),
    });

    const files = report.thresholds.find((entry) => entry.key === 'quickfix.max_files');
    assert.equal(files.configured, 3);
    assert.match(files.measured, /75% of merged pull requests changed 3 file\(s\) or fewer/);

    // The line count includes lockfiles and generated output; the threshold is
    // about lines a person writes. Comparing them silently is the lie.
    const linesEntry = report.thresholds.find((entry) => entry.key === 'quickfix.max_changed_lines');
    assert.match(linesEntry.caveat, /lockfiles and generated output/);

    const stale = report.thresholds.find((entry) => entry.key === 'review.stale_after_days');
    assert.match(stale.caveat, /under-counts exactly the slow tail/);
  });

  test('no sample says so instead of reporting zeroes', async () => {
    const report = await collect({ config: CONFIG, now: NOW, exec: fakeGh({ merged: [], open: [] }) });

    assert.equal(report.merged.window, null);
    assert.match(format(report), /no sample/);
  });
});

describe('the report recommends nothing', () => {
  test('it prints distributions and says the decision is not its own', async () => {
    const report = await collect({ config: CONFIG, now: NOW, exec: fakeGh({ merged: [pr()], open: [] }) });
    const text = format(report);

    assert.match(text, /No value is recommended here and nothing was written/);
    // A "suggested" field would be the recommendation the text disclaims.
    for (const threshold of report.thresholds) {
      assert.ok(!('suggested' in threshold));
      assert.ok(!('verdict' in threshold));
    }
  });
});
