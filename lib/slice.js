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
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parsePlan, parseTask } from './artefacts.js';
import { hasChannels, mayHoldChannels, touchedChannels } from './contracts.js';
import { get, issueDir, load, resolveHome } from './config.js';
import { capture, digest, writeReceipt } from './evidence.js';
import * as git from './git.js';
import { matchesAny } from './globs.js';
import { append as appendJournal } from './journal.js';
import { branchName, slugify } from './ids.js';
import { branches, changedPaths, currentBranch, packageFor, pickScript, readPackageMap, resolveBase, scripts } from './repo.js';
import { runScript, scopedScripts, typecheckScripts } from './scripts.js';
import * as formatting from './slice/format.js';
import { JOIN_ELIGIBLE, MATERIALIZE_ELIGIBLE, read as readState } from './state.js';
import { validateCommit } from './upstream.js';
import { prepare, verifyName } from './worktree.js';

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

/**
 * What a slicer works from: every changed file, mapped to the package, layer,
 * task and requirements that claim it.
 *
 * The mapping is done here rather than left to the reader because it is set
 * arithmetic, and set arithmetic is what a model asked to intersect two lists of
 * paths can get subtly wrong while sounding certain. `ref` is a resolved commit
 * for the reason the graph's is.
 *
 * @typedef {object} Facts
 * @property {Array<{status: string, path: string}>} changed
 * @property {object} packageMap
 * @property {Array<{path: string, package: string|null, layer: string, tasks: string[], requirements: string[], channels?: Array<{channel: string, existed: boolean}>}>} files
 * @property {string[]} requirements  the frozen set
 * @property {string[]} wholeTree     requirements of tasks that own no files: a check over the whole tree
 * @property {string} route
 * @property {string} base
 * @property {string} ref
 * @property {string} [refName]       what the ref was asked for by: `HEAD`, a branch, refs/pull/<k>/head
 * @property {string|null} [branch]   the local branch the diff was read from, null when it was not one
 * @property {string} [tree]          the working tree it was read in
 * @property {number} issue
 * @property {string[]} layerOrder
 * @property {Hypothesis|null} [hypothesis]  what the plan said about cutting, null when there is no plan
 */

/**
 * What the approved plan said about how the work would be cut.
 *
 * `count` is the number from the plan's header, `text` the reasoning under its
 * `## Slice hypothesis` heading. Both are the planner's, written with the
 * whole design in view and checked by the plan critic, which is more than the
 * slicer will ever see from a diff.
 *
 * @typedef {object} Hypothesis
 * @property {number|null} count
 * @property {string} text
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
  const hypothesis = await hypothesisOf(home, input.issue);

  // Resolved to a commit, and this is not tidiness. `HEAD` is whatever is
  // checked out, and materializing checks out a slice branch — so a graph
  // holding the word HEAD starts describing a different change set halfway
  // through the flow it exists to drive. The first stacked slice built from
  // such a graph came out empty, silently, because its diff was taken against
  // a branch that did not contain it.
  const sha = (await git.text(['rev-parse', ref], { cwd: input.repoRoot, maxBuffer: MAX_BUFFER })).trim();

  // The branch the diff was read from, beside the name it was read by. On
  // DESKTOP-18915 refName was "HEAD" and the tree under it was on
  // DESKTOP-18967/…, so the slicer was handed another issue's diff with nothing
  // in front of it that could have looked wrong. A branch name it can compare
  // with the issue number is that something. Null for a sha, a tag, a fetched
  // pull request — anything that is not a local branch.
  const short = ref.replace(/^refs\/heads\//, '');
  const branch =
    ref === 'HEAD'
      ? await currentBranch({ cwd: input.repoRoot })
      : (await branches({ cwd: input.repoRoot })).includes(short)
        ? short
        : null;

  // Rename detection off: see sliceDiff. The file list and the diff have to
  // agree about how many paths a rename is.
  //
  // Against the resolved base, while the graph keeps the name: what the branch
  // added is measured from upstream, and a stale local `main` would hand the
  // slicer every file upstream touched since the last pull.
  const resolvedBase = (await resolveBase({ cwd: input.repoRoot, base, config })).ref;
  const changed = await changedPaths(resolvedBase, ref, { cwd: input.repoRoot, renames: false });

  // The point `base...ref` diffs from, for reading a file as it was before
  // the change. Not the resolved base: upstream may have moved since.
  const forkPoint = (await git.text(['merge-base', resolvedBase, ref], { cwd: input.repoRoot, maxBuffer: MAX_BUFFER }).catch(() => '')).trim();

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
      channels: await channelsOf(entry, { repoRoot: input.repoRoot, forkPoint, ref }),
    });
  }

  // A task that owns no files is a verification — the whole-suite gate, the
  // measurement — and its requirements reach the change set through no file at
  // all. Left out, they reach no slice either, and `slice set` refuses a graph
  // for requirements nobody dropped: R7, R8 and R15 on 18835, where the gate was
  // the only task claiming them. They belong to the whole tree, so build() gives
  // them to every slice rather than guessing which PR carries the proof.
  const wholeTree = [...new Set(tasks.filter((task) => task.owns.length === 0).flatMap((task) => task.satisfies))];

  return {
    issue: input.issue,
    base,
    ref: sha === '' ? ref : sha,
    refName: ref,
    branch,
    tree: input.repoRoot,
    changed,
    packageMap: map,
    files,
    wholeTree,
    requirements: record.requirements.ids,
    route: record.route ?? 'standard',
    layerOrder: /** @type {string[]} */ (get(config, 'slicing.layer_order') ?? []),
    hypothesis,
  };
}

/**
 * The IPC channels a changed file touches (lib/contracts.js says why).
 *
 * The file is read on both sides only when one side names a channel at all,
 * so the cost is two `git show` for most files and a diff for the few that
 * cross the process boundary.
 *
 * @param {{path: string, status: string}} entry
 * @param {{repoRoot: string, forkPoint: string, ref: string}} where
 * @returns {Promise<Array<{channel: string, existed: boolean}>>}
 */
async function channelsOf(entry, where) {
  if (!mayHoldChannels(entry.path) || where.forkPoint === '') return [];

  const show = (rev) => git.text(['show', `${rev}:${entry.path}`], { cwd: where.repoRoot, maxBuffer: MAX_BUFFER }).catch(() => '');
  const before = entry.status.startsWith('A') ? '' : await show(where.forkPoint);
  const after = entry.status.startsWith('D') ? '' : await show(where.ref);
  if (!hasChannels(before) && !hasChannels(after)) return [];

  const diff = await git.text(['diff', '-U0', '--no-renames', where.forkPoint, where.ref, '--', entry.path], { cwd: where.repoRoot, maxBuffer: MAX_BUFFER });
  return touchedChannels({ before, after, diff });
}

/**
 * The plan's slice hypothesis, or null when the issue has no plan.
 *
 * Read here because nothing else carried it to the slicer. On DESKTOP-19818
 * the plan said "One slice, one PR … no proper subset typechecks on its own",
 * the plan critic agreed, and the slicer, which reads the diff and not the
 * plan, cut three pull requests by layer. Upstream rejected them for exactly
 * the reason the plan had given.
 *
 * @param {string} home
 * @param {number} issue
 * @returns {Promise<Hypothesis|null>}
 */
async function hypothesisOf(home, issue) {
  let text;
  try {
    text = await readFile(join(issueDir(home, issue), 'plan.md'), 'utf8');
  } catch {
    return null;
  }

  const plan = parsePlan(text);
  if (plan.sliceCount === null && plan.sliceHypothesis === '') return null;
  return { count: plan.sliceCount, text: plan.sliceHypothesis };
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

  // Carried by every slice, because that is what they are about: a requirement
  // whose only task owns no files is a claim over the whole change — "refactor
  // only", "no unannounced visible change" — and every pull request cut from it
  // is a place that claim has to hold. See facts().
  const wholeTree = input.facts.wholeTree ?? [];

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

    // By slug first, then by index. A join renumbers the slices after the
    // ones it merges, and a slice that moved from #3 to #2 is still the slice
    // whose pull request is open; matching it by index would hand it the
    // number of whatever used to be #2.
    const carriedSupersedes = Array.isArray(entry.supersedes) && entry.supersedes.length > 0;
    const carried = carriedSupersedes
      ? undefined
      : (input.previous?.slices?.find((slice) => slice.slug === slug) ?? input.previous?.slices?.find((slice) => slice.index === index));

    let branch = '';
    try {
      // A published slice keeps its branch: the pull request is open from it,
      // and a new name for the same work would open a second one.
      branch = carried?.pr ? carried.branch : slug === '' ? '' : branchName({ issue: input.issue, index, slug, config: input.config ?? {} });
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
    const commits = commitsOf(entry, files, index, problems);
    // A commit per layer is the answer to this warning, not a case of it: the
    // reviewer of each layer reads one commit (podman-desktop#19831).
    const layeredCommits = commits !== null && commits.every((commit) => new Set(commit.files.map((file) => layerOf.get(file) ?? 'other')).size === 1);
    if (layers.length > 1 && !layeredCommits) {
      warnings.push({
        check: 'layers',
        detail:
          `slice #${index} spans ${layers.join(', ')} — layer decides the reviewer, and a PR spanning two waits for both. ` +
          'If it is one change across layers, give it a commit per layer',
      });
    }

    const maxFiles = Number(get(input.config ?? {}, 'slicing.max_files_per_slice') ?? 12);
    if (files.length > maxFiles) {
      warnings.push({ check: 'size', detail: `slice #${index} has ${files.length} files, over the ${maxFiles} in slicing.max_files_per_slice` });
    }

    const supersedes = carriedSupersedes ? entry.supersedes.map(Number).filter(Number.isInteger) : [];

    slices.push({
      index,
      slug,
      branch,
      title: String(entry.title ?? '').trim(),
      baseSlice: Number.isInteger(baseSlice) ? baseSlice : null,
      files: files.sort(),
      layers,
      requirements: [...new Set([...files.flatMap((file) => requirementsOf.get(file) ?? []), ...wholeTree])].sort(compareRequirements),
      whySeparate: String(entry.whySeparate ?? '').trim(),
      selfJustifying: String(entry.selfJustifying ?? '').trim(),
      // A verification survives only if it was for this exact set of files;
      // otherwise it describes a slice that no longer exists.
      verification: carried && sameFiles(carried.files, files) ? carried.verification : null,
      // The pull request opened from this slice, once there is one. Carried
      // across a re-set even when the files changed: the PR exists on GitHub
      // whatever the graph now says, and forgetting its number here is how the
      // plugin would open a second one for the same work.
      // A slice that replaces pull requests carries nothing (see `carried`):
      // the number at its index is one of the slices it was joined from, and
      // carrying it would publish the joined work as an update to that one.
      pr: carried?.pr ?? null,
      commits,
      ...(supersedes.length > 0 ? { supersedes } : {}),
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

  const contracts = contractFindings(slices, input.facts);
  problems.push(...contracts.problems);
  warnings.push(...contracts.warnings);

  const deviation = String(input.proposal.whyDeviates ?? '').trim();
  const planned = hypothesisFindings(slices.length, input.facts.hypothesis ?? null, deviation);
  problems.push(...planned.problems);
  warnings.push(...planned.warnings);

  /** @type {Graph} */
  const graph = {
    issue: input.issue,
    strategy: String(input.proposal.strategy ?? get(input.config ?? {}, 'slicing.strategy') ?? 'prefer-independent'),
    updatedAt: new Date().toISOString(),
    source: {
      base: input.facts.base,
      ref: input.facts.ref,
      refName: input.facts.refName ?? input.facts.ref,
      branch: input.facts.branch ?? null,
      repo: input.proposal.repo ?? null,
    },
    // What the plan said and, when the cut is not that, why. Kept on the graph
    // so slices.md can put it in front of the person approving the cut: a
    // deviation stated only in the slicer's context is one nobody approves.
    hypothesis: input.facts.hypothesis ? { count: input.facts.hypothesis.count, deviation: deviation || null } : null,
    slices,
  };

  return { ok: problems.length === 0, graph: problems.length === 0 ? graph : null, problems, warnings };
}

/**
 * The commits a slice is published as, when it is more than one.
 *
 * One concern can span layers: an IPC signature changes in main, preload and
 * renderer at once, and none of the three stands alone. Upstream's answer on
 * DESKTOP-19818 was one pull request with a commit per layer, so the reviewer
 * of main still reads main. The commits partition the slice's files, exactly:
 * a commit is the slice's diff restricted to its files, as a slice is the
 * change set's, so a file in two commits is as impossible here as there.
 *
 * @param {object} entry
 * @param {string[]} files  the slice's
 * @param {number} index
 * @param {Problem[]} problems  appended to
 * @returns {Array<{subject: string, files: string[]}>|null}
 */
function commitsOf(entry, files, index, problems) {
  if (entry.commits === undefined || entry.commits === null) return null;
  if (!Array.isArray(entry.commits) || entry.commits.length === 0) {
    problems.push({ check: 'commits', detail: `slice #${index} gives "commits" that is not a non-empty list` });
    return null;
  }

  const inSlice = new Set(files);
  const seen = new Map();
  const commits = [];

  for (const [position, commit] of entry.commits.entries()) {
    const number = position + 1;
    const subject = String(commit?.subject ?? '').trim();
    const own = [...new Set(Array.isArray(commit?.files) ? commit.files.map(String) : [])];

    const checked = validateCommit({ subject, trailers: { 'Signed-off-by': ['pending'] } });
    for (const problem of checked.problems) problems.push({ check: 'commits', detail: `slice #${index}, commit ${number}: ${problem}` });
    if (own.length === 0) problems.push({ check: 'commits', detail: `slice #${index}, commit ${number} has no files` });

    for (const file of own) {
      if (!inSlice.has(file)) {
        problems.push({ check: 'commits', detail: `slice #${index}, commit ${number} claims ${file}, which is not in the slice` });
      } else if (seen.has(file)) {
        problems.push({ check: 'commits', detail: `${file} is in commits ${seen.get(file)} and ${number} of slice #${index} — a commit is the slice restricted to its files` });
      } else {
        seen.set(file, number);
      }
    }

    commits.push({ subject, files: own.sort() });
  }

  const missing = files.filter((file) => !seen.has(file));
  if (missing.length > 0) {
    problems.push({ check: 'commits', detail: `slice #${index} has files in no commit: ${missing.join(', ')}` });
  }

  return commits;
}

/**
 * Both ends of an IPC channel ship in one slice.
 *
 * A channel is a string, so the handler in main and the call in preload are
 * one contract no typecheck can see across (lib/contracts.js). Split between
 * slices, each half compiles, each verifies green, and whichever merges first
 * breaks the other at runtime: DESKTOP-19818, where the image checker stopped
 * working for anyone who merged #19829 without #19830.
 *
 * A channel that existed before is refused outright, since something depends
 * on it today. A new one is refused unless one slice is stacked on the other,
 * and warned about even then, because the half that merges first is either
 * dead code or a call nothing answers.
 *
 * @param {Slice[]} slices
 * @param {Facts} collected
 * @returns {{problems: Problem[], warnings: Problem[]}}
 */
function contractFindings(slices, collected) {
  /** @type {Map<string, {existed: boolean, holders: Map<number, string[]>}>} */
  const byChannel = new Map();
  const sliceOf = new Map(slices.flatMap((slice) => slice.files.map((file) => [file, slice.index])));

  for (const file of collected.files) {
    const index = sliceOf.get(file.path);
    if (index === undefined) continue;

    for (const { channel, existed } of file.channels ?? []) {
      if (!byChannel.has(channel)) byChannel.set(channel, { existed: false, holders: new Map() });
      const entry = byChannel.get(channel);
      entry.existed ||= existed;
      if (!entry.holders.has(index)) entry.holders.set(index, []);
      entry.holders.get(index).push(file.path);
    }
  }

  const graph = { slices };
  const problems = [];
  const warnings = [];

  for (const [channel, { existed, holders }] of byChannel) {
    if (holders.size < 2) continue;

    const where = [...holders].map(([index, files]) => `#${index} (${files.join(', ')})`).join(' and ');
    const indexes = [...holders.keys()];
    const stacked = indexes.every((index) => indexes.every((other) => other === index || related(graph, index, other)));

    if (existed) {
      problems.push({
        check: 'ipc-contract',
        detail:
          `IPC channel "${channel}" changes in ${where}. It exists today, so both ends ship together: merged alone, ` +
          'either half breaks the other at runtime, and no typecheck sees it because the channel is a string',
      });
    } else if (!stacked) {
      problems.push({
        check: 'ipc-contract',
        detail: `new IPC channel "${channel}" is split across ${where}, and neither is stacked on the other — whichever merges first calls nothing or answers nobody`,
      });
    } else {
      warnings.push({
        check: 'ipc-contract',
        detail: `new IPC channel "${channel}" is split across ${where}; the lower slice is dead code until the upper one merges`,
      });
    }
  }

  return { problems, warnings };
}

/**
 * Whether one slice sits on the other, in either direction.
 *
 * @param {{slices: Slice[]}} graph
 * @param {number} left
 * @param {number} right
 * @returns {boolean}
 */
function related(graph, left, right) {
  try {
    const above = (index, other) => chainTo(/** @type {Graph} */ (graph), index).some((slice) => slice.index === other);
    return above(left, right) || above(right, left);
  } catch {
    return false;
  }
}

/**
 * Hold a proposal to the plan's slice hypothesis.
 *
 * More slices than the plan said is refused without a reason, because the
 * plan is where the cut was argued with the whole design in view, and the
 * slicer works from a diff. DESKTOP-19818 is the case: the plan said one
 * slice, because a signature change across main, preload and renderer has no
 * subset that stands alone, and the slicer cut three by layer. A reason makes
 * it a warning rather than a pass, so it reaches the person approving the cut.
 *
 * Fewer slices than planned is only a warning. Keeping together what the plan
 * expected to separate cannot leave main broken, which more slices can.
 *
 * @param {number} count
 * @param {Hypothesis|null} hypothesis
 * @param {string} deviation  the proposal's `whyDeviates`
 * @returns {{problems: Problem[], warnings: Problem[]}}
 */
function hypothesisFindings(count, hypothesis, deviation) {
  if (!hypothesis || hypothesis.count === null || count === hypothesis.count) return { problems: [], warnings: [] };

  const planned = `${hypothesis.count} slice${hypothesis.count === 1 ? '' : 's'}`;
  const said = excerpt(hypothesis.text);

  if (count < hypothesis.count) {
    return {
      problems: [],
      warnings: [{ check: 'hypothesis', detail: `${count} slice(s) where the plan said ${planned} — say in the rationale what turned out to belong together` }],
    };
  }

  if (deviation === '') {
    return {
      problems: [
        {
          check: 'hypothesis',
          detail:
            `the plan's slice hypothesis is ${planned} and this proposal has ${count}${said ? `. The plan says: "${said}"` : ''}. ` +
            'Overruling it takes a reason: give "whyDeviates" in the proposal, naming what the diff shows that the plan could not see',
        },
      ],
      warnings: [],
    };
  }

  return { problems: [], warnings: [{ check: 'hypothesis', detail: `${count} slices where the plan said ${planned}: ${deviation}` }] };
}

/**
 * The start of a passage, short enough to quote in a refusal.
 *
 * @param {string} text
 * @returns {string}
 */
function excerpt(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
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
 * Whether two file lists hold the same paths, in any order.
 *
 * Sorted before comparing because the order a slice lists its files in is not
 * part of what the slice is — a graph re-rendered with the same files in a
 * different order would otherwise read as a different graph, and invalidate a
 * verification that is still good.
 *
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
 * What to do about a refused proposal, one line per kind of refusal.
 *
 * "nothing was stored" on its own sent DESKTOP-18833 looking for a way round
 * the refusal rather than a way forward. Two of the refusals have a way
 * forward that is not a re-cut. A file in two slices cannot be expressed by
 * this model at all, and the work that needs it belongs to another issue. A
 * requirement no slice carries means the task map is missing a task, which an
 * amendment fixes. Neither is fixed by editing the proposal until it passes.
 *
 * @param {Problem[]} problems
 * @returns {string[]}
 */
export function refusalAdvice(problems) {
  const kinds = new Set(problems.map((problem) => problem.check));
  const lines = ['nothing was stored: a graph is stored whole or not at all.'];

  if (kinds.has('exclusive-files')) {
    lines.push(
      'exclusive-files: a slice is the diff restricted to its files, so one file has one slice. Re-cut so the file',
      '  belongs to one of them. If the work needs the file changed in two pull requests, one after the other, this',
      '  issue cannot hold both: the earlier change goes in an issue of its own, and this one waits for it',
      '  (`pdkit issue block`). Do not drop the file from a slice to get past this.',
    );
  }
  if (kinds.has('ipc-contract')) {
    lines.push(
      'ipc-contract: put both ends of the channel in one slice. If the reviewer should still see main, preload and',
      '  renderer apart, give that slice "commits" — one commit per layer, in one pull request.',
    );
  }
  if (kinds.has('hypothesis')) {
    lines.push(
      'hypothesis: start from the cut the plan argued for. Overruling it is allowed, with "whyDeviates" naming',
      '  what the diff shows that the plan could not; that reason goes in front of whoever approves the graph.',
    );
  }
  if (kinds.has('requirements')) {
    lines.push(
      'requirements: a requirement no slice carries has no live task claiming its files. That is an amendment',
      '  (`pdkit amendment new`) adding the task, not a proposal edit.',
    );
  }
  if (lines.length === 1) lines.push('Fix what is marked ✘ above and run slice set again.');

  return lines;
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
 * Merge slices into one, published as one commit per slice it was made from.
 *
 * The way back from a cut that should not have been made, once it is out.
 * DESKTOP-19818 opened three pull requests that only worked together, and the
 * reviewer asked for one pull request with three commits. Re-cutting with
 * `slice set` would lose which pull requests the new one replaces, and the
 * numbers of the slices that move.
 *
 * What it refuses is drift. A slice branch that review has moved away from the
 * change set holds work the graph does not, and joining from the change set
 * would drop it without a word. Each joined slice's files are compared, blob by
 * blob, between its branch and the source, and any difference is named.
 *
 * Every rule `slice set` holds is held here, because the result goes through
 * build(): the joined slice is a proposal like any other.
 *
 * @param {{issue: number, indexes: number[], repoRoot: string, facts: Facts, slug?: string, title?: string, config?: object, home?: string}} input
 * @returns {Promise<{ok: boolean, graph: Graph|null, problems: Problem[], warnings: Problem[]}>}
 */
export async function joinSlices(input) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? (await load({ repoRoot: input.repoRoot, home }));
  const refuse = (detail, check = 'join') => ({ ok: false, graph: null, problems: [{ check, detail }], warnings: [] });

  const graph = await read(input.issue, { home });
  if (!graph) return refuse(`issue ${input.issue} has no slice graph`);

  const record = await readState(input.issue, { home });
  if (!JOIN_ELIGIBLE.includes(record.state)) {
    return refuse(`issue ${input.issue} is ${record.state}; slices are joined from ${JOIN_ELIGIBLE.join(', ')}`);
  }

  const wanted = [...new Set(input.indexes)];
  if (wanted.length < 2) return refuse('joining takes two slices or more');
  const unknown = wanted.filter((index) => !graph.slices.some((slice) => slice.index === index));
  if (unknown.length > 0) return refuse(`there is no slice ${unknown.map((index) => `#${index}`).join(', ')}`);

  const { order } = mergeOrder(graph.slices);
  const joined = order.filter((index) => wanted.includes(index)).map((index) => graph.slices.find((slice) => slice.index === index));

  // Where the joined slice stands: on whatever the first of them stood on,
  // and nothing else outside the set.
  const outside = [...new Set(joined.map((slice) => slice.baseSlice).filter((base) => base !== null && !wanted.includes(base)))];
  if (outside.length > 1) {
    return refuse(`slices ${wanted.map((index) => `#${index}`).join(', ')} stand on different slices (${outside.map((index) => `#${index}`).join(', ')}); join those too, or join fewer`);
  }

  /** @type {Problem[]} */
  const drift = [];
  const commits = [];
  for (const entry of joined) {
    const found = await subjectsOf(graph, entry, { repoRoot: input.repoRoot, config, ref: input.facts.ref });
    drift.push(...found.problems);
    commits.push(...found.commits);
  }
  if (drift.length > 0) return { ok: false, graph: null, problems: drift, warnings: [] };

  const first = Math.min(...wanted);
  const renumber = new Map();
  let next = 1;
  for (const slice of graph.slices) {
    if (wanted.includes(slice.index)) {
      if (slice.index === first) renumber.set(slice.index, next++);
    } else {
      renumber.set(slice.index, next++);
    }
  }
  for (const index of wanted) renumber.set(index, renumber.get(first));

  const workingSlug = String(input.facts.branch ?? '').split('/').pop() ?? '';
  const slug = slugify(input.slug ?? (workingSlug || joined.map((slice) => slice.slug).join('-')));
  const supersedes = joined.map((slice) => slice.pr).filter((number) => Number.isInteger(number));

  const slices = [];
  for (const slice of graph.slices) {
    if (wanted.includes(slice.index) && slice.index !== first) continue;

    if (slice.index === first) {
      slices.push({
        slug,
        title: String(input.title ?? joined.map((entry) => entry.title).filter(Boolean).join('; ')),
        files: joined.flatMap((entry) => entry.files),
        baseSlice: outside.length === 1 ? renumber.get(outside[0]) : null,
        whySeparate: `joined from ${joined.map((entry) => `#${entry.index}`).join(', ')}: one change across layers, which no part of stands alone`,
        selfJustifying: 'yes — every layer of the change, one commit each',
        commits,
        ...(supersedes.length > 0 ? { supersedes } : {}),
      });
      continue;
    }

    slices.push({
      slug: slice.slug,
      title: slice.title,
      files: slice.files,
      baseSlice: slice.baseSlice === null ? null : renumber.get(slice.baseSlice),
      whySeparate: slice.whySeparate,
      selfJustifying: slice.selfJustifying,
      commits: slice.commits ?? null,
    });
  }

  const built = build({
    issue: input.issue,
    facts: input.facts,
    config,
    previous: graph,
    proposal: { strategy: graph.strategy, repo: graph.source.repo, whyDeviates: graph.hypothesis?.deviation ?? undefined, slices },
  });
  if (!built.ok || !built.graph) return built;

  const saved = await save(built.graph, { home });
  await appendJournal(
    {
      issue: input.issue,
      event: 'slices-joined',
      detail:
        `${joined.map((entry) => `#${entry.index}`).join(' + ')} → #${renumber.get(first)} ${saved.slices.find((entry) => entry.index === renumber.get(first))?.branch ?? ''}` +
        `${supersedes.length > 0 ? `, replacing ${supersedes.map((number) => `#${number}`).join(', ')}` : ''}`,
    },
    { home },
  );

  return { ...built, graph: saved };
}

/**
 * The commits one slice brings into a join, and whether its branch drifted.
 *
 * A slice with commits brings them. One without brings a single commit, under
 * the subject its branch was published with — the oldest commit the branch has
 * over its base, since review fixes come after it. A slice that was never
 * materialized has no subject to bring, and says so.
 *
 * @param {Graph} graph
 * @param {Slice} slice
 * @param {{repoRoot: string, config: object, ref: string}} where
 * @returns {Promise<{commits: Array<{subject: string, files: string[]}>, problems: Problem[]}>}
 */
async function subjectsOf(graph, slice, where) {
  const exists = slice.branch && (await git.succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${slice.branch}`], { cwd: where.repoRoot }));

  if (!exists) {
    if (slice.commits?.length) return { commits: slice.commits, problems: [] };
    return {
      commits: [],
      problems: [
        {
          check: 'join',
          detail: `slice #${slice.index} has no branch to take its commit subject from; join it with slice set and a "commits" proposal instead`,
        },
      ],
    };
  }

  /** @type {Problem[]} */
  const problems = [];
  const blob = async (rev, file) => (await git.text(['rev-parse', '--verify', '--quiet', `${rev}:${file}`], { cwd: where.repoRoot, maxBuffer: MAX_BUFFER }).catch(() => '')).trim();

  for (const file of slice.files) {
    if ((await blob(slice.branch, file)) !== (await blob(where.ref, file))) {
      problems.push({
        check: 'drift',
        detail:
          `${file} on ${slice.branch} is not what the change set has. Review moved the branch, and joining from the ` +
          `change set would drop that. Bring it back first: \`git checkout ${slice.branch} -- ${file}\` on the working branch, and commit`,
      });
    }
  }

  const base = await resolvedBaseOf(graph, slice, where);
  const outside = (await changedPaths(base, slice.branch, { cwd: where.repoRoot, renames: false }))
    .map((entry) => entry.path)
    .filter((file) => !slice.files.includes(file));
  if (outside.length > 0) {
    problems.push({ check: 'drift', detail: `${slice.branch} changes ${outside.join(', ')}, which is in no slice; settle that first` });
  }

  if (slice.commits?.length) return { commits: slice.commits, problems };

  const subjects = (await git.text(['log', '--reverse', '--format=%s', `${base}..${slice.branch}`], { cwd: where.repoRoot, maxBuffer: MAX_BUFFER })).split('\n').filter(Boolean);
  if (subjects.length === 0) {
    problems.push({ check: 'join', detail: `${slice.branch} has no commits over ${base}` });
    return { commits: [], problems };
  }

  return { commits: [{ subject: subjects[0], files: slice.files }], problems };
}

/**
 * The command a verification runs.
 *
 * The whole typecheck, lint and the scoped tests, chained with `&&` as section
 * 4 writes it. One command and therefore one capture: the question is whether the
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
  // The resolvers read exactly these fields, so a context-shaped object is the
  // whole adapter needed. Reimplementing the package -> script resolution here
  // would be a second answer to a question that already has one.
  const context = {
    changedFiles: input.files,
    packageMap: input.packageMap,
    scripts: input.scripts,
    config: input.config,
    repoRoot: input.repoRoot,
  };

  // Whole for types, scoped for tests: a slice that changes a signature breaks
  // the package that calls it, not its own (typecheckScripts says where that
  // was learned). Tests stay scoped because a consumer's tests are bound to its
  // types, and the whole typecheck has already said whether those still hold.
  const typecheck = await typecheckScripts(context);
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
 * @param {string} diff
 * @param {string} cwd
 * @param {string[]} [extra]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function apply(diff, cwd, extra = []) {
  if (diff === '') return { ok: true };

  const applied = await git.withStdin(['apply', '--index', '--binary', ...extra, '-'], diff, { cwd });
  return { ok: applied.ok, error: applied.error ?? (applied.stderr.trim() || `git apply exited ${applied.code}`) };
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

  // Once the branch exists, it is the slice — and `verifyBranch` is the function
  // that knows it. Until this call existed it was reachable only from `cascade`,
  // which has never run, so every verification digested `graph.source.ref`
  // instead: a commit frozen when the graph was cut.
  //
  // That is fine right up until the branch moves, which is what review does to
  // it. On 18834 a squash and then a round of review fixes left the recorded
  // digest describing a diff nobody was going to merge, `slice-standalone`
  // called it stale on the very next line, and re-running verify wrote the same
  // stale digest again. Three passes and a wrong diagnosis before the graph was
  // re-cut, which is a workaround for this rather than a fix.
  //
  // `--standalone` on a STACKED slice still comes here: "would this build
  // without the one below it" is a question about the change set, not about a
  // branch that already contains its parent.
  const materialized = await branchOf(graph, input.index, input.repoRoot);
  const stackedStandaloneQuestion = input.standalone === true && materialized?.baseSlice !== null;

  if (materialized && !stackedStandaloneQuestion) {
    return verifyBranch({ ...input, graph, home, config });
  }

  const target = graph.slices.find((entry) => entry.index === input.index);
  if (!target) return { ok: false, error: `there is no slice #${input.index}` };

  const baseBranch = await sourceBaseOf(graph, { repoRoot: input.repoRoot, config });
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
          base: baseBranch,
          baseCommit: tree.baseSha ?? null,
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
    base: baseBranch,
    baseCommit: tree.baseSha ?? null,
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
 * @param {{issue: number, home: string, config: object, graph: Graph, target: Slice, tree: {path: string, baseSha?: string|null}, standalone: boolean, base: string, baseCommit: string|null, diffDigest: string, revertDiff: string, files: string[], packageMap?: object}} input
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
      // What the build actually stood on, named and resolved. `standalone: true`
      // beside a sha somebody can run `git merge-base` against is a claim; on
      // its own it is a word, and on 18835 it was the wrong one for a run nobody
      // could have caught without checking the branch by hand.
      base: input.base ?? null,
      baseCommit: input.baseCommit ?? null,
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
  const base = await sourceBaseOf(input.graph, { repoRoot: input.repoRoot ?? input.tree.path, config: input.config });
  const key = `${input.tree.baseSha ?? base}:${digest(`${input.command}\n${prepareScripts.join(',')}`)}`;
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
      base,
      issue: input.issue,
      config: input.config,
      home: input.home,
    });
    if (!prepared.ok) return null;
    path = prepared.path;
  } else {
    const reset = await git.succeeds(['reset', '--hard', base], { cwd: path });
    const cleaned = await git.succeeds(['clean', '-fdx', '-e', 'node_modules'], { cwd: path });
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
    return { ok: true, path: input.worktree, baseSha: (await git.text(['rev-parse', input.base], { cwd: input.worktree, maxBuffer: MAX_BUFFER })).trim() };
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

  return { ok: true, path: prepared.path, baseSha: (await git.text(['rev-parse', input.base], { cwd: prepared.path, maxBuffer: MAX_BUFFER })).trim() };
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
 * Build each intermediate commit of a multi-commit slice, and record it.
 *
 * Commits 1..k for every k short of the last; the last is the slice, and its
 * verification is the one preflight holds to green. These are recorded beside
 * it as `commitChecks` and gate nothing (CommitCheck says why).
 *
 * From the change set, like an unmaterialized verify, so the answer is about
 * the commits the graph describes rather than about a branch review has moved.
 * A stacked slice is built on what it is based on, as its own verify is.
 *
 * @param {{issue: number, index: number, repoRoot: string, home?: string, config?: object, packageMap?: object, worktree?: string}} input
 * @returns {Promise<{ok: boolean, checks?: CommitCheck[], error?: string, graph?: Graph}>}
 */
export async function verifyCommits(input) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? (await load({ repoRoot: input.repoRoot, home }));

  let graph = await read(input.issue, { home });
  if (!graph) return { ok: false, error: `issue ${input.issue} has no slice graph` };

  const target = graph.slices.find((entry) => entry.index === input.index);
  if (!target) return { ok: false, error: `there is no slice #${input.index}` };
  if (!Array.isArray(target.commits) || target.commits.length < 2) {
    return { ok: false, error: `slice #${input.index} is one commit; its own verification already answers for it` };
  }

  const baseBranch = await sourceBaseOf(graph, { repoRoot: input.repoRoot, config });
  const below = chainTo(graph, target.index).slice(0, -1);
  const diffOf = (files) => sliceDiff({ repoRoot: input.repoRoot, base: baseBranch, ref: graph.source.ref, files });
  const packageMap = input.packageMap ?? (await readPackageMap({ home }));

  /** @type {CommitCheck[]} */
  const checks = [];

  for (let upTo = 1; upTo < target.commits.length; upTo += 1) {
    const files = target.commits.slice(0, upTo).flatMap((commit) => commit.files);
    const own = await diffOf(files);

    const tree = await prepareTree({ ...input, config, home, base: baseBranch });
    if (!tree.ok) return { ok: false, error: tree.error };

    for (const entry of [...below.map((slice) => slice.files), files]) {
      const applied = await apply(await diffOf(entry), tree.path);
      if (!applied.ok) return { ok: false, error: `commits 1..${upTo} of slice #${target.index} do not apply to ${baseBranch}: ${applied.error}` };
    }

    const resolved = await verifyCommand({
      repoRoot: tree.path,
      files: [...below.flatMap((slice) => slice.files), ...files],
      scripts: await scripts(tree.path),
      packageMap,
      config,
    });
    if (!resolved.command) return { ok: false, error: 'no typecheck, lint or test script resolved in this repository' };

    const run = await capture({ command: resolved.command, cwd: tree.path, timeoutMs: VERIFY_TIMEOUT_MS });
    const evidence = `verify/S${target.index}-c${upTo}.md`;
    await writeReceipt({
      issue: input.issue,
      taskId: `S${target.index} commits 1..${upTo}`,
      path: evidence,
      run,
      home,
      files,
      commit: tree.baseSha,
    });

    checks.push({
      commit: upTo,
      subject: target.commits[upTo - 1].subject,
      ok: run.exitCode === 0 && run.complete,
      exitCode: run.exitCode,
      evidence,
      diffDigest: digestOf(own),
      verifiedAt: run.at,
    });
  }

  graph = await save(
    { ...graph, slices: graph.slices.map((slice) => (slice.index === target.index ? { ...slice, commitChecks: checks } : slice)) },
    { home },
  );

  await appendJournal(
    {
      issue: input.issue,
      slice: target.index,
      event: 'slice-commits-verified',
      detail: checks.map((check) => `${check.commit}:${check.ok ? 'green' : 'red'}`).join(' '),
    },
    { home },
  );

  return { ok: true, checks, graph };
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
 * Refuses a branch that is not on the base its slice declares. What that branch
 * builds is a true answer to a question nobody asked, recorded as the answer to
 * the one they did.
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

  const baseRef = await resolvedBaseOf(graph, target, { repoRoot: input.repoRoot, config });
  const exists = await git.succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}`], { cwd: input.repoRoot });
  if (!exists) return { ok: false, error: `${target.branch} does not exist yet; materialize slice #${target.index} first` };

  // The branch has to sit on the base the slice declares, and until this check
  // existed nothing said so. An issue with one slice names its branch exactly
  // what `pdkit worktree create` names the working branch, so on 18835 verify
  // found a branch, took it for the materialized slice, built the working tree
  // on the base it had been cut from ten files ago, and wrote `standalone: true`
  // against `main` — a build on main that never happened. preflight then read
  // that record as proof. A name collision is the normal case for a single-slice
  // issue, not an edge one, which is why this is a refusal rather than a warning.
  const based = await basedOn(input.repoRoot, target.branch, baseRef);
  if (!based.onBase) {
    return {
      ok: false,
      error:
        `${target.branch} forked from ${shortSha(based.forkPoint) ?? 'nothing in common'}, and slice #${target.index} ` +
        `declares ${baseRef}, which is ${shortSha(based.baseCommit) ?? 'unresolvable'}. Building this branch would ` +
        `answer for the base it was cut from rather than for the one the slice claims.\n` +
        `  Rebase it onto ${baseRef} and verify again, or delete it and let verify build the slice from the change set.`,
    };
  }

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
    // Measured rather than inferred. `baseSlice === null` is what the slice
    // intends; what makes the word true is the check above, which is the half
    // that was missing — the structure of a graph cannot say where a branch is.
    standalone: target.baseSlice === null && based.onBase,
    base: baseRef,
    baseCommit: based.baseCommit,
    diffDigest: digestOf(diff),
    revertDiff: diff,
    files: target.files,
  });
}

/**
 * Whether a branch is based on a ref, and on what it is based instead.
 *
 * `merge-base` rather than `--is-ancestor`, because the answer wanted here is
 * not only yes or no: a refusal that names both commits is one somebody can act
 * on without running git themselves, and the whole reason this check exists is
 * that nobody was going to.
 *
 * @param {string} repoRoot
 * @param {string} branch
 * @param {string} baseRef
 * @returns {Promise<{onBase: boolean, baseCommit: string|null, forkPoint: string|null}>}
 */
async function basedOn(repoRoot, branch, baseRef) {
  const commit = async (args) => {
    try {
      const out = (await git.text(args, { cwd: repoRoot, maxBuffer: MAX_BUFFER })).trim();
      return out === '' ? null : out;
    } catch {
      // An unknown ref or two histories with nothing in common. Both are "not
      // on that base", and both are named in the refusal rather than thrown.
      return null;
    }
  };

  const baseCommit = await commit(['rev-parse', baseRef]);
  const forkPoint = await commit(['merge-base', branch, baseRef]);

  return { onBase: baseCommit !== null && baseCommit === forkPoint, baseCommit, forkPoint };
}

/**
 * A commit, short enough to read and long enough to look up.
 *
 * @param {string|null} sha
 * @returns {string|null}
 */
function shortSha(sha) {
  return sha === null || sha === undefined ? null : sha.slice(0, 12);
}

/**
 * Build a branch for a slice: base, apply, one commit — or one per group when
 * the slice has `commits`, in their order, each with its own subject.
 *
 * The working branch is left alone. Materializing is additive — if the graph
 * turns out to be wrong, there is nothing to undo except deleting branches, and
 * the change set it was cut from is still exactly where it was.
 *
 * Refuses before the human has approved the graph, by the same argument that
 * makes gate.open consult the state machine rather than its caller: a rule
 * enforced by whoever remembers to check it is not a rule.
 *
 * @param {{issue: number, index: number, repoRoot: string, subject?: string, force?: boolean, graph?: Graph, home?: string, config?: object}} input
 * @returns {Promise<{ok: boolean, branch?: string, base?: string, created?: boolean, adopted?: boolean, commits?: number, error?: string}>}
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

  // A slice with commits carries its own subjects; one without takes the one
  // it is given. Either way every subject is checked before anything moves.
  const groups =
    Array.isArray(target.commits) && target.commits.length > 0
      ? target.commits
      : [{ subject: String(input.subject ?? ''), files: target.files }];

  for (const group of groups) {
    const validated = validateCommit({ subject: group.subject, trailers: { 'Signed-off-by': ['pending'] } });
    if (validated.problems.length > 0) {
      return { ok: false, error: `commit subject${groups.length > 1 ? ` "${group.subject}"` : ''}: ${validated.problems.join('; ')}` };
    }
  }

  // Tracked changes only, on the same reasoning as the working-tree preflight
  // check: an untracked scratch file is not going to be committed here — the
  // commit takes the index, and the index is what `git apply` staged — while a
  // modified tracked file could be carried in or make the patch conflict.
  const dirty = (await git.text(['status', '--porcelain'], { cwd: input.repoRoot, maxBuffer: MAX_BUFFER }))
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

  const baseRef = await resolvedBaseOf(graph, target, { repoRoot: input.repoRoot, config });
  const sourceBase = await sourceBaseOf(graph, { repoRoot: input.repoRoot, config });
  const diff = await sliceDiff({ repoRoot: input.repoRoot, base: sourceBase, ref: graph.source.ref, files: target.files });

  const already = await git.succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}`], { cwd: input.repoRoot });
  if (already && !input.force) {
    const current = await sliceDiff({ repoRoot: input.repoRoot, base: baseRef, ref: target.branch, files: target.files });
    if (digestOf(current) === digestOf(diff)) {
      await git.text(['checkout', target.branch], { cwd: input.repoRoot, maxBuffer: MAX_BUFFER });
      return { ok: true, branch: target.branch, base: baseRef, created: false, adopted: true };
    }
    return {
      ok: false,
      error:
        `${target.branch} exists and does not match the slice any more. ` +
        'Re-run with --force to rebuild it from its base, which discards whatever is on it',
    };
  }

  // --no-track: started from a remote-tracking ref, git would otherwise make
  // upstream/main the branch's upstream, and a bare `git push` would aim there.
  const checkout = await git.succeeds(['checkout', '--no-track', '-B', target.branch, baseRef], { cwd: input.repoRoot });
  if (!checkout) return { ok: false, error: `cannot start ${target.branch} from ${baseRef}` };

  // One group at a time, each its own diff and its own commit. The groups
  // partition the slice's files, so their diffs add up to the slice's diff
  // exactly, and the adoption check above still compares the whole.
  for (const [position, group] of groups.entries()) {
    const own = groups.length === 1 ? diff : await sliceDiff({ repoRoot: input.repoRoot, base: sourceBase, ref: graph.source.ref, files: group.files });
    const committed = await commitGroup({ diff: own, subject: group.subject, repoRoot: input.repoRoot, branch: target.branch, baseRef });
    if (!committed.ok) {
      return {
        ok: false,
        error: groups.length === 1 ? committed.error : `commit ${position + 1} of ${groups.length} ("${group.subject}"): ${committed.error}`,
      };
    }
  }

  await appendJournal(
    {
      issue: input.issue,
      slice: target.index,
      event: 'slice-materialized',
      detail: `${target.branch} from ${baseRef}${groups.length > 1 ? `, ${groups.length} commits` : ''}`,
    },
    { home },
  );

  return { ok: true, branch: target.branch, base: baseRef, created: true, adopted: false, commits: groups.length };
}

/**
 * Apply one diff to the checked-out branch and commit it.
 *
 * @param {{diff: string, subject: string, repoRoot: string, branch: string, baseRef: string}} input
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function commitGroup(input) {
  const applied = await apply(input.diff, input.repoRoot);
  if (!applied.ok) {
    return { ok: false, error: `the slice does not apply to ${input.baseRef}: ${applied.error}` };
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
  const nothingStaged = await git.succeeds(['diff', '--cached', '--quiet'], { cwd: input.repoRoot });
  const committed = await git.attempt(['commit', '-s', '-m', input.subject], { cwd: input.repoRoot });
  if (!committed.ok) {
    return {
      ok: false,
      error: nothingStaged
        ? `nothing to commit on ${input.branch}: the slice diff applied to nothing`
        : `${input.branch} has the slice staged, and the commit was refused:\n${committed.output.split('\n').map((line) => `  ${line}`).join('\n')}`,
    };
  }

  return { ok: true };
}


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
      const baseRef = await resolvedBaseOf(graph, slice, { repoRoot: input.repoRoot, config });
      await git.succeeds(['checkout', slice.branch], { cwd: input.repoRoot });
      const done = await git.succeeds(['rebase', baseRef], { cwd: input.repoRoot });

      if (!done) {
        await git.succeeds(['rebase', '--abort'], { cwd: input.repoRoot });
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
 * Whether a stored verification still describes the diff on disk.
 *
 * This is what keeps "verified" from meaning "was verified once". Read by the
 * slice-standalone preflight check, which fails rather than passes on a
 * mismatch: a green tick for yesterday's diff is precisely the kind of evidence
 * lib/evidence.js exists to refuse.
 *
 * @param {{graph: Graph, index: number, repoRoot: string, base?: string, ref?: string, config?: object}} input
 * @returns {Promise<{fresh: boolean, reason?: string, digest?: string, expected?: string}>}
 */
/**
 * The slice, if its branch has been cut — the thing that decides whether a
 * verification should read the branch or the change set.
 *
 * @param {Graph} graph
 * @param {number} index
 * @param {string} repoRoot
 * @returns {Promise<Slice|null>} null when the slice has no branch yet
 */
async function branchOf(graph, index, repoRoot) {
  const target = graph.slices.find((entry) => entry.index === index);
  if (!target?.branch) return null;

  const exists = await git.succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}`], { cwd: repoRoot });
  return exists ? target : null;
}

export async function checkFreshness(input) {
  const target = input.graph.slices.find((entry) => entry.index === input.index);
  if (!target) return { fresh: false, reason: `there is no slice #${input.index}` };
  if (!target.verification) return { fresh: false, reason: `slice #${input.index} has never been verified` };

  const diff = await sliceDiff({
    repoRoot: input.repoRoot,
    base: input.base ?? (await resolvedBaseOf(input.graph, target, { repoRoot: input.repoRoot, config: input.config })),
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

// Rendering lives in lib/slice/format.js. It needs mergeOrder() and cannot
// import it from here without a cycle, so the names callers know are kept and
// hand it over.
export const renderValues = (graph, given) => formatting.renderValues(graph, given, { mergeOrder });
export const mergeOrderText = (graph) => formatting.mergeOrderText(graph, { mergeOrder });
export { hypothesisText } from './slice/format.js';
export const format = (graph) => formatting.format(graph, { mergeOrder });
