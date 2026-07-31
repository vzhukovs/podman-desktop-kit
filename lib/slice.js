// SPDX-License-Identifier: Apache-2.0

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

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { parseTask } from './artefacts.js';
import { get, issueDir, load, resolveHome } from './config.js';
import { digest } from './evidence.js';
import { matchesAny } from './globs.js';
import { append as appendJournal } from './journal.js';
import { branchName, slugify } from './ids.js';
import { changedPaths, packageFor } from './repo.js';
import { read as readState } from './state.js';

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
 */

/**
 * @typedef {object} Graph
 * @property {number} issue
 * @property {string} strategy
 * @property {string} updatedAt
 * @property {{base: string, ref: string, repo: string|null}} source
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
    ref,
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
      problems.push({ check: 'base', detail: `slice #${index} is based on #${entry.baseSlice}, which is not a slice` });
    } else if (baseSlice === index) {
      problems.push({ check: 'base', detail: `slice #${index} is based on itself` });
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

  problems.push(...extensionApiProblems(slices, layerOf));
  problems.push(...requirementProblems(slices, input.facts));

  /** @type {Graph} */
  const graph = {
    issue: input.issue,
    strategy: String(input.proposal.strategy ?? get(input.config ?? {}, 'slicing.strategy') ?? 'prefer-independent'),
    updatedAt: new Date().toISOString(),
    source: { base: input.facts.base, ref: input.facts.ref, repo: input.proposal.repo ?? null },
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
export function independenceProblems(graph) {
  return graph.slices
    .filter((slice) => slice.baseSlice === null && slice.verification && !slice.verification.ok && slice.verification.standalone)
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
      ? `${slice.verification.ok ? '✔' : '✘'} ${slice.verification.standalone ? 'standalone' : 'stacked'} ${slice.verification.verifiedAt}`
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
