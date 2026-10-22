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

// SubagentStop handler: no receipt, no completion.
//
// "Done" means the output of the command from `Done when`, captured verbatim.
// Without this hook that rule is advice, and advice loses to a confident
// summary every time. With it, a task cannot be marked complete on narrative.
//
// Registered on `SubagentStop`, not `TaskCompleted` (see lib/hooks/events.js
// for why that cost four months of silence). The two events refuse differently,
// and that shapes this file: exit 2 on SubagentStop does not leave a task
// unmarked, it keeps the subagent running with the refusal as its next
// instruction. For "capture a receipt" and "fix the work" that is exactly the
// instruction wanted. For a task blocked at the attempts ceiling it is a forced
// fourth try, so that one refusal is delivered once and then let go.
//
// Which task is being completed comes from lib/active.js, not from the event.
// The identifier in the payload is Claude Code's, and ours is T1 — mapping one
// to the other would be a guess, while the working tree already knows what it
// is executing. It is recorded in the journal so the two can be lined up later.
//
// The scope, stated rather than discovered: while a task is marked active in a
// tree, the implementer completing there is asked for that task's receipt, and
// no other agent is. It used to be any subagent, because the event carried no
// agent name. SubagentStop does carry one, and the refusal now has teeth: it
// keeps the agent running with "capture a receipt" as its next instruction. A
// scout or an auditor sent off mid-`/pd:exec` would be held until it wrote a
// receipt for a task that was never its job. Outside execution, `pdkit task
// stop` is what says the tree is no longer executing a planned task.
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
import { EVENTS as ATTEMPT_EVENTS, blockedMessage, status, taskOf } from '../attempts.js';
import { issueDir, load, resolveHome } from '../config.js';
import { validateReceipt } from '../evidence.js';
import { parseBranch } from '../ids.js';
import { append as appendJournal, read as readJournal } from '../journal.js';
import { currentBranch } from '../repo.js';
import { movedSince, read as readState } from '../state.js';

/**
 * Which issue a subagent belonged to, from what the machine can see, and a note
 * when the answer was withheld.
 *
 * Two sources, in order of how much they know. The active pointer is exact and
 * exists during `/pd:exec`; outside it — the scouts of `/pd:plan`, the critic,
 * the auditor — there is no pointer, and the working tree's branch is what is
 * left. `pdkit worktree create` names branches `DESKTOP-<issue>/<slug>`, so
 * parsing one is reading a name this plugin wrote, not guessing.
 *
 * Reading the name is not guessing; reading it as the issue being worked on
 * can be. Nothing returns a checkout to where it was, and on DESKTOP-18915 the
 * whole cycle ran in a main checkout left on 18967's branch: every slicer,
 * auditor and scout of that afternoon was filed under 18967, and `pdkit cost`,
 * which attributes calls by the nearest journal entry, followed them. So when
 * another issue in progress was moved after the branch's issue, the branch is
 * one witness among two and the run is recorded with no issue, the reason in
 * its detail.
 *
 * Neither source answers when the work is happening on a branch of somebody
 * else's shape either. In both cases an unattributed count is still a count,
 * and a wrong attribution is worse than none in the one file nothing may
 * rewrite.
 *
 * @param {{cwd?: string}|null} payload
 * @param {{issue: number}|null} active
 * @param {string} home
 * @returns {Promise<{issue: number|null, note: string|null}>}
 */
async function issueOf(payload, active, home) {
  if (active) return { issue: active.issue, note: null };

  const branch = await currentBranch({ cwd: payload?.cwd ?? process.cwd() }).catch(() => null);
  const named = branch ? (parseBranch(branch)?.issue ?? null) : null;
  if (named === null) return { issue: null, note: null };

  const record = await readState(named, { home });
  const later = await movedSince(record.updatedAt, { home, except: named });
  if (later.length === 0) return { issue: named, note: null };

  const moved = later.map((other) => other.issue).join(', ');
  return { issue: null, note: `not filed under ${named}: the tree is on ${branch}, and ${moved} moved since` };
}

/**
 * Claude Code's identifier for the run that finished.
 *
 * SubagentStop sends `agent_id`; `task_id` is what TaskCompleted sent, kept so
 * an entry written by an older registration still reads the same.
 *
 * @param {{agent_id?: string, task_id?: string}|null} payload
 * @returns {string|null}
 */
const runId = (payload) => payload?.agent_id ?? payload?.task_id ?? null;

/**
 * The one agent whose finishing is a claim that a task is done.
 *
 * Plugin agents are reported as `<plugin>:<name>`. That shape was observed live
 * for `pd:pd-scout`, and `name: pd-implementer` in agents/pd-implementer.md
 * gives this one. Renaming that agent without changing this constant switches
 * the gate off. test/task-completed.test.js reads the frontmatter to catch it.
 */
export const IMPLEMENTER = 'pd:pd-implementer';

/**
 * Whether this finish is held to the active task's receipt.
 *
 * A payload with no `agent_type` is gated. SubagentStop has always sent one,
 * so its absence means a host that stopped saying who finished. Under an
 * active task, assuming the implementer refuses a completion that can be
 * redone. Assuming anyone else lets an unproven one through.
 *
 * @param {{agent_type?: string}|null} payload
 * @returns {boolean}
 */
const claimsTheTask = (payload) => !payload?.agent_type || payload.agent_type === IMPLEMENTER;

/**
 * Whether the run is one of Claude Code's own, not a subagent anybody spawned.
 *
 * SubagentStop also fires for the agents behind the host's features, prompt
 * suggestions and `/btw` among them, and those arrive with `agent_type` set to
 * the empty string. An absent field and an empty one are different statements:
 * absent is a host that stopped saying, and stays gated (see claimsTheTask);
 * empty is the host saying "nobody's". On DESKTOP-19818 they were neither
 * counted apart nor let through: a prompt suggestion finishing after each turn
 * was held for T2's receipt, and once the receipt existed, four of them were
 * journalled as "T2 accepted".
 *
 * @param {{agent_type?: string}|null} payload
 * @returns {boolean}
 */
const isInternal = (payload) => payload?.agent_type === '';

/**
 * Whether the run belongs to another session than the one that started the
 * task in this tree.
 *
 * Only when both sides say which session they are: a pointer written before
 * the session was recorded, or a payload without one, is treated as before.
 * Treating an unknown as foreign would switch the receipt gate off exactly
 * where it cannot be seen.
 *
 * @param {{session_id?: string}|null} payload
 * @param {{session?: string}|null} active
 * @returns {boolean}
 */
const fromAnotherSession = (payload, active) =>
  Boolean(active?.session && payload?.session_id && active.session !== payload.session_id);

/**
 * How many stops in a row the same run may be held without capturing anything.
 *
 * A refusal on SubagentStop keeps the agent running with "run `pdkit receipt
 * write`" as its next instruction. Usually that instruction is followed by a
 * capture, and the capture is progress: it either produces the receipt or
 * counts toward the attempts ceiling, which ends the loop. Some failures end
 * the command before it captures anything: no task file, or a `Done when` that
 * is prose. The plan has to be amended, and the implementer cannot do that. No
 * attempt is recorded, the ceiling never comes, and without this limit the
 * agent is held forever.
 *
 * The holds are counted from the journal, not stored separately. Every stop
 * already writes `agent-done` with the run's id, and every capture writes an
 * attempts event for the task. So the count is the number of this run's stops
 * since the task's last capture. A healthy run never gets past one.
 */
export const STALL_LIMIT = 3;

/**
 * This run's stops since the active task last captured anything, the current
 * one included (recordRun writes it before any decision is made).
 *
 * A run with no id cannot be told apart from other runs, so it is never let go
 * on this count. Being held is the gate's default, and the default wins when
 * the record cannot say otherwise.
 *
 * @param {{agent_id?: string, task_id?: string}|null} payload
 * @param {{issue: number, taskId: string}} active
 * @param {string} home
 * @returns {Promise<number>}
 */
async function holdsWithoutCapture(payload, active, home) {
  const id = runId(payload);
  if (!id) return 0;

  const mine = `agent task ${id}`;
  const captures = new Set(Object.values(ATTEMPT_EVENTS));
  const entries = await readJournal({ issue: active.issue }, { home }).catch(() => []);

  let holds = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (captures.has(entry.event) && taskOf(entry.detail) === active.taskId) break;
    if (entry.event === 'agent-done' && (entry.detail === mine || entry.detail.startsWith(`${mine};`))) holds += 1;
  }
  return holds;
}

/**
 * Record that a subagent finished.
 *
 * Which agent it was is recorded when the host says so: SubagentStop carries
 * `agent_type` (`pd:pd-scout`, `general-purpose`), observed in a live payload,
 * not assumed. When it is absent the entry says nothing about it rather than
 * guessing — a count that claims more than was measured is the defect this
 * repository keeps finding under other names.
 *
 * Never throws. A journal append that fails must not block a completion —
 * counting is bookkeeping, and bookkeeping does not get to stop the work.
 *
 * @param {{agent_id?: string, agent_type?: string, task_id?: string, cwd?: string}|null} payload
 * @param {{issue: number, taskId: string}|null} active
 * @param {string} home
 * @param {string|null} [aside] why the run was not filed under the task in its tree
 * @returns {Promise<void>}
 */
async function recordRun(payload, active, home, aside = null) {
  try {
    const owner = await issueOf(payload, active, home);
    await appendJournal(
      {
        issue: owner.issue,
        event: 'agent-done',
        detail: [
          runId(payload) ? `agent task ${runId(payload)}` : 'agent task unnamed',
          payload?.agent_type ?? null,
          active ? `while ${active.taskId} was active` : null,
          owner.note,
          aside,
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
 * @param {{agent_id?: string, agent_type?: string, task_id?: string, session_id?: string, stop_hook_active?: boolean, cwd?: string}|null} payload
 * @param {{event: string, pluginRoot: string}} [_context]
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, _context) {
  // Not counted either: the count is of the machinery an issue took, and a
  // prompt suggestion is the host's, not this plugin's.
  if (isInternal(payload)) return { block: false };

  const pointer = await current({ cwd: payload?.cwd });
  const home = resolveHome();

  // Another session's agent in this tree is not working on this task. It is
  // counted, by the tree's branch as any run outside execution is, and neither
  // held for the receipt nor taken as a claim that the task is done.
  const foreign = fromAnotherSession(payload, pointer);
  const active = foreign ? null : pointer;

  // Written before anything is decided, and that ordering is the point: an
  // agent that finishes has run, whatever this handler then does about its
  // claim. Counting only the accepted ones would make the record cheapest
  // exactly where the work went worst.
  await recordRun(payload, active, home, foreign ? `from another session than the one running ${pointer?.taskId}` : null);

  if (!active || !claimsTheTask(payload)) return { block: false };

  const receiptPath = join(issueDir(home, active.issue), 'receipts', `${active.taskId}.md`);
  const capture = `pdkit receipt write --issue ${active.issue} --task ${active.taskId}`;

  /**
   * @param {string} problem
   * @returns {import('./dispatch.js').Decision}
   */
  const holds = await holdsWithoutCapture(payload, active, home);

  /**
   * A receipt refusal, unless this run has been held without capturing for
   * longer than holding can help.
   *
   * At the limit, the refusal says what the next stop will do, so the agent
   * ends its run by reporting what `pdkit receipt write` printed. Holding it
   * again cannot produce a receipt. Past the limit the agent is let go. That
   * does not accept the task: nothing writes `task-receipt … accepted`, and the
   * audit reports the receipt as missing or failed on its own.
   *
   * @param {import('./dispatch.js').Decision} decision
   * @returns {import('./dispatch.js').Decision}
   */
  const hold = (decision) => {
    if (holds > STALL_LIMIT) {
      return {
        block: false,
        rule: 'stalled',
        message:
          `pdkit: ${active.taskId} of issue ${active.issue} is NOT accepted — let go after ${holds} stops with ` +
          `no capture between them. The task stays unproven until a receipt passes.`,
      };
    }
    if (holds === STALL_LIMIT) {
      return {
        ...decision,
        reason:
          `${decision.reason}\n` +
          `  This is stop ${holds} with nothing captured. If \`${capture}\` cannot run, end your turn now and ` +
          `report what it printed: the next stop is let go, and the task stays unproven.`,
      };
    }
    return decision;
  };

  const refuse = (problem) => hold({
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
      // `stop_hook_active` is the host saying this subagent is already running
      // on a stop hook's instruction — it has been told it is blocked. Holding
      // it again would only make it try a fourth time, which is what the
      // ceiling exists to prevent; it goes back to its caller with the refusal
      // in hand, and `pdkit task start` keeps the task closed from there.
      if (payload?.stop_hook_active) {
        return { block: false, rule: 'attempts', message: `pdkit: ${blockedMessage({ issue: active.issue }, tried)}` };
      }
      return { block: true, rule: 'attempts', reason: `pdkit: ${blockedMessage({ issue: active.issue }, tried)}` };
    }

    return hold({
      block: true,
      rule: 'receipt',
      reason:
        `pdkit: ${active.taskId} of issue ${active.issue} has a valid receipt for a command that failed ` +
        `(exit ${checked.exitCode === null ? 'none — killed' : checked.exitCode}).\n` +
        `  ${checked.command}\n` +
        `  ${receiptPath}\n` +
        `  Fix the work and capture again. If the command itself is wrong, that is a finding about the ` +
        `plan — report it rather than editing \`Done when\` to something that passes.`,
    });
  }

  await appendJournal(
    {
      issue: active.issue,
      event: 'task-receipt',
      detail: [`${active.taskId} accepted`, runId(payload) ? `agent task ${runId(payload)}` : null]
        .filter(Boolean)
        .join('; '),
    },
    { home },
  );

  return { block: false, message: `pdkit: ${active.taskId} has a receipt for \`${checked.command}\`` };
}
