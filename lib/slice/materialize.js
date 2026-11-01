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
// part that turns the cut into branches: materializing a slice, rebuilding
// what is stacked on it, and joining slices back together.
//
// A slice is a BASE PLUS A SET OF FILES, not a set of commits. Verification is
// step one of the /pd:pr flow — before branches exist, before the squash — so
// the commits of a slice are not available to apply. The diff restricted to its
// files is, and it is also what materializing the slice applies back, and what
// `--from-pr` will substitute for a published diff.
//
// Reading and writing the graph, and verifyBranch(), which does both, arrive
// as parameters (Graphs below): they live in lib/slice.js, which re-exports
// this file, and importing them back would be a cycle. The graph model comes
// from ./graph.js and build() from ./draft.js, directly.

import { load, resolveHome } from '../config.js';
import * as git from '../git.js';
import { append as appendJournal } from '../journal.js';
import { slugify } from '../ids.js';
import { changedPaths } from '../repo.js';
import { JOIN_ELIGIBLE, MATERIALIZE_ELIGIBLE, read as readState } from '../state.js';
import { validateCommit } from '../upstream.js';
import { build } from './draft.js';
import { dependentsOf, digestOf, mergeOrder, resolvedBaseOf, sliceDiff, sourceBaseOf } from './graph.js';
import { apply } from './verify.js';

/** @typedef {import('../slice.js').Graph} Graph */
/** @typedef {import('../slice.js').Slice} Slice */
/** @typedef {import('../slice.js').Problem} Problem */
/** @typedef {import('../slice.js').Facts} Facts */

/**
 * What materializing and joining need from lib/slice.js, handed over by its
 * facade.
 *
 * `save` is among them on purpose: the graph keeps one writer, and a join
 * stores its result through it rather than through a second one.
 *
 * @typedef {object} Graphs
 * @property {(issue: number, options?: {home?: string}) => Promise<Graph|null>} read
 * @property {(graph: Graph, options: {home?: string}) => Promise<Graph>} save
 * @property {(input: object) => Promise<{ok: boolean, graph?: Graph, error?: string}>} verifyBranch
 */

/**
 * How much a git call here that reads output may print. A diff is not a status
 * line: the cap has to hold a real change set, binary hunks included.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

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
 * @param {Graphs} deps
 * @returns {Promise<{ok: boolean, graph: Graph|null, problems: Problem[], warnings: Problem[]}>}
 */
export async function joinSlices(input, deps) {
  const { read, save } = deps;
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
 * @param {Graphs} deps
 * @returns {Promise<{ok: boolean, branch?: string, base?: string, created?: boolean, adopted?: boolean, commits?: number, error?: string}>}
 */
export async function materialize(input, deps) {
  const { read } = deps;
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
 * @param {Graphs} deps
 * @returns {Promise<{ok: boolean, rebased: number[], regressed: number[], conflicted: number[], results: Array<{index: number, ok: boolean, error?: string}>}>}
 */
export async function cascade(input, deps) {
  const { read, verifyBranch } = deps;
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
