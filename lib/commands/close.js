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

// `pdkit close`: the facts for a knowledge harvest; --finish moves the issue to
// merged.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { basename } from 'node:path';

import { amendmentOutcomes, readAmendments } from '../amendment.js';
import { resolveHome } from '../config.js';
import * as deferrals from '../deferrals.js';
import * as journal from '../journal.js';
import * as pr from '../pr.js';
import * as state from '../state.js';
import * as worktree from '../worktree.js';
import { EXIT, printJson, repoContext, treeHasLanded } from './support.js';

export const flags = ['issue', 'finish', 'force', 'confirmed'];

/**
 * The facts for a knowledge harvest; --finish moves the issue to merged, but
 * only once every pull request has landed, and cleans up worktrees.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const issue = Number.parseInt(String(args[0] ?? flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit close: an issue number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });
  const config = repo.config;

  const record = await state.read(issue, { home });

  // Read GitHub before the rollup, not after. The rollup is the only thing that
  // may move an issue to a terminal state, and the record it reads is the one
  // most likely to be out of date: the merge happens in the browser, hours or
  // weeks after whatever last ran `pr refresh`. On DESKTOP-17221 it was seven
  // weeks, so `close` said `pr-open` and `allMerged: false` about a pull
  // request that had merged that morning, and the way out was for the person to
  // guess which command to run.
  const reread = await pr.refreshOpen({ issue, config, home });

  const summary = await pr.rollup(issue, { home });
  const entries = await journal.read({ issue }, { home });
  const amendments = await readAmendments(issue, home);

  // Both the branch and the path are checked: a verify tree is detached and has
  // no branch at all, and it is named after the issue for exactly this reason.
  const trees = (repo.root ? await worktree.list(repo.root) : [])
    .filter((tree) => !tree.main)
    .filter((tree) => String(tree.branch ?? '').includes(`DESKTOP-${issue}`) || tree.path.includes(`DESKTOP-${issue}`));

  const facts = {
    issue,
    state: record.state,
    route: record.route,
    requirements: record.requirements.ids,
    pullRequests: summary,
    // What was read from GitHub just now, and what could not be. The second
    // list is the one that changes how the rest should be read: a pull request
    // whose state could not be established is reported from a record of the
    // stated age, and the rollup has counted it as it was.
    refreshed: reread.refreshed,
    refreshFailed: reread.failed.map((entry) => ({
      number: entry.number,
      error: entry.error,
      read: entry.reading.at,
      age: entry.reading.at ? entry.reading.label : 'never',
    })),
    amendments: amendmentOutcomes(amendments, entries),
    // What the journal remembers and the code does not: why a slice ended up
    // stacked, which upstream commit forced an amendment, what went red.
    notable: entries
      .filter((entry) => ['slice-regressed', 'conflict-semantic', 'pr-closed', 'requirements-frozen'].includes(entry.event))
      .map((entry) => `${entry.event}: ${entry.detail}`),
    worktrees: trees.map((tree) => tree.path),
    // What was set aside and never settled. It belongs in the harvest for the
    // same reason the amendments do — it is a decision this issue produced that
    // outlives it — and it belongs in the human output because closing is the
    // last step, so this is the last moment anyone looks.
    deferred: await deferrals.open({ issue, home }),
  };

  if (flags.json) printJson(facts);
  else {
    process.stdout.write(`DESKTOP-${issue} is ${record.state}\n`);
    process.stdout.write(`  pull requests: ${summary.merged.length} merged, ${summary.open.length} open, ${summary.closed.length} closed\n`);
    // Said before anything that rests on it. Every line below this one is
    // computed from the record, and for these pull requests the record is not
    // what GitHub says — it is what GitHub said, once, at the stated time.
    for (const entry of facts.refreshFailed) {
      process.stdout.write(
        `  could not re-read #${entry.number}: ${entry.error}\n` +
          `      counted as it stands in prs.json, last read ${entry.read ? `${entry.age} ago` : 'never'}\n`,
      );
    }
    // Printed here and not only in --json for the same reason the deferrals
    // are: what happened to the plan is half of what closing harvests, and the
    // human output was the half of `close` that never said it.
    for (const line of facts.amendments) process.stdout.write(`  amendment: ${line}\n`);
    for (const line of facts.notable) process.stdout.write(`  ${line}\n`);
    for (const entry of facts.deferred) {
      const from = [entry.raisedBy, entry.pr ? `#${entry.pr}` : ''].filter(Boolean).join(', ');
      process.stdout.write(`  deferred, still open: ${entry.id} — ${entry.what}${from ? ` (${from})` : ''}\n`);
    }
    for (const tree of facts.worktrees) process.stdout.write(`  worktree: ${tree}\n`);
  }

  if (!flags.finish) return EXIT.OK;

  // Two ways an issue finishes, and they are not the same fact. Code that
  // landed is a rollup over pull requests; an answer that settled it is a state
  // the machine only reaches over captured evidence (section 1). Sending the
  // second through the first is what produced "not finished — no pull request
  // was ever opened" about #18284, which was true and about nothing.
  const byAnswer = record.state === 'answered';

  if (!byAnswer && !summary.allMerged) {
    // The rollup is the only thing that may move an issue to a terminal state.
    // Upstream merges slices one at a time, and finishing on the first would
    // strand every slice after it.
    process.stderr.write(
      `pdkit close: DESKTOP-${issue} is not finished — ` +
        `${[...summary.open, ...summary.closed].map((entry) => `#${entry}`).join(', ') || 'no pull request was ever opened'}\n` +
        (summary.total === 0
          ? `  If the answer was the deliverable rather than a diff, the state for that is \`answered\`: ` +
            `pdkit state ${issue} --to answered --reason "<what the answer is>"\n`
          : ''),
    );
    return EXIT.ERROR;
  }

  if (byAnswer && !flags.confirmed) {
    // Answered means the findings are published and the reporter has not spoken
    // yet. Closing on our own say-so would make the plugin the judge of whether
    // someone else's problem went away — the same thing `awaiting-review`
    // refuses to do for domain owners.
    process.stderr.write(
      `pdkit close: DESKTOP-${issue} is answered, which means the findings are out and nobody has confirmed them yet.\n` +
        `  --confirmed says the reporter or a maintainer did: that is a fact about them, not a verdict of ours.\n` +
        `  If the answer implied product work instead, planning starts again: pdkit state ${issue} --to planned\n`,
    );
    return EXIT.ERROR;
  }

  // Warned about, and not refused. Closing is the last step, so there is no
  // later gate this could be caught at — which is an argument for blocking until
  // you notice the other half: a gate that is expensive to pass gets routed
  // around, and one standing between a finished issue and its terminal state
  // would be paid every time and earn its keep almost never. What actually keeps
  // the promise is that the journal is append-only, so the entry outlives the
  // state this transition is about to write.
  for (const entry of facts.deferred) {
    const from = [entry.raisedBy, entry.pr ? `#${entry.pr}` : ''].filter(Boolean).join(', ');
    process.stdout.write(
      `  ! ${entry.id} is still open, and closing does not settle it:\n` +
        `      ${entry.what}${from ? ` — ${from}` : ''}\n` +
        (entry.url ? `      ${entry.url}\n` : '') +
        `      \`pdkit defer resolve ${entry.id} --issue ${issue} --follow-up <n>\` when you open one.\n`,
    );
  }

  const moved = byAnswer
    ? await state.transition(issue, 'resolved', {
        reason: typeof flags.confirmed === 'string' ? flags.confirmed : 'the published answer settled it; no diff of ours did',
        home,
      })
    : await state.transition(issue, 'merged', { reason: `${summary.merged.length} pull request(s) merged`, home });
  if (!moved.ok) {
    process.stderr.write(`pdkit close: ${moved.error}\n`);
    return EXIT.ERROR;
  }

  for (const tree of facts.worktrees) {
    const name = basename(tree);
    const removed = await worktree.remove({
      repoRoot: repo.root,
      name,
      issue,
      config,
      home,
      // The same record `close` has just reported one merged pull request from.
      // Without it this refuses every squash-merged branch, which upstream is
      // all of them.
      landed: await treeHasLanded(repo.root, name, issue, config, home),
      force: Boolean(flags.force),
    });

    // Four outcomes and they are not two. `kept` is only true of a tree git
    // still has registered — saying it about one git has already unregistered
    // sends the person to look at a directory nothing will ever offer them
    // again, which is what happened on DESKTOP-17221.
    if (removed.ok && removed.leftover) {
      process.stdout.write(`  removed ${tree} — git left files behind; deleted\n`);
    } else if (removed.ok) {
      process.stdout.write(`  removed ${tree}\n`);
    } else if (removed.unregistered) {
      process.stdout.write(
        `  unregistered but still on disk: ${tree}\n` +
          `      ${removed.error}\n` +
          `      git no longer tracks it, so nothing here will offer it again: \`rm -rf ${tree}\` once you have looked\n`,
      );
    } else {
      process.stdout.write(`  kept ${tree} — ${removed.error}\n`);
    }
  }

  process.stdout.write(`DESKTOP-${issue} is ${byAnswer ? 'resolved — settled by the answer, not by a diff' : 'merged'}\n`);
  return EXIT.OK;
}
