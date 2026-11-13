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

// The operator's decisions on a plan review: what each round decided, and
// whether the latest round is waiting to reach the plan.
//
// `/pd:plan-review` ends with "the plan goes back to /pd:plan", and `/pd:plan`
// had no way to know there was a review to go back with. Three times in one
// issue the person asked how to start the revision, and each time the answer
// was a paragraph of context to paste after the command, written by the
// session that happened to be open — with line numbers into a plan that the
// next edit would move.
//
// The decisions already have a home: the review writes them into
// plan-review.md under `## Operator decisions (round N)`. This module reads
// whether that section exists and which round it is, and the journal says
// whether `/pd:plan` has applied it (`pdkit plan revised`). Nothing is stored
// twice, and nothing here interprets what a decision asks for — applying it is
// judgment, and it is `/pd:plan`'s.
//
// The rounds before the latest are read too, for the critic's brief: a critic
// that is not told what earlier rounds rejected raises it again, and a person
// spends the round rejecting it twice. What is read is the verdict each line
// opens with — `accepted`, `rejected`, `no decision` — which is what the line
// says, not a reading of it.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { issueDir, resolveHome } from './config.js';
import * as journal from './journal.js';

/** The journal event `pdkit plan revised` writes. */
export const REVISED = 'plan-revised';

/**
 * The decision heading. The Russian form is the one the reviews of this
 * plugin's own users were written with before the heading was fixed, and a
 * revision waiting under it is a revision waiting all the same.
 */
const DECISIONS = /^##[ \t]+(?:operator decisions|решения оператора)(?![\p{L}\d_])(.*)$/gimu;

/**
 * `round 3` or `раунд 3`, in a heading. The boundaries are spelled out with
 * `\p{L}` because `\b` is an ASCII word boundary, and there is none around a
 * Cyrillic word.
 */
const ROUND = /(?<![\p{L}\d_])(?:round|раунд)[ \t]+(\d+)/iu;

/**
 * One decision line: `- A1: accepted — why`, the shape step 4 of
 * /pd:plan-review prescribes, or `- **A1.** принято`, the one the earlier
 * reviews were written with.
 */
const DECISION_LINE = /^[ \t]*[-*][ \t]+(?:\*\*)?([A-C]\d+)[.:]?(?:\*\*)?[.:]?[ \t]*(.*?)[ \t]*$/u;

/**
 * The verdict a decision line opens with, by its first words. Anything else is
 * `other`: read, kept, and not guessed at.
 */
const VERDICTS = /** @type {const} */ ([
  ['accepted', /^(?:accepted|принят[оа]?)(?![\p{L}\d_])/iu],
  ['rejected', /^(?:rejected|отклон[её]н[оа]?)(?![\p{L}\d_])/iu],
  ['undecided', /^(?:no decision|без решения)(?![\p{L}\d_])/iu],
]);

/** An item's heading in the report: `### B3. What the finding is`. */
const ITEM_HEADING = /^###[ \t]+(?:\*\*)?([A-C]\d+)[.:)]?(?:\*\*)?[ \t]+(.+?)[ \t]*$/gmu;

/** A review on disk: the latest round, or an earlier one moved aside. */
const REVIEW_FILE = /^plan-review(?:\.r(\d+))?\.md$/;

/** The round a heading or title names, or null. */
function roundIn(line) {
  const found = ROUND.exec(line ?? '');
  return found ? Number.parseInt(found[1], 10) : null;
}

/**
 * A review's text with comments cut, and its last decision section: the round
 * its heading names, else the document title's, and its body.
 *
 * @param {string} text
 * @returns {{source: string, title: string, last: {round: number|null, body: string}|null}}
 */
function sections(text) {
  const source = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const title = /^#[ \t]+.*$/m.exec(source)?.[0] ?? '';
  const headings = [...source.matchAll(DECISIONS)];
  if (headings.length === 0) return { source, title, last: null };

  const last = headings[headings.length - 1];
  const rest = source.slice(last.index + last[0].length);
  const end = rest.search(/^#{1,2}[ \t]/m);
  return { source, title, last: { round: roundIn(last[1]) ?? roundIn(title), body: end === -1 ? rest : rest.slice(0, end) } };
}

/**
 * What a plan-review.md says about decisions, read from its text.
 *
 * The last decision section is the one that counts. A round is the number in
 * its heading, else the one in the document title, else 1.
 *
 * @param {string} text
 * @returns {{decided: boolean, round: number|null, items: string[]}}
 */
export function decisionsIn(text) {
  const { last } = sections(text);
  if (last === null) return { decided: false, round: null, items: [] };

  const items = [...new Set(last.body.match(/\b[A-C]\d+\b/g) ?? [])];
  return { decided: true, round: last.round ?? 1, items };
}

/**
 * @typedef {object} Decision
 * @property {string} id                 A1, B3, C2
 * @property {'accepted'|'rejected'|'undecided'|'other'} verdict  by the words the line opens with
 * @property {string} text               the line after the ID, as the person's decision was written
 * @property {string|null} title         the item's heading in the same report, null when it has none
 */

/**
 * One review, line by line: the round, and every line of its last decision
 * section with the verdict it opens with and the heading of the item it
 * decides.
 *
 * A second line for the same item is kept as a second entry — a decision
 * amended during the revision is written that way, and both halves are what
 * the person decided. The round is the decision heading's, else the title's,
 * else null: unlike decisionsIn, the caller has the file name to fall back on.
 *
 * @param {string} text
 * @returns {{round: number|null, decisions: Decision[]}}
 */
export function reviewIn(text) {
  const { source, title, last } = sections(text);
  if (last === null) return { round: roundIn(title), decisions: [] };

  /** @type {Map<string, string>} */
  const titles = new Map();
  for (const [, id, heading] of source.matchAll(ITEM_HEADING)) if (!titles.has(id)) titles.set(id, heading);

  /** @type {Decision[]} */
  const decisions = [];
  for (const line of last.body.split('\n')) {
    const found = DECISION_LINE.exec(line);
    if (!found) continue;
    const [, id, said] = found;
    const verdict = VERDICTS.find(([, words]) => words.test(said))?.[0] ?? 'other';
    decisions.push({ id, verdict, text: said, title: titles.get(id) ?? null });
  }
  return { round: last.round, decisions };
}

/**
 * Every round of a plan's review on disk, oldest first: each
 * `plan-review.r<k>.md` and the latest, `plan-review.md`.
 *
 * A file's round is what its text says, else the `r<k>` in its name; the latest
 * file, when its text names none, is the one after the highest found.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<Array<{file: string, round: number, decisions: Decision[]}>>}
 */
export async function rounds(issue, options = {}) {
  const dir = issueDir(options.home ?? resolveHome(), issue);
  const files = (await readdir(dir).catch(() => [])).filter((name) => REVIEW_FILE.test(name));

  const read = await Promise.all(
    files.map(async (file) => {
      const review = reviewIn(await readFile(join(dir, file), 'utf8'));
      const named = REVIEW_FILE.exec(file)?.[1];
      return { file, round: review.round ?? (named ? Number.parseInt(named, 10) : null), decisions: review.decisions };
    }),
  );

  const highest = Math.max(0, ...read.map((entry) => entry.round ?? 0));
  return read
    .map((entry) => ({ ...entry, round: entry.round ?? highest + 1 }))
    .sort((a, b) => a.round - b.round || a.file.localeCompare(b.file));
}

/**
 * Whether a revision is waiting: decisions recorded, and no `plan-revised` for
 * their round.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{pending: boolean, round: number|null, items: string[], path: string}>}
 */
export async function pending(issue, options = {}) {
  const home = options.home ?? resolveHome();
  const path = join(issueDir(home, issue), 'plan-review.md');
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return { pending: false, round: null, items: [], path };

  const found = decisionsIn(text);
  if (!found.decided) return { pending: false, round: null, items: [], path };

  const revised = await journal.read({ issue, event: REVISED }, { home }).catch(() => []);
  const applied = revised.some((entry) => entry.detail.split(' ')[0] === `round-${found.round}`);
  return { pending: !applied, round: found.round, items: found.items, path };
}

/**
 * Record that the plan now carries a round's decisions.
 *
 * @param {number} issue
 * @param {number} round
 * @param {{home?: string}} [options]
 * @returns {Promise<void>}
 */
export async function markRevised(issue, round, options = {}) {
  await journal.append({ issue, event: REVISED, detail: `round-${round} applied to plan.md` }, { home: options.home ?? resolveHome() });
}

/**
 * The context `state.nextStep` takes, for a record: a waiting revision when the
 * issue is `planned` and the review's decisions have not reached the plan.
 *
 * @param {{issue: number, state: string}} record
 * @param {{home?: string}} [options]
 * @returns {Promise<import('./state/machine.js').NextContext>}
 */
export async function nextContext(record, options = {}) {
  if (record.state !== 'planned') return {};
  const found = await pending(record.issue, options);
  return found.pending ? { revision: { round: /** @type {number} */ (found.round) } } : {};
}
