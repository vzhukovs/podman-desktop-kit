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

// Slicing one change set into N atomic pull requests (spec section 4) — the
// graph model: everything about a slice graph that neither reads nor writes
// the file it is stored in. Topology (merge order, chains, dependents), the
// diff a slice is and its digest, and the refs a slice is built on.
//
// Storing the graph stays with lib/slice.js, its one writer. This file is a
// leaf of the package: every module under lib/slice/ may import it directly.

import { digest } from '../evidence.js';
import * as git from '../git.js';
import { resolveBase } from '../repo.js';

/** @typedef {import('../slice.js').Graph} Graph */
/** @typedef {import('../slice.js').Slice} Slice */

/**
 * How much a git call here that reads output may print. A diff is not a status
 * line: the cap has to hold a real change set, binary hunks included.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

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
export async function sourceBaseOf(graph, options) {
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

/**
 * The slice, if its branch has been cut — the thing that decides whether a
 * verification should read the branch or the change set.
 *
 * @param {Graph} graph
 * @param {number} index
 * @param {string} repoRoot
 * @returns {Promise<Slice|null>} null when the slice has no branch yet
 */
export async function branchOf(graph, index, repoRoot) {
  const target = graph.slices.find((entry) => entry.index === index);
  if (!target?.branch) return null;

  const exists = await git.succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}`], { cwd: repoRoot });
  return exists ? target : null;
}
