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

// Whether the operator's decisions on a plan review are waiting to reach the
// plan.
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
// twice, and nothing here reads what the decisions say — applying them is
// judgment, and it is `/pd:plan`'s.

import { readFile } from 'node:fs/promises';
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
 * What a plan-review.md says about decisions, read from its text.
 *
 * The last decision section is the one that counts. A round is the number in
 * its heading, else the one in the document title, else 1.
 *
 * @param {string} text
 * @returns {{decided: boolean, round: number|null, items: string[]}}
 */
export function decisionsIn(text) {
  const source = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const headings = [...source.matchAll(DECISIONS)];
  if (headings.length === 0) return { decided: false, round: null, items: [] };

  const last = headings[headings.length - 1];
  const title = /^#[ \t]+.*$/m.exec(source)?.[0] ?? '';
  const round = Number.parseInt(ROUND.exec(last[1])?.[1] ?? ROUND.exec(title)?.[1] ?? '1', 10);

  const rest = source.slice(last.index + last[0].length);
  const end = rest.search(/^#{1,2}[ \t]/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  const items = [...new Set(body.match(/\b[A-C]\d+\b/g) ?? [])];

  return { decided: true, round, items };
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
