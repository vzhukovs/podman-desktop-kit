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

// What planning cost and found, round by round, and what the plan needed after
// it was approved (`pdkit cost --planning`).
//
// lib/cost.js puts everything between `planned` and `plan-approved` into one
// phase, and a plan's reviews and revisions are in it together. The question
// here is finer: how many rounds a plan took, what each review and each
// revision cost, what each round raised and what the person decided — and,
// beside it, whether a plan that took fewer rounds then needed more mending in
// exec. Everything is read from what is already recorded:
//
//   - the journal: `plan-reviewed`, written when a round's report is, and
//     `plan-revised`, when its decisions reached the plan (both
//     lib/plan-review.js), cut the plan-review phase into windows. A call
//     belongs to the first of those entries at or after it: up to
//     `plan-reviewed round-k`, the review of round k; from there up to
//     `plan-revised round-k`, its revision.
//   - the review files, each round's items by letter and its decisions.
//   - after approval: amendments, stop reports, tasks whose `Done when`
//     failed a capture, and the findings audit.md lists — counts, each from
//     the module that owns the record.
//
// Calls are attributed to an issue and a phase by lib/cost.js's own
// attributor and phaser, from the same transcripts, on the same scale.
//
// Like lib/cost.js, this reports and recommends nothing: how many rounds are
// too many is a judgment about how to work, made by whoever reads the numbers.
//
// What it does not claim, and prints so a reader cannot miss it:
//
//   - A round with no `plan-reviewed` entry — every round before the entry
//     existed — has no line between its review and its revision. Its cost is
//     `unknown`, never divided by a guess; the windows that only `plan-revised`
//     closes are summed as one figure, "not split by round".
//   - The decisions a review session writes after its report fall in the
//     revision's window, since the entry is written when the report is.
//   - Only the issue's current cycle is read. After a reset, rounds and
//     windows start again; the earlier cycles are counted, not measured.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readAmendments } from './amendment.js';
import * as attempts from './attempts.js';
import * as audit from './audit.js';
import { resolveHome } from './config.js';
import * as cost from './cost.js';
import * as journal from './journal.js';
import * as planReview from './plan-review.js';
import * as state from './state.js';
import * as stops from './stops.js';

/** A cost that cannot be known from what was recorded. */
export const UNKNOWN = 'unknown';

/** A revision that did not happen: the round has no `plan-revised`. */
export const NONE = 'none';

/** The two transitions that bound planning in lib/cost.js's phases. */
const PLANNED = 'planned';
const APPROVED = 'plan-approved';

/**
 * Calls summed, and when the first and the last of them were made.
 *
 * @typedef {object} Part
 * @property {number} calls
 * @property {number} subagentCalls
 * @property {number} units
 * @property {string|null} first
 * @property {string|null} last
 */

/**
 * @param {import('./cost.js').Call[]} calls
 * @returns {Part}
 */
function part(calls) {
  const totals = cost.tally(calls);
  const times = calls.map((call) => call.at).sort((left, right) => Date.parse(left) - Date.parse(right));
  return { calls: totals.calls, subagentCalls: totals.subagentCalls, units: totals.units, first: times[0] ?? null, last: times.at(-1) ?? null };
}

/**
 * A round boundary: a `plan-reviewed` or `plan-revised` entry.
 *
 * @typedef {object} Mark
 * @property {string} at
 * @property {'review'|'revision'} kind   what the entry closes
 * @property {number} round
 * @property {string} detail
 */

/**
 * A lookup from an instant to the boundary that closes its window: the first
 * mark at or after it, null after the last.
 *
 * The window is named by the entry that closes it rather than the one that
 * opens it: what follows `plan-revised round-2` is round 3's review only if a
 * `plan-reviewed round-3` comes, and it may instead be the approval.
 *
 * @param {Mark[]} marks
 * @returns {(at: string) => Mark|null}
 */
export function closer(marks) {
  const sorted = marks
    .map((mark) => ({ mark, t: Date.parse(mark.at) }))
    .filter((entry) => Number.isFinite(entry.t))
    .sort((left, right) => left.t - right.t);

  return (at) => {
    const t = Date.parse(at);
    let low = 0;
    let high = sorted.length - 1;
    let best = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (sorted[middle].t >= t) {
        best = sorted[middle].mark;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    return best;
  };
}

/**
 * The boundaries of an issue's plan-review phase, from its journal.
 *
 * @param {import('./journal.js').Entry[]} cycle  the current cycle's entries
 * @param {(at: string) => string} phaseOf
 * @returns {Mark[]}
 */
export function marksOf(cycle, phaseOf) {
  return cycle.flatMap((entry) => {
    const kind = entry.event === planReview.REVIEWED ? 'review' : entry.event === planReview.REVISED ? 'revision' : null;
    const round = kind ? planReview.roundOf(entry.detail) : null;
    if (kind === null || round === null || phaseOf(entry.at) !== 'plan-review') return [];
    return [{ at: entry.at, kind, round, detail: entry.detail }];
  });
}

/**
 * @typedef {object} Round
 * @property {number} round
 * @property {string|null} file                 the review file of the round, null when there is none
 * @property {'journal'|'file'|null} countedFrom where mode and items were read
 * @property {'full'|'delta'|'unknown'} mode
 * @property {{A: number, B: number, C: number}|null} items
 * @property {import('./plan-review.js').ReviewSummary['decisions']} decisions  from the file; null with no decision section
 * @property {Part|'unknown'} review
 * @property {Part|'unknown'|'none'} revision
 */

/**
 * The facts read for one issue besides its calls and its journal.
 *
 * @typedef {object} IssueRecord
 * @property {string} [state]
 * @property {Array<{file: string, round: number} & Omit<import('./plan-review.js').ReviewSummary, 'round'>>} reviews
 * @property {{amendments: number, stops: number, failedTasks: Array<{taskId: string, failed: number}>, audit: {count: number|null, reason: string|null}}} after
 */

/**
 * One issue's planning, from its calls, its journal and its records. Pure.
 *
 * @param {object} input
 * @param {number} input.issue
 * @param {import('./cost.js').Call[]|null} input.calls   attributed to the issue; null when no transcript was read
 * @param {import('./journal.js').Entry[]} input.entries   the issue's own, oldest first
 * @param {IssueRecord} input.record
 */
export function issueReport(input) {
  const { issue, entries, record } = input;
  const measured = input.calls !== null;
  const resets = entries.filter((entry) => entry.event === journal.RESET_EVENT);
  const cycle = journal.sinceLastReset(entries);
  const cycleStart = resets.at(-1)?.at ?? null;

  const planned = cycle.find((entry) => entry.event === PLANNED) ?? null;
  const approved = planned ? (cycle.find((entry) => entry.event === APPROVED && Date.parse(entry.at) >= Date.parse(planned.at)) ?? null) : null;

  const phaseOf = cost.phaser(cycle);
  const calls = (input.calls ?? []).filter((call) => cycleStart === null || Date.parse(call.at) >= Date.parse(cycleStart));
  const marks = marksOf(cycle, phaseOf);
  const reviewed = new Set(marks.filter((mark) => mark.kind === 'review').map((mark) => mark.round));
  const closeOf = closer(marks);

  /** @type {Map<string, import('./cost.js').Call[]>} */
  const windows = new Map();
  const put = (key, call) => {
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key)?.push(call);
  };
  const firstPlan = [];
  const afterFirstPlan = [];
  for (const call of calls) {
    const phase = phaseOf(call.at);
    if (phase === 'plan') firstPlan.push(call);
    if (phase !== 'plan-review') continue;
    afterFirstPlan.push(call);
    const mark = closeOf(call.at);
    if (mark === null) put('tail', call);
    else if (mark.kind === 'review') put(`review-${mark.round}`, call);
    else put(reviewed.has(mark.round) ? `revision-${mark.round}` : 'unsplit', call);
  }
  const windowOf = (key) => (measured ? part(windows.get(key) ?? []) : UNKNOWN);

  const numbers = [...new Set([...record.reviews.map((review) => review.round), ...marks.map((mark) => mark.round)])].sort((a, b) => a - b);
  /** @type {Round[]} */
  const rounds = numbers.map((round) => {
    const file = record.reviews.filter((review) => review.round === round).at(-1) ?? null;
    const recorded = marks.filter((mark) => mark.kind === 'review' && mark.round === round).at(-1) ?? null;
    const fromJournal = recorded ? planReview.reviewedFrom(recorded.detail) : null;
    const revised = marks.some((mark) => mark.kind === 'revision' && mark.round === round);
    return {
      round,
      file: file?.file ?? null,
      countedFrom: fromJournal ? 'journal' : file ? 'file' : null,
      mode: fromJournal?.mode ?? file?.mode ?? planReview.UNKNOWN_MODE,
      items: fromJournal?.items ?? file?.items ?? null,
      decisions: file?.decisions ?? null,
      review: recorded ? windowOf(`review-${round}`) : UNKNOWN,
      revision: !revised ? NONE : recorded ? windowOf(`revision-${round}`) : UNKNOWN,
    };
  });

  return {
    issue,
    state: record.state ?? 'unknown',
    cycle: { start: cycleStart, earlier: resets.length },
    planned: planned?.at ?? null,
    approved: approved?.at ?? null,
    totals: {
      firstPlan: measured ? part(firstPlan) : UNKNOWN,
      afterFirstPlan: measured ? part(afterFirstPlan) : UNKNOWN,
      unsplit: windowOf('unsplit'),
      tail: windowOf('tail'),
    },
    lastMark: marks.at(-1) ?? null,
    unrecorded: rounds.filter((round) => round.review === UNKNOWN).map((round) => round.round),
    rounds,
    after: approved === null ? null : { at: approved.at, ...record.after },
  };
}

/**
 * The issues that have a plan in their current cycle.
 *
 * @param {import('./journal.js').Entry[]} entries the whole journal
 * @returns {number[]}
 */
export function plannedIssues(entries) {
  /** @type {Map<number, import('./journal.js').Entry[]>} */
  const byIssue = new Map();
  for (const entry of entries) {
    if (entry.issue == null) continue;
    if (!byIssue.has(entry.issue)) byIssue.set(entry.issue, []);
    byIssue.get(entry.issue)?.push(entry);
  }
  return [...byIssue]
    .filter(([, own]) => journal.sinceLastReset(own).some((entry) => entry.event === PLANNED))
    .map(([issue]) => issue)
    .sort((a, b) => a - b);
}

/**
 * Attribute calls and assemble the report. Pure: every source has been read.
 *
 * @param {object} input
 * @param {import('./cost.js').Scan} input.scan
 * @param {import('./journal.js').Entry[]} input.entries   the whole journal
 * @param {Record<number, IssueRecord>} input.records
 * @param {number|null} [input.issue]
 * @param {string} [input.generatedAt]
 * @param {number} [input.windowMs]
 */
export function build(input) {
  const windowMs = input.windowMs ?? cost.ATTRIBUTION_WINDOW_MS;
  const scanned = input.scan;
  const measured = scanned.missing.length < scanned.dirs.length;

  const issueOf = cost.attributor(input.entries, windowMs);
  /** @type {Map<number, import('./cost.js').Call[]>} */
  const byIssue = new Map();
  let unattributed = 0;
  for (const call of measured ? scanned.calls : []) {
    const issue = issueOf(call.at);
    if (issue === null) {
      unattributed += 1;
      continue;
    }
    if (!byIssue.has(issue)) byIssue.set(issue, []);
    byIssue.get(issue)?.push(call);
  }

  const wanted = input.issue == null ? plannedIssues(input.entries) : [input.issue];
  const blank = { reviews: [], after: { amendments: 0, stops: 0, failedTasks: [], audit: { count: null, reason: 'not read' } } };

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    issue: input.issue ?? null,
    attributionWindowHours: windowMs / 3_600_000,
    weights: { ...cost.TOKEN_WEIGHTS, opusMultiplier: cost.OPUS_MULTIPLIER },
    transcripts: {
      dirs: scanned.dirs,
      missing: scanned.missing,
      skip: measured ? null : `no transcripts at ${scanned.dirs.join(', ')}; every cost below is unknown`,
    },
    coverage: measured
      ? {
          calls: scanned.calls.length,
          attributed: scanned.calls.length - unattributed,
          unattributed,
          unattributedShare: cost.unattributedShare(unattributed, scanned.calls.length),
        }
      : null,
    issues: wanted.map((issue) =>
      issueReport({
        issue,
        calls: measured ? (byIssue.get(issue) ?? []) : null,
        entries: input.entries.filter((entry) => entry.issue === issue),
        record: input.records[issue] ?? blank,
      }),
    ),
  };
}

/** @typedef {ReturnType<typeof build>} Report */

/**
 * Read the review files and the after-approval records of one issue, each
 * through the module that owns it.
 *
 * @param {number} issue
 * @param {string} home
 * @returns {Promise<IssueRecord>}
 */
async function recordOf(issue, home) {
  return {
    state: (await state.read(issue, { home })).state,
    reviews: await planReview.summaries(issue, { home }),
    after: {
      amendments: (await readAmendments(issue, home)).length,
      stops: (await stops.read(issue, { home })).length,
      failedTasks: await attempts.failures({ issue, home }),
      audit: await audit.findings(issue, { home }),
    },
  };
}

/**
 * Read every source and build the report.
 *
 * @param {object} input
 * @param {string[]} input.transcripts
 * @param {string} [input.home]
 * @param {number|null} [input.issue]
 * @returns {Promise<Report>}
 */
export async function collect(input) {
  const home = input.home ?? resolveHome();
  const scanned = await cost.scan(input.transcripts);
  const entries = await journal.read({}, { home });

  const wanted = input.issue != null ? [input.issue] : plannedIssues(entries);
  /** @type {Record<number, IssueRecord>} */
  const records = {};
  for (const issue of wanted) records[issue] = await recordOf(issue, home);

  return build({ scan: scanned, entries, records, issue: input.issue ?? null });
}

/**
 * Write the report as `$PDKIT_HOME/cost/planning/<date>.json`, beside the cost
 * snapshots and out of their way: `--compare` reads those by date. A second
 * one on the same day replaces the first.
 *
 * @param {Report} report
 * @param {{home?: string}} [options]
 * @returns {Promise<string>}
 */
export async function writeSnapshot(report, options = {}) {
  const dir = join(cost.snapshotDir(options.home ?? resolveHome()), 'planning');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${report.generatedAt.slice(0, 10)}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/** `2026-11-12 22:47 UTC`. */
function when(at) {
  return at ? `${at.slice(0, 16).replace('T', ' ')} UTC` : '—';
}

/**
 * Units, or the word that stands for them. A window no call was attributed to
 * is a dash: nothing measured is not a cost of zero.
 */
function units(value) {
  if (typeof value === 'string') return value;
  return value.calls === 0 ? '—' : cost.human(value.units);
}

/** `1.7 M (212 calls)`, or the word. */
function sized(value) {
  return typeof value === 'string' ? value : `${cost.human(value.units)} (${value.calls} calls)`;
}

/** Rounds 1–5, 7 as a list of runs. */
function runs(numbers) {
  const out = [];
  for (const n of numbers) {
    const last = out.at(-1);
    if (last && last[1] === n - 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(', ');
}

/** The decisions of a round that are neither accepted nor rejected. */
function open(decisions) {
  return decisions ? decisions.undecided + decisions.unread + decisions.missing : null;
}

/** A number, or a dash for one nobody counted. */
function count(value) {
  return Number.isFinite(value) ? String(value) : '—';
}

/**
 * A column summed over rounds. A count missing from any round — a letter the
 * review has no section for, or decisions it has no `## Operator decisions`
 * section for — makes the sum a dash: a total with a hole in it is not a
 * total, and a review decided in another shape did not decide nothing.
 *
 * @param {Round[]} rounds
 * @param {(round: Round) => number|null} pick
 * @returns {string}
 */
function total(rounds, pick) {
  let sum = 0;
  for (const round of rounds) {
    const value = pick(round);
    if (value === null) return '—';
    sum += value;
  }
  return String(sum);
}

/** The columns `total` sums, by name. */
const COLUMNS = {
  A: (round) => round.items?.A ?? null,
  B: (round) => round.items?.B ?? null,
  C: (round) => round.items?.C ?? null,
  accepted: (round) => round.decisions?.accepted ?? null,
  rejected: (round) => round.decisions?.rejected ?? null,
  other: (round) => open(round.decisions),
};

/** The caveats every planning report carries. */
function caveats(report) {
  return [
    'windows      in plan-review, a call belongs to the first plan-reviewed or plan-revised entry at or after it:',
    '             up to plan-reviewed round-k, the review of round k; then up to plan-revised round-k, its revision',
    'decisions    written after the report, so they fall in the revision\'s window',
    'not split    a round with no plan-reviewed entry has no line between review and revision: its cost is unknown,',
    '             and the windows closed by plan-revised alone are one sum',
    'cycle        only the current cycle, since the last reset; earlier cycles are counted, not measured',
    `attribution  as pdkit cost: the issue of the nearest earlier journal entry within ${report.attributionWindowHours} h`,
    'units        input + 0.1 cache-read + 1.25 cache-write + 5 output, x5 on Opus, as pdkit cost',
    'after        counts: amendment files, stop reports, tasks with a failed capture since the reset, findings in audit.md',
  ].map((line) => `    ${line}`);
}

/**
 * @param {ReturnType<typeof issueReport>} entry
 * @returns {string[]}
 */
function issueBlock(entry) {
  const cycle = entry.cycle.start ? `cycle since ${when(entry.cycle.start)}, after ${entry.cycle.earlier} reset(s)` : 'first cycle';
  const lines = [`planning: issue ${entry.issue} — ${entry.state}; ${cycle}`, ''];

  if (entry.planned === null) {
    lines.push('  no plan in this cycle: no `planned` entry since the last reset', '');
    return lines;
  }

  const t = entry.totals;
  lines.push(
    `  first plan          ${sized(t.firstPlan).padEnd(22)} triaged → planned ${when(entry.planned)}`,
    `  after first plan    ${sized(t.afterFirstPlan).padEnd(22)} planned → ${entry.approved ? `plan-approved ${when(entry.approved)}` : 'not approved yet'}`,
  );
  if (t.unsplit === UNKNOWN || t.unsplit.calls > 0) {
    lines.push(`    not split         ${sized(t.unsplit).padEnd(22)} windows closed by plan-revised alone`);
  }
  if (t.tail === UNKNOWN || t.tail.calls > 0) {
    const after = entry.lastMark ? `after ${entry.lastMark.kind === 'review' ? 'plan-reviewed' : 'plan-revised'} round-${entry.lastMark.round}` : 'no round entry in the phase';
    lines.push(`    after the last    ${sized(t.tail).padEnd(22)} ${after}`);
  }
  if (entry.unrecorded.length > 0) {
    lines.push(`  round(s) ${runs(entry.unrecorded)} have no plan-reviewed entry: their review and revision costs are unknown`);
  }
  lines.push('');

  if (entry.rounds.length === 0) {
    lines.push('  no review round: no review file and no round entry', '');
  } else {
    lines.push('  round  mode       A    B    C   accepted  rejected  other   review        revision      counted from');
    for (const round of entry.rounds) {
      const items = round.items ?? { A: null, B: null, C: null };
      const d = round.decisions;
      lines.push(
        `  r${String(round.round).padEnd(5)} ${round.mode.padEnd(8)} ${count(items.A).padStart(3)}  ${count(items.B).padStart(3)}  ${count(items.C).padStart(3)}   ` +
          `${count(d?.accepted).padStart(8)}  ${count(d?.rejected).padStart(8)}  ${count(open(d)).padStart(5)}   ` +
          `${units(round.review).padEnd(12)}  ${units(round.revision).padEnd(12)}  ${round.countedFrom === 'journal' ? 'journal' : (round.file ?? '—')}`,
      );
    }
    const sum = (name) => total(entry.rounds, COLUMNS[name]);
    lines.push(
      `  all             ${sum('A').padStart(3)}  ${sum('B').padStart(3)}  ${sum('C').padStart(3)}   ` +
        `${sum('accepted').padStart(8)}  ${sum('rejected').padStart(8)}  ${sum('other').padStart(5)}`,
      '',
    );
  }

  if (entry.after === null) {
    lines.push('  after approval: not approved in this cycle', '');
  } else {
    const a = entry.after;
    const failed = a.failedTasks.length > 0 ? `   (${a.failedTasks.map((task) => `${task.taskId} ×${task.failed}`).join(', ')})` : '';
    lines.push(
      `  after approval (${when(a.at)})`,
      `    amendments                   ${a.amendments}`,
      `    stop reports                 ${a.stops}`,
      `    tasks with a failed capture  ${a.failedTasks.length}${failed}`,
      `    audit findings               ${a.audit.count === null ? `— (${a.audit.reason})` : a.audit.count}`,
      '',
    );
  }
  return lines;
}

/**
 * @param {Report} report
 * @returns {string}
 */
export function format(report) {
  const lines = [];
  if (report.transcripts.skip) lines.push(`  skip: ${report.transcripts.skip}`, '');

  if (report.issue != null) {
    for (const entry of report.issues) lines.push(...issueBlock(entry));
  } else {
    lines.push(`planning: every issue with a plan in its current cycle (${report.issues.length})`, '');
    // Header and rows through one set of widths, so they cannot drift apart.
    const widths = [-8, -16, 6, 8, 10, 10, 4, 4, 4, 8, 8, 6, 5, 6, 5];
    const row = (cells) => `  ${cells.map((cell, at) => (widths[at] < 0 ? cell.padEnd(-widths[at]) : cell.padStart(widths[at]))).join(' ')}`.trimEnd();
    lines.push(row(['issue', 'state', 'rounds', 'recorded', 'first plan', 'after plan', 'A', 'B', 'C', 'accepted', 'rejected', 'amend', 'stops', 'failed', 'audit']));
    for (const entry of report.issues) {
      const sum = (name) => total(entry.rounds, COLUMNS[name]);
      const a = entry.after;
      lines.push(
        row([
          String(entry.issue),
          entry.state,
          String(entry.rounds.length),
          String(entry.rounds.length - entry.unrecorded.length),
          units(entry.totals.firstPlan),
          units(entry.totals.afterFirstPlan),
          sum('A'),
          sum('B'),
          sum('C'),
          sum('accepted'),
          sum('rejected'),
          a ? String(a.amendments) : '—',
          a ? String(a.stops) : '—',
          a ? String(a.failedTasks.length) : '—',
          a ? count(a.audit.count) : '—',
        ]),
      );
    }
    lines.push(
      '',
      '  — in a cost: no call attributed; in A, B, C: a round whose review has no section for the letter;',
      '  in accepted, rejected: a round with no "## Operator decisions"; after approval: not approved, or not counted.',
      '  `recorded` is the rounds with a plan-reviewed entry. pdkit cost --planning --issue <n> splits one by round.',
      '',
    );
  }

  if (report.coverage) {
    const c = report.coverage;
    lines.push(
      `  attribution  ${c.attributed} of ${c.calls} call(s) mapped to an issue; ${c.unattributed} to none`,
      '',
    );
  }
  lines.push('  caveats', ...caveats(report), '');
  return lines.join('\n');
}
