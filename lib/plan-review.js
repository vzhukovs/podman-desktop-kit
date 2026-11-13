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
//
// And a review read whole, after the fact (reportIn): every item it raised and
// every decision recorded on it, for a later attempt at the same issue. Those
// reviews are older, and were written in more shapes than the current round's
// heading and lines, so that reader accepts more of them.

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
  ['accepted', /^(?:accepted|принят[оаы]?)(?![\p{L}\d_])/iu],
  ['rejected', /^(?:rejected|not accepted|отклон[её]н[оаы]?|не[ \t]+принят[оаы]?)(?![\p{L}\d_])/iu],
  ['undecided', /^(?:no decision|без решения)(?![\p{L}\d_])/iu],
]);

/** An item's heading in the report: `### B3. What the finding is`. */
const ITEM_HEADING = /^###[ \t]+(?:\*\*)?([A-C]\d+)[.:)]?(?:\*\*)?[ \t]+(.+?)[ \t]*$/gmu;

/** The same heading, matched against one line. */
const ITEM_HEADING_LINE = new RegExp(ITEM_HEADING.source, 'u');

/**
 * An item opening a line in bold, the way most reports write B items:
 * `**B6. What the finding is.**`, then whatever follows on the line.
 */
const BOLD_ITEM = /^\*\*([A-C]\d+)[.:)][ \t]+(.+?)\*\*[ \t]*(.*)$/u;

/** A report section by its letter: `## A. Must change`, `## B. Worth discussing`. */
const LETTER_SECTION = /^##[ \t]+([A-C])[.:)]?(?:[ \t]|$)/u;

/** An item numbered inside its letter section, as earlier reports wrote B: `1. **What it is.** …`. */
const NUMBERED_ITEM = /^(\d+)\.[ \t]+\*\*(.+?)\*\*/u;

/** A citation that closes an item's bold heading on its line: `(`file.ts:31`, …)`. */
const CITATION = /^\(.*\)\.?$/u;

/** A list line: `- …`, `* …`, `1. …`. */
const LIST_LINE = /^[ \t]*(?:[-*+]|\d+\.)[ \t]/u;

/** A review on disk: the latest round, or an earlier one moved aside. */
export const REVIEW_FILE = /^plan-review(?:\.r(\d+))?\.md$/;

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
 * The decision lines of a section: each one's item, the verdict it opens with,
 * and what it says after the ID.
 *
 * @param {string} body
 * @returns {Array<{id: string, verdict: Verdict, text: string}>}
 */
function linesIn(body) {
  return body.split('\n').flatMap((line) => {
    const found = DECISION_LINE.exec(line);
    if (!found) return [];
    const [, id, said] = found;
    return [{ id, verdict: VERDICTS.find(([, words]) => words.test(said))?.[0] ?? 'other', text: said }];
  });
}

/** @typedef {'accepted'|'rejected'|'undecided'|'other'} Verdict */

/**
 * @typedef {object} ItemDecision
 * @property {string} id            A1, B3, C2
 * @property {'A'|'B'|'C'} letter   the report section the item is in
 * @property {Verdict} decision     the verdict of its first line that opens with one; `other` when none does
 */

/**
 * What a plan-review.md says about decisions, read from its text.
 *
 * The last decision section is the one that counts. A round is the number in
 * its heading, else the one in the document title, else 1. `items` is every ID
 * the section names; `decisions` is one entry per item with a decision line,
 * and `accepted` counts the A and B items accepted.
 *
 * An item's decision is the first verdict among its lines: a second line for
 * the same item is a decision amended during the revision, and it adds to the
 * first rather than reversing it. An item none of whose lines opens with a
 * verdict is `other` — read, kept, and not guessed at; what that means for the
 * next step is the state machine's to say.
 *
 * @param {string} text
 * @returns {{decided: boolean, round: number|null, items: string[], decisions: ItemDecision[], accepted: {A: number, B: number}}}
 */
export function decisionsIn(text) {
  const { last } = sections(text);
  if (last === null) return { decided: false, round: null, items: [], decisions: [], accepted: { A: 0, B: 0 } };

  const items = [...new Set(last.body.match(/\b[A-C]\d+\b/g) ?? [])];
  const lines = linesIn(last.body);
  /** @type {ItemDecision[]} */
  const decisions = [...new Set(lines.map((line) => line.id))].map((id) => ({
    id,
    letter: /** @type {'A'|'B'|'C'} */ (id[0]),
    decision: lines.find((line) => line.id === id && line.verdict !== 'other')?.verdict ?? 'other',
  }));
  const accepted = (letter) => decisions.filter((item) => item.letter === letter && item.decision === 'accepted').length;
  return { decided: true, round: last.round ?? 1, items, decisions, accepted: { A: accepted('A'), B: accepted('B') } };
}

/**
 * @typedef {object} Decision
 * @property {string} id                 A1, B3, C2
 * @property {Verdict} verdict          by the words the line opens with
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
  const decisions = linesIn(last.body).map((line) => ({ ...line, title: titles.get(line.id) ?? null }));
  return { round: last.round, decisions };
}

/**
 * @typedef {object} ReportItem
 * @property {string} id                 A1, B3, C2
 * @property {'A'|'B'|'C'} letter
 * @property {string} title              the item's heading as the report wrote it
 */

/**
 * @typedef {object} RecordedDecision
 * @property {string} id                 A1, B3, C2
 * @property {'A'|'B'|'C'} letter
 * @property {Verdict} verdict
 * @property {'line'|'heading'|'none'} by  what the verdict was read from: the
 *   line's own first words, the heading or lead-in line it sits under
 *   ("Accepted:", "Не приняты: B3, B4."), or nothing
 * @property {string} text               the line after the ID, as written
 * @property {string[]} more             the indented lines that continue it
 */

/**
 * A whole review, as written: the round its title names, every item the
 * report raises, and every decision line in every decision section.
 *
 * For reading a review after the fact — what an earlier attempt raised and
 * what was decided — rather than for the state of the current round, which is
 * decisionsIn's. So it reads more of what reviews have looked like:
 *
 * - an item is a `### A1. …` heading, a line opening with `**B6. …**` (a
 *   citation in parentheses closing that line is kept with it), or, inside a
 *   `## B.` section, a numbered `1. **…**` line, which is item B1;
 * - items are read from the report, above the first decision section; an
 *   operator's own `### B1. …` notes inside a decision section are not items;
 * - a decision line with no verdict of its own takes the one its heading or
 *   lead-in line opens with — `Accepted for the revision:` above a list of
 *   `- **A1**: …` lines — and a lead-in that names items after its colon
 *   (`Rejected: B3, B4.`) decides each of them. `by` says which it was.
 *
 * @param {string} text
 * @returns {{round: number|null, items: ReportItem[], decisions: RecordedDecision[]}}
 */
export function reportIn(text) {
  const source = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const title = /^#[ \t]+.*$/m.exec(source)?.[0] ?? '';
  const cut = source.search(DECISIONS);
  const report = cut === -1 ? source : source.slice(0, cut);

  /** @type {Map<string, string>} */
  const titles = new Map();
  const add = (id, heading) => {
    if (!titles.has(id)) titles.set(id, heading.trim());
  };
  let letter = null;
  for (const line of report.split('\n')) {
    if (/^##[ \t]/.test(line)) {
      letter = LETTER_SECTION.exec(line)?.[1] ?? null;
      continue;
    }
    const heading = ITEM_HEADING_LINE.exec(line);
    if (heading) {
      add(heading[1], heading[2]);
      continue;
    }
    const bold = BOLD_ITEM.exec(line);
    if (bold) {
      add(bold[1], CITATION.test(bold[3].trim()) ? `${bold[2]} ${bold[3].trim()}` : bold[2]);
      continue;
    }
    const numbered = letter ? NUMBERED_ITEM.exec(line) : null;
    if (numbered) add(`${letter}${numbered[1]}`, numbered[2]);
  }

  return {
    round: roundIn(title),
    items: [...titles].map(([id, heading]) => ({ id, letter: /** @type {'A'|'B'|'C'} */ (id[0]), title: heading })),
    decisions: [...source.matchAll(DECISIONS)].flatMap((found) => {
      const rest = source.slice(found.index + found[0].length);
      const end = rest.search(/^#{1,2}[ \t]/m);
      return recordedIn(end === -1 ? rest : rest.slice(0, end));
    }),
  };
}

/** The verdict a heading or lead-in line opens with, once its markup is off. */
function leadVerdict(line) {
  const words = line.replace(/^[ \t#*_]+/u, '');
  return VERDICTS.find(([, pattern]) => pattern.test(words))?.[0] ?? null;
}

/**
 * The decision lines of one decision section, each with the verdict it is
 * under. See reportIn.
 *
 * @param {string} body
 * @returns {RecordedDecision[]}
 */
function recordedIn(body) {
  /** @type {RecordedDecision[]} */
  const out = [];
  /** @type {Verdict|null} */
  let lead = null;
  /** @type {RecordedDecision|null} */
  let current = null;

  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    const indented = /^[ \t]/.test(line);
    if (indented && current) {
      current.more.push(line.trim());
      continue;
    }

    const found = DECISION_LINE.exec(line);
    if (found) {
      const [, id, said] = found;
      const own = VERDICTS.find(([, words]) => words.test(said))?.[0] ?? null;
      current = {
        id,
        letter: /** @type {'A'|'B'|'C'} */ (id[0]),
        verdict: own ?? lead ?? 'other',
        by: own ? 'line' : lead ? 'heading' : 'none',
        text: said,
        more: [],
      };
      out.push(current);
      continue;
    }

    current = null;
    // A list line without an ID sits under the lead-in like the decisions do,
    // so it does not change what they are under.
    if (LIST_LINE.test(line)) continue;

    lead = leadVerdict(line);
    if (lead === null) continue;
    // `Не приняты: B3, B4, B5.` — the items named right after the colon.
    const after = line.slice(line.indexOf(':') + 1);
    const named = line.includes(':') ? /^[ \t]*((?:\*{0,2}[A-C]\d+\*{0,2}(?:[ \t]*(?:,|и|and)[ \t]*|[ \t]*))+)/u.exec(after) : null;
    for (const id of named?.[1].match(/[A-C]\d+/g) ?? []) {
      out.push({ id, letter: /** @type {'A'|'B'|'C'} */ (id[0]), verdict: lead, by: 'heading', text: line.trim(), more: [] });
    }
  }

  return out;
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
 * their round. `round` is null when the latest review has no decisions; the
 * decisions themselves come with it, applied or not, for the step after the
 * revision.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{pending: boolean, round: number|null, items: string[], decisions: ItemDecision[], accepted: {A: number, B: number}, path: string}>}
 */
export async function pending(issue, options = {}) {
  const home = options.home ?? resolveHome();
  const path = join(issueDir(home, issue), 'plan-review.md');
  const text = await readFile(path, 'utf8').catch(() => null);
  const found = decisionsIn(text ?? '');
  const { decided: _decided, ...facts } = found;
  if (!found.decided) return { pending: false, ...facts, path };

  const revised = await journal.read({ issue, event: REVISED }, { home }).catch(() => []);
  const applied = revised.some((entry) => entry.detail.split(' ')[0] === `round-${found.round}`);
  return { pending: !applied, ...facts, path };
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
