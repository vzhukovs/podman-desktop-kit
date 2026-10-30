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
// part that verifies the cut: each slice built on its own, in a scratch
// worktree, and the result recorded.
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
// INVARIANT (section 2.2, third one): the verification result is produced here
// from a run rather than accepted from a caller. There is no parameter for
// "standalone: true" — the same argument that made receipts evidence rather
// than claims.
//
// Reading and writing the graph, and the graph model, arrive as parameters
// (Graphs below): they live in lib/slice.js, which re-exports this file, and
// importing them back would be a cycle.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { get, issueDir, load, resolveHome } from '../config.js';
import { capture, digest, writeReceipt } from '../evidence.js';
import * as git from '../git.js';
import { append as appendJournal } from '../journal.js';
import { pickScript, readPackageMap, scripts } from '../repo.js';
import { runScript, scopedScripts, typecheckScripts } from '../scripts.js';
import { prepare, verifyName } from '../worktree.js';

/** @typedef {import('../slice.js').Graph} Graph */
/** @typedef {import('../slice.js').Slice} Slice */
/** @typedef {import('../slice.js').Problem} Problem */
/** @typedef {import('../slice.js').Verification} Verification */
/** @typedef {import('../slice.js').CommitCheck} CommitCheck */

/**
 * What verification needs from lib/slice.js, handed over by its facade.
 *
 * `save` is among them on purpose: the graph keeps one writer, and this file
 * stores a verification through it rather than through a second one.
 *
 * @typedef {object} Graphs
 * @property {(issue: number, options?: {home?: string}) => Promise<Graph|null>} read
 * @property {(graph: Graph, options: {home?: string}) => Promise<Graph>} save
 * @property {(slices: Slice[]) => {order: number[], cycle: number[]}} mergeOrder
 * @property {(graph: Graph, index: number) => Slice[]} chainTo
 * @property {(input: {repoRoot: string, base: string, ref?: string, files: string[]}) => Promise<string>} sliceDiff
 * @property {(diff: string) => string} digestOf
 * @property {(graph: Graph, options: {repoRoot: string, config?: object}) => Promise<string>} sourceBaseOf
 * @property {(graph: Graph, slice: Slice, options: {repoRoot: string, config?: object}) => Promise<string>} resolvedBaseOf
 * @property {(graph: Graph, index: number, repoRoot: string) => Promise<Slice|null>} branchOf
 */

/**
 * How much a git call here that reads output may print. A diff is not a status
 * line: the cap has to hold a real change set, binary hunks included.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

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
 * in the slice graph.
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
export async function apply(diff, cwd, extra = []) {
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
 * @param {Graphs} deps
 * @returns {Promise<{ok: boolean, verification?: Verification, error?: string, output?: string, graph?: Graph}>}
 */
export async function verifySlice(input, deps) {
  const { read, sourceBaseOf, chainTo, sliceDiff, digestOf, branchOf } = deps;
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
    return verifyBranch({ ...input, graph, home, config }, deps);
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
      }, deps);
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
  }, deps);
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
 * @param {Graphs} deps
 * @returns {Promise<{ok: boolean, verification?: Verification, error?: string, output?: string, graph?: Graph}>}
 */
async function finish(input, deps) {
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
  const baselineOk = ok ? null : await baselineFor({ ...input, command: resolved.command }, deps);

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
  }, deps);

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
 * @param {Graphs} deps
 * @returns {Promise<boolean|null>} null when the base could not be measured
 */
async function baselineFor(input, deps) {
  const { sourceBaseOf } = deps;
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
 * @param {Graphs} deps
 * @returns {Promise<{graph: Graph, verification: Verification}>}
 */
async function store(input, deps) {
  const { save } = deps;
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
 * @param {Graphs} deps
 * @returns {Promise<{ok: boolean, results: Array<{index: number, ok: boolean, error?: string}>, graph: Graph|null, problems: Problem[]}>}
 */
export async function verifyAll(input, deps) {
  const { read, mergeOrder } = deps;
  const home = input.home ?? resolveHome();
  let graph = await read(input.issue, { home });
  if (!graph) return { ok: false, results: [], graph: null, problems: [{ check: 'graph', detail: `issue ${input.issue} has no slice graph` }] };

  const { order, cycle } = mergeOrder(graph.slices);
  if (cycle.length > 0) {
    return { ok: false, results: [], graph, problems: [{ check: 'base', detail: `slices ${cycle.join(', ')} form a cycle` }] };
  }

  const results = [];
  for (const index of order) {
    const result = await verifySlice({ ...input, index, graph, home }, deps);
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
 * @param {Graphs} deps
 * @returns {Promise<{ok: boolean, checks?: CommitCheck[], error?: string, graph?: Graph}>}
 */
export async function verifyCommits(input, deps) {
  const { read, save, sourceBaseOf, chainTo, sliceDiff, digestOf } = deps;
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
 * @param {Graphs} deps
 * @returns {Promise<{ok: boolean, verification?: Verification, error?: string, output?: string, graph?: Graph}>}
 */
export async function verifyBranch(input, deps) {
  const { read, resolvedBaseOf, sliceDiff, digestOf } = deps;
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
  }, deps);
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
 * Whether a stored verification still describes the diff on disk.
 *
 * This is what keeps "verified" from meaning "was verified once". Read by the
 * slice-standalone preflight check, which fails rather than passes on a
 * mismatch: a green tick for yesterday's diff is precisely the kind of evidence
 * lib/evidence.js exists to refuse.
 *
 * @param {{graph: Graph, index: number, repoRoot: string, base?: string, ref?: string, config?: object}} input
 * @param {Graphs} deps
 * @returns {Promise<{fresh: boolean, reason?: string, digest?: string, expected?: string}>}
 */
export async function checkFreshness(input, deps) {
  const { sliceDiff, resolvedBaseOf, digestOf } = deps;
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
