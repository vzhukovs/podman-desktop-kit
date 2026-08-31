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

// What upstream did while we were away (spec section 4, /pd:resume).
//
// Facts, like lib/audit.js and lib/threads.js. The question this module does
// not answer is the one that matters: mechanical conflict or semantic. What it
// does is put the evidence in front of whoever answers it — which commits
// landed since the branch point, which of our files they touched, and whether
// any of them touched a line the plan quoted.
//
// The last part is the whole point. A commit that touched a file is a candidate
// for a mechanical conflict; a commit that touched the lines the plan built on
// is a candidate for a semantic one, and semantic means stop. It is a hint and
// not a verdict: pd-conflict-analyst still has to read the commits, and a
// dangerous semantic conflict is precisely the kind that merges cleanly.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { get, issueDir, resolveHome } from './config.js';
import { branchPoint, branches as listBranches, changedFiles, drift as driftCommits, touchedRanges } from './repo.js';
import { branchOfSlice, read as readPullRequests } from './pr.js';
import { baseRefOf, read as readGraph } from './slice.js';

/**
 * A `path/to/file.ext:123` reference, as the plan template asks every context
 * bullet to carry.
 *
 * Deliberately requires an extension and a line number: `section 4:` and
 * `note 2:` appear in prose constantly, and a citation map full of those would
 * make every commit look semantic.
 */
const CITATION = /\b((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w]*):(\d+)\b/g;

/**
 * Every file:line the plan and its tasks point at.
 *
 * @param {string} home
 * @param {number} issue
 * @returns {Promise<Map<string, Set<number>>>}
 */
export async function citations(home, issue) {
  /** @type {Map<string, Set<number>>} */
  const found = new Map();

  const dir = issueDir(home, issue);
  const files = [join(dir, 'plan.md')];

  try {
    for (const name of await readdir(join(dir, 'tasks'))) {
      if (name.endsWith('.md')) files.push(join(dir, 'tasks', name));
    }
  } catch {
    // An issue on the quickfix route has no tasks, and no plan either. Drift is
    // still worth reporting for it — just without the semantic hint.
  }

  for (const file of files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }

    for (const [, path, line] of text.matchAll(CITATION)) {
      if (!found.has(path)) found.set(path, new Set());
      found.get(path).add(Number.parseInt(line, 10));
    }
  }

  return found;
}

/**
 * @typedef {object} Commit
 * @property {string} sha
 * @property {string} subject
 * @property {string} author
 * @property {string} at
 * @property {string[]} files           only ours
 * @property {Array<{path: string, lines: number[]}>} citedLinesTouched
 */

/**
 * @typedef {object} Report
 * @property {number} issue
 * @property {string} upstream          the ref that moved
 * @property {Array<{slice: number|null, branch: string|null, base: string, branchPoint: string|null, files: string[], commits: Commit[]}>} units
 * @property {Commit[]} semantic        commits that touched a cited line
 * @property {number} total
 */

/**
 * What landed upstream under each slice since it branched.
 *
 * One unit per slice, or a single unit for an issue with no graph. Each unit
 * measures from its own branch point, because a stacked slice branched from its
 * predecessor and not from the base branch.
 *
 * @param {{issue: number, repoRoot: string, upstream?: string, home?: string, config?: object, files?: string[], ref?: string}} input
 * @returns {Promise<Report>}
 */
async function branchFor(input, home) {
  // In order of authority: a pull request already registered against the issue
  // knows its own branch; otherwise a local branch named for the issue. Both
  // are facts rather than guesses, and when neither exists the answer is null —
  // which the report then says out loud instead of measuring an empty set.
  const book = await readPullRequests(input.issue, { home });
  const registered = (book?.prs ?? []).find((record) => record.branch);
  if (registered) return registered.branch;

  const listed = await listBranches({ cwd: input.repoRoot });
  return listed.find((name) => name.startsWith(`DESKTOP-${input.issue}/`)) ?? null;
}

export async function collect(input) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? {};

  const baseBranch = String(get(config, 'repo.base_branch') ?? 'main');
  const remote = String(get(config, 'repo.upstream_remote') ?? 'upstream');
  const upstream = input.upstream ?? `${remote}/${baseBranch}`;

  const graph = await readGraph(input.issue, { home });
  const cited = await citations(home, input.issue);

  // Without a slice graph the branch has to come from somewhere, and until 0.12
  // it came from nowhere: the command passed neither a ref nor a file list, so
  // every issue without slices measured an empty set and reported "not cut yet"
  // about a branch that existed. Found on #17577, two months stale — the real
  // answer was 21 upstream commits, one of them in the two files the fix is
  // about.
  const branch = graph ? null : (input.ref ?? (await branchFor(input, home)));
  const files = graph
    ? null
    : input.files?.length
      ? input.files
      : branch
        ? await changedFiles(await branchPoint(branch, baseBranch, { cwd: input.repoRoot }), branch, { cwd: input.repoRoot })
        : [];

  // The same order of authority `branchFor` applies without a graph, applied
  // per slice with one: the branch of the pull request registered for it beats
  // the name the graph computed, because one is a write that happened and the
  // other is a string. Reported, never silent.
  const book = graph ? await readPullRequests(input.issue, { home }) : null;

  const units = graph
    ? graph.slices.map((slice) => {
        const resolved = branchOfSlice(book, slice);
        return {
          slice: slice.index,
          branch: resolved.branch,
          namedInGraph: resolved.fromPullRequest === null ? null : slice.branch,
          fromPullRequest: resolved.fromPullRequest,
          base: baseRefOf(graph, slice, graph.source.base),
          files: slice.files,
        };
      })
    : [
        {
          slice: null,
          branch,
          base: baseBranch,
          files,
        },
      ];

  const report = [];
  const semantic = [];

  for (const unit of units) {
    // Without a branch there is nothing to measure from; a slice that was never
    // materialised has not drifted, it has not been cut.
    const from = unit.branch ? await branchPoint(unit.branch, unit.base, { cwd: input.repoRoot }) : null;

    const commits = from
      ? await driftCommits({ from, to: upstream, files: unit.files, cwd: input.repoRoot })
      : [];

    const detailed = [];
    for (const commit of commits) {
      const hits = [];

      for (const path of commit.files) {
        const lines = cited.get(path);
        if (!lines || lines.size === 0) continue;

        const ranges = await touchedRanges(commit.sha, path, { cwd: input.repoRoot });
        const touched = [...lines].filter((line) => ranges.some(([start, end]) => line >= start && line <= end)).sort((a, b) => a - b);
        if (touched.length > 0) hits.push({ path, lines: touched });
      }

      const entry = { ...commit, citedLinesTouched: hits };
      detailed.push(entry);
      if (hits.length > 0) semantic.push(entry);
    }

    report.push({ ...unit, branchPoint: from, commits: detailed });
  }

  return {
    // Whether anything was cited at all. "No commit touches a cited line" over
    // an issue with no plan is a sentence about nothing, and it reads as
    // reassurance.
    citedAny: cited.size > 0,
    issue: input.issue,
    upstream,
    units: report,
    semantic,
    total: report.reduce((count, unit) => count + unit.commits.length, 0),
  };
}

/**
 * @param {Report} report
 * @returns {string}
 */
export function format(report) {
  const lines = [`drift for DESKTOP-${report.issue} against ${report.upstream}`, ''];

  for (const unit of report.units) {
    const name = unit.slice === null ? 'work' : `slice #${unit.slice}`;
    lines.push(`  ${name} (${unit.branch ?? 'no branch yet'}, from ${unit.base})`);

    // Said out loud. A measurement taken from a branch other than the one the
    // graph names is still the right measurement, and the reader is entitled to
    // know it was not the name they would have expected.
    if (unit.namedInGraph) {
      lines.push(`      measured from the branch of #${unit.fromPullRequest}; the graph names ${unit.namedInGraph}, which is not what was published`);
    }

    if (!unit.branchPoint) {
      lines.push(
        unit.branch
          ? `      ${unit.branch} does not resolve here — fetch it, or name another with --ref`
          : '      no branch found for this issue: none is registered against it and none is named DESKTOP-<n>/… here',
      );
      lines.push('      nothing was measured, so nothing below is a statement about this work');
      continue;
    }
    if (unit.commits.length === 0) {
      lines.push('      no upstream commits touch its files');
      continue;
    }

    for (const commit of unit.commits) {
      lines.push(`      ${commit.sha.slice(0, 9)}  ${commit.subject}`);
      lines.push(`          ${commit.files.join(', ')}`);
      for (const hit of commit.citedLinesTouched) {
        // Named rather than counted: "touched a cited line" is the sentence
        // that decides whether the flow stops, and it should be checkable.
        lines.push(`          ⚠ touches ${hit.path}:${hit.lines.join(',')} — the plan builds on these lines`);
      }
    }
  }

  const measured = report.units.some((unit) => unit.branchPoint);

  lines.push(
    '',
    !measured
      ? '  Nothing was measured. This is not a clean bill of health — it is the absence of one.'
      : report.semantic.length > 0
        ? `  ${report.semantic.length} commit(s) touch lines the plan cites. Read them before rebasing: a semantic conflict that merges cleanly is the dangerous one.`
        : report.citedAny
          ? '  no upstream commit touches a line the plan cites — which makes a conflict likelier to be mechanical, not certain to be.'
          : // Saying "nothing touches a cited line" when nothing is cited is a
            // sentence about nothing, and it reads as reassurance.
            '  this issue cites no lines — there is no plan to measure against, so the list above is all there is.',
  );

  return `${lines.join('\n')}\n`;
}
