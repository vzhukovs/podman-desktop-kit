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

// `pdkit slice`: the slice graph: propose it, store it, verify it, turn it into
// branches.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import { resolveHome } from '../config.js';
import * as render from '../render.js';
import { fetchPullRequestHead, readPackageMap } from '../repo.js';
import * as slice from '../slice.js';
import * as worktree from '../worktree.js';
import { EXIT, commandLine, printJson, refusedRef, repoContext, requireIssueTree, shellWord } from './support.js';

export const flags = ['issue', 'slice', 'slices', 'all', 'standalone', 'commits', 'from', 'from-pr', 'ref', 'worktree', 'values', 'subject', 'title', 'force', 'slug'];

const ACTIONS = {
  suggest,
  set,
  join: joinSlices,
  show: withGraph(show),
  verify: withGraph(verify),
  render: withGraph(renderGraph),
  materialize: withGraph(materialize),
  cascade: withGraph(cascade),
};

/**
 * The slice graph: propose it, store it, verify it, turn it into branches.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const action = args[0];
  const issue = Number.parseInt(String(flags.issue ?? args[1]), 10);

  if (!Number.isInteger(issue)) {
    process.stderr.write(`pdkit slice ${action ?? ''}: --issue <n> is required\n`);
    return EXIT.ERROR;
  }

  if (flags.ref !== undefined && typeof flags.ref !== 'string') {
    process.stderr.write(`pdkit slice ${action}: --ref takes a branch, tag or commit\n`);
    return EXIT.ERROR;
  }
  if (typeof flags.ref === 'string' && flags['from-pr'] !== undefined) {
    process.stderr.write(`pdkit slice ${action}: --ref and --from-pr both say where the diff comes from; pass one\n`);
    return EXIT.ERROR;
  }

  // --worktree is --repo by another name, plus the name `worktree list` shows:
  // `--worktree DESKTOP-18915` is what a person reads off that list, and
  // making them assemble the path from `worktrees.root` is a step to get wrong.
  let scope = flags;
  if (flags.worktree !== undefined) {
    if (typeof flags.worktree !== 'string') {
      process.stderr.write(`pdkit slice ${action}: --worktree takes a path, or a name from \`pdkit worktree list\`\n`);
      return EXIT.ERROR;
    }
    let path = resolvePath(flags.worktree);
    if (!(await stat(path).then(() => true, () => false))) {
      const around = await repoContext(flags);
      if (around.root) path = join(await worktree.rootFor({ repoRoot: around.root, config: around.config }), flags.worktree);
    }
    scope = { ...flags, repo: path };
  }

  const repo = await repoContext(scope);
  if (!repo.root) {
    process.stderr.write(`pdkit slice: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: repo.root });
  const shared = { issue, repoRoot: repo.root, home, config: repo.config };

  // Which actions read the tree they are standing in. suggest and set take
  // their diff from HEAD; materialize and cascade check branches out in it.
  // verify does neither — it reads the commit the graph recorded, in its own
  // tree — and show and render read no git at all.
  //
  // `--from-pr` and `--ref` both say where the diff comes from, so the tree is
  // not consulted for suggest and set when either is given; a --ref that names
  // another issue's branch is refused on its own terms.
  const readsTree = ['suggest', 'set', 'join', 'materialize', 'cascade'].includes(action);
  const sourced = flags['from-pr'] !== undefined || typeof flags.ref === 'string';
  if (typeof flags.ref === 'string' && refusedRef(`pdkit slice ${action}`, issue, flags.ref)) return EXIT.ERROR;
  if (readsTree && !(sourced && (action === 'suggest' || action === 'set'))) {
    const held = await requireIssueTree({
      issue,
      repo,
      command: `pdkit slice ${action}`,
      words: ['slice', ...args],
      flags,
      // Reading the diff needs no checkout, so for suggest and set the branch
      // can be named instead of switched to — the one remedy that leaves both
      // trees exactly as they are.
      alternative: (found) =>
        found.branch && (action === 'suggest' || action === 'set' || action === 'join')
          ? `${commandLine(['slice', ...args], flags)} --ref ${shellWord(found.branch)}`
          : null,
    });
    if (!held.ok) return EXIT.ERROR;
  }

  const context = { action, issue, repo, home, shared };
  // An unknown action is told there is no graph before it is told it is
  // unknown: the graph is read first for everything after join.
  const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : withGraph(unknown);
  return handler(context, flags);
}

/**
 * Scenario 13: upstream asks for an already-published pull request to be
 * split. The slicer is unchanged — what changes is where the diff comes from,
 * and `--from-pr` gives it a local ref to read instead of HEAD.
 *
 * Both `suggest` and `set` need it. It used to be resolved inside `suggest`
 * alone, so a proposal drafted from a published pull request was then checked
 * against `main...HEAD` and refused file by file — the whole scenario broken
 * at its second step, found by dry-running it on #18434.
 *
 * @returns {Promise<{source: object, pr: number|null}>}
 */
async function diffSource(repo, flags) {
  // Named rather than checked out: facts() resolves it to a commit and keeps
  // the name as refName, and the branch it is goes beside both.
  if (typeof flags.ref === 'string') return { source: { ref: flags.ref }, pr: null };

  const pr = Number.parseInt(String(flags['from-pr']), 10);
  if (!Number.isInteger(pr)) return { source: {}, pr: null };

  const fetched = await fetchPullRequestHead({ pr, repoRoot: repo.root, config: repo.config });
  process.stderr.write(`  #${pr} fetched: ${fetched.ref.slice(0, 9)} branched from ${fetched.base.slice(0, 9)}\n`);

  return { source: { base: fetched.base, ref: fetched.ref, refName: `refs/pull/${pr}/head` }, pr };
}

async function suggest({ repo, home, shared }, flags) {
  let packageMap;
  try {
    packageMap = await readPackageMap({ home });
  } catch {
    process.stderr.write('pdkit slice suggest: no package map; run pdkit init first\n');
    return EXIT.ERROR;
  }

  const { source, pr: fromPr } = await diffSource(repo, flags);

  const collected = await slice.facts({ ...shared, ...source, packageMap });
  const suggestion = { ...collected, draft: slice.draft(collected), fromPr };

  if (flags.json) printJson(suggestion);
  else {
    process.stdout.write(
      `${collected.files.length} changed file(s) ${collected.base}...${collected.refName ?? collected.ref}` +
        `${collected.branch ? ` on ${collected.branch}` : ''} in ${collected.tree}\n\n`,
    );
    for (const file of collected.files) {
      process.stdout.write(`  ${file.layer.padEnd(14)} ${file.path}  ${file.requirements.join(',') || '—'}\n`);
    }
    // First thing after the files, because it is the first thing the cut is
    // held to: `slice set` refuses more slices than this without a reason.
    if (collected.hypothesis) {
      process.stdout.write(
        `\nThe plan's slice hypothesis: ${collected.hypothesis.count ?? 'no count'} slice(s)\n` +
          `${collected.hypothesis.text ? `  ${collected.hypothesis.text.replace(/\s+/g, ' ').trim()}\n` : ''}`,
      );
    }
    process.stdout.write(
      '\nA draft grouped by layer is in --json. It is a draft: grouping is arithmetic, ' +
        'and whether a slice justifies itself alone is not.\n',
    );
  }
  return EXIT.OK;
}

async function set({ repo, home, shared }, flags) {
  if (typeof flags.from !== 'string') {
    process.stderr.write('pdkit slice set: --from <file.json> is required\n');
    return EXIT.ERROR;
  }

  const proposal = JSON.parse(await readFile(flags.from, 'utf8'));
  const packageMap = await readPackageMap({ home });
  const { source } = await diffSource(repo, flags);
  const collected = await slice.facts({ ...shared, ...source, packageMap });
  const result = await slice.set({ ...shared, proposal, facts: collected });

  if (flags.json) printJson({ ok: result.ok, problems: result.problems, warnings: result.warnings, graph: result.graph });
  else {
    for (const problem of result.problems) process.stderr.write(`  ✘ ${problem.check}: ${problem.detail}\n`);
    for (const warning of result.warnings) process.stderr.write(`  ! ${warning.check}: ${warning.detail}\n`);
    if (result.ok) process.stdout.write(slice.format(result.graph));
    else process.stderr.write(`\n${slice.refusalAdvice(result.problems).join('\n')}\n`);
  }

  return result.ok ? EXIT.OK : EXIT.ERROR;
}

async function joinSlices({ repo, home, shared }, flags) {
  const indexes = String(flags.slices ?? '')
    .split(',')
    .map((word) => Number.parseInt(word.trim(), 10))
    .filter(Number.isInteger);
  if (indexes.length < 2) {
    process.stderr.write('pdkit slice join: --slices <i,j[,k…]> names two slices or more\n');
    return EXIT.ERROR;
  }

  const packageMap = await readPackageMap({ home });
  const { source } = await diffSource(repo, flags);
  const collected = await slice.facts({ ...shared, ...source, packageMap });
  const result = await slice.joinSlices({
    ...shared,
    indexes,
    facts: collected,
    slug: typeof flags.slug === 'string' ? flags.slug : undefined,
    title: typeof flags.title === 'string' ? flags.title : undefined,
  });

  if (flags.json) printJson(result);
  else {
    for (const problem of result.problems) process.stderr.write(`  ✘ ${problem.check}: ${problem.detail}\n`);
    for (const warning of result.warnings) process.stderr.write(`  ! ${warning.check}: ${warning.detail}\n`);
    if (result.ok) {
      process.stdout.write(slice.format(result.graph));
      process.stdout.write(
        '\nStored, and nothing is verified yet. Next: pdkit state <n> --to sliced, pdkit slice verify --all, ' +
          'slice render, and a human approves the new graph before anything is cut from it.\n',
      );
    } else if (result.problems.some((problem) => problem.check !== 'join' && problem.check !== 'drift')) {
      process.stderr.write(`\n${slice.refusalAdvice(result.problems).join('\n')}\n`);
    }
  }
  return result.ok ? EXIT.OK : EXIT.ERROR;
}

/**
 * The actions that read the stored graph: it is read before the action runs,
 * and its absence is the error.
 *
 * @param {(context: object, flags: Record<string, string|boolean>) => Promise<number>} handler
 */
function withGraph(handler) {
  return async (context, flags) => {
    const { action, issue, home } = context;
    const graph = await slice.read(issue, { home });
    if (!graph) {
      process.stderr.write(`pdkit slice ${action}: issue ${issue} has no slice graph yet (pdkit slice set)\n`);
      return EXIT.ERROR;
    }

    return handler({ ...context, graph }, flags);
  };
}

async function show({ graph }, flags) {
  if (flags.json) printJson({ ...graph, problems: slice.independenceProblems(graph) });
  else {
    process.stdout.write(slice.format(graph));
    for (const problem of slice.independenceProblems(graph)) process.stdout.write(`  ✘ ${problem.detail}\n`);
  }
  return EXIT.OK;
}

async function verify({ home, shared, graph }, flags) {
  const packageMap = await readPackageMap({ home });
  const standalone = Boolean(flags.standalone);

  if (flags.commits) {
    const index = Number.parseInt(String(flags.slice), 10);
    if (!Number.isInteger(index)) {
      process.stderr.write('pdkit slice verify --commits: --slice <i> is required\n');
      return EXIT.ERROR;
    }

    const result = await slice.verifyCommits({ ...shared, index, packageMap });
    if (flags.json) printJson(result);
    else if (!result.ok) process.stderr.write(`pdkit slice verify --commits: ${result.error}\n`);
    else {
      for (const check of result.checks) {
        process.stdout.write(`  ${check.ok ? '✔' : '✘'} commits 1..${check.commit}  ${check.subject}  (${check.evidence})\n`);
      }
      process.stdout.write('  information only: the slice as a whole is what preflight holds to green\n');
    }
    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  if (flags.all || flags.slice === undefined) {
    const result = await slice.verifyAll({ ...shared, standalone, packageMap });
    if (flags.json) printJson(result);
    else {
      const MARK = { green: '✔', inconclusive: '⚠', red: '✘', unverified: '·' };
      for (const entry of result.results) {
        process.stdout.write(
          `  ${MARK[entry.verdict] ?? '✘'} slice #${entry.index}` +
            `${entry.verdict === 'inconclusive' ? '  inconclusive — the base fails this command too' : ''}` +
            `${entry.error ? `  ${entry.error}` : ''}\n`,
        );
      }
      for (const problem of result.problems) process.stdout.write(`  ✘ ${problem.detail}\n`);

      // Said once for the sweep rather than per slice: when the base does not
      // build, every slice comes back the same way and the cause is one thing
      // rather than N.
      const stuck = result.results.filter((entry) => entry.verdict === 'inconclusive');
      if (stuck.length > 0) {
        const lines = slice.explainInconclusive(stuck[0].verification, { base: graph.source.base });
        process.stdout.write(`\n  ${stuck.length} of ${result.results.length} proved nothing — ${lines.join('\n  ')}\n`);
      }
    }
    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  const index = Number.parseInt(String(flags.slice), 10);
  const result = await slice.verifySlice({ ...shared, index, standalone, packageMap });

  if (flags.json) printJson(result);
  else {
    // Three words rather than two. `RED` for a run that proved nothing is the
    // plugin accusing a slice of something it did not measure — the exact
    // mirror of a false green, and the failure this command exists to avoid.
    const said = slice.verdict(result.verification);
    process.stdout.write(`slice #${index}: ${said === 'green' ? 'green' : said === 'inconclusive' ? 'INCONCLUSIVE' : 'RED'}\n`);
    if (result.error) process.stdout.write(`  ${result.error}\n`);

    if (said === 'inconclusive') {
      process.stdout.write(`  ${slice.explainInconclusive(result.verification, { base: graph.source.base }).join('\n  ')}\n`);
    } else if (result.verification?.evidence) {
      process.stdout.write(`  the run is in ${result.verification.evidence} under the issue\n`);
    }
  }
  return result.ok ? EXIT.OK : EXIT.ERROR;
}

async function renderGraph({ issue, home, graph }, flags) {
  const values = typeof flags.values === 'string' ? JSON.parse(await readFile(flags.values, 'utf8')) : {};
  const path = await render.write({
    issue,
    template: 'slices',
    path: 'slices.md',
    home,
    // Through renderValues rather than spread over it: the Standalone and
    // Patch-comes-off columns are measured, and a --values file that could
    // replace them would make the one document whose columns cannot be typed
    // in a document whose columns can.
    values: slice.renderValues(graph, values),
  });

  process.stdout.write(`${path}\n`);
  return EXIT.OK;
}

async function materialize({ shared, graph }, flags) {
  const index = Number.parseInt(String(flags.slice), 10);
  if (!Number.isInteger(index)) {
    process.stderr.write('pdkit slice materialize: --slice <i> is required\n');
    return EXIT.ERROR;
  }

  const target = graph.slices.find((entry) => entry.index === index);
  const subject = typeof flags.subject === 'string' ? flags.subject : typeof flags.title === 'string' ? flags.title : null;
  // A slice with commits names its own subjects, one per commit.
  const ownSubjects = Array.isArray(target?.commits) && target.commits.length > 0;
  if (subject && ownSubjects) {
    process.stderr.write(`pdkit slice materialize: slice #${index} has ${target.commits.length} commits with their own subjects; drop --subject\n`);
    return EXIT.ERROR;
  }
  if (!subject && !ownSubjects) {
    process.stderr.write(
      `pdkit slice materialize: --subject "<type>(<scope>): <description>" is required\n` +
        `  slice #${index} is titled: ${target?.title || '(untitled)'}\n`,
    );
    return EXIT.ERROR;
  }

  const result = await slice.materialize({ ...shared, index, subject, force: Boolean(flags.force) });
  if (!result.ok) {
    process.stderr.write(`pdkit slice materialize: ${result.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson(result);
  else {
    process.stdout.write(
      `${result.branch} on ${result.base}${result.adopted ? ' (already matched the slice)' : ''}` +
        `${(result.commits ?? 1) > 1 ? `, ${result.commits} commits` : ''}\n`,
    );
  }
  return EXIT.OK;
}

async function cascade({ home, shared }, flags) {
  const from = Number.parseInt(String(flags.from ?? flags.slice), 10);
  if (!Number.isInteger(from)) {
    process.stderr.write('pdkit slice cascade: --from <i> is required\n');
    return EXIT.ERROR;
  }

  const packageMap = await readPackageMap({ home });
  const result = await slice.cascade({ ...shared, from, packageMap });

  if (flags.json) printJson(result);
  else {
    process.stdout.write(`rebased: ${result.rebased.map((index) => `#${index}`).join(', ') || 'none'}\n`);
    if (result.conflicted.length) process.stdout.write(`conflicts: ${result.conflicted.map((index) => `#${index}`).join(', ')}\n`);
    if (result.regressed.length) {
      process.stdout.write(`NO LONGER GREEN: ${result.regressed.map((index) => `#${index}`).join(', ')}\n`);
    }
  }
  return result.ok ? EXIT.OK : EXIT.ERROR;
}

async function unknown({ action }) {
  process.stderr.write(
    `pdkit slice: unknown action "${action ?? ''}" (${Object.keys(ACTIONS).join(', ')})\n`,
  );
  return EXIT.ERROR;
}
