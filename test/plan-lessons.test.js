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

// What the plan reviews of earlier attempts raised.
//
// What these protect: an attempt that starts from nothing after a reset, and
// whose review finds again, round by round, the facts the first attempt's
// review had already found. Those reviews were written in more shapes than
// the current one — Russian headings, bold items, numbered B lists, a heading
// "accepted" above a list of IDs — and an item read as having no decision, or
// no heading, is a lesson the next plan does not get.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { issueDir, paths } from '../lib/config.js';
import { archiveName, lessons } from '../lib/plan-lessons.js';
import { reportIn } from '../lib/plan-review.js';
import { apply } from '../lib/reset.js';

const ISSUE = 17002;

let home;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-lessons-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Write review files into one archive directory of ISSUE. */
async function archive(dir, files) {
  const root = join(paths(home).archive, String(ISSUE), dir);
  await mkdir(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
}

const CURRENT = [
  '# PLAN REVIEW: DESKTOP-1 — round 2',
  '',
  '## A. Must change',
  '',
  '### A1. The fixture is ignored by the loader',
  '- body',
  '',
  '## B. Worth discussing',
  '',
  '**B1. The runner has no `getElectronApp()`** (`fixtures.ts:31`).',
  '- body',
  '',
  '**B2. Two options in one file.** The factory keeps the first; `x.ts:3` says so.',
  '',
  '## C. Could not judge',
  '',
  '- C1 something',
  '',
  '## Operator decisions (round 2)',
  '- A1: accepted — add the field to the manifest',
  '- B1: rejected — the spec is skipped there already',
  '- B2: no decision',
  '- C1: accepted',
  '',
].join('\n');

// The shape the reviews were written in before the decision heading was fixed.
const EARLIER = [
  '# PLAN REVIEW: DESKTOP-1',
  '',
  '## A. Исправить до одобрения',
  '',
  '### A1. The lint gate fails on any fixture under this path',
  '',
  '## B. Стоит обсудить',
  '',
  '1. **The dialog can block delivery.** A long body on the same line.',
  '2. **An existing test becomes untrue.** More.',
  '',
  '---',
  '',
  '## Решения оператора (2026-01-01) и разбор по коду',
  '',
  '### Принято к исправлению в `/pd:plan`',
  '- **A1**: the fixture moves under the ignored directory.',
  '  - The path is ignored by `**/test-resources`.',
  '  - Add `description` to the manifest.',
  '- **B2**: the test stays as it is.',
  '',
  '### B1. An operator note, not an item',
  'Facts:',
  '- a list line with no ID',
  '',
  '## Решения оператора, раунд 2',
  '',
  'Не приняты: B1, B3. План по ним не меняется.',
  '',
].join('\n');

describe('reportIn', () => {
  test('items in all three shapes, from the report only, with a closing citation kept', () => {
    assert.deepEqual(
      reportIn(CURRENT).items.map((item) => [item.id, item.title]),
      [
        ['A1', 'The fixture is ignored by the loader'],
        ['B1', 'The runner has no `getElectronApp()` (`fixtures.ts:31`).'],
        ['B2', 'Two options in one file.'],
      ],
    );
    assert.deepEqual(
      reportIn(EARLIER).items.map((item) => [item.id, item.title]),
      [
        ['A1', 'The lint gate fails on any fixture under this path'],
        // Numbered inside `## B.`: B1 and B2 by position. The operator's own
        // `### B1.` note below the decisions is not the item's heading.
        ['B1', 'The dialog can block delivery.'],
        ['B2', 'An existing test becomes untrue.'],
      ],
    );
  });

  test('a verdict from the line, from the heading above it, and from a lead-in naming items', () => {
    assert.deepEqual(
      reportIn(EARLIER).decisions.map(({ id, verdict, by, more }) => [id, verdict, by, more.length]),
      [
        ['A1', 'accepted', 'heading', 2],
        ['B2', 'accepted', 'heading', 0],
        ['B1', 'rejected', 'heading', 0],
        ['B3', 'rejected', 'heading', 0],
      ],
    );
    assert.deepEqual(
      reportIn(CURRENT).decisions.map(({ id, verdict, by }) => [id, verdict, by]),
      [
        ['A1', 'accepted', 'line'],
        ['B1', 'rejected', 'line'],
        ['B2', 'undecided', 'line'],
        ['C1', 'accepted', 'line'],
      ],
    );
  });

  test('a decision line under a heading that is no verdict has none', () => {
    const text = '## Operator decisions (round 1)\n\n### Notes\n- A1: see below\n';
    assert.deepEqual(
      reportIn(text).decisions.map(({ id, verdict, by }) => [id, verdict, by]),
      [['A1', 'other', 'none']],
    );
  });

  // The person's yes to a knowledge candidate is written on the decision. Read
  // too widely, a decision's own words ("update the knowledge: …") would become
  // a fact nobody agreed to put in the base.
  test('a knowledge mark on the line or a line continuing it, and not in the decision\'s own words', () => {
    const text = [
      '## Operator decisions (round 1)',
      '- A1: accepted — knowledge: the loader drops a manifest without `description` (`a.ts:12`)',
      '- A2: accepted',
      '  - knowledge: a fact on the next line',
      '- A3: accepted — update the knowledge: not a mark',
      '- B1: rejected',
      '',
    ].join('\n');
    assert.deepEqual(
      reportIn(text).decisions.map(({ id, candidate }) => [id, candidate]),
      [
        ['A1', 'the loader drops a manifest without `description` (`a.ts:12`)'],
        ['A2', 'a fact on the next line'],
        ['A3', null],
        ['B1', null],
      ],
    );
  });

  test('the round is the title\'s', () => {
    assert.equal(reportIn(CURRENT).round, 2);
    assert.equal(reportIn(EARLIER).round, null);
  });
});

describe('archiveName', () => {
  test('a reset, a reset on a collision, a rollback, and a name with no time', () => {
    assert.deepEqual(archiveName('2026-01-02-030405'), { kind: 'reset', archivedAt: '2026-01-02T03:04:05Z' });
    assert.deepEqual(archiveName('2026-01-02-030405-2'), { kind: 'reset', archivedAt: '2026-01-02T03:04:05Z' });
    assert.deepEqual(archiveName('rollback-C1-2026-01-02T03-04-05-678Z'), { kind: 'rollback', archivedAt: '2026-01-02T03:04:05Z' });
    assert.deepEqual(archiveName('copied-by-hand'), { kind: 'other', archivedAt: null });
  });
});

describe('lessons', () => {
  test('no archive is said, not an error', async () => {
    const found = await lessons(ISSUE, { home });
    assert.equal(found.found, false);
    assert.deepEqual(found.attempts, []);
  });

  test('every attempt oldest first, each round by its file name, A and B only, with the decisions', async () => {
    await archive('2026-01-03-100000', { 'plan-review.md': CURRENT.replace('round 2', 'round 1').replace('(round 2)', '(round 1)') });
    await archive('2026-01-02-100000', { 'plan-review.r1.md': EARLIER, 'plan-review.md': CURRENT });

    const found = await lessons(ISSUE, { home });
    assert.deepEqual(
      found.attempts.map((attempt) => [attempt.dir, attempt.kind, attempt.reviews.map((review) => `${review.round}:${review.file}`)]),
      [
        ['2026-01-02-100000', 'reset', ['1:plan-review.r1.md', '2:plan-review.md']],
        ['2026-01-03-100000', 'reset', ['1:plan-review.md']],
      ],
    );

    const [first] = found.attempts[0].reviews;
    // C items are left out; B3 has no heading, only the lead-in that rejected it.
    assert.deepEqual(
      first.items.map((item) => [item.id, item.title, item.decisions.map((decision) => decision.verdict)]),
      [
        ['A1', 'The lint gate fails on any fixture under this path', ['accepted']],
        ['B1', 'The dialog can block delivery.', ['rejected']],
        ['B2', 'An existing test becomes untrue.', ['accepted']],
        ['B3', null, ['rejected']],
      ],
    );
    assert.deepEqual(first.items[0].decisions[0].more, ['- The path is ignored by `**/test-resources`.', '- Add `description` to the manifest.']);
  });

  test('a review with no decisions keeps its items, each with none', async () => {
    await archive('2026-01-02-100000', { 'plan-review.md': CURRENT.slice(0, CURRENT.indexOf('## Operator decisions')) });
    const [review] = (await lessons(ISSUE, { home })).attempts[0].reviews;
    assert.deepEqual(review.items.map((item) => [item.id, item.decisions.length]), [['A1', 0], ['B1', 0], ['B2', 0]]);
  });

  // A rollback archives the files it replaces and restores the checkpoint's,
  // so the same review is in both archives. Listed twice, the next plan reads
  // each lesson twice.
  test('a review whose text is in a reset archive is named there from the rollback archive', async () => {
    await archive('rollback-C1-2026-01-02T09-00-00-000Z', { 'plan-review.md': EARLIER, 'plan-review.r1.md': 'other text\n' });
    await archive('2026-01-02-100000', { 'plan-review.r1.md': EARLIER });

    const found = await lessons(ISSUE, { home });
    assert.deepEqual(found.attempts.map((attempt) => attempt.dir), ['rollback-C1-2026-01-02T09-00-00-000Z', '2026-01-02-100000']);
    const [rollback, reset] = found.attempts;
    const same = rollback.reviews.find((review) => review.file === 'plan-review.md');
    assert.equal(same.sameAs, '2026-01-02-100000/plan-review.r1.md');
    assert.deepEqual(same.items, []);
    assert.equal(reset.reviews[0].sameAs, null);
    assert.equal(reset.reviews[0].items.length, 4);
    assert.equal(rollback.reviews.find((review) => review.file === 'plan-review.r1.md').sameAs, null);
  });

  // The directory name is the only record of when an attempt ended. Written by
  // lib/reset.js and read here: a change to its stamp would leave every
  // attempt without a time and in the wrong order.
  test('an archive a real reset made is read with its kind and time', async () => {
    await mkdir(issueDir(home, ISSUE), { recursive: true });
    await writeFile(join(issueDir(home, ISSUE), 'plan-review.md'), CURRENT);
    const outcome = await apply({ issue: ISSUE, home });
    assert.ok(outcome.archived);

    const [attempt] = (await lessons(ISSUE, { home })).attempts;
    assert.equal(attempt.kind, 'reset');
    assert.match(attempt.archivedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(attempt.reviews[0].items.map((item) => item.id), ['A1', 'B1', 'B2']);
  });
});
