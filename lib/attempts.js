// SPDX-License-Identifier: Apache-2.0

// How many times a task has been tried, and when to stop trying it
// (spec section 13, open item G; the idea is flow-next's, section 0).
//
// The count is DERIVED from the journal, not stored. That is the same choice
// as the per-issue journal view in section 2.3: a stored counter is a second
// source of truth, and this one would need a second writer for state.json,
// which invariant 1 does not allow. The journal already records what happened
// and is append-only by construction, so the question "how many times has T1
// failed since anyone last looked at it" is a read over facts that are already
// there.
//
// What counts as an attempt is deliberately narrow: a capture from
// `pdkit receipt write` that came back non-zero. Not an edit, not a subagent
// turn, not a thought — the same input that decides everything else about
// completion (section 6). An agent cannot inflate it or talk it down, because
// it is not an input at all.
//
// Two events reset the count, and both mean a human or a green run has been
// through: `task-receipt` (the command from `Done when` finally passed) and
// `task-unblocked` (somebody looked and said continue, with a reason).

import { get } from './config.js';
import { append, read } from './journal.js';

/** Journal events this module reads and writes. */
export const EVENTS = {
  attempt: 'task-attempt',
  accepted: 'task-receipt',
  unblocked: 'task-unblocked',
};

/**
 * How many failures make a task blocked, when the configuration says nothing.
 *
 * Three, from flow-next. A first failure is ordinary, a second is a hint, and
 * a third means the loop is not converging — at which point another try costs
 * the same as the last one and buys the same nothing.
 */
export const DEFAULT_MAX = 3;

/**
 * The task a journal entry is about.
 *
 * Entries carry the identifier at the front of `detail`, which is how
 * lib/active.js and the task-completed hook have written them since stage 2.
 * Parsing it here rather than in three places means one convention, and a test
 * that pins it.
 *
 * @param {string} detail
 * @returns {string|null}
 */
export function taskOf(detail) {
  const match = /^(T\d+)\b/.exec(String(detail ?? ''));
  return match ? match[1] : null;
}

/**
 * The configured ceiling. Zero or negative disables blocking entirely.
 *
 * The escape hatch is deliberate and it only ever loosens: someone who decides
 * a task is worth a fourth try can say so once, in configuration, rather than
 * learning to ignore a message. What the key cannot do is tighten past the
 * evidence — the count itself comes from captures.
 *
 * @param {object} config
 * @returns {number}
 */
export function ceiling(config) {
  const configured = get(config, 'exec.max_attempts');
  return configured === undefined || configured === null ? DEFAULT_MAX : Number(configured);
}

/**
 * @typedef {object} Status
 * @property {string} taskId
 * @property {number} attempts        failed captures since the last reset
 * @property {number} max             zero or less means blocking is off
 * @property {boolean} blocked
 * @property {string|null} since      when the counting restarted, if it did
 * @property {string|null} lastAt
 * @property {string[]} details       what each attempt recorded, oldest first
 */

/**
 * Where a task stands.
 *
 * Walks the journal backwards to the most recent reset and counts the failures
 * after it. Backwards rather than forwards because the question is about now:
 * a task that failed twice in March, passed, and failed once today has failed
 * once, not three times.
 *
 * @param {{issue: number, taskId: string, config?: object, home?: string}} input
 * @returns {Promise<Status>}
 */
export async function status(input) {
  const entries = await read({ issue: input.issue }, { home: input.home });

  const mine = entries.filter(
    (entry) => taskOf(entry.detail) === input.taskId && Object.values(EVENTS).includes(entry.event),
  );

  /** @type {typeof mine} */
  const since = [];
  let restartedAt = null;

  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const entry = mine[i];
    if (entry.event === EVENTS.accepted || entry.event === EVENTS.unblocked) {
      restartedAt = entry.at;
      break;
    }
    since.unshift(entry);
  }

  const max = ceiling(input.config ?? {});

  return {
    taskId: input.taskId,
    attempts: since.length,
    max,
    blocked: max > 0 && since.length >= max,
    since: restartedAt,
    lastAt: since.length > 0 ? since[since.length - 1].at : null,
    details: since.map((entry) => entry.detail),
  };
}

/**
 * Record a failed capture.
 *
 * Called by `pdkit receipt write`, which is the only thing that runs a task's
 * `Done when`. The exit code is copied in rather than summarised: a journal
 * line saying "T1 failed" and one saying "T1 exit 137" answer different
 * questions six weeks later.
 *
 * @param {{issue: number, taskId: string, exitCode: number|null, config?: object, home?: string}} input
 * @returns {Promise<Status>}
 */
export async function record(input) {
  await append(
    {
      issue: input.issue,
      event: EVENTS.attempt,
      detail: `${input.taskId} exit ${input.exitCode === null ? 'none — killed' : input.exitCode}`,
    },
    { home: input.home },
  );

  return status(input);
}

/**
 * Record a capture that passed, so counting starts over.
 *
 * The task-completed hook writes the same event when it accepts a receipt, and
 * a duplicate is harmless: status() walks back to the first reset it meets and
 * both mean the same thing. Writing it here as well is what keeps the count
 * honest when the hook never fires — a receipt captured by hand still ends the
 * streak it ended.
 *
 * @param {{issue: number, taskId: string, home?: string}} input
 * @returns {Promise<void>}
 */
export async function passed(input) {
  await append(
    { issue: input.issue, event: EVENTS.accepted, detail: `${input.taskId} exit 0` },
    { home: input.home },
  );
}

/**
 * Let a blocked task be attempted again.
 *
 * The reason is required by the caller, not defaulted here. An unblock without
 * one is the rubber stamp this whole mechanism exists to interrupt, and the
 * journal is where "why" lives — six weeks later `state.json` says where the
 * work is and only this says why anyone thought a fourth try would differ.
 *
 * @param {{issue: number, taskId: string, reason: string, home?: string}} input
 * @returns {Promise<void>}
 */
export async function unblock(input) {
  await append(
    { issue: input.issue, event: EVENTS.unblocked, detail: `${input.taskId} ${input.reason}` },
    { home: input.home },
  );
}

/**
 * Every task of an issue that has an attempt recorded against it.
 *
 * @param {{issue: number, config?: object, home?: string}} input
 * @returns {Promise<Status[]>}
 */
export async function all(input) {
  const entries = await read({ issue: input.issue }, { home: input.home });

  const ids = [
    ...new Set(
      entries
        .filter((entry) => entry.event === EVENTS.attempt)
        .map((entry) => taskOf(entry.detail))
        .filter(Boolean),
    ),
  ].sort();

  return Promise.all(ids.map((taskId) => status({ ...input, taskId })));
}

/**
 * What to say when a task has run out of attempts.
 *
 * One text, used by the receipt command, the completion hook and the session
 * summary. Three wordings of the same refusal would drift, and the one that
 * drifts is the one the reader learns to skim.
 *
 * @param {{issue: number}} input
 * @param {Status} state
 * @returns {string}
 */
export function blockedMessage(input, state) {
  return (
    `${state.taskId} of issue ${input.issue} is blocked: ${state.attempts} failed captures` +
    `${state.since ? ` since ${state.since}` : ''}, and the ceiling is ${state.max}.\n` +
    `  A fourth attempt costs what the third did. What changed between them is the question — if the\n` +
    `  answer is "nothing", the plan is wrong rather than the code, and that is an amendment, not a retry.\n` +
    `  When you have decided otherwise: pdkit task unblock --issue ${input.issue} --task ${state.taskId} --reason "<what is different this time>"`
  );
}
