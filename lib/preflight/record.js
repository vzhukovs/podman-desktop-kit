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

// What preflight found, kept, so that `preflight-green` has to be earned.
//
// The hole this closes is the largest one the design had, and it sat under its
// own hard rule. Section 1: "pdkit gate lets git push and gh pr create through
// only from preflight-green." The gate does check the state — and nothing
// checked that the state was true. `pdkit state <n> --to preflight-green` is a
// legal transition from `slices-approved`, so the entire chain of evidence could
// be replaced by fourteen characters. Walked into on DESKTOP-18832, where a
// session typed exactly that after a slice graph landed, opened a token, and
// pushed. Nothing was wrong with that diff; nothing would have been wrong with
// the next one either, which is the problem.
//
// The other states already work this way. `answered` refuses while nothing has
// been captured, the redo route refuses to leave `triaged` until the previous
// attempt has been looked up — in both cases because a file exists that only a
// real run could have produced. Preflight produced no such file at all: it
// printed a report and forgot it. So the report is now written down, and the
// transition reads it.
//
// Runs accumulate rather than replace, and that is forced by the two-pass flow
// (section 7). Four checks read the PR body, which does not exist on the first
// pass; `--body-only` then re-runs those four against it. Neither pass alone is
// "everything green with the body in hand", so the question is asked of the
// merged view: for each check, the most recent result at this commit, and for
// the body-dependent ones, a result from a run that actually had the body.
//
// Deliberately not a receipt. lib/evidence.js digests a command's output so a
// hand-edited receipt stops validating, and that is the right shape for a thing
// whose content is a program's stdout. This is a verdict over fourteen checks
// run in-process; there is no output to digest, and a digest over our own JSON
// would protect against nothing an attacker with a text editor could not redo.
// What makes it hard to forge is that the file is written by the same command
// that ran the checks, and the transition checks it against the commit HEAD is
// on right now.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { issueDir, resolveHome } from '../config.js';

/**
 * How many runs are kept.
 *
 * Enough for the two passes of several slices, and bounded because this file is
 * read on a transition: an issue reworked five times should not make the gate
 * parse a hundred stale reports to answer a question about the current commit.
 */
export const KEEP_RUNS = 20;

/**
 * One check's outcome, as preflight.json keeps it.
 *
 * Narrower than the runner's own result: the summary is kept and the raw output
 * is not, because this file exists to answer whether the state may move rather
 * than to reproduce the report. `bodyDependent` is stored so a later reader can
 * tell a check that had nothing to say from one that had nothing to read.
 *
 * @typedef {object} Result
 * @property {string} id
 * @property {'pass'|'fail'|'warn'|'skip'} status
 * @property {boolean} blocking
 * @property {boolean} bodyDependent  whether this check reads the PR body
 * @property {string} summary
 */

/**
 * One preflight run, filed under the commit it judged.
 *
 * Under the resolved sha rather than under `HEAD`, because the name is the same
 * five letters before and after an amend and evidence filed under it still looks
 * current when the diff it judged is gone. `body` is what makes the second pass
 * load-bearing instead of ceremonial — a run whose body-dependent checks skipped
 * has judged nothing, and `state --to preflight-green` reads that.
 *
 * @typedef {object} Run
 * @property {string} at
 * @property {boolean} ok
 * @property {string|null} branch
 * @property {number|null} slice
 * @property {string|null} head       the commit the checks looked at
 * @property {{ref: string|null, sha: string|null}} base
 * @property {boolean} body           whether the PR body was in hand
 * @property {Result[]} results
 */

/**
 * @param {string} home
 * @param {number} issue
 * @returns {string}
 */
function recordPath(home, issue) {
  return join(issueDir(home, issue), 'preflight.json');
}

/**
 * Read what preflight has found for an issue.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{issue: number, updatedAt: string|null, runs: Run[]}>}
 */
export async function read(issue, options = {}) {
  const home = options.home ?? resolveHome();

  try {
    const parsed = JSON.parse(await readFile(recordPath(home, issue), 'utf8'));
    return { issue, updatedAt: parsed.updatedAt ?? null, runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
  } catch {
    // Absent or unreadable are the same answer here: nothing has been
    // demonstrated. Failing closed costs a re-run; failing open costs the rule.
    return { issue, updatedAt: null, runs: [] };
  }
}

/**
 * Append a run.
 *
 * Called by the command that ran the checks, and by nothing else. There is no
 * parameter through which a verdict could be supplied — `results` comes from
 * the report the runner produced, the same device section 2.2 uses everywhere:
 * the discipline rests on the absence of an input.
 *
 * @param {{issue: number, report: {ok: boolean, results: object[]}, context: object, bodyDependent: string[], home?: string}} input
 * @returns {Promise<Run>}
 */
export async function write(input) {
  const home = input.home ?? resolveHome();
  const file = recordPath(home, input.issue);
  const existing = await read(input.issue, { home });

  /** @type {Run} */
  const run = {
    at: new Date().toISOString(),
    ok: input.report.ok,
    branch: input.context.branch ?? null,
    slice: input.context.slice ?? null,
    head: input.context.headSha ?? null,
    base: { ref: input.context.baseInfo?.ref ?? null, sha: input.context.baseInfo?.sha ?? null },
    body: input.context.prBody !== null && input.context.prBody !== undefined,
    results: input.report.results.map((result) => ({
      id: result.id,
      status: result.status,
      blocking: Boolean(result.blocking),
      bodyDependent: input.bodyDependent.includes(result.id),
      summary: result.summary ?? '',
    })),
  };

  const runs = [...existing.runs, run].slice(-KEEP_RUNS);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ issue: input.issue, updatedAt: run.at, runs }, null, 2)}\n`);

  return run;
}

/**
 * Whether preflight has demonstrated this commit is ready to publish.
 *
 * The merged view rather than the last run, because the flow that produces a
 * green is two passes and neither is complete on its own.
 *
 * Scoped to a commit, and that is what makes the evidence about this diff rather
 * than about a diff. Scoped to a branch too, because a sliced issue passes
 * through `preflight-green` once per slice and #2's readiness says nothing about
 * #3.
 *
 * @param {number} issue
 * @param {{home?: string, head?: string|null, branch?: string|null}} options
 * @returns {Promise<{ok: boolean, problems: string[], at: string|null, checks: number}>}
 */
export async function evidence(issue, options = {}) {
  const home = options.home ?? resolveHome();
  const { runs } = await read(issue, { home });

  if (runs.length === 0) {
    return { ok: false, problems: ['preflight has never run for this issue'], at: null, checks: 0 };
  }

  const head = options.head ?? null;
  const branch = options.branch ?? null;

  const mine = runs.filter(
    (run) => (head === null || run.head === head) && (branch === null || run.branch === null || run.branch === branch),
  );

  if (mine.length === 0) {
    const last = runs[runs.length - 1];
    return {
      ok: false,
      problems: [
        `preflight last ran on ${last.head ? last.head.slice(0, 9) : 'an unrecorded commit'}` +
          `${last.branch ? ` (${last.branch})` : ''}, and this is ${head ? head.slice(0, 9) : 'a different commit'}` +
          `${branch ? ` (${branch})` : ''} — a green run of a diff that has since moved is the false evidence this check exists for`,
      ],
      at: last.at,
      checks: 0,
    };
  }

  // Latest result per check, across the passes.
  /** @type {Map<string, Result & {at: string, body: boolean}>} */
  const latest = new Map();
  for (const run of mine) {
    for (const result of run.results) latest.set(result.id, { ...result, at: run.at, body: run.body });
  }

  const problems = [];
  for (const result of latest.values()) {
    if (result.blocking && result.status === 'fail') {
      problems.push(`${result.id} failed: ${result.summary}`);
      continue;
    }
    // A body-dependent check that ran without the body did not skip because
    // there was nothing to say — it skipped because it had nothing to read.
    // Counting that as green is the second pass proving nothing, which is the
    // shape `--body-only` already refuses without `--body`.
    if (result.bodyDependent && !result.body) {
      problems.push(`${result.id} has only ever run without the pull request body, so it has judged nothing`);
    }
  }

  const at = mine[mine.length - 1].at;
  return { ok: problems.length === 0, problems, at, checks: latest.size };
}
