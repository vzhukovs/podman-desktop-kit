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

// Slicing one change set into N atomic pull requests (spec section 4).
//
// Two different graphs, and conflating them is the classic mistake:
//
//   file independence     slices do not share files. Checked mechanically.
//   symbol dependence     slice B references a symbol introduced by slice A.
//                         Invisible at the file level.
//
// Only one of these settles the question, and it is not an opinion:
// verifySlice() builds the slice alone, from main, in a scratch worktree.
// Green means the slice branches from main. Red means it needs a stack.
//
// A slice is a BASE PLUS A SET OF FILES, not a set of commits. Verification is
// step one of the /pd:pr flow — before branches exist, before the squash — so
// the commits of a slice are not available to apply. The diff restricted to its
// files is, and it is also what materializing the slice applies back, and what
// `--from-pr` will substitute for a published diff.
//
// INVARIANT (section 2.2, third one): this module is the only writer of
// slices.json, and the verification result is produced here from a run rather
// than accepted from a caller. There is no parameter for "standalone: true" —
// the same argument that made receipts evidence rather than claims.

import { constants as FS } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { issueDir, resolveHome } from './config.js';
import { digest } from './evidence.js';
import * as git from './git.js';
import { append as appendJournal } from './journal.js';
import { branches, resolveBase } from './repo.js';
import * as drafting from './slice/draft.js';
import * as formatting from './slice/format.js';
import * as materializing from './slice/materialize.js';
import { branchOf } from './slice/materialize.js';
import * as verifying from './slice/verify.js';
import { JOIN_ELIGIBLE, MATERIALIZE_ELIGIBLE } from './state.js';

export { JOIN_ELIGIBLE, MATERIALIZE_ELIGIBLE };

/**
 * How much a git call here that reads output may print. A diff is not a status
 * line: the cap has to hold a real change set, binary hunks included.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The result of building one slice on its own — produced by a run, never
 * accepted from a caller (invariant 3).
 *
 * `standalone` and `ok` answer different questions and both matter: green from
 * the base branch means the slice can be reviewed alone, green only when
 * stacked means it needs the slice below it. `diffDigest` is what makes the
 * verdict expire — the same slice with different contents was never verified.
 * `baselineOk` guards the other direction: red against a base that is also red
 * says nothing about this slice.
 *
 * @typedef {object} Verification
 * @property {boolean} ok               the run came back green
 * @property {boolean} standalone       it was built from the base branch alone
 * @property {string} diffDigest        sha256 of the diff that was verified
 * @property {string|null} base         the ref the slice branches from: the base branch, or the branch below it
 * @property {string|null} baseCommit   what that ref was when the build ran, so the claim can be checked afterwards
 * @property {string|null} baseSha      the commit the tree was prepared at
 * @property {string} verifiedAt
 * @property {string} command
 * @property {number|null} exitCode
 * @property {string} evidence          path under the issue, e.g. verify/S1.md
 * @property {boolean|null} revertsCleanly
 * @property {boolean|null} baselineOk   whether the base passes the same command; null when green or unmeasured
 */

/**
 * One pull request's worth of the change set: a base plus a set of files.
 *
 * Not a set of commits, and the distinction is load-bearing — verification runs
 * before any branch exists, so the only thing there is to build with is the diff
 * restricted to these files. `whySeparate` and `selfJustifying` are the
 * slicer's argument for the cut, kept because a reviewer asked to take one PR
 * of four is entitled to it.
 *
 * @typedef {object} Slice
 * @property {number} index
 * @property {string} slug
 * @property {string} branch
 * @property {string} title
 * @property {number|null} baseSlice    null when it branches from the base branch
 * @property {string[]} files
 * @property {string[]} layers
 * @property {string[]} requirements    R-IDs, empty on the quickfix route
 * @property {string} whySeparate
 * @property {string} selfJustifying
 * @property {Verification|null} verification
 * @property {number|null} pr           the pull request opened from this slice
 * @property {Array<{subject: string, files: string[]}>|null} [commits]  the commits it is published as, in order; null for one
 * @property {CommitCheck[]} [commitChecks]  what each commit's prefix built to, for the reviewer; never a gate
 * @property {number[]} [supersedes]    pull requests this slice replaces, when it was made by joining slices
 */

/**
 * One prefix of a multi-commit slice, built: commits 1..k on the slice's base.
 *
 * Information, not a gate. Upstream asked for one pull request with a commit
 * per layer, and has not said whether each commit has to build on its own
 * (podman-desktop#19798, question 2). The slice as a whole is what preflight
 * holds to green; this says which intermediate commits are not, so a person
 * can decide whether that matters before a reviewer bisects into one.
 *
 * @typedef {object} CommitCheck
 * @property {number} commit        1-based: the prefix ends at this commit
 * @property {string} subject
 * @property {boolean} ok
 * @property {number|null} exitCode
 * @property {string} evidence      verify/S<i>-c<k>.md
 * @property {string} diffDigest
 * @property {string} verifiedAt
 */

/**
 * The whole cut: every slice, and the commit it was cut from.
 *
 * `source.ref` is a resolved commit rather than a symbolic name on purpose. A
 * graph that recorded `HEAD` would describe a different change set the moment
 * anything was committed, and every verification under it would still look
 * current.
 *
 * @typedef {object} Graph
 * @property {number} issue
 * @property {string} strategy
 * @property {string} updatedAt
 * @property {{base: string, ref: string, refName?: string, branch?: string|null, repo: string|null}} source  ref is a commit, never a symbolic name
 * @property {{count: number|null, deviation: string|null}|null} [hypothesis]  what the plan said, and why the cut differs
 * @property {Slice[]} slices
 */

/** @typedef {{check: string, detail: string}} Problem */

/** Where the graph lives. */
function graphPath(home, issue) {
  return join(issueDir(home, issue), 'slices.json');
}

/**
 * Read the slice graph for an issue, or null when there is none.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<Graph|null>}
 */
export async function read(issue, options = {}) {
  try {
    return JSON.parse(await readFile(graphPath(options.home ?? resolveHome(), issue), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`slices.json for issue ${issue} is not readable JSON`, { cause: error });
  }
}

/**
 * Persist the graph. Private: every caller goes through a named operation, so
 * the set of things that can happen to a graph is the set of functions here.
 *
 * @param {Graph} graph
 * @param {{home?: string}} options
 * @returns {Promise<Graph>}
 */
async function save(graph, options) {
  const file = graphPath(options.home ?? resolveHome(), graph.issue);
  const next = { ...graph, updatedAt: new Date().toISOString() };

  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, file);

  return next;
}

/**
 * The diff a slice is, in the one form everything uses.
 *
 * Every flag here is load-bearing:
 *
 *   --binary        an icon or a snapshot in the slice must survive `git apply`
 *   --no-renames    a rename names two paths; keeping one would carry the new
 *                   file and leave the old one behind (see repo.changedPaths)
 *   base...ref      what the branch added, not what the base gained meanwhile
 *
 * They are here rather than at each call site because the digest of this output
 * is what preflight compares against — two callers with different flags would
 * produce a mismatch that reads as a stale verification.
 *
 * @param {{repoRoot: string, base: string, ref?: string, files: string[], git?: (args: string[], cwd: string) => Promise<string>}} input
 * @returns {Promise<string>}
 */
export async function sliceDiff(input) {
  if (input.files.length === 0) return '';

  const run = input.git ?? ((args, cwd) => git.text(args, { cwd, maxBuffer: MAX_BUFFER }));
  return run(
    ['diff', '--binary', '--no-renames', `${input.base}...${input.ref ?? 'HEAD'}`, '--', ...input.files],
    input.repoRoot,
  );
}

/**
 * Digest of a slice diff, in the form receipts already use.
 *
 * @param {string} diff
 * @returns {string}
 */
export function digestOf(diff) {
  return digest(diff);
}

/**
 * Merge order: every slice after the one it is based on, ties by index.
 *
 * @param {Array<{index: number, baseSlice: number|null}>} slices
 * @returns {{order: number[], cycle: number[]}} cycle is empty when the graph is a forest
 */
export function mergeOrder(slices) {
  const remaining = new Map(slices.map((slice) => [slice.index, slice]));
  const order = [];

  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const [index, slice] of [...remaining].sort((left, right) => left[0] - right[0])) {
      if (slice.baseSlice !== null && remaining.has(slice.baseSlice)) continue;
      order.push(index);
      remaining.delete(index);
      progressed = true;
    }
  }

  return { order, cycle: [...remaining.keys()].sort((left, right) => left - right) };
}

/**
 * The base ref a slice branches from.
 *
 * @param {Graph} graph
 * @param {Slice} slice
 * @param {string} baseBranch
 * @returns {string}
 */
export function baseRefOf(graph, slice, baseBranch) {
  if (slice.baseSlice === null) return baseBranch;

  const parent = graph.slices.find((entry) => entry.index === slice.baseSlice);
  if (!parent) throw new Error(`slice ${slice.index} is based on #${slice.baseSlice}, which is not in the graph`);
  return parent.branch;
}

/**
 * The ref a slice is diffed against and built on: `baseRefOf`, resolved.
 *
 * A stacked slice bases on a local branch, and that is correct — it is ours
 * and exists nowhere else. The base branch is the other case, and here the
 * local copy is the wrong ref, for the reason repo.resolveBase gives. Until
 * this went through the same resolver as preflight, verify took its digest
 * against a local `main` 43 commits behind while preflight took its own
 * against `upstream/main`, so a branch rebased onto upstream read as a stale
 * verification that re-verifying could never refresh. Found on DESKTOP-18833.
 *
 * @param {Graph} graph
 * @param {Slice} slice
 * @param {{repoRoot: string, config?: object}} options
 * @returns {Promise<string>}
 */
export async function resolvedBaseOf(graph, slice, options) {
  if (slice.baseSlice !== null) return baseRefOf(graph, slice, graph.source.base);
  return sourceBaseOf(graph, options);
}

/**
 * The graph's base branch, resolved the way preflight resolves it.
 *
 * @param {Graph} graph
 * @param {{repoRoot: string, config?: object}} options
 * @returns {Promise<string>}
 */
async function sourceBaseOf(graph, options) {
  return (await resolveBase({ cwd: options.repoRoot, base: graph.source.base, config: options.config })).ref;
}

/**
 * Slices that have to be applied before this one, base first.
 *
 * @param {Graph} graph
 * @param {number} index
 * @returns {Slice[]}
 */
export function chainTo(graph, index) {
  const byIndex = new Map(graph.slices.map((slice) => [slice.index, slice]));
  const chain = [];

  let current = byIndex.get(index);
  const seen = new Set();
  while (current) {
    if (seen.has(current.index)) throw new Error(`slice ${index} sits in a cycle`);
    seen.add(current.index);
    chain.unshift(current);
    current = current.baseSlice === null ? undefined : byIndex.get(current.baseSlice);
  }

  return chain;
}

/** @typedef {import('./slice/draft.js').Facts} Facts */

/**
 * Record which pull request a slice was opened as.
 *
 * The back-reference to lib/pr.js, and it goes in this direction on purpose:
 * prs.json has one writer and slices.json has another, so pr.js asks for this
 * rather than editing the graph itself. Two writers on one file is the thing
 * section 2.2 exists to prevent.
 *
 * @param {{issue: number, index: number, pr: number|null, home?: string}} input
 * @returns {Promise<Graph>}
 */
export async function setPullRequest(input) {
  const graph = await read(input.issue, input);
  if (!graph) throw new Error(`issue ${input.issue} has no slice graph`);

  const target = graph.slices.find((slice) => slice.index === input.index);
  if (!target) throw new Error(`issue ${input.issue} has no slice #${input.index}`);

  return save(
    { ...graph, slices: graph.slices.map((slice) => (slice.index === input.index ? { ...slice, pr: input.pr } : slice)) },
    input,
  );
}

/**
 * Validate a proposal and store it.
 *
 * @param {{issue: number, proposal: object, facts: Facts, config?: object, home?: string}} input
 * @returns {Promise<{ok: boolean, graph: Graph|null, problems: Problem[], warnings: Problem[]}>}
 */
export async function set(input) {
  const home = input.home ?? resolveHome();
  const previous = await read(input.issue, { home });

  const built = build({ ...input, previous });
  if (!built.ok || !built.graph) return built;

  const saved = await save(built.graph, { home });
  const { order } = mergeOrder(saved.slices);

  await appendJournal(
    {
      issue: input.issue,
      event: 'slices-set',
      detail: `${saved.slices.length} slice(s), merge order ${order.map((index) => `#${index}`).join(' → ')}`,
    },
    { home },
  );

  return { ...built, graph: saved };
}

/**
 * Slices stacked on a slice, directly or through others.
 *
 * @param {Graph} graph
 * @param {number} index
 * @returns {number[]}
 */
export function dependentsOf(graph, index) {
  const found = new Set();

  let grew = true;
  while (grew) {
    grew = false;
    for (const slice of graph.slices) {
      if (slice.baseSlice === null || found.has(slice.index)) continue;
      if (slice.baseSlice === index || found.has(slice.baseSlice)) {
        found.add(slice.index);
        grew = true;
      }
    }
  }

  return [...found].sort((left, right) => left - right);
}

// Rendering lives in lib/slice/format.js. It needs mergeOrder() and cannot
// import it from here without a cycle, so the names callers know are kept and
// hand it over.
export const renderValues = (graph, given) => formatting.renderValues(graph, given, { mergeOrder });
export const mergeOrderText = (graph) => formatting.mergeOrderText(graph, { mergeOrder });
export { hypothesisText } from './slice/format.js';
export const format = (graph) => formatting.format(graph, { mergeOrder });

// Drafting lives in lib/slice/draft.js. build() needs mergeOrder() and
// chainTo() and cannot import them from here without a cycle, so the names
// callers know are kept and hand them over.
export { facts, draft } from './slice/draft.js';
export const build = (input) => drafting.build(input, { mergeOrder, chainTo });

// Verification lives in lib/slice/verify.js. It reads and stores the graph and
// works on the graph model, and cannot import either from here without a
// cycle, so the names callers know are kept and hand them over — save()
// included, which is how slices.json keeps this file as its one writer.
const graphs = { read, save, mergeOrder, chainTo, sliceDiff, digestOf, sourceBaseOf, resolvedBaseOf, branchOf };
export { verdict, explainInconclusive, independenceProblems, refusalAdvice, verifyCommand, VERIFY_TIMEOUT_MS } from './slice/verify.js';
export const verifySlice = (input) => verifying.verifySlice(input, graphs);
export const verifyAll = (input) => verifying.verifyAll(input, graphs);
export const verifyCommits = (input) => verifying.verifyCommits(input, graphs);
export const verifyBranch = (input) => verifying.verifyBranch(input, graphs);
export const checkFreshness = (input) => verifying.checkFreshness(input, graphs);

// Materializing, cascading and joining live in lib/slice/materialize.js. They
// read and store the graph, build proposals and verify branches, and cannot
// import any of that from here without a cycle, so the names callers know are
// kept and hand it over — save() included, as for verification.
const cutting = { read, save, mergeOrder, dependentsOf, sliceDiff, digestOf, sourceBaseOf, resolvedBaseOf, build, verifyBranch };
export const joinSlices = (input) => materializing.joinSlices(input, cutting);
export const materialize = (input) => materializing.materialize(input, cutting);
export const cascade = (input) => materializing.cascade(input, cutting);
