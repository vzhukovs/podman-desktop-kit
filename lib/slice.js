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

import { execFile, spawn } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { parseTask } from './artefacts.js';
import { get, issueDir, load, resolveHome } from './config.js';
import { capture, digest, writeReceipt } from './evidence.js';
import { matchesAny } from './globs.js';
import { append as appendJournal } from './journal.js';
import { branchName, slugify } from './ids.js';
import { runScript, scopedScripts } from './preflight/scope.js';
import { changedPaths, packageFor, pickScript, readPackageMap, scripts } from './repo.js';
import { read as readState } from './state.js';
import { validateCommit } from './upstream.js';
import { prepare, verifyName } from './worktree.js';

/**
 * @typedef {object} Verification
 * @property {boolean} ok               the run came back green
 * @property {boolean} standalone       it was built from the base branch alone
 * @property {string} diffDigest        sha256 of the diff that was verified
 * @property {string|null} baseSha
 * @property {string} verifiedAt
 * @property {string} command
 * @property {number|null} exitCode
 * @property {string} evidence          path under the issue, e.g. verify/S1.md
 * @property {boolean|null} revertsCleanly
 * @property {boolean|null} baselineOk   whether the base passes the same command; null when green or unmeasured
 */

/**
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
 */

/**
 * @typedef {object} Graph
 * @property {number} issue
 * @property {string} strategy
 * @property {string} updatedAt
 * @property {{base: string, ref: string, refName?: string, repo: string|null}} source  ref is a commit, never a symbolic name
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

  const run = input.git ?? gitText;
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
 * @typedef {object} Facts
 * @property {Array<{status: string, path: string}>} changed
 * @property {object} packageMap
 * @property {Array<{path: string, package: string|null, layer: string, tasks: string[], requirements: string[]}>} files
 * @property {string[]} requirements  the frozen set
 * @property {string} route
 * @property {string} base
 * @property {string} ref
 * @property {number} issue
 * @property {string[]} layerOrder
 */

/**
 * Everything mechanical about the change set, before anyone decides anything.
 *
 * This is the slicer's equivalent of `pdkit audit`: facts, no verdict. The
 * agent gets a file list already mapped to packages, layers, tasks and R-IDs,
 * rather than re-deriving the mapping by reading the diff — which is the kind
 * of set arithmetic section 4 keeps out of the model on purpose.
 *
 * @param {{issue: number, repoRoot: string, base?: string, ref?: string, home?: string, config?: object, packageMap?: object}} input
 * @returns {Promise<Facts>}
 */
export async function facts(input) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? (await load({ repoRoot: input.repoRoot, home }));
  const base = input.base ?? String(get(config, 'repo.base_branch') ?? 'main');
  const ref = input.ref ?? 'HEAD';

  const record = await readState(input.issue, { home });
  const map = input.packageMap ?? { packages: {}, layers: [] };
  const tasks = await tasksOf(home, input.issue);

  // Resolved to a commit, and this is not tidiness. `HEAD` is whatever is
  // checked out, and materializing checks out a slice branch — so a graph
  // holding the word HEAD starts describing a different change set halfway
  // through the flow it exists to drive. The first stacked slice built from
  // such a graph came out empty, silently, because its diff was taken against
  // a branch that did not contain it.
  const sha = (await gitText(['rev-parse', ref], input.repoRoot)).trim();

  // Rename detection off: see sliceDiff. The file list and the diff have to
  // agree about how many paths a rename is.
  const changed = await changedPaths(base, ref, { cwd: input.repoRoot, renames: false });

  const files = [];
  for (const entry of changed) {
    const owner = await packageFor(entry.path, { map });
    const owning = tasks.filter((task) => matchesAny(entry.path, task.owns));

    files.push({
      path: entry.path,
      status: entry.status,
      package: owner?.name ?? null,
      layer: owner?.layer ?? 'other',
      tasks: owning.map((task) => task.id),
      requirements: [...new Set(owning.flatMap((task) => task.satisfies))],
    });
  }

  return {
    issue: input.issue,
    base,
    ref: sha === '' ? ref : sha,
    refName: ref,
    changed,
    packageMap: map,
    files,
    requirements: record.requirements.ids,
    route: record.route ?? 'standard',
    layerOrder: /** @type {string[]} */ (get(config, 'slicing.layer_order') ?? []),
  };
}

/**
 * Task files of an issue, for the file -> task -> R-ID mapping.
 *
 * @param {string} home
 * @param {number} issue
 * @returns {Promise<Array<import('./artefacts.js').Task>>}
 */
async function tasksOf(home, issue) {
  const directory = join(issueDir(home, issue), 'tasks');

  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const tasks = [];
  for (const name of entries.filter((entry) => /^T\d+\.md$/.test(entry))) {
    tasks.push(parseTask(await readFile(join(directory, name), 'utf8')));
  }
  return tasks;
}

/**
 * A draft grouping, by layer, for the slicer to argue with.
 *
 * Grouping files by layer is arithmetic, and layer is what decides the reviewer
 * (section 4), so this is the shape a first cut takes. It is explicitly a
 * draft: whether a slice justifies itself without the next one is the question
 * the model is for, and no amount of grouping answers it.
 *
 * @param {Facts} collected
 * @returns {{strategy: string, slices: Array<{slug: string, title: string, baseSlice: null, files: string[]}>}}
 */
export function draft(collected) {
  const order = [...collected.layerOrder, 'other'];
  const byLayer = new Map();

  for (const file of collected.files) {
    if (!byLayer.has(file.layer)) byLayer.set(file.layer, []);
    byLayer.get(file.layer).push(file.path);
  }

  const slices = [...byLayer.entries()]
    .sort((left, right) => {
      const rank = (layer) => (order.indexOf(layer) === -1 ? order.length : order.indexOf(layer));
      return rank(left[0]) - rank(right[0]);
    })
    .map(([layer, files]) => ({
      slug: slugify(`${layer}-changes`),
      title: `${layer}: <what this slice does>`,
      baseSlice: null,
      files: files.sort(),
    }));

  return { strategy: 'prefer-independent', slices };
}

/**
 * Whether pull requests leave from a fork rather than from the repository they
 * open against.
 *
 * The one fact that decides whether a stack can be published at all: the base
 * of a pull request is a branch of the target repository, and a slice branch
 * that lives only in a fork can never be one. Unknown fork, or the two the
 * same, means no claim is made.
 *
 * @param {object} config
 * @returns {boolean}
 */
function forkIsSeparate(config) {
  const fork = get(config, 'repo.fork');
  const upstream = get(config, 'repo.upstream');
  return typeof fork === 'string' && fork !== '' && typeof upstream === 'string' && upstream !== '' && fork !== upstream;
}

/**
 * Turn a proposal into a graph, refusing the shapes that cannot work.
 *
 * Nothing here is judgement. Every rule is a property of the file list, the
 * package map or the plan, which is why they are checked in code: an Opus asked
 * to intersect two lists of paths is an Opus that can fail to.
 *
 * @param {{issue: number, proposal: object, facts: Facts, config?: object, previous?: Graph|null}} input
 * @returns {{ok: boolean, graph: Graph|null, problems: Problem[], warnings: Problem[]}}
 */
export function build(input) {
  /** @type {Problem[]} */
  const problems = [];
  /** @type {Problem[]} */
  const warnings = [];

  const proposed = Array.isArray(input.proposal?.slices) ? input.proposal.slices : [];
  if (proposed.length === 0) {
    return { ok: false, graph: null, problems: [{ check: 'slices', detail: 'the proposal has no slices' }], warnings };
  }

  const layerOf = new Map(input.facts.files.map((file) => [file.path, file.layer]));
  const requirementsOf = new Map(input.facts.files.map((file) => [file.path, file.requirements]));
  const changed = new Set(input.facts.files.map((file) => file.path));

  /** @type {Slice[]} */
  const slices = [];
  const seenFiles = new Map();
  const seenSlugs = new Set();

  for (const [position, entry] of proposed.entries()) {
    const index = position + 1;
    const files = [...new Set(Array.isArray(entry.files) ? entry.files.map(String) : [])];

    if (files.length === 0) {
      problems.push({ check: 'files', detail: `slice #${index} has no files` });
    }

    for (const file of files) {
      if (seenFiles.has(file)) {
        problems.push({
          check: 'exclusive-files',
          detail: `${file} is in slice #${seenFiles.get(file)} and #${index} — slices that share a file cannot be reviewed, merged or reverted apart`,
        });
      } else {
        seenFiles.set(file, index);
      }
      if (!changed.has(file)) {
        problems.push({ check: 'files', detail: `slice #${index} claims ${file}, which is not in the diff ${input.facts.base}...${input.facts.ref}` });
      }
    }

    const slug = slugify(entry.slug ?? entry.title ?? `slice-${index}`);
    if (slug === '') problems.push({ check: 'slug', detail: `slice #${index} has no usable slug` });
    if (seenSlugs.has(slug)) problems.push({ check: 'slug', detail: `two slices are called "${slug}"` });
    seenSlugs.add(slug);

    let branch = '';
    try {
      branch = slug === '' ? '' : branchName({ issue: input.issue, index, slug, config: input.config ?? {} });
    } catch (error) {
      problems.push({ check: 'branch', detail: `slice #${index}: ${error.message}` });
    }

    const baseSlice = entry.baseSlice === undefined || entry.baseSlice === null ? null : Number(entry.baseSlice);
    if (baseSlice !== null && (!Number.isInteger(baseSlice) || baseSlice < 1 || baseSlice > proposed.length)) {
      // Named as what it has to be rather than echoed back with a `#` in front.
      // A slug arrived here once and was reported as "#fix-main-event-stream-
      // reconnect, which is not a slice", which reads as a missing slice rather
      // than as the wrong kind of value.
      problems.push({
        check: 'base',
        detail:
          `slice #${index} gives baseSlice ${JSON.stringify(entry.baseSlice)} — it is the index of another slice, ` +
          `1 to ${proposed.length}, or null to branch from the base branch`,
      });
    } else if (baseSlice === index) {
      problems.push({ check: 'base', detail: `slice #${index} is based on itself` });
    } else if (baseSlice !== null && forkIsSeparate(input.config ?? {})) {
      // The stack is legal here and unpublishable later, and the distance
      // between those two facts was a live run's worth of work: verified,
      // preflighted and shown against the predecessor's branch, then opened
      // against `main` carrying the predecessor's diff. Said at the cut, which
      // is the last point where independence is still cheap.
      warnings.push({
        check: 'base',
        detail:
          `slice #${index} stacks on #${baseSlice}, and the branches live in your fork — a pull request opens against ` +
          'a branch of the upstream repository, so it cannot open against another slice. It ships against the base ' +
          `branch, carrying #${baseSlice}'s diff until #${baseSlice} merges`,
      });
    }

    const layers = [...new Set(files.map((file) => layerOf.get(file) ?? 'other'))].sort();
    if (layers.length > 1) {
      warnings.push({
        check: 'layers',
        detail: `slice #${index} spans ${layers.join(', ')} — layer decides the reviewer, and a PR spanning two waits for both`,
      });
    }

    const maxFiles = Number(get(input.config ?? {}, 'slicing.max_files_per_slice') ?? 12);
    if (files.length > maxFiles) {
      warnings.push({ check: 'size', detail: `slice #${index} has ${files.length} files, over the ${maxFiles} in slicing.max_files_per_slice` });
    }

    const carried = input.previous?.slices?.find((slice) => slice.index === index);
    slices.push({
      index,
      slug,
      branch,
      title: String(entry.title ?? '').trim(),
      baseSlice: Number.isInteger(baseSlice) ? baseSlice : null,
      files: files.sort(),
      layers,
      requirements: [...new Set(files.flatMap((file) => requirementsOf.get(file) ?? []))].sort(compareRequirements),
      whySeparate: String(entry.whySeparate ?? '').trim(),
      selfJustifying: String(entry.selfJustifying ?? '').trim(),
      // A verification survives only if it was for this exact set of files;
      // otherwise it describes a slice that no longer exists.
      verification: carried && sameFiles(carried.files, files) ? carried.verification : null,
      // The pull request opened from this slice, once there is one. Carried
      // across a re-set even when the files changed: the PR exists on GitHub
      // whatever the graph now says, and forgetting its number here is how the
      // plugin would open a second one for the same work.
      pr: carried?.pr ?? null,
    });
  }

  // Every file in the diff belongs to exactly one slice. The other direction of
  // the same rule that lib/audit.js applies to Owns: a file in no slice is a
  // change that would never reach a pull request, and nothing else would say so.
  const orphans = [...changed].filter((file) => !seenFiles.has(file)).sort();
  if (orphans.length > 0) {
    problems.push({
      check: 'coverage',
      detail: `${orphans.length} changed file(s) are in no slice: ${orphans.join(', ')}`,
    });
  }

  const { cycle } = mergeOrder(slices);
  if (cycle.length > 0) {
    problems.push({ check: 'base', detail: `slices ${cycle.map((index) => `#${index}`).join(', ')} depend on each other in a cycle` });
  }

  // A proposal in which NOTHING is in the diff is a different finding from one
  // where a file or two are, and it has a usual cause: the proposal was drawn
  // from another source. Found by dry-running scenario 13 — `slice suggest
  // --from-pr` substitutes the diff and the proposal it drafts is then checked
  // against `main...HEAD`, so all fourteen files came back "not in the diff",
  // fourteen times, none of them naming the reason.
  const proposedFiles = [...seenFiles.keys()];
  if (proposedFiles.length > 0 && proposedFiles.every((file) => !changed.has(file))) {
    problems.push({
      check: 'source',
      detail:
        `not one of the ${proposedFiles.length} proposed file(s) is in ${input.facts.base}...${input.facts.refName ?? input.facts.ref}, ` +
        'which usually means the proposal was drawn from a different diff — pass the same --from-pr to `slice set` as to `slice suggest`',
    });
  }

  problems.push(...extensionApiProblems(slices, layerOf));
  problems.push(...requirementProblems(slices, input.facts));

  /** @type {Graph} */
  const graph = {
    issue: input.issue,
    strategy: String(input.proposal.strategy ?? get(input.config ?? {}, 'slicing.strategy') ?? 'prefer-independent'),
    updatedAt: new Date().toISOString(),
    source: {
      base: input.facts.base,
      ref: input.facts.ref,
      refName: input.facts.refName ?? input.facts.ref,
      repo: input.proposal.repo ?? null,
    },
    slices,
  };

  return { ok: problems.length === 0, graph: problems.length === 0 ? graph : null, problems, warnings };
}

/**
 * R1, R2, R10 — numeric where the numbers are.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareRequirements(left, right) {
  const number = (id) => Number.parseInt(String(id).replace(/^R/, ''), 10);
  return (number(left) || 0) - (number(right) || 0);
}

/**
 * @param {string[]} left
 * @param {string[]} right
 * @returns {boolean}
 */
function sameFiles(left, right) {
  return left.length === right.length && [...left].sort().join('\n') === [...right].sort().join('\n');
}

/**
 * Section 10, scenario 12: a public API change is always its own first slice.
 *
 * Not a style rule. Reviewers for extension-api are different people, the
 * compatibility questions are different questions, and a public API change
 * buried in a UI PR is how a breaking change gets approved by someone who was
 * looking at something else.
 *
 * @param {Slice[]} slices
 * @param {Map<string, string>} layerOf
 * @returns {Problem[]}
 */
function extensionApiProblems(slices, layerOf) {
  const holders = slices.filter((slice) => slice.files.some((file) => layerOf.get(file) === 'extension-api'));
  if (holders.length === 0) return [];

  /** @type {Problem[]} */
  const problems = [];

  if (holders.length > 1) {
    problems.push({
      check: 'extension-api',
      detail: `the public API change is split across ${holders.map((slice) => `#${slice.index}`).join(', ')}; it belongs in one slice`,
    });
    return problems;
  }

  const holder = holders[0];
  const foreign = holder.files.filter((file) => layerOf.get(file) !== 'extension-api');
  if (foreign.length > 0) {
    problems.push({
      check: 'extension-api',
      detail: `slice #${holder.index} mixes the public API change with ${foreign.join(', ')} — the API change is reviewed by different people and goes alone`,
    });
  }

  const { order } = mergeOrder(slices);
  if (order.length > 0 && order[0] !== holder.index) {
    problems.push({
      check: 'extension-api',
      detail: `slice #${holder.index} carries the public API change but merges after #${order[0]}; everything that uses the new API depends on it landing first`,
    });
  }

  return problems;
}

/**
 * Every frozen requirement reaches a pull request.
 *
 * Skipped on the quickfix route, where tracing goes by issue number and there
 * are no R-IDs to cover (section 4).
 *
 * @param {Slice[]} slices
 * @param {Facts} collected
 * @returns {Problem[]}
 */
function requirementProblems(slices, collected) {
  if (collected.route === 'quickfix' || collected.requirements.length === 0) return [];

  const covered = new Set(slices.flatMap((slice) => slice.requirements));
  const missing = collected.requirements.filter((id) => !covered.has(id));

  if (missing.length === 0) return [];

  return [
    {
      check: 'requirements',
      detail:
        `${missing.join(', ')} reach no slice. Either the files that satisfy them are missing from the diff, ` +
        'or no task claims those files — and an R-ID that reaches no PR is a requirement nobody shipped',
    },
  ];
}

/**
 * Slices that claim to branch from the base branch but failed to build there.
 *
 * Kept out of build(): at the time a graph is proposed nothing has been
 * verified, and the rule is about verification results rather than about shape.
 *
 * @param {Graph} graph
 * @returns {Problem[]}
 */
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
 * What a verification amounts to, in one word.
 *
 * Exported because the word was in five places and disagreed with the sixth.
 * `format`, `renderValues`, `independenceProblems`, the preflight check and the
 * journal all distinguish a slice that broke something from a run that proved
 * nothing — and `pdkit slice verify`, the one a person runs and reads at the
 * moment it happens, printed `RED` for both. Measured on DESKTOP-18832: the
 * verify tree could not build the base at all, the plugin knew it, said `RED`,
 * and a session spent the next half hour rediscovering by hand what was already
 * in `slices.json`.
 *
 * @param {Verification|null|undefined} verification
 * @returns {'green'|'inconclusive'|'red'|'unverified'}
 */
export function verdict(verification) {
  if (!verification) return 'unverified';
  if (verification.ok) return 'green';
  return verification.baselineOk === false ? 'inconclusive' : 'red';
}

/**
 * Why an inconclusive run is inconclusive, and where to look first.
 *
 * The cause is named rather than left to be found because it is nearly always
 * the same one, and it is not guessable from the output: the tree is cleaned to
 * `git` on every run, so anything a command needs but does not itself produce is
 * simply absent, and the failure surfaces as hundreds of errors in files no
 * slice touched. `slicing.verify.prepare` exists for exactly that, and nothing
 * pointed at it.
 *
 * @param {Verification} verification
 * @param {{base: string}} context
 * @returns {string[]} lines
 */
export function explainInconclusive(verification, context) {
  return [
    `the base fails this command too, so nothing has been shown about this slice either way`,
    `  command : ${verification.command}`,
    `  base    : ${context.base}`,
    `  runs    : ${verification.evidence} for the slice, verify/baseline.json for the base`,
    '',
    '  The verify tree is cleaned back to what git holds on every run, so anything the',
    '  command needs and does not build itself is missing there and present in your own',
    '  checkout. That is what `slicing.verify.prepare` is for — a list of build scripts',
    '  run after every clean. If the command passes where you work and fails here, that',
    '  is the difference, and the list is where to fix it.',
  ];
}

export function independenceProblems(graph) {
  return graph.slices
    .filter((slice) => slice.baseSlice === null && slice.verification && !slice.verification.ok && slice.verification.standalone)
    // A slice that failed a command the base fails too has demonstrated
    // nothing about its own independence, and saying otherwise would send
    // somebody re-cutting a graph that was never the problem.
    .filter((slice) => slice.verification.baselineOk !== false)
    .map((slice) => ({
      check: 'standalone',
      detail: `slice #${slice.index} does not build from ${graph.source.base} on its own, so it cannot branch from it — stack it on the slice that introduces what it uses`,
    }));
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
 * The command a verification runs.
 *
 * Typecheck, lint and the scoped tests, chained with `&&` exactly as section 4
 * writes it. One command and therefore one capture: the question is whether the
 * slice stands up, and the first failure answers it. Splitting it into three
 * artefacts would triple the bookkeeping to learn nothing more.
 *
 * Script names are resolved from the repository, never hardcoded — the same
 * rule and the same resolver preflight uses (section 7).
 *
 * @param {{repoRoot: string, files: string[], scripts: Record<string, string>, packageMap: object, config: object}} input
 * @returns {Promise<{command: string|null, scripts: string[], unresolved: string[]}>}
 */
export async function verifyCommand(input) {
  // scopedScripts reads exactly these fields, so a context-shaped object is the
  // whole adapter needed. Reimplementing the package -> script resolution here
  // would be a second answer to a question that already has one.
  const context = {
    changedFiles: input.files,
    packageMap: input.packageMap,
    scripts: input.scripts,
    config: input.config,
    repoRoot: input.repoRoot,
  };

  const typecheck = await scopedScripts(context, { verb: 'typecheck', fallback: ['typecheck'] });
  const tests = await scopedScripts(context, { verb: 'test', fallback: ['test:unit'] });
  const lint = pickScript(input.scripts, ['lint:check', 'lint']);

  const names = [...typecheck.scripts, ...(lint ? [lint] : []), ...tests.scripts];
  if (names.length === 0) return { command: null, scripts: [], unresolved: [...typecheck.unresolved, ...tests.unresolved] };

  return {
    command: names.map((script) => runScript(context, script)).join(' && '),
    scripts: names,
    unresolved: [...new Set([...typecheck.unresolved, ...tests.unresolved])],
  };
}

/**
 * Apply a diff to a working tree.
 *
 * spawn rather than execFile: the patch goes in on stdin, and execFile has no
 * `input` — it accepts the option and ignores it, leaving `git apply -` waiting
 * on a stdin nobody ever writes to. Silent, and indistinguishable from a slow
 * verification until it never finishes.
 *
 * @param {string} diff
 * @param {string} cwd
 * @param {string[]} [extra]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function apply(diff, cwd, extra = []) {
  if (diff === '') return Promise.resolve({ ok: true });

  return new Promise((resolve) => {
    const child = spawn('git', ['apply', '--index', '--binary', ...extra, '-'], { cwd });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // git closes stdin as soon as it refuses the patch; without this the EPIPE
    // arrives as an unhandled error and takes the process with it.
    child.stdin.on('error', () => {});

    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, error: stderr.trim() || `git apply exited ${code}` }));

    child.stdin.end(diff);
  });
}

/**
 * Build one slice and record what happened.
 *
 * The result is produced here, from a run, and there is no parameter through
 * which a caller could supply it — the invariant at the top of this file. What
 * the caller chooses is only *which* build to perform:
 *
 *   standalone   the slice alone on the base branch. The criterion from
 *                section 4: green means it may branch from main, red means it
 *                needs a stack, and red is the evidence FOR the stack rather
 *                than a failure to hide.
 *   stacked      the slice on top of everything it is based on. What the
 *                reviewer of that pull request will actually see.
 *
 * A slice declaring `base: main` is always verified standalone: for it the two
 * are the same build, and letting the flag say otherwise would let a slice
 * claim independence it was never asked to demonstrate.
 *
 * @param {{issue: number, index: number, repoRoot: string, standalone?: boolean, graph?: Graph, home?: string, config?: object, packageMap?: object, worktree?: string}} input
 * @returns {Promise<{ok: boolean, verification?: Verification, error?: string, output?: string, graph?: Graph}>}
 */
export async function verifySlice(input) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? (await load({ repoRoot: input.repoRoot, home }));

  const graph = input.graph ?? (await read(input.issue, { home }));
  if (!graph) return { ok: false, error: `issue ${input.issue} has no slice graph; run pdkit slice set first` };

  const target = graph.slices.find((entry) => entry.index === input.index);
  if (!target) return { ok: false, error: `there is no slice #${input.index}` };

  const baseBranch = graph.source.base;
  const standalone = target.baseSlice === null ? true : input.standalone === true;
  const chain = standalone ? [target] : chainTo(graph, target.index);

  const diffs = [];
  for (const entry of chain) {
    diffs.push(await sliceDiff({ repoRoot: input.repoRoot, base: baseBranch, ref: graph.source.ref, files: entry.files }));
  }
  const own = diffs[diffs.length - 1];
  const diffDigest = digestOf(own);

  const tree = await prepareTree({ ...input, config, home, base: baseBranch });
  if (!tree.ok) return { ok: false, error: tree.error, output: tree.output };

  for (const [position, diff] of diffs.entries()) {
    const applied = await apply(diff, tree.path);
    if (!applied.ok) {
      // Not being able to apply IS the answer for a standalone build: the slice
      // depends on a change that is not in it. Recorded as a failed
      // verification rather than thrown, so the graph carries the finding.
      const verification = await store({
        graph,
        index: target.index,
        home,
        verification: {
          ok: false,
          standalone,
          diffDigest,
          baseSha: tree.baseSha,
          verifiedAt: new Date().toISOString(),
          command: `git apply (slice #${chain[position].index})`,
          exitCode: null,
          evidence: null,
          revertsCleanly: null,
          note: applied.error,
        },
      });
      return { ok: false, error: `slice #${chain[position].index} does not apply to ${baseBranch}: ${applied.error}`, ...verification };
    }
  }

  return finish({
    ...input,
    home,
    config,
    graph,
    target,
    tree,
    standalone,
    diffDigest,
    revertDiff: own,
    files: chain.flatMap((entry) => entry.files),
  });
}

/**
 * Run the verification in a prepared tree and record it.
 *
 * Shared by both entry points because everything from here down is the same
 * question — does this build, and what did it print — and the two ways of
 * getting the content into the tree are the only thing that differs. A second
 * copy of this tail is how one of the two paths would end up writing a
 * verification the other's validator never checks.
 *
 * @param {{issue: number, home: string, config: object, graph: Graph, target: Slice, tree: {path: string, baseSha?: string|null}, standalone: boolean, diffDigest: string, revertDiff: string, files: string[], packageMap?: object}} input
 * @returns {Promise<{ok: boolean, verification?: Verification, error?: string, output?: string, graph?: Graph}>}
 */
async function finish(input) {
  const resolved = await verifyCommand({
    repoRoot: input.tree.path,
    files: input.files,
    scripts: await scripts(input.tree.path),
    packageMap: input.packageMap ?? (await readPackageMap({ home: input.home })),
    config: input.config,
  });

  if (!resolved.command) {
    return {
      ok: false,
      error:
        'no typecheck, lint or test script resolved in this repository, so there is nothing to verify with. ' +
        'A verification that ran nothing must not report green',
    };
  }

  const run = await capture({ command: resolved.command, cwd: input.tree.path, timeoutMs: VERIFY_TIMEOUT_MS });
  const ok = run.exitCode === 0 && run.complete;

  // A red run has two possible causes and they are not the same finding: the
  // slice broke something, or the base does not pass this command either. The
  // second is a false accusation, and it is the exact mirror of a false green —
  // so it is measured rather than assumed. Only when red, and cached per base
  // and command, because measuring it costs a second full run.
  const baselineOk = ok ? null : await baselineFor({ ...input, command: resolved.command });

  // Reverting is checked against the tree as built. Textual only, and the
  // column is named for that — `Patch comes off`, not `Reverts cleanly`.
  //
  // It stays textual, and the reason is not the price. Measured on this
  // repository (issue 17221, warm tree): the verify command is 152s, so the
  // honest form — revert, then run it again — costs +100% per slice, or +26%
  // if narrowed to typecheck. Affordable, and still the wrong purchase: the
  // revert that matters happens weeks after the merge, against a tree that has
  // moved. A build proved green against the tree of the day the slice was cut
  // answers about a tree that will not exist by then. What does not decay is
  // whether the diff is self-contained enough to come off, and that is what
  // this line measures (section 13, item H).
  const reverted = await apply(input.revertDiff, input.tree.path, ['--reverse', '--check']);

  const evidence = await writeReceipt({
    issue: input.issue,
    taskId: `S${input.target.index} ${input.standalone ? 'standalone' : 'stacked'}`,
    path: `verify/S${input.target.index}.md`,
    run,
    home: input.home,
    files: input.files,
    commit: input.tree.baseSha,
  });

  const stored = await store({
    graph: input.graph,
    index: input.target.index,
    home: input.home,
    verification: {
      ok,
      standalone: input.standalone,
      diffDigest: input.diffDigest,
      baseSha: input.tree.baseSha ?? null,
      verifiedAt: run.at,
      command: resolved.command,
      exitCode: run.exitCode,
      evidence: `verify/S${input.target.index}.md`,
      revertsCleanly: reverted.ok,
      baselineOk,
    },
  });

  await appendJournal(
    {
      issue: input.issue,
      slice: input.target.index,
      event: ok ? 'slice-verified' : baselineOk === false ? 'slice-verify-inconclusive' : 'slice-verify-failed',
      detail:
        `${input.standalone ? 'standalone' : 'stacked'}, exit ${run.exitCode ?? 'killed'}` +
        `${baselineOk === false ? ', and the base fails the same command' : ''}, ${evidence.path}`,
    },
    { home: input.home },
  );

  return { ok, output: `${run.stdout}${run.stderr}`, ...stored };
}

/**
 * Whether the base passes the command the slice just failed.
 *
 * Runs in the same tree, reset back to the base and prepared the same way, so
 * the two runs differ in exactly one thing: the slice. Cached per base commit
 * and command — three slices failing the same repo-wide lint should measure the
 * base once, not three times.
 *
 * @param {{issue: number, home: string, config: object, tree: {path: string, baseSha?: string|null}, graph: Graph, command: string, repoRoot?: string, packageMap?: object}} input
 * @returns {Promise<boolean|null>} null when the base could not be measured
 */
async function baselineFor(input) {
  // The preparation is part of the key, and leaving it out made this cache
  // outlive the thing it measured. A base that fails because the tree was never
  // told to build what the command needs is a fact about `slicing.verify.prepare`
  // as much as about the commit — so once that list is corrected, a measurement
  // taken under the old one is not an answer to the new question. Without this,
  // fixing the list left every issue that had already measured a false baseline
  // reporting inconclusive forever, and the cache is the only thing that would
  // have said why.
  // Named for what it holds rather than `prepare`, which is the worktree
  // function this very function calls twenty lines down.
  const prepareScripts = /** @type {string[]} */ (get(input.config, 'slicing.verify.prepare') ?? []);
  const key = `${input.tree.baseSha ?? input.graph.source.base}:${digest(`${input.command}\n${prepareScripts.join(',')}`)}`;
  const file = join(issueDir(input.home, input.issue), 'verify', 'baseline.json');

  /** @type {Record<string, {ok: boolean, at: string, command: string}>} */
  let cache = {};
  try {
    cache = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // No measurements yet.
  }
  if (key in cache) return cache[key].ok;

  // Back to the base in the same tree. Through worktree.prepare when it owns
  // the tree, so the build steps a fresh tree needs run again — the base has to
  // be measured under the conditions the slice was measured under, or the
  // comparison says nothing.
  let path = input.tree.path;
  if (input.repoRoot && !input.worktree) {
    const prepared = await prepare({
      repoRoot: input.repoRoot,
      name: verifyName(input.issue),
      base: input.graph.source.base,
      issue: input.issue,
      config: input.config,
      home: input.home,
    });
    if (!prepared.ok) return null;
    path = prepared.path;
  } else {
    const reset = await gitOk(['reset', '--hard', input.graph.source.base], path);
    const cleaned = await gitOk(['clean', '-fdx', '-e', 'node_modules'], path);
    if (!reset || !cleaned) return null;
  }

  const run = await capture({ command: input.command, cwd: path, timeoutMs: VERIFY_TIMEOUT_MS });
  const ok = run.exitCode === 0 && run.complete;

  cache[key] = { ok, at: run.at, command: input.command };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`);

  return ok;
}

/** A full typecheck, lint and test run on a workspace this size is not quick. */
export const VERIFY_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * The tree a verification builds in.
 *
 * @param {{issue: number, repoRoot: string, base: string, config: object, home: string, worktree?: string}} input
 * @returns {Promise<{ok: boolean, path?: string, baseSha?: string|null, error?: string, output?: string}>}
 */
async function prepareTree(input) {
  if (input.worktree) {
    // An explicit tree is the caller's to keep clean; used by the tests and by
    // anyone debugging a verification by hand.
    return { ok: true, path: input.worktree, baseSha: (await gitText(['rev-parse', input.base], input.worktree)).trim() };
  }

  const prepared = await prepare({
    repoRoot: input.repoRoot,
    name: verifyName(input.issue),
    base: input.base,
    issue: input.issue,
    config: input.config,
    home: input.home,
  });
  if (!prepared.ok) return { ok: false, error: prepared.error, output: prepared.output };

  return { ok: true, path: prepared.path, baseSha: (await gitText(['rev-parse', input.base], prepared.path)).trim() };
}

/**
 * Put a verification into the graph.
 *
 * @param {{graph: Graph, index: number, verification: object, home: string}} input
 * @returns {Promise<{graph: Graph, verification: Verification}>}
 */
async function store(input) {
  const slices = input.graph.slices.map((slice) =>
    slice.index === input.index ? { ...slice, verification: input.verification } : slice,
  );
  const graph = await save({ ...input.graph, slices }, { home: input.home });

  return { graph, verification: /** @type {Verification} */ (input.verification) };
}

/**
 * Verify every slice, in merge order.
 *
 * Merge order rather than index order because a stacked slice is built on top
 * of what it is based on, and reporting #2 before #1 would put the cause after
 * the effect in the output a person reads.
 *
 * @param {{issue: number, repoRoot: string, standalone?: boolean, home?: string, config?: object, packageMap?: object}} input
 * @returns {Promise<{ok: boolean, results: Array<{index: number, ok: boolean, error?: string}>, graph: Graph|null, problems: Problem[]}>}
 */
export async function verifyAll(input) {
  const home = input.home ?? resolveHome();
  let graph = await read(input.issue, { home });
  if (!graph) return { ok: false, results: [], graph: null, problems: [{ check: 'graph', detail: `issue ${input.issue} has no slice graph` }] };

  const { order, cycle } = mergeOrder(graph.slices);
  if (cycle.length > 0) {
    return { ok: false, results: [], graph, problems: [{ check: 'base', detail: `slices ${cycle.join(', ')} form a cycle` }] };
  }

  const results = [];
  for (const index of order) {
    const result = await verifySlice({ ...input, index, graph, home });
    graph = result.graph ?? graph;
    // The verdict travels with the result, not just the boolean. A sweep that
    // reports eight red slices when the tree cannot build the base at all is
    // eight false accusations, and the caller has no way to tell from `ok`.
    results.push({ index, ok: result.ok, error: result.error, verdict: verdict(result.verification), verification: result.verification ?? null });
  }

  return {
    ok: results.every((result) => result.ok),
    results,
    graph,
    problems: independenceProblems(graph),
  };
}

/**
 * Verify a slice from its branch rather than from the change set.
 *
 * After materialization the branch is the slice: a review fix lands there, not
 * in the working branch it was cut from. Verifying from the source afterwards
 * would check content nobody is going to merge.
 *
 * A stacked branch already contains what it is based on, so this is the stacked
 * build by construction — and it is exactly what the reviewer of that pull
 * request sees. Asking whether a stacked slice would stand alone is still a
 * question, and still answered by verifySlice with --standalone.
 *
 * @param {{issue: number, index: number, repoRoot: string, graph?: Graph, home?: string, config?: object, packageMap?: object}} input
 * @returns {Promise<{ok: boolean, verification?: Verification, error?: string, output?: string, graph?: Graph}>}
 */
export async function verifyBranch(input) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? (await load({ repoRoot: input.repoRoot, home }));

  const graph = input.graph ?? (await read(input.issue, { home }));
  if (!graph) return { ok: false, error: `issue ${input.issue} has no slice graph` };

  const target = graph.slices.find((entry) => entry.index === input.index);
  if (!target) return { ok: false, error: `there is no slice #${input.index}` };

  const baseRef = baseRefOf(graph, target, graph.source.base);
  const exists = await gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}`], input.repoRoot);
  if (!exists) return { ok: false, error: `${target.branch} does not exist yet; materialize slice #${target.index} first` };

  const diff = await sliceDiff({ repoRoot: input.repoRoot, base: baseRef, ref: target.branch, files: target.files });

  const tree = await prepareTree({ ...input, config, home, base: target.branch });
  if (!tree.ok) return { ok: false, error: tree.error, output: tree.output };

  return finish({
    ...input,
    home,
    config,
    graph,
    target,
    tree,
    standalone: target.baseSlice === null,
    diffDigest: digestOf(diff),
    revertDiff: diff,
    files: target.files,
  });
}

/**
 * Build a branch for a slice: base, apply, one commit.
 *
 * The working branch is left alone. Materializing is additive — if the graph
 * turns out to be wrong, there is nothing to undo except deleting branches, and
 * the change set it was cut from is still exactly where it was.
 *
 * Refuses before the human has approved the graph, by the same argument that
 * makes gate.open consult the state machine rather than its caller: a rule
 * enforced by whoever remembers to check it is not a rule.
 *
 * @param {{issue: number, index: number, repoRoot: string, subject: string, force?: boolean, graph?: Graph, home?: string, config?: object}} input
 * @returns {Promise<{ok: boolean, branch?: string, base?: string, created?: boolean, adopted?: boolean, error?: string}>}
 */
export async function materialize(input) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? (await load({ repoRoot: input.repoRoot, home }));

  const graph = input.graph ?? (await read(input.issue, { home }));
  if (!graph) return { ok: false, error: `issue ${input.issue} has no slice graph` };

  const target = graph.slices.find((entry) => entry.index === input.index);
  if (!target) return { ok: false, error: `there is no slice #${input.index}` };

  const record = await readState(input.issue, { home });
  if (!MATERIALIZE_ELIGIBLE.includes(record.state)) {
    return {
      ok: false,
      error:
        `issue ${input.issue} is ${record.state}; branches are cut from ${MATERIALIZE_ELIGIBLE.join(', ')}. ` +
        'The graph goes to a human before it goes to branches',
    };
  }

  const validated = validateCommit({ subject: input.subject, trailers: { 'Signed-off-by': ['pending'] } });
  if (validated.problems.length > 0) {
    return { ok: false, error: `commit subject: ${validated.problems.join('; ')}` };
  }

  // Tracked changes only, on the same reasoning as the working-tree preflight
  // check: an untracked scratch file is not going to be committed here — the
  // commit takes the index, and the index is what `git apply` staged — while a
  // modified tracked file could be carried in or make the patch conflict.
  const dirty = (await gitText(['status', '--porcelain'], input.repoRoot))
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('??'));

  if (dirty.length > 0) {
    return {
      ok: false,
      error:
        `the working tree has ${dirty.length} uncommitted change(s); materializing would carry them into the slice branch:\n` +
        dirty.map((line) => `  ${line}`).join('\n'),
    };
  }

  const baseRef = baseRefOf(graph, target, graph.source.base);
  const diff = await sliceDiff({ repoRoot: input.repoRoot, base: graph.source.base, ref: graph.source.ref, files: target.files });

  const already = await gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}`], input.repoRoot);
  if (already && !input.force) {
    const current = await sliceDiff({ repoRoot: input.repoRoot, base: baseRef, ref: target.branch, files: target.files });
    if (digestOf(current) === digestOf(diff)) {
      await gitText(['checkout', target.branch], input.repoRoot);
      return { ok: true, branch: target.branch, base: baseRef, created: false, adopted: true };
    }
    return {
      ok: false,
      error:
        `${target.branch} exists and does not match the slice any more. ` +
        'Re-run with --force to rebuild it from its base, which discards whatever is on it',
    };
  }

  const checkout = await gitOk(['checkout', '-B', target.branch, baseRef], input.repoRoot);
  if (!checkout) return { ok: false, error: `cannot start ${target.branch} from ${baseRef}` };

  const applied = await apply(diff, input.repoRoot);
  if (!applied.ok) {
    return { ok: false, error: `the slice does not apply to ${baseRef}: ${applied.error}` };
  }

  // Always -s, and the reason is a defect this produced twice over.
  //
  // Leaving the sign-off to the husky hook looks equivalent and is not. The hook
  // appends with `echo "$SOB" >>"$1"`, and a message written by `-m <subject>`
  // is a single line with no blank one after it — so the trailer lands in the
  // same paragraph, and git takes the whole paragraph as the subject. The slice
  // branch came out with a 130-character subject ending in
  // `Signed-off-by: …`, which upstream's commitlint rejects on length and the
  // preflight sign-off check rejects outright: a branch this very command had
  // just made could not be pushed.
  //
  // `-s` puts the trailer where trailers go, and the hook's own
  // `grep -qs "^$SOB" || echo …` then finds it and adds nothing. Exactly one
  // sign-off, in the right place, whether or not the hook is installed — which
  // also covers the worktree where `pnpm install` has not run and nothing would
  // have signed at all.
  // Two different failures used to arrive as one sentence. `git commit` returns
  // non-zero when nothing is staged AND when the repository's own pre-commit
  // hook refuses, and reporting both as "nothing to commit" asserts a cause
  // that was never measured — the defect closed in `steps-to-check` (0.11) and
  // in the config arrays message (0.16), here again.
  //
  // Found dry-running scenario 13 on #18434: the patch applied and staged
  // cleanly, and husky's pre-commit ran `pnpm install`, which aborted on a
  // checkout whose lockfile did not match `node_modules`. "Nothing to commit"
  // sent the reader looking at the diff, which was fine.
  // `git diff --cached --quiet` exits zero when there is nothing staged, so a
  // true here is the empty case.
  const nothingStaged = await gitOk(['diff', '--cached', '--quiet'], input.repoRoot);
  const committed = await gitTry(['commit', '-s', '-m', input.subject], input.repoRoot);
  if (!committed.ok) {
    return {
      ok: false,
      error: nothingStaged
        ? `nothing to commit on ${target.branch}: the slice diff applied to nothing`
        : `${target.branch} has the slice staged, and the commit was refused:\n${committed.output.split('\n').map((line) => `  ${line}`).join('\n')}`,
    };
  }

  await appendJournal(
    { issue: input.issue, slice: target.index, event: 'slice-materialized', detail: `${target.branch} from ${baseRef}` },
    { home },
  );

  return { ok: true, branch: target.branch, base: baseRef, created: true, adopted: false };
}

/** States a slice branch may be cut from. */
export const MATERIALIZE_ELIGIBLE = ['slices-approved', 'preflight-green', 'pr-open', 'review-in-progress'];


/**
 * Rebuild everything downstream of a slice that changed, and re-verify it.
 *
 * A fix that lands in a stacked slice moves the ground under the ones on top of
 * it. Rebasing them is mechanical; the part that matters is what happens after,
 * which is that each one is verified again and any that stopped being green is
 * REPORTED rather than quietly rebased into a lie.
 *
 * @param {{issue: number, from: number, repoRoot: string, home?: string, config?: object, packageMap?: object}} input
 * @returns {Promise<{ok: boolean, rebased: number[], regressed: number[], conflicted: number[], results: Array<{index: number, ok: boolean, error?: string}>}>}
 */
export async function cascade(input) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? (await load({ repoRoot: input.repoRoot, home }));

  let graph = await read(input.issue, { home });
  if (!graph) throw new Error(`issue ${input.issue} has no slice graph`);

  const before = new Map(graph.slices.map((slice) => [slice.index, slice.verification?.ok ?? null]));
  const affected = [input.from, ...dependentsOf(graph, input.from)];
  const { order } = mergeOrder(graph.slices);
  const walk = order.filter((index) => affected.includes(index));

  const rebased = [];
  const regressed = [];
  const conflicted = [];
  const results = [];

  for (const index of walk) {
    const slice = graph.slices.find((entry) => entry.index === index);

    if (index !== input.from) {
      const baseRef = baseRefOf(graph, slice, graph.source.base);
      await gitOk(['checkout', slice.branch], input.repoRoot);
      const done = await gitOk(['rebase', baseRef], input.repoRoot);

      if (!done) {
        await gitOk(['rebase', '--abort'], input.repoRoot);
        conflicted.push(index);
        results.push({ index, ok: false, error: `rebasing ${slice.branch} onto ${baseRef} conflicts` });
        // Everything after this one is stacked on a branch that did not move.
        break;
      }
      rebased.push(index);
    }

    const verified = await verifyBranch({ ...input, index, graph, home, config });
    graph = verified.graph ?? graph;
    results.push({ index, ok: verified.ok, error: verified.error });

    if (before.get(index) === true && !verified.ok) regressed.push(index);
  }

  await appendJournal(
    {
      issue: input.issue,
      slice: input.from,
      event: regressed.length > 0 || conflicted.length > 0 ? 'slice-regressed' : 'slice-cascade',
      detail:
        `from #${input.from}: rebased ${rebased.map((index) => `#${index}`).join(', ') || 'none'}` +
        `${regressed.length ? `; no longer green: ${regressed.map((index) => `#${index}`).join(', ')}` : ''}` +
        `${conflicted.length ? `; conflicts on ${conflicted.map((index) => `#${index}`).join(', ')}` : ''}`,
    },
    { home },
  );

  return { ok: regressed.length === 0 && conflicted.length === 0, rebased, regressed, conflicted, results };
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
 * Whether a git command succeeded, when the output is not the point.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
async function gitOk(args, cwd) {
  try {
    await promisify(execFile)('git', args, { cwd, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Same, but keeping what git said when it refused.
 *
 * `gitOk` throws the reason away, which is fine where the caller knows what a
 * failure means and wrong where it does not. Materializing is the second kind:
 * a commit can fail because nothing is staged, or because the repository's own
 * pre-commit hook refused, and those are not the same news.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, output: string}>}
 */
async function gitTry(args, cwd) {
  try {
    const { stdout, stderr } = await promisify(execFile)('git', args, { cwd, encoding: 'utf8' });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || String(error.message ?? error) };
  }
}

/**
 * Whether a stored verification still describes the diff on disk.
 *
 * This is what keeps "verified" from meaning "was verified once". Read by the
 * slice-standalone preflight check, which fails rather than passes on a
 * mismatch: a green tick for yesterday's diff is precisely the kind of evidence
 * lib/evidence.js exists to refuse.
 *
 * @param {{graph: Graph, index: number, repoRoot: string, base?: string, ref?: string}} input
 * @returns {Promise<{fresh: boolean, reason?: string, digest?: string, expected?: string}>}
 */
export async function checkFreshness(input) {
  const target = input.graph.slices.find((entry) => entry.index === input.index);
  if (!target) return { fresh: false, reason: `there is no slice #${input.index}` };
  if (!target.verification) return { fresh: false, reason: `slice #${input.index} has never been verified` };

  const diff = await sliceDiff({
    repoRoot: input.repoRoot,
    base: input.base ?? baseRefOf(input.graph, target, input.graph.source.base),
    ref: input.ref ?? 'HEAD',
    files: target.files,
  });
  const current = digestOf(diff);

  if (current !== target.verification.diffDigest) {
    return {
      fresh: false,
      reason: 'the diff has changed since it was verified',
      digest: current,
      expected: target.verification.diffDigest,
    };
  }

  return { fresh: true, digest: current };
}

/**
 * The values slices.md is rendered from.
 *
 * The verified columns are built here, from the graph, and the caller may only
 * add prose around them: `pdkit slice render` merges the agent's rationale on
 * top of these, and a rationale cannot overwrite a tick it did not earn.
 *
 * @param {Graph} graph
 * @returns {Record<string, string>}
 */
export function renderValues(graph) {
  const mark = (value) => (value === true ? '✅' : value === false ? '❌' : '—');
  const { order } = mergeOrder(graph.slices);

  const rows = graph.slices.map((slice) => {
    const verification = slice.verification;
    const inconclusive = verification?.baselineOk === false;
    const standalone = !verification
      ? '— not verified'
      : inconclusive
        ? '⚠️ inconclusive — the base fails this too'
        : verification.standalone
          ? mark(verification.ok)
          : `${mark(verification.ok)} stacked${slice.baseSlice === null ? '' : ` on #${slice.baseSlice}`}`;

    return [
      '',
      slice.index,
      slice.branch,
      slice.layers.join(', ') || '—',
      slice.baseSlice === null ? graph.source.base : `#${slice.baseSlice}`,
      slice.files.length,
      slice.requirements.join(', ') || '—',
      standalone,
      verification ? mark(verification.revertsCleanly) : '—',
      '',
    ].join(' | ').trim();
  });

  const verifiedAt = graph.slices
    .map((slice) => slice.verification?.verifiedAt)
    .filter(Boolean)
    .sort()
    .pop();

  const rationale = graph.slices.map((slice) =>
    [
      `### #${slice.index} ${slice.title || slice.slug}`,
      `- Why separate: ${slice.whySeparate || '<not stated>'}`,
      `- Self-justifying without the next slice: ${slice.selfJustifying || '<not stated>'}`,
      '- Steps to check: <draft, filled out in /pd:pr>',
      '',
    ].join('\n'),
  );

  return {
    issue: String(graph.issue),
    strategy: graph.strategy,
    source: `${graph.source.base}...${graph.source.refName ?? graph.source.ref}`,
    verifiedAt: verifiedAt ? `${verifiedAt} by \`pdkit slice verify\`` : 'never — no slice has been built yet',
    rows: rows.join('\n'),
    mergeOrder: order.map((index) => `#${index}`).join(' → ') || '—',
    rationale: rationale.join('\n'),
  };
}

/**
 * Render the graph for a terminal.
 *
 * @param {Graph} graph
 * @returns {string}
 */
export function format(graph) {
  const { order, cycle } = mergeOrder(graph.slices);
  const lines = [`slices: issue ${graph.issue} — ${graph.slices.length}, strategy ${graph.strategy}`, ''];

  for (const slice of graph.slices) {
    const verification = slice.verification
      ? `${slice.verification.ok ? '✔' : slice.verification.baselineOk === false ? '⚠' : '✘'} ` +
        `${slice.verification.standalone ? 'standalone' : 'stacked'} ${slice.verification.verifiedAt}` +
        `${slice.verification.baselineOk === false ? ' — the base fails this command too' : ''}`
      : '· not verified';

    lines.push(
      `  #${slice.index} ${slice.branch}`,
      `      base   ${slice.baseSlice === null ? graph.source.base : `#${slice.baseSlice}`}   layers ${slice.layers.join(', ') || '—'}   R ${slice.requirements.join(', ') || '—'}`,
      `      files  ${slice.files.length}`,
      `      verify ${verification}`,
    );
  }

  lines.push('', `  merge order: ${order.map((index) => `#${index}`).join(' → ') || '—'}`);
  if (cycle.length > 0) lines.push(`  CYCLE among ${cycle.map((index) => `#${index}`).join(', ')}`);

  return `${lines.join('\n')}\n`;
}

/**
 * git, for the calls this module makes itself.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function gitText(args, cwd) {
  const { stdout } = await promisify(execFile)('git', args, {
    cwd,
    encoding: 'utf8',
    // A diff is not a status line: the cap has to hold a real change set,
    // binary hunks included.
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}
