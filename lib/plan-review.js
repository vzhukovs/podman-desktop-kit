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
// heading and lines, so that reader accepts more of them. It also reads the
// one mark a person adds to a decision line after the fact: `knowledge: <fact>`,
// their yes to a candidate for knowledge/, which lib/knowledge.js collects.
//
// And the record that a round was reviewed (`pdkit plan reviewed`): its round,
// its mode and how many items it raised under each letter, as one journal
// entry written once the report is. Without it nothing said where a review
// ended and its revision began, so what each cost, and how many rounds a plan
// took, had to be rebuilt by hand from transcripts. lib/planning.js reads it.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { issueDir, resolveHome } from './config.js';
import * as journal from './journal.js';

/** The journal event `pdkit plan revised` writes. */
export const REVISED = 'plan-revised';

/** The journal event `pdkit plan reviewed` writes. */
export const REVIEWED = 'plan-reviewed';

/** What a round's mode is when its report does not say. */
export const UNKNOWN_MODE = 'unknown';

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

/**
 * An item as a list line with its ID in bold, the way reports have written C:
 * `- **C1.** What it is…` or `- **C2. What it is.** Why…`. The heading is the
 * bold part after the ID, else the rest of the line.
 */
const LIST_ITEM = /^[-*][ \t]+\*\*([A-C]\d+)[.:)]?(?:[ \t]+(.+?))?\*\*[ \t]*(.*)$/u;

/**
 * The line under a report's title that says how the round was run:
 * `Mode: full` or `Mode: delta`, then why. The critic's brief asks for exactly
 * those words; the label is read as `Режим:` too, since the report is written
 * in the language the person reads.
 */
const MODE_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(?:mode|режим)(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*[`*]*(full|delta)(?![\p{L}\d_])/imu;

/** A citation that closes an item's bold heading on its line: `(`file.ts:31`, …)`. */
const CITATION = /^\(.*\)\.?$/u;

/** A list line: `- …`, `* …`, `1. …`. */
const LIST_LINE = /^[ \t]*(?:[-*+]|\d+\.)[ \t]/u;

/**
 * The person's yes to a knowledge candidate, written on the item's decision
 * line or a line continuing it: `- A2: accepted — knowledge: <the fact>`.
 * After a dash or a semicolon, or opening the line, so that "update the
 * knowledge: …" in a decision's own words is not one.
 */
const KNOWLEDGE_MARK = /(?:^[-*+]?[ \t]*|[ \t]+[—–-][ \t]+|;[ \t]*)knowledge:[ \t]*(\S.*?)[ \t]*$/iu;

/** The fact a line marks as a knowledge candidate, or null. */
function candidateIn(line) {
  return KNOWLEDGE_MARK.exec(line)?.[1] ?? null;
}

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
 * @property {string|null} candidate     the fact marked `knowledge:` on it, null when none is
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
 *   citation in parentheses closing that line is kept with it), a list line
 *   `- **C1.** …` inside the `## C` section, or, inside a `## B.` section with
 *   no item heading above it, a numbered `1. **…**` line, which is item B1;
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
  // Whether the letter section has had an item heading: below one, a numbered
  // line is a step of that item. An A1 that proposed three slices as
  // `1. **S1.** …` was read as items A1–A3, and the A2 and A3 headings after it
  // lost their titles to "S2." and "S3.".
  let headed = false;
  for (const line of report.split('\n')) {
    if (/^##[ \t]/.test(line)) {
      letter = LETTER_SECTION.exec(line)?.[1] ?? null;
      headed = false;
      continue;
    }
    const heading = ITEM_HEADING_LINE.exec(line);
    if (heading) {
      add(heading[1], heading[2]);
      headed = true;
      continue;
    }
    const bold = BOLD_ITEM.exec(line);
    if (bold) {
      add(bold[1], CITATION.test(bold[3].trim()) ? `${bold[2]} ${bold[3].trim()}` : bold[2]);
      continue;
    }
    // Only under its own letter: elsewhere above the decisions, a report
    // lists the last round's decisions in the same shape.
    const listed = letter ? LIST_ITEM.exec(line) : null;
    if (listed && listed[1][0] === letter) {
      add(listed[1], listed[2] ?? listed[3]);
      continue;
    }
    const numbered = letter && !headed ? NUMBERED_ITEM.exec(line) : null;
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
      current.candidate ??= candidateIn(line.trim());
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
        candidate: candidateIn(said),
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
      out.push({ id, letter: /** @type {'A'|'B'|'C'} */ (id[0]), verdict: lead, by: 'heading', text: line.trim(), more: [], candidate: null });
    }
  }

  return out;
}

/**
 * A review counted: its round, its mode, its items by letter, and its
 * decisions by verdict.
 *
 * @typedef {object} ReviewSummary
 * @property {number|null} round            the round its title names
 * @property {'full'|'delta'|'unknown'} mode
 * @property {{A: number|null, B: number|null, C: number|null}} items
 *   null for a letter whose `## A`, `## B` or `## C` section the review does not have
 * @property {{accepted: number, rejected: number, undecided: number, unread: number, missing: number}|null} decisions
 *   one per item; null when the review has no decision section yet
 */

/**
 * What a review says about itself, as numbers.
 *
 * The round is the title's, which the report is required to carry; the mode
 * is the `Mode:` line above the first section, and `unknown` when there is
 * none — reviews written before the line was asked for have none. The items
 * are reportIn's, so this count and `plan lessons` read a report the same
 * way, and a letter is counted only when the review has its section: earlier
 * reviews put items under `## Must change before approval` as `### M1 —`, and
 * a zero there would be a review nobody could read reported as one that found
 * nothing. An item's decision is the first verdict among its lines, as in
 * decisionsIn: `unread` when none of its lines opens with one, `missing` when
 * the decision section has no line for it. A line for an ID the report does
 * not raise counts all the same: it is what the person decided.
 *
 * @param {string} text
 * @returns {ReviewSummary}
 */
export function summaryIn(text) {
  const source = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const report = reportIn(source);
  const top = source.split(/^##[ \t]/m)[0];
  const mode = /** @type {'full'|'delta'|undefined} */ (MODE_LINE.exec(top)?.[1]?.toLowerCase()) ?? UNKNOWN_MODE;

  const cut = source.search(DECISIONS);
  const above = cut === -1 ? source : source.slice(0, cut);
  const sections = new Set(above.split('\n').map((line) => LETTER_SECTION.exec(line)?.[1]).filter(Boolean));
  /** @type {{A: number|null, B: number|null, C: number|null}} */
  const items = { A: null, B: null, C: null };
  for (const letter of /** @type {const} */ (['A', 'B', 'C'])) {
    if (sections.has(letter)) items[letter] = report.items.filter((item) => item.letter === letter).length;
  }

  if (cut === -1) return { round: report.round, mode, items, decisions: null };

  const decisions = { accepted: 0, rejected: 0, undecided: 0, unread: 0, missing: 0 };
  const ids = new Set([...report.items.map((item) => item.id), ...report.decisions.map((decision) => decision.id)]);
  for (const id of ids) {
    const lines = report.decisions.filter((decision) => decision.id === id);
    const verdict = lines.find((decision) => decision.verdict !== 'other')?.verdict;
    decisions[verdict ?? (lines.length > 0 ? 'unread' : 'missing')] += 1;
  }
  return { round: report.round, mode, items, decisions };
}

/**
 * The review files of an issue, each read by `read`, oldest round first.
 *
 * A file's round is what `read` finds in its text, else the `r<k>` in its
 * name; the latest file, when neither names one, is the one after the highest
 * found.
 *
 * @template {{round: number|null}} T
 * @param {number} issue
 * @param {{home?: string}} options
 * @param {(text: string) => T} read
 * @returns {Promise<Array<{file: string} & Omit<T, 'round'> & {round: number}>>}
 */
async function onDisk(issue, options, read) {
  const dir = issueDir(options.home ?? resolveHome(), issue);
  const files = (await readdir(dir).catch(() => [])).filter((name) => REVIEW_FILE.test(name));

  const found = await Promise.all(
    files.map(async (file) => {
      const parsed = read(await readFile(join(dir, file), 'utf8'));
      const named = REVIEW_FILE.exec(file)?.[1];
      return { file, ...parsed, round: parsed.round ?? (named ? Number.parseInt(named, 10) : null) };
    }),
  );

  const highest = Math.max(0, ...found.map((entry) => entry.round ?? 0));
  return found
    .map((entry) => ({ ...entry, round: entry.round ?? highest + 1 }))
    .sort((a, b) => a.round - b.round || a.file.localeCompare(b.file));
}

/**
 * Every round of a plan's review on disk, oldest first: each
 * `plan-review.r<k>.md` and the latest, `plan-review.md`, with the decision
 * lines of its last decision section. Its round is the one that section
 * names, else the title's.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<Array<{file: string, round: number, decisions: Decision[]}>>}
 */
export async function rounds(issue, options = {}) {
  return onDisk(issue, options, (text) => {
    const review = reviewIn(text);
    return { round: review.round, decisions: review.decisions };
  });
}

/**
 * Every round of a plan's review on disk, oldest first, counted (summaryIn).
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<Array<{file: string, round: number} & Omit<ReviewSummary, 'round'>>>}
 */
export async function summaries(issue, options = {}) {
  return onDisk(issue, options, summaryIn);
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

/** The detail of a `plan-reviewed` entry: `round-3 mode=delta A=0 B=2 C=1`. */
const REVIEWED_DETAIL = /^round-(\d+) mode=(full|delta|unknown) A=(\d+) B=(\d+) C=(\d+)$/;

/**
 * The round a `plan-reviewed` or `plan-revised` entry is about, from the
 * `round-<k>` its detail opens with.
 *
 * @param {string} detail
 * @returns {number|null}
 */
export function roundOf(detail) {
  const found = /^round-(\d+)\b/.exec(String(detail ?? ''));
  return found ? Number.parseInt(found[1], 10) : null;
}

/**
 * The detail a `plan-reviewed` entry carries.
 *
 * @param {{round: number, mode: string, items: {A: number, B: number, C: number}}} summary
 * @returns {string}
 */
export function reviewedDetail(summary) {
  return `round-${summary.round} mode=${summary.mode} A=${summary.items.A} B=${summary.items.B} C=${summary.items.C}`;
}

/**
 * A `plan-reviewed` detail read back, or null when it is not one.
 *
 * @param {string} detail
 * @returns {{round: number, mode: 'full'|'delta'|'unknown', items: {A: number, B: number, C: number}}|null}
 */
export function reviewedFrom(detail) {
  const found = REVIEWED_DETAIL.exec(String(detail ?? '').trim());
  if (!found) return null;
  const [, round, mode, A, B, C] = found;
  const count = (value) => Number.parseInt(value, 10);
  return { round: count(round), mode: /** @type {'full'|'delta'|'unknown'} */ (mode), items: { A: count(A), B: count(B), C: count(C) } };
}

/**
 * Record that a round's report is written: the round its title names, its
 * mode, and how many items it raises under each letter.
 *
 * The entry marks where the review ended and its revision began, so it is
 * refused once the round has a `plan-revised`: written then, it would put the
 * end of the review after the revision. Run again over the same report it
 * writes nothing; over one changed since — the critics' reports merged again
 * — it writes the new counts, and a reader takes the round's last entry. Only
 * the current cycle is read: a round 1 recorded before a reset was another
 * plan's.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{ok: true, outcome: 'recorded'|'recorded again'|'unchanged', round: number, mode: string, items: {A: number, B: number, C: number}, detail: string, path: string} | {ok: false, error: string}>}
 */
export async function markReviewed(issue, options = {}) {
  const home = options.home ?? resolveHome();
  const path = join(issueDir(home, issue), 'plan-review.md');
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return { ok: false, error: `${path} does not exist; the round's report is written first` };

  const summary = summaryIn(text);
  if (summary.round === null) {
    return { ok: false, error: `${path}: the title names no round — it is "# PLAN REVIEW: DESKTOP-${issue} — round <k>"` };
  }
  const round = summary.round;
  const absent = /** @type {const} */ (['A', 'B', 'C']).filter((letter) => summary.items[letter] === null);
  if (absent.length > 0) {
    return {
      ok: false,
      error: `${path} has no ${absent.map((letter) => `"## ${letter}"`).join(', ')} section, so its items cannot be counted; an empty section is written, not left out`,
    };
  }
  const items = /** @type {{A: number, B: number, C: number}} */ (summary.items);

  const cycle = journal.sinceLastReset(await journal.read({ issue }, { home }));
  const ofRound = (event) => cycle.filter((entry) => entry.event === event && roundOf(entry.detail) === round);
  if (ofRound(REVISED).length > 0) {
    return { ok: false, error: `round ${round} is already marked revised, and a review recorded now would end after its revision` };
  }

  const detail = reviewedDetail({ round, mode: summary.mode, items });
  const facts = { round, mode: summary.mode, items, detail, path };
  const earlier = ofRound(REVIEWED).at(-1);
  if (earlier?.detail === detail) return { ok: true, outcome: 'unchanged', ...facts };

  await journal.append({ issue, event: REVIEWED, detail }, { home });
  return { ok: true, outcome: earlier ? 'recorded again' : 'recorded', ...facts };
}
