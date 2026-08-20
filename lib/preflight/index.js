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

// The preflight runner (spec section 7).
//
// Every check is its own module under checks/ with the same shape, so the set
// is enumerable and a check can be reasoned about — and disabled — in isolation.
// The report is machine-readable because the /pd:pr flow refuses to proceed on
// anything but a green result, and that decision must not depend on parsing
// prose.
//
// Blocking vs warning is a property of the check, not of the caller.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { get, load, resolveHome } from '../config.js';
import { branches, changedPaths, commits, currentBranch, readPackageMap, resolveBase, revision, scripts } from '../repo.js';
import { baseRefOf, read as readGraph } from '../slice.js';
import * as state from '../state.js';

const CHECKS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'checks');

/**
 * @typedef {object} CheckResult
 * @property {string} id
 * @property {'pass'|'fail'|'warn'|'skip'} status
 * @property {boolean} blocking
 * @property {string} summary
 * @property {string} [output]     raw command output where the check ran one
 * @property {string} [remedy]     what to do about it
 */

/**
 * @typedef {object} Check
 * @property {string} id
 * @property {boolean} blocking
 * @property {(context: PreflightContext) => Promise<CheckResult>} run
 */

/**
 * @typedef {object} PreflightContext
 * @property {number} issue
 * @property {number} [slice]
 * @property {import('../slice.js').Graph|null} sliceGraph
 * @property {import('../slice.js').Slice|null} sliceRecord
 * @property {'quickfix'|'standard'|'multi-slice'|'redo'} route
 * @property {string} repoRoot
 * @property {string} base                          the ref the work forked from
 * @property {{ref: string, kind: string, sha: string|null, at: string|null, localBehind: number|null}} baseInfo
 * @property {string} ref
 * @property {string|null} branch                   the branch under check
 * @property {string[]} changedFiles
 * @property {Array<{status: string, path: string}>} changed
 * @property {Array<object>} commits
 * @property {Record<string, string>} scripts       what the repository defines
 * @property {object} packageMap
 * @property {string|null} prBody                   null before the body is drafted
 * @property {object} config
 * @property {string} home
 * @property {string|null} problem   why this run cannot honestly happen at all
 */

/** Check ids in report order. Mirrors the table in section 7. */
export const CHECK_IDS = [
  'working-tree',
  'tests',
  'lint',
  'typecheck',
  'spdx',
  'conventional-commits',
  'signed-off-by',
  'schemas',
  'extension-api',
  'api-surface',
  'slice-standalone',
  'branch-name',
  'quickfix-size',
  'steps-to-check',
  'r-coverage',
  'e2e-stability',
  'e2e-environment',
  'validation-evidence',
  'debug-leftovers',
  'ci-blind-spots',
];

/**
 * Load every check module.
 *
 * @returns {Promise<Check[]>}
 */
export async function loadChecks(only = null) {
  const wanted = only === null ? CHECK_IDS : CHECK_IDS.filter((id) => only.includes(id));
  const unknown = (only ?? []).filter((id) => !CHECK_IDS.includes(id));
  if (unknown.length > 0) throw new Error(`no such check: ${unknown.join(', ')}`);

  const checks = [];
  for (const id of wanted) {
    const module = await import(join(CHECKS_DIR, `${id}.js`));
    checks.push({ id: module.id ?? id, blocking: module.blocking ?? true, run: module.run });
  }

  return checks;
}

/**
 * The checks that read the PR body.
 *
 * The second pass of the /pd:pr flow (section 4) only needs these: the first
 * pass already ran the rest, and re-running `pnpm test` on three packages to
 * re-read a paragraph is minutes of nothing. Naming them here rather than in
 * the caller keeps "which checks need the body" next to the checks.
 *
 * Missing an entry here is worse than it looks: a body-dependent check left out
 * of this list keeps the first pass's answer forever, and the first pass's
 * answer is `skip` — which reads, in a report, exactly like a check that had
 * nothing to complain about.
 */
export const BODY_DEPENDENT = [
  'extension-api',
  'steps-to-check',
  'r-coverage',
  'ci-blind-spots',
  'e2e-environment',
  'validation-evidence',
];

/**
 * Gather everything the checks read, once.
 *
 * Doing this here rather than in each check means a run costs one `git diff`
 * and one `git log` instead of fourteen, and — more to the point — every check
 * sees the same repository state. Checks that each fetched their own could
 * disagree about what the diff contains.
 *
 * @param {{issue: number, slice?: number, repoRoot: string, home?: string, base?: string, ref?: string, prBody?: string|null}} input
 * @returns {Promise<PreflightContext>}
 */
export async function prepare(input) {
  const home = input.home ?? resolveHome({ repoRoot: input.repoRoot });
  const config = await load({ repoRoot: input.repoRoot, home });

  const cwd = input.repoRoot;
  const branch = await currentBranch({ cwd });

  // Which slice this run is about, and therefore what it is a diff FROM.
  //
  // A stacked slice branches from its predecessor, and reading it against the
  // base branch instead would hand every file check the previous slice's work
  // as though it were this one's — a report that is confidently about the wrong
  // change. The slice is taken from the flag, or inferred from the branch when
  // the flag is absent, because `pdkit preflight <n>` standing on a slice
  // branch means the slice.
  const graph = await readGraph(input.issue, { home });
  const slice =
    graph === null
      ? null
      : (graph.slices.find((entry) => entry.index === input.slice) ??
        graph.slices.find((entry) => entry.branch === branch) ??
        null);

  const configuredBase = String(get(config, 'repo.base_branch') ?? 'main');
  const named = input.base ?? (slice ? baseRefOf(graph, slice, configuredBase) : configuredBase);

  // A slice stacked on another slice bases on a local branch, and that is
  // correct — it is ours and it exists nowhere else. Everything else bases on
  // the base branch, where the local copy is the wrong ref: see repo.resolveBase.
  const stacked = Boolean(slice) && named !== configuredBase;
  const resolvedBase = stacked
    ? { ref: named, kind: 'local', sha: null, at: null, localBehind: null }
    : await resolveBase({ cwd, base: named, config });

  const base = resolvedBase.ref;

  // And what it is a diff TO. The base came from the graph; the ref used to be
  // whatever happened to be checked out, which is right only because the flow
  // runs preflight from the slice's own worktree. Run it from anywhere else and
  // every file check reads a change the slice has nothing to do with — and says
  // nothing, because HEAD is always a valid ref.
  //
  // Found by dry-running scenario 13: a graph cut from published PR #18434,
  // `preflight --slice 1`, and a green report saying "the public API
  // declaration is untouched" about a slice whose only file is
  // extension-api.d.ts. Green is the worst possible way to be wrong here.
  //
  // A slice that has no branch yet is refused rather than measured: the flow
  // materializes before preflight (section 4), so no branch means the run is
  // out of order, and reporting on HEAD instead would answer a question nobody
  // asked.
  let ref = input.ref ?? 'HEAD';
  let problem = null;
  if (!input.ref && slice?.branch) {
    if ((await branches({ cwd })).includes(slice.branch)) ref = slice.branch;
    else {
      problem =
        `slice #${slice.index} has no branch ${slice.branch} yet, so there is nothing to check it against — ` +
        `\`pdkit slice materialize --issue ${input.issue} --slice ${slice.index}\` comes first`;
    }
  }

  const record = await state.read(input.issue, { home });
  const changed = problem ? [] : await changedPaths(base, ref, { cwd });

  // An empty diff under a slice is not a clean run, it is a missing one. Every
  // file check passes trivially on nothing, so the report comes out green and
  // the gate opens on a branch with no change on it. Reached in practice: a
  // materialize whose commit the repository's pre-commit hook refused left the
  // branch created and empty, and preflight blessed it.
  if (!problem && slice && changed.length === 0) {
    problem =
      `nothing lies between ${base} and ${ref}, so slice #${slice.index} has no change to check. ` +
      'Every check would pass on an empty diff, which is not the same as passing';
  }

  let packageMap = { packages: {}, layers: [] };
  try {
    packageMap = await readPackageMap({ home });
  } catch {
    // No map yet. Checks that need it say so rather than guessing a layout.
  }

  return {
    issue: input.issue,
    slice: slice?.index ?? input.slice,
    sliceGraph: graph,
    sliceRecord: slice,
    route: record.route ?? 'standard',
    repoRoot: input.repoRoot,
    base,
    baseInfo: resolvedBase,
    ref,
    // The commit the checks actually looked at, resolved rather than the name
    // `HEAD`. What the record needs is something that changes when the diff
    // changes: `HEAD` is the same five letters before and after an amend, and a
    // green run identified by it would still look current afterwards.
    headSha: await revision(ref, { cwd }),
    branch,
    changed,
    changedFiles: changed.map((entry) => entry.path),
    commits: problem ? [] : await commits(base, ref, { cwd }),
    scripts: await scripts(input.repoRoot),
    packageMap,
    prBody: input.prBody ?? null,
    config,
    home,
    // Set when the run cannot honestly happen at all. Not a failed check: a
    // check that failed looked at something.
    problem,
  };
}

/**
 * Run preflight and produce a report.
 *
 * Runs every check even after one fails: a report listing three problems is one
 * round trip, three reports of one problem each are three.
 *
 * @param {PreflightContext} context
 * @param {Check[]} [checks]   defaults to every declared check; injectable so
 *                             the runner's own error handling can be tested
 * @returns {Promise<{ok: boolean, results: CheckResult[], base: PreflightContext['baseInfo']}>}
 */
export async function run(context, checks = null) {
  const results = [];

  for (const check of checks ?? (await loadChecks())) {
    try {
      const result = await check.run(context);
      results.push({ blocking: check.blocking, ...result, id: check.id });
    } catch (error) {
      // A check that cannot run has not passed. Reporting it as anything other
      // than a failure would make preflight green on the strength of a bug.
      results.push({
        id: check.id,
        status: check.blocking ? 'fail' : 'warn',
        blocking: check.blocking,
        summary: `the check itself failed: ${error.message}`,
      });
    }
  }

  return {
    ok: !results.some((result) => result.blocking && result.status === 'fail'),
    results,
    // What every file check was a diff FROM. Reported rather than assumed: a
    // report that does not say which base it read is a report that cannot be
    // caught reading the wrong one.
    base: context.baseInfo ?? null,
  };
}

/**
 * Render a report for a terminal.
 *
 * @param {{ok: boolean, results: CheckResult[], base?: object|null}} report
 * @returns {string}
 */
export function format(report) {
  const MARK = { pass: '✔', warn: '!', fail: '✘', skip: '·' };
  const lines = [`preflight: ${report.ok ? 'green' : 'RED'}`];

  if (report.base) {
    const age = report.base.at ? `, ${String(report.base.at).slice(0, 10)}` : '';
    lines.push(`  base ${report.base.ref}${report.base.sha ? ` @ ${report.base.sha}` : ''}${age}`);
    if (report.base.localBehind) {
      // Not a failure — the diff was taken against the remote-tracking ref, so
      // it is right either way. It is the next branch cut from the local copy
      // that would be wrong.
      lines.push(`  note: the local ${report.base.ref.split('/').pop()} is ${report.base.localBehind} commit(s) behind; fast-forward it before cutting the next branch`);
    }
  }

  lines.push('');

  for (const result of report.results) {
    lines.push(`  ${MARK[result.status] ?? '?'} ${result.id.padEnd(22)} ${result.summary}`);
    if (result.remedy) lines.push(`      → ${result.remedy}`);
  }

  const failed = report.results.filter((result) => result.status === 'fail');
  if (failed.length > 0) {
    lines.push('', `${failed.length} blocking failure${failed.length === 1 ? '' : 's'}. Nothing is pushed until these are green.`);
  }

  return `${lines.join('\n')}\n`;
}
