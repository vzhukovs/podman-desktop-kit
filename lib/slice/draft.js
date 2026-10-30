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
// part that proposes the cut: the facts of the change set, a first draft, and
// the rules a proposal has to pass to become a graph.
//
// Two different graphs, and conflating them is the classic mistake:
//
//   file independence     slices do not share files. Checked mechanically.
//   symbol dependence     slice B references a symbol introduced by slice A.
//                         Invisible at the file level.
//
// A slice is a BASE PLUS A SET OF FILES, not a set of commits. Verification is
// step one of the /pd:pr flow — before branches exist, before the squash — so
// the commits of a slice are not available to apply. The diff restricted to its
// files is, and it is also what materializing the slice applies back, and what
// `--from-pr` will substitute for a published diff.
//
// mergeOrder() and chainTo() arrive as parameters: they live in lib/slice.js,
// which re-exports this file, and importing them back would be a cycle.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parsePlan, parseTask } from '../artefacts.js';
import { hasChannels, mayHoldChannels, touchedChannels } from '../contracts.js';
import { get, issueDir, load, resolveHome } from '../config.js';
import * as git from '../git.js';
import { matchesAny } from '../globs.js';
import { branchName, slugify } from '../ids.js';
import { branches, changedPaths, currentBranch, packageFor, resolveBase } from '../repo.js';
import { read as readState } from '../state.js';
import { validateCommit } from '../upstream.js';

/** @typedef {import('../slice.js').Graph} Graph */
/** @typedef {import('../slice.js').Slice} Slice */
/** @typedef {import('../slice.js').Problem} Problem */

/**
 * How much a git call here that reads output may print. A diff is not a status
 * line: the cap has to hold a real change set, binary hunks included.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

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
 * @returns {Promise<Array<import('../artefacts.js').Task>>}
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
 * @param {{mergeOrder: typeof import('../slice.js').mergeOrder, chainTo: typeof import('../slice.js').chainTo}} deps
 * @returns {{ok: boolean, graph: Graph|null, problems: Problem[], warnings: Problem[]}}
 */
export function build(input, { mergeOrder, chainTo }) {
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

  problems.push(...extensionApiProblems(slices, layerOf, { mergeOrder }));
  problems.push(...requirementProblems(slices, input.facts));

  const contracts = contractFindings(slices, input.facts, { chainTo });
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
 * @param {{chainTo: typeof import('../slice.js').chainTo}} deps
 * @returns {{problems: Problem[], warnings: Problem[]}}
 */
function contractFindings(slices, collected, { chainTo }) {
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
    const stacked = indexes.every((index) => indexes.every((other) => other === index || related(graph, index, other, { chainTo })));

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
 * @param {{chainTo: typeof import('../slice.js').chainTo}} deps
 * @returns {boolean}
 */
function related(graph, left, right, { chainTo }) {
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
 * @param {{mergeOrder: typeof import('../slice.js').mergeOrder}} deps
 * @returns {Problem[]}
 */
function extensionApiProblems(slices, layerOf, { mergeOrder }) {
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

