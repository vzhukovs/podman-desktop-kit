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

// Tests for lib/planning.js.
//
// The report exists to put a number on each review round and each revision,
// where the cost report had one figure for all of them, and to say "unknown"
// where nothing recorded the line between them. So what is pinned here is the
// cut: which window a call falls in, that a round with no plan-reviewed entry
// is never divided by a guess, that an earlier cycle's calls and rounds stay
// out, and that a cost nobody could read is "unknown" rather than zero.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { issueDir } from '../lib/config.js';
import { append } from '../lib/journal.js';
import { NONE, UNKNOWN, build, closer, collect, format, issueReport, plannedIssues } from '../lib/planning.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-12T10:00:00Z');
const ISSUE = 100;

/** @param {number} hours after T0 */
const at = (hours) => new Date(T0 + hours * HOUR).toISOString();

/**
 * A Sonnet call whose cost in units is its fresh input.
 *
 * @param {number} hours
 * @param {number} input
 */
const call = (hours, input) => ({ at: at(hours), model: 'claude-sonnet-5', sessionId: 's1', agent: null, usage: { input, cacheRead: 0, cacheWrite: 0, output: 0 } });

/** @param {number} hours @param {string} event @param {string} [detail] */
const entry = (hours, event, detail = '') => ({ at: at(hours).replace(/\.\d{3}Z$/, 'Z'), issue: ISSUE, slice: null, event, detail });

const AFTER = { amendments: 1, stops: 0, failedTasks: [{ taskId: 'T2', failed: 2 }], audit: { count: 3, reason: null } };

/** A round as plan-review.js summarizes a file. */
const file = (round, name, items = { A: 1, B: 1, C: 0 }) => ({
  file: name,
  round,
  mode: /** @type {const} */ ('unknown'),
  items,
  decisions: { accepted: 1, rejected: 1, undecided: 0, unread: 0, missing: 0 },
});

/** @param {import('../lib/planning.js').Part|string} value */
const unitsOf = (value) => (typeof value === 'string' ? value : value.units);

describe('the window a call falls in', () => {
  test('the first boundary at or after the instant closes it, and nothing does after the last', () => {
    const close = closer([
      { at: at(2), kind: 'review', round: 1, detail: '' },
      { at: at(3), kind: 'revision', round: 1, detail: '' },
    ]);
    assert.equal(close(at(1))?.kind, 'review');
    assert.equal(close(at(2))?.kind, 'review', 'a call at the instant of the entry is before it was written');
    assert.equal(close(at(2.5))?.kind, 'revision');
    assert.equal(close(at(3.5)), null);
  });
});

describe('one issue, rounds recorded', () => {
  // An earlier cycle planned and revised a round 1; the reset ends it. In the
  // current one, round 1 is reviewed and revised, round 2 reviewed and approved.
  const report = issueReport({
    issue: ISSUE,
    calls: [call(-8.5, 7), call(0.7, 100), call(1.5, 200), call(2.5, 300), call(3.5, 400), call(4.5, 500), call(5.5, 600)],
    entries: [
      entry(-10, 'triaged'),
      entry(-9, 'planned'),
      entry(-8, 'plan-revised', 'round-1 applied to plan.md'),
      entry(0, 'reset', 'was planned'),
      entry(0.5, 'triaged'),
      entry(1, 'planned'),
      entry(2, 'plan-reviewed', 'round-1 mode=full A=2 B=1 C=0'),
      entry(3, 'plan-revised', 'round-1 applied to plan.md'),
      entry(4, 'plan-reviewed', 'round-2 mode=delta A=0 B=1 C=1'),
      entry(5, 'plan-approved'),
    ],
    record: { state: 'plan-approved', reviews: [file(1, 'plan-review.r1.md'), file(2, 'plan-review.md')], after: AFTER },
  });

  test('each review and each revision is its own window', () => {
    assert.deepEqual(
      report.rounds.map((round) => [round.round, unitsOf(round.review), unitsOf(round.revision)]),
      [
        [1, 200, 300],
        [2, 400, NONE],
      ],
    );
  });

  test('the first plan, the whole phase after it, and what came after the last entry', () => {
    assert.equal(unitsOf(report.totals.firstPlan), 100);
    assert.equal(unitsOf(report.totals.afterFirstPlan), 200 + 300 + 400 + 500);
    assert.equal(unitsOf(report.totals.tail), 500);
    assert.equal(unitsOf(report.totals.unsplit), 0);
  });

  test("an earlier cycle's calls and rounds are not this cycle's", () => {
    assert.deepEqual(report.cycle, { start: entry(0, 'reset').at, earlier: 1 });
    assert.deepEqual(report.unrecorded, []);
  });

  test('mode and items come from the journal entry when the round has one', () => {
    assert.deepEqual(
      report.rounds.map((round) => [round.mode, round.items, round.countedFrom, round.decisions?.rejected]),
      [
        ['full', { A: 2, B: 1, C: 0 }, 'journal', 1],
        ['delta', { A: 0, B: 1, C: 1 }, 'journal', 1],
      ],
    );
  });

  test('after approval, the counts as read', () => {
    assert.deepEqual(report.after, { at: entry(5, 'plan-approved').at, ...AFTER });
  });
});

describe('rounds without a plan-reviewed entry', () => {
  // Every issue planned before the entry existed: plan-revised alone.
  const old = issueReport({
    issue: ISSUE,
    calls: [call(1.5, 10), call(2.5, 20), call(3.5, 40)],
    entries: [
      entry(1, 'planned'),
      entry(2, 'plan-revised', 'round-1 applied to plan.md'),
      entry(3, 'plan-revised', 'round-2 applied to plan.md'),
      entry(4, 'plan-approved'),
    ],
    record: { state: 'plan-approved', reviews: [file(1, 'plan-review.r1.md'), file(2, 'plan-review.r2.md'), file(3, 'plan-review.md')], after: AFTER },
  });

  test('the rounds are read from the files, and their cost is unknown, not divided', () => {
    assert.deepEqual(
      old.rounds.map((round) => [round.round, round.countedFrom, round.review, round.revision]),
      [
        [1, 'file', UNKNOWN, UNKNOWN],
        [2, 'file', UNKNOWN, UNKNOWN],
        [3, 'file', UNKNOWN, NONE],
      ],
    );
    assert.deepEqual(old.unrecorded, [1, 2, 3]);
  });

  test('what plan-revised alone closes is one sum, and the totals still add up', () => {
    assert.equal(unitsOf(old.totals.unsplit), 30);
    assert.equal(unitsOf(old.totals.tail), 40);
    assert.equal(unitsOf(old.totals.afterFirstPlan), 70);
  });

  test('a round recorded after the entry existed is split, the ones before it are not', () => {
    const mixed = issueReport({
      issue: ISSUE,
      calls: [call(1.5, 10), call(2.5, 20), call(3.5, 40), call(4.5, 80)],
      entries: [
        entry(1, 'planned'),
        entry(2, 'plan-revised', 'round-1 applied to plan.md'),
        entry(3, 'plan-reviewed', 'round-2 mode=full A=1 B=0 C=0'),
        entry(4, 'plan-revised', 'round-2 applied to plan.md'),
        entry(5, 'plan-approved'),
      ],
      record: { state: 'plan-approved', reviews: [file(1, 'plan-review.r1.md'), file(2, 'plan-review.md')], after: AFTER },
    });
    assert.deepEqual(
      mixed.rounds.map((round) => [round.round, unitsOf(round.review), unitsOf(round.revision)]),
      [
        [1, UNKNOWN, UNKNOWN],
        [2, 20, 40],
      ],
    );
    assert.equal(unitsOf(mixed.totals.unsplit), 10);
    assert.equal(unitsOf(mixed.totals.tail), 80);
  });
});

describe('what cannot be known is said', () => {
  test('with no transcript read, every cost is unknown and the counts stay', () => {
    const blind = issueReport({
      issue: ISSUE,
      calls: null,
      entries: [entry(1, 'planned'), entry(2, 'plan-reviewed', 'round-1 mode=full A=3 B=0 C=0'), entry(3, 'plan-approved')],
      record: { state: 'plan-approved', reviews: [], after: AFTER },
    });
    assert.deepEqual([blind.totals.firstPlan, blind.totals.afterFirstPlan, blind.rounds[0].review], [UNKNOWN, UNKNOWN, UNKNOWN]);
    assert.deepEqual(blind.rounds[0].items, { A: 3, B: 0, C: 0 });
  });

  test('a plan not approved has no after-approval counts, and the window after the last entry stays open', () => {
    const open = issueReport({
      issue: ISSUE,
      calls: [call(1.5, 10), call(2.5, 20)],
      entries: [entry(1, 'planned'), entry(2, 'plan-reviewed', 'round-1 mode=full A=1 B=0 C=0')],
      record: { state: 'planned', reviews: [], after: AFTER },
    });
    assert.equal(open.after, null);
    assert.equal(unitsOf(open.rounds[0].revision), NONE);
    assert.equal(unitsOf(open.totals.tail), 20);
  });

  test('an issue reset after its plan, and not planned since, has no plan in its cycle', () => {
    const entries = [entry(1, 'planned'), entry(2, 'reset'), entry(3, 'triaged'), { ...entry(1, 'planned'), issue: 200 }];
    assert.deepEqual(plannedIssues(entries), [200]);
  });
});

describe('the report', () => {
  const scan = {
    calls: [call(1.5, 10), call(30, 5)],
    compactions: [],
    dirs: ['/transcripts'],
    missing: [],
    files: 1,
    subagentFiles: 0,
    duplicateLines: 0,
    unreadableLines: 0,
  };
  const entries = [entry(1, 'planned'), entry(2, 'plan-reviewed', 'round-1 mode=full A=1 B=0 C=0')];
  const report = build({ scan, entries, records: { [ISSUE]: { state: 'planned', reviews: [], after: AFTER } }, issue: ISSUE });

  test('calls are attributed as the cost report does, and the unattributed ones are counted', () => {
    assert.equal(unitsOf(report.issues[0].rounds[0].review), 10);
    assert.deepEqual([report.coverage?.attributed, report.coverage?.unattributed], [1, 1]);
  });

  test('prints each round with its numbers, the caveats, and no verdict', () => {
    const text = format(report);
    assert.match(text, /r1\s+full\s+1\s+0\s+0/);
    assert.match(text, /caveats/);
    assert.match(text, /not approved in this cycle/);
    assert.doesNotMatch(text, /\b(?:good|bad|should|recommend)/i);
  });

  test('every cost is unknown when no transcript directory exists', () => {
    const blind = build({ scan: { ...scan, missing: ['/transcripts'] }, entries, records: {}, issue: ISSUE });
    assert.equal(blind.issues[0].rounds[0].review, UNKNOWN);
    assert.match(format(blind), /every cost below is unknown/);
  });
});

describe('read from disk', () => {
  let root;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'pdkit-planning-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('the journal, the review files, audit.md and the transcripts, each through its owner', async () => {
    const home = join(root, 'home');
    const dir = issueDir(home, ISSUE);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'plan-review.r1.md'),
      '# PLAN REVIEW: DESKTOP-100 — round 1\n\n## A — must change\n### A1. x\n### A2. y\n## B — worth discussing\n## C — cannot judge\n- **C1.** z\n\n## Operator decisions (round 1)\n- A1: accepted\n- A2: rejected — no\n- C1: no decision\n',
    );
    await writeFile(join(dir, 'plan-review.md'), '# PLAN REVIEW: DESKTOP-100 — round 2\n\nMode: delta — only T3 changed\n\n## A — must change\n## B — worth discussing\n### B1. w\n## C — cannot judge\n');
    await writeFile(join(dir, 'audit.md'), '## Findings\n- [Q1] a.ts:1 — R1 — x\n- [Q4] b.ts:2 — T1 — nit: y\n');
    for (const [hours, event, detail] of [
      [1, 'planned', ''],
      [2, 'plan-revised', 'round-1 applied to plan.md'],
      [3, 'plan-reviewed', 'round-2 mode=delta A=0 B=1 C=0'],
      [4, 'plan-approved', ''],
    ]) {
      await append({ at: at(Number(hours)).replace(/\.\d{3}Z$/, 'Z'), issue: ISSUE, event: String(event), detail: String(detail) }, { home });
    }

    const transcripts = join(root, 'transcripts');
    await mkdir(transcripts, { recursive: true });
    const line = (hours, id, input) => JSON.stringify({ timestamp: at(hours), sessionId: 's1', message: { id, model: 'claude-sonnet-5', usage: { input_tokens: input } } });
    await writeFile(join(transcripts, 's1.jsonl'), `${[line(1.5, 'm1', 10), line(2.5, 'm2', 20), line(3.5, 'm3', 40)].join('\n')}\n`);

    const report = await collect({ transcripts: [transcripts], home, issue: ISSUE });
    const [issue] = report.issues;
    assert.deepEqual(
      issue.rounds.map((round) => [round.round, round.mode, round.items, round.decisions?.accepted ?? null, unitsOf(round.review)]),
      [
        [1, 'unknown', { A: 2, B: 0, C: 1 }, 1, UNKNOWN],
        [2, 'delta', { A: 0, B: 1, C: 0 }, null, 20],
      ],
    );
    assert.equal(unitsOf(issue.totals.unsplit), 10);
    assert.equal(issue.after?.audit.count, 2);
    assert.deepEqual([issue.after?.amendments, issue.after?.stops, issue.after?.failedTasks], [0, 0, []]);
  });
});
