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

// Measurements for the thresholds that were guessed (spec section 13, open
// items L and the fourth PoC question).
//
// Four numbers in config.yaml were taken from common sense and labelled as
// such: `quickfix.max_changed_lines`, `quickfix.max_files`,
// `review.stale_after_days`, and the ceiling this repository now puts on
// attempts. Common sense is a reasonable starting point and a poor resting
// place — a threshold nobody has measured is a threshold nobody can defend,
// and the first time it is inconvenient it gets moved by feel.
//
// This module measures the population those numbers are about: pull requests
// that upstream actually merged. It reports distributions and where each
// configured value falls in them. It does not recommend a value and it does
// not write configuration, for the reason lib/audit.js does not grade its own
// findings — "42% of merged pull requests changed three files or fewer" is a
// fact, and "so set max_files to 5" is a decision about how this fork wants to
// work.
//
// What it deliberately does not claim: `additions + deletions` counts every
// line in the diff, including lockfiles, generated schemas and vendored
// output, while `quickfix.max_changed_lines` is about the lines a person
// writes. The two are not the same number, and the report says so rather than
// quietly comparing them.

import { get } from './config.js';
import * as gh from './gh.js';

/** One day, in milliseconds. */
const DAY = 86_400_000;

/**
 * A measured spread, reported by percentile rather than as an average.
 *
 * A mean over pull request sizes is dragged by one dependency bump touching four
 * hundred files, and the thresholds this exists to calibrate are about the
 * typical case. `n` travels with the percentiles so a figure computed from six
 * pull requests cannot be read as one computed from six hundred.
 *
 * @typedef {object} Distribution
 * @property {number} n
 * @property {number|null} p50
 * @property {number|null} p75
 * @property {number|null} p90
 * @property {number|null} max
 */

/**
 * Nearest-rank percentiles over a sample.
 *
 * Nearest-rank rather than interpolation: every value it reports is a value
 * some pull request actually had. An interpolated 4.5 files is a pull request
 * that does not exist, and this report exists to be argued with.
 *
 * @param {number[]} values
 * @returns {Distribution}
 */
export function distribution(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return { n: 0, p50: null, p75: null, p90: null, max: null };

  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];

  return { n: sorted.length, p50: at(0.5), p75: at(0.75), p90: at(0.9), max: sorted[sorted.length - 1] };
}

/**
 * The share of a sample at or below a bound.
 *
 * @param {number[]} values
 * @param {number} bound
 * @returns {number|null}
 */
export function shareWithin(values, bound) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return null;
  return usable.filter((value) => value <= bound).length / usable.length;
}

/**
 * What upstream's pull requests actually look like, against the thresholds
 * guessed for them.
 *
 * Recommends nothing and writes nothing. `thresholds` puts each configured
 * number beside the measurement of the population it is about, so the decision
 * to move one is taken by a person looking at both — a config this file edited
 * would be a threshold nobody chose.
 *
 * @typedef {object} Report
 * @property {string} repository
 * @property {string|null} author           when the sample was narrowed to one
 * @property {{sampled: number, files: Distribution, lines: Distribution, daysToMerge: Distribution}} merged
 * @property {{sampled: number, idleDays: Distribution}} open
 * @property {Array<{key: string, configured: number, measured: string, caveat?: string}>} thresholds
 */

/**
 * Measure the population the guessed thresholds are about.
 *
 * Two calls: merged pull requests for size and latency, open ones for how long
 * a live pull request normally goes quiet. Both are `gh pr list` without the
 * CI rollup, which is what makes a sample of a hundred affordable.
 *
 * @param {{limit?: number, author?: string, config: object, now?: number, exec?: Function}} input
 * @returns {Promise<Report>}
 */
export async function collect(input) {
  const now = input.now ?? Date.now();
  const limit = Math.min(Math.max(1, Number(input.limit) || 60), 100);
  const options = { config: input.config, exec: input.exec, fields: gh.PR_SHAPE_FIELDS, limit, author: input.author };

  const [merged, open] = await Promise.all([
    gh.pullRequests({ ...options, state: 'merged' }),
    gh.pullRequests({ ...options, state: 'open' }),
  ]);

  const files = merged.map((pr) => pr.changedFiles);
  const lines = merged.map((pr) => (pr.additions ?? 0) + (pr.deletions ?? 0));
  const daysToMerge = merged
    .filter((pr) => pr.createdAt && pr.mergedAt)
    .map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / DAY);
  const idleDays = open.filter((pr) => pr.updatedAt).map((pr) => (now - Date.parse(pr.updatedAt)) / DAY);

  // `gh pr list` orders by creation, newest first, so a sample of a hundred is
  // "the last N days of work" rather than "a hundred merges". A pull request
  // opened before that window and merged yesterday is not in it — which biases
  // exactly the tail the staleness question is about, since the ones missing
  // are the slow ones. Reporting the window is what lets a reader see it.
  const created = merged.map((pr) => pr.createdAt).filter(Boolean).sort();
  const window = created.length > 0 ? { from: created[0], to: created[created.length - 1] } : null;

  const maxFiles = Number(get(input.config, 'quickfix.max_files'));
  const maxLines = Number(get(input.config, 'quickfix.max_changed_lines'));
  const stale = Number(get(input.config, 'review.stale_after_days'));

  /** @param {number|null} share */
  const percent = (share) => (share === null ? 'no sample' : `${Math.round(share * 100)}%`);

  return {
    repository: String(get(input.config, 'repo.upstream') ?? ''),
    author: input.author ?? null,
    merged: {
      sampled: merged.length,
      window,
      files: distribution(files),
      lines: distribution(lines),
      daysToMerge: distribution(daysToMerge),
    },
    open: { sampled: open.length, idleDays: distribution(idleDays) },
    thresholds: [
      {
        key: 'quickfix.max_files',
        configured: maxFiles,
        measured: `${percent(shareWithin(files, maxFiles))} of merged pull requests changed ${maxFiles} file(s) or fewer`,
      },
      {
        key: 'quickfix.max_changed_lines',
        configured: maxLines,
        measured: `${percent(shareWithin(lines, maxLines))} of merged pull requests changed ${maxLines} line(s) or fewer`,
        caveat: 'additions + deletions counts lockfiles and generated output; the threshold is about hand-written lines',
      },
      {
        key: 'review.stale_after_days',
        configured: stale,
        // The interesting direction is the opposite one: not how many are
        // stale, but how much normal work this would call stale.
        measured:
          `${percent(shareWithin(daysToMerge, stale) === null ? null : 1 - shareWithin(daysToMerge, stale))} of merged ` +
          `pull requests took longer than ${stale} day(s) to merge; ${idleDays.filter((days) => days > stale).length} of ` +
          `${open.length} open ones have been quiet longer than that`,
        caveat:
          'time to merge is not silence, and the sample is the most recently opened pull requests — one opened ' +
          'before the window and merged yesterday is missing from it, which under-counts exactly the slow tail',
      },
    ],
  };
}

/**
 * @param {Distribution} dist
 * @param {(value: number) => string} [render]
 * @returns {string}
 */
function row(dist, render = (value) => String(Math.round(value))) {
  if (dist.n === 0) return 'no sample';
  return `p50 ${render(dist.p50)}   p75 ${render(dist.p75)}   p90 ${render(dist.p90)}   max ${render(dist.max)}`;
}

/**
 * @param {Report} report
 * @returns {string}
 */
export function format(report) {
  const who = report.author ? ` by ${report.author}` : '';
  const window = report.merged.window;
  const lines = [
    `stats: ${report.merged.sampled} merged and ${report.open.sampled} open pull request(s)${who} in ${report.repository}`,
    window ? `  merged sample opened between ${window.from.slice(0, 10)} and ${window.to.slice(0, 10)}` : '',
    '',
    `  files changed     ${row(report.merged.files)}`,
    `  lines changed     ${row(report.merged.lines)}`,
    `  days to merge     ${row(report.merged.daysToMerge)}`,
    `  open, days quiet  ${row(report.open.idleDays)}`,
    '',
    '  Configured against measured:',
  ];

  for (const threshold of report.thresholds) {
    lines.push(`    ${threshold.key} = ${threshold.configured}`);
    lines.push(`      ${threshold.measured}`);
    if (threshold.caveat) lines.push(`      caveat: ${threshold.caveat}`);
  }

  lines.push(
    '',
    '  No value is recommended here and nothing was written. What a threshold',
    '  should be is a decision about how this fork wants to work; what the',
    '  population does is the part that was guessed until now.',
    '',
  );

  return lines.join('\n');
}
