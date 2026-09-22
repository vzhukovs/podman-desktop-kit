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

// TaskCompleted handler: no receipt, no completion.
//
// "Done" means the output of the command from `Done when`, captured verbatim.
// Without this hook that rule is advice, and advice loses to a confident
// summary every time. With it, a task cannot be marked complete on narrative.
//
// Which task is being completed comes from lib/active.js, not from the event.
// The identifier in the payload is Claude Code's, and ours is T1 — mapping one
// to the other would be a guess, while the working tree already knows what it
// is executing. It is recorded in the journal so the two can be lined up later.
//
// The scope this implies, stated rather than discovered: while a task is marked
// active in a tree, *any* subagent completing there is asked for that task's
// receipt. During `/pd:exec` the only subagent running is the implementer, so
// that is the intent; outside it, `pdkit task stop` is what says the tree is no
// longer executing a planned task.
//
// The second job is counting. This hook is the only place that sees every
// subagent finish — scouts, the plan critic, the auditor, the slicer and the
// reviewers all complete here, and until now all of them passed through in
// silence because the handler returns early when no task is active. What that
// cost is the answer to "how much machinery did this issue take", which is the
// one number that normalises across issues of different sizes: an issue with
// seven tasks and two slices is supposed to be dearer than a one-task fix, and
// dollars alone cannot tell that apart from waste.
//
// Counted here rather than reported by the session, for the reason the CI
// verdict is not a parameter: a count an agent writes about itself is a count
// it can forget to write, and nothing downstream could tell the difference
// between a cheap issue and an unrecorded one.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { current } from '../active.js';
import { blockedMessage, status } from '../attempts.js';
import { issueDir, load, resolveHome } from '../config.js';
import { validateReceipt } from '../evidence.js';
import { parseBranch } from '../ids.js';
import { append as appendJournal } from '../journal.js';
import { currentBranch } from '../repo.js';

/**
 * Which issue a subagent belonged to, from what the machine can see.
 *
 * Two sources, in order of how much they know. The active pointer is exact and
 * exists during `/pd:exec`; outside it — the scouts of `/pd:plan`, the critic,
 * the auditor — there is no pointer, and the working tree's branch is what is
 * left. `pdkit worktree create` names branches `DESKTOP-<issue>/<slug>`, so
 * parsing one is reading a name this plugin wrote, not guessing.
 *
 * Neither answers when the work is happening in the main checkout on a branch
 * of somebody else's shape. Then the run is recorded with no issue rather than
 * attributed to a guess: an unattributed count is still a count, and a wrong
 * attribution is worse than none in the one file nothing may rewrite.
 *
 * @param {{cwd?: string}|null} payload
 * @param {{issue: number}|null} active
 * @returns {Promise<number|null>}
 */
async function issueOf(payload, active) {
  if (active) return active.issue;

  const branch = await currentBranch({ cwd: payload?.cwd ?? process.cwd() }).catch(() => null);
  return branch ? (parseBranch(branch)?.issue ?? null) : null;
}

/**
 * Record that a subagent finished.
 *
 * What is NOT recorded is which agent it was. The payload carries Claude Code's
 * own task identifier and the directory; the agent's name — `pd-scout`,
 * `pd-auditor` — is not in what this hook is given, and inventing a field to
 * read it from would make the entry claim more than was measured. That is the
 * defect this repository keeps finding under other names, so the entry says
 * what it saw: one subagent, here, then.
 *
 * Never throws. A journal append that fails must not block a completion —
 * counting is bookkeeping, and bookkeeping does not get to stop the work.
 *
 * @param {{task_id?: string, cwd?: string}|null} payload
 * @param {{issue: number, taskId: string}|null} active
 * @param {string} home
 * @returns {Promise<void>}
 */
async function recordRun(payload, active, home) {
  try {
    await appendJournal(
      {
        issue: await issueOf(payload, active),
        event: 'agent-done',
        detail: [
          payload?.task_id ? `agent task ${payload.task_id}` : 'agent task unnamed',
          active ? `while ${active.taskId} was active` : null,
        ]
          .filter(Boolean)
          .join('; '),
      },
      { home },
    );
  } catch {
    // Bookkeeping, not a gate.
  }
}

/**
 * Refuse to let a task be marked done without a receipt that proves it.
 *
 * The task is taken from the active pointer rather than from the payload, whose
 * identifier belongs to Claude Code and not to the plan. No pointer means no
 * claim to check, which is allowed — this hook exists to catch a completion
 * asserted over a failing command, not to police every task that ever runs.
 *
 * @param {{task_id?: string, cwd?: string}|null} payload
 * @param {{event: string, pluginRoot: string}} [_context]
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, _context) {
  const active = await current({ cwd: payload?.cwd });
  const home = resolveHome();

  // Written before anything is decided, and that ordering is the point: an
  // agent that finishes has run, whatever this handler then does about its
  // claim. Counting only the accepted ones would make the record cheapest
  // exactly where the work went worst.
  await recordRun(payload, active, home);

  if (!active) return { block: false };

  const receiptPath = join(issueDir(home, active.issue), 'receipts', `${active.taskId}.md`);
  const capture = `pdkit receipt write --issue ${active.issue} --task ${active.taskId}`;

  /**
   * @param {string} problem
   * @returns {import('./dispatch.js').Decision}
   */
  const refuse = (problem) => ({
    block: true,
    rule: 'receipt',
    reason:
      `pdkit: ${active.taskId} of issue ${active.issue} cannot be completed — ${problem}.\n` +
      `  Run: ${capture}\n` +
      `  It runs the command from \`Done when\` itself and records what it printed. The output is not ` +
      `something you can hand it, which is the point: "the tests passed" and the test runner's own ` +
      `text are different kinds of claim.`,
  });

  let content;
  try {
    content = await readFile(receiptPath, 'utf8');
  } catch {
    return refuse('there is no receipt');
  }

  const checked = validateReceipt(content);
  if (!checked.ok) return refuse(checked.reason);

  // A genuine receipt for a run that failed. The receipt is valid — it is the
  // evidence that the task is not done — so what is refused here is the
  // completion, and the message says which of the two it is.
  if (checked.exitCode !== 0) {
    // How many times this has already happened changes what to say. "Fix it and
    // capture again" is the right advice twice; the third time it is the advice
    // that built the loop.
    const tried = await status({ issue: active.issue, taskId: active.taskId, config: await load({}), home });
    if (tried.blocked) {
      return { block: true, rule: 'attempts', reason: `pdkit: ${blockedMessage({ issue: active.issue }, tried)}` };
    }

    return {
      block: true,
      rule: 'receipt',
      reason:
        `pdkit: ${active.taskId} of issue ${active.issue} has a valid receipt for a command that failed ` +
        `(exit ${checked.exitCode === null ? 'none — killed' : checked.exitCode}).\n` +
        `  ${checked.command}\n` +
        `  ${receiptPath}\n` +
        `  Fix the work and capture again. If the command itself is wrong, that is a finding about the ` +
        `plan — report it rather than editing \`Done when\` to something that passes.`,
    };
  }

  await appendJournal(
    {
      issue: active.issue,
      event: 'task-receipt',
      detail: [`${active.taskId} accepted`, payload?.task_id ? `agent task ${payload.task_id}` : null]
        .filter(Boolean)
        .join('; '),
    },
    { home },
  );

  return { block: false, message: `pdkit: ${active.taskId} has a receipt for \`${checked.command}\`` };
}
