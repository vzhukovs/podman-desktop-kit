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

// What a state asks for before it can be entered, as an ordered list. A move
// the machine allows can still be refused here, each rule after an incident of
// its own. Kept apart from lib/state.js so a new condition is a new entry
// rather than a branch between rules it has nothing to do with; the order of
// the list is the order the refusals are reported in. Nothing here writes.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { issueDir, resolveHome } from '../config.js';

/** @typedef {import('./machine.js').State} State */
/** @typedef {import('../state.js').Record_} Record_ */

/**
 * One condition for entering a state. `applies` says whether the move is one
 * the rule is about; `refuse` answers with the text to show, or null.
 *
 * @typedef {object} EntryRule
 * @property {(move: {from: State, to: State, record: Record_}) => boolean} applies
 * @property {(move: {issue: number, from: State, to: State, record: Record_, meta: object}) => Promise<string|null>} refuse
 */

/**
 * Whether a file is there. Private, and used for one question only: has the
 * previous attempt been looked up.
 *
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function hasFile(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether anything was actually captured for this issue.
 *
 * Counted as files rather than by reading validation.json, and not out of
 * laziness: lib/validation.js imports this module, so importing it back would
 * be a cycle, and re-deriving the record's shape here would give that file a
 * second reader who could disagree with its owner. What is asked instead is the
 * same question archaeology.json answers for the redo route — is there
 * something on disk that only a real run could have put there. `validation/*`
 * holds receipts written by `pdkit validate attach --run`, and evidence.js has
 * no parameter through which output could be handed in, so the file cannot be
 * talked into existing.
 *
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function hasCapture(dir) {
  try {
    return (await readdir(dir)).some((name) => name.endsWith('.md'));
  } catch {
    return false;
  }
}

/**
 * A re-cut: back to `sliced` from anywhere but `audited`.
 *
 * @param {State} from
 * @param {State} to
 * @returns {boolean}
 */
export const isRecut = (from, to) => to === 'sliced' && from !== 'audited';

/**
 * A rework: back to `triaged` from a published pull request.
 *
 * @param {State} from
 * @param {State} to
 * @returns {boolean}
 */
export const isRework = (from, to) => to === 'triaged' && (from === 'pr-open' || from === 'review-in-progress');

/** @type {EntryRule[]} */
export const ENTRY_RULES = [
  // The redo route names an ordering, and section 10 puts it in bold: the
  // archaeology comes BEFORE any implementation. Held here rather than asked
  // for in the skill, because a sentence in a prompt is what it was until now.
  //
  // What the check can honestly demand is that the previous attempt was looked
  // up — the facts file is written only from a real lookup, so prose cannot
  // produce it. Whether its lesson was learned is not checkable, and pretending
  // otherwise would be a gate reporting on what it did not do.
  {
    applies: ({ to, record }) => record.route === 'redo' && (to === 'planned' || to === 'quickfix'),
    async refuse({ issue, meta }) {
      const facts = join(issueDir(meta.home ?? resolveHome(), issue), 'archaeology.json');
      if (!(await hasFile(facts))) {
        return (
          `issue ${issue} is on the redo route: the previous attempt has not been looked up.\n` +
          `  Run: pdkit issue history ${issue}\n` +
          `  What was tried, what broke it and what the reviewers objected to comes first — re-implementing ` +
          `to rediscover it is the expensive path, and it is the one this route exists to close.`
        );
      }
      return null;
    },
  },

  // The state the whole design rests on, and until now the only one that could
  // simply be asserted. Section 1 states it as the hard rule — a push token is
  // issued from `preflight-green` and nowhere else — and the gate does check it.
  // Nothing checked that it was true. `slices-approved -> preflight-green` is a
  // legal move, so the entire chain of gates could be replaced by typing the
  // name of its outcome. Walked into on DESKTOP-18832: a session set it by hand
  // after a slice graph landed, opened a token, and pushed.
  //
  // Now it is earned from the file preflight writes. Same device as `answered`
  // above and the redo route below: a state is reachable when something on disk
  // exists that only a real run could have put there. The difference is that
  // preflight used to write nothing at all — it printed a report and forgot it —
  // which is why this was the one rule with no evidence behind it.
  {
    applies: ({ to }) => to === 'preflight-green',
    async refuse({ issue, meta }) {
      const { evidence } = await import('../preflight/record.js');
      const found = await evidence(issue, { home: meta.home ?? resolveHome(), head: meta.head ?? null, branch: meta.branch ?? null });

      if (!found.ok) {
        return (
          `issue ${issue} has not been shown to be ready to publish:\n` +
          found.problems.map((problem) => `    ${problem}\n`).join('') +
          `  Run: pdkit preflight ${issue}${meta.slice ? ` --slice ${meta.slice}` : ''}, then again with --body-only --body <file>\n` +
          `  This state is what the push gate opens from, so asserting it is asserting every check under it.`
        );
      }
      return null;
    },
  },

  // An answer published instead of a diff is still subject to the rule that
  // decides everything else here: the outcome follows what is attached. A
  // workaround nobody ran is a suggestion, and a suggestion posted on someone
  // else's tracker in the voice of a finding is worse than silence — the
  // reporter spends their evening on it.
  //
  // Deliberately narrow, and the wording says so: this proves something was
  // captured, not that the workaround works. Nothing here can check the second,
  // and claiming it would be a gate reporting on what it did not do — the same
  // boundary invariant 5 draws around PASS.
  {
    applies: ({ to }) => to === 'answered',
    async refuse({ issue, meta }) {
      const dir = issueDir(meta.home ?? resolveHome(), issue);
      if (!(await hasCapture(join(dir, 'validation')))) {
        return (
          `issue ${issue} has nothing captured, so there is no answer to publish yet.\n` +
          `  Run the reproduction and the workaround, and attach them:\n` +
          `    pdkit validate attach --issue ${issue} --title "<what this step shows>" --run "<command>"\n` +
          `  Steps that were reasoned about rather than run are how a workaround costs a reporter an evening.`
        );
      }

      if (!meta.reason?.trim()) {
        return `issue ${issue}: --reason is required — what the answer is, in one line, for the reader who finds this state in six months`;
      }
      return null;
    },
  },

  // Going back to triage from a published pull request is a rework, and it is
  // the one transition whose reason cannot be reconstructed from anything else
  // on disk: the diff still exists, the pull request is still open, and only
  // this line says why the work is being done again.
  // A re-cut from an approved or published graph is the same kind of event:
  // the graph that was approved is not the one that will ship, and only this
  // line says why.
  {
    applies: ({ from, to }) => isRecut(from, to),
    async refuse({ issue, meta }) {
      if (!meta.reason?.trim()) {
        return `issue ${issue}: a re-cut needs --reason "<why the approved graph is not the one to ship>"`;
      }
      return null;
    },
  },

  {
    applies: ({ from, to }) => isRework(from, to),
    async refuse({ issue, meta }) {
      if (!meta.reason?.trim()) {
        return (
          `issue ${issue}: a rework needs --reason "<what the review rejected>".\n` +
          `  The pull request stays open and the branch stays as it is; what changes is that planning runs again.`
        );
      }
      return null;
    },
  },
];
