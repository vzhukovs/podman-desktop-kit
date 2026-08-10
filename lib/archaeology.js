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

// Facts about a previous attempt (spec section 4, the `redo` route; section 10,
// scenario 10).
//
// Same shape as lib/audit.js, lib/review.js and lib/backlog.js: collect()
// gathers, format() prints, nothing here decides. What is mechanical about an
// attempt that was reverted is narrow and expensive to reconstruct by hand —
// which pull request landed it, when, what it touched, who backed it out, what
// the reviewers said at the time, and whether anybody has been in those files
// since. What is not mechanical is the only question that matters: why it was
// reverted, and whether that reason still applies.
//
// This module owns `issues/<n>/archaeology.json`, and that file is the reason
// the ordering in scenario 10 — archaeology BEFORE any implementation — is a
// fact rather than an instruction. lib/state.js refuses to leave `triaged` on
// the redo route until it exists, and it exists only when GitHub has actually
// been asked. A prose summary cannot produce it, for the same reason a
// convincing account of a test run cannot produce a receipt.
//
// The guarantee is deliberately narrow, in the wording of invariant 5: the file
// means the previous attempt was looked up, not that its lesson was learned.
// Code cannot check the second, and a check that reported on what it did not do
// would be worth less than no check at all.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { issueDir, resolveHome } from './config.js';
import * as gh from './gh.js';
import { changedPaths, drift as commitsTouching, fetchPullRequestHead } from './repo.js';
import { isBot, summarise } from './threads.js';

/** One day, in milliseconds. */
const DAY = 86_400_000;

/** Issue references in a pull request body — where a revert says what broke. */
const REFERENCES = /(?:closes|fixes|resolves|reverts|part of|refs?|regression in)\s+#(\d+)/gi;

/** Fields the history questions need; the CI rollup is not among them. */
const HISTORY_FIELDS = [
  'number',
  'title',
  'state',
  'body',
  'url',
  'author',
  'createdAt',
  'mergedAt',
  'closedAt',
  'mergeCommit',
  'changedFiles',
  'additions',
  'deletions',
  'headRefName',
  'baseRefName',
].join(',');

/**
 * @param {string} path
 * @param {number} issue
 * @returns {string}
 */
function recordPath(home, issue) {
  return join(issueDir(home, issue), 'archaeology.json');
}

/**
 * @typedef {object} Report
 * @property {number} issue
 * @property {string|null} at
 * @property {Array<object>} pulls              every pull request referencing the issue
 * @property {object|null} attempt              the merged one that was backed out
 * @property {object|null} revert               the pull request that backed it out
 * @property {Array<object>} rejected           closed without merging: approaches already refused
 * @property {Array<object>} open               anybody working on it right now
 * @property {{changesRequested: Array<object>, threads: Array<object>, comments: Array<object>}} discussion
 * @property {Array<object>} sinceRevert        commits in those files after the revert
 * @property {string[]} gaps                    what could not be established, and why
 */

/**
 * Reconstruct what happened last time.
 *
 * @param {{issue: number, repoRoot?: string|null, config: object, home?: string, exec?: Function, fetch?: boolean}} input
 * @returns {Promise<Report>}
 */
export async function collect(input) {
  const options = { config: input.config, exec: input.exec };
  /** @type {string[]} */
  const gaps = [];

  const referencing = await gh.linkedPullRequests(input.issue, options);

  // A revert references what it reverts, and what it reverts is a pull request
  // rather than the issue. Live on podman-desktop: #17829 ("revert: #16294")
  // appears nowhere in the timeline of issue #12775, which #16294 closed — so
  // asking only the issue reports a merged attempt and no revert, which reads
  // as "this landed and is still there". Every merged pull request is asked
  // about in turn, which is one extra call per merge and answers the question
  // the route is named after.
  const merged = referencing.filter((pull) => pull.mergedAt && !pull.isRevert);

  /** Merged pull request -> every pull request that references it. */
  const crossRefs = new Map(
    await Promise.all(merged.map(async (pull) => [pull.number, await gh.linkedToPullRequest(pull.number, options)])),
  );

  /** @param {number} number */
  // A revert that names a different pull request is not this one's revert, even
  // though it cross-references it — the same reason the pair is established
  // rather than assembled from two "latest" picks. When it names nothing, the
  // cross-reference is all the evidence there is, and it is taken.
  const revertedBy = (number) =>
    (crossRefs.get(number) ?? []).filter((linked) => linked.isRevert && (linked.reverts == null || linked.reverts === number));

  const seen = new Map(referencing.map((pull) => [pull.number, pull]));
  for (const list of crossRefs.values()) for (const pull of list) if (!seen.has(pull.number)) seen.set(pull.number, pull);
  const pulls = [...seen.values()].sort((a, b) => a.number - b.number);

  const reverts = pulls.filter((pull) => pull.isRevert);
  const rejected = pulls.filter((pull) => pull.state === 'CLOSED' && !pull.mergedAt && !pull.isRevert);
  const open = pulls.filter((pull) => pull.state === 'OPEN');

  // The pair has to be established, not assembled from two independent
  // "latest" picks. Live on issue #12775: the newest merge is #17900 and the
  // newest revert is #17829, but #17829 reverts #16294 — pairing them by date
  // produced an attempt that its "revert" predates, a lifetime of zero days,
  // and reviewer comments from the wrong pull request. Every number in that
  // report was real, and the relationship between them was invented.
  const pairs = merged
    .map((pull) => ({ attempt: pull, revert: revertedBy(pull.number).find((r) => r.mergedAt) ?? revertedBy(pull.number)[0] ?? null }))
    .filter((pair) => pair.revert);

  const byMerge = (list, key) => [...list].sort((a, b) => String(a[key]?.mergedAt ?? '').localeCompare(String(b[key]?.mergedAt ?? '')));

  const pair = byMerge(pairs, 'revert').at(-1) ?? null;
  const attemptRef = pair?.attempt ?? [...merged].sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt))).at(-1) ?? null;
  const revertRef = pair?.revert ?? null;

  if (!attemptRef) gaps.push('no merged pull request references this issue: there may be nothing to redo');
  if (attemptRef && !revertRef) {
    gaps.push(`#${attemptRef.number} merged and nothing reverts it — check whether the regression came from elsewhere`);
  }
  if (pairs.length > 1) {
    gaps.push(`${pairs.length} attempts have been reverted here; this report describes the most recent one`);
  }

  // Merges that landed after the revert and reference either the issue or the
  // attempt. Somebody may already have redone part of it — on #12775 that is
  // #17900, which touches the same navigation bar and references the reverted
  // pull request rather than the issue, so looking only at the issue would
  // miss it. Starting without knowing is how the same work gets paid twice.
  const after = revertRef?.mergedAt
    ? pulls.filter(
        (pull) =>
          pull.mergedAt &&
          !pull.isRevert &&
          pull.number !== attemptRef?.number &&
          String(pull.mergedAt) > String(revertRef.mergedAt),
      )
    : [];

  const attempt = attemptRef ? await detail(attemptRef.number, options) : null;
  const revert = revertRef ? await detail(revertRef.number, options) : null;

  if (attempt && revert?.mergedAt && attempt.mergedAt) {
    attempt.livedDays = Math.max(0, Math.round((Date.parse(revert.mergedAt) - Date.parse(attempt.mergedAt)) / DAY));
  }

  // What the reviewers said, at the time, about the change that was backed out.
  // The reason a change is reverted is usually written down in the review it
  // passed — rediscovering it by re-implementing is the costly path.
  const discussion = attempt ? await feedback(attempt.number, input.config, options) : { changesRequested: [], threads: [], comments: [] };

  // Which issues the revert names. A revert body is where the regression is
  // pointed at, and that issue is the requirement the redo has to satisfy as
  // much as the original one.
  if (revert) revert.references = [...new Set([...String(revert.body ?? '').matchAll(REFERENCES)].map((match) => Number(match[1])))].filter((number) => number !== input.issue);

  /** @type {Array<object>} */
  let sinceRevert = [];

  if (attempt && input.repoRoot && input.fetch !== false) {
    try {
      const fetched = await fetchPullRequestHead({ pr: attempt.number, repoRoot: input.repoRoot, config: input.config });
      attempt.files = await changedPaths(fetched.base, fetched.ref, { cwd: input.repoRoot });

      // Has anybody been in those files since it was backed out? A redo that
      // does not know the answer is a redo that may be re-doing work someone
      // already redid, which is the expensive mistake this route exists to
      // avoid making twice.
      if (revert?.mergeCommit) {
        sinceRevert = await commitsTouching({
          from: revert.mergeCommit,
          to: fetched.baseBranch ? `${String(input.config?.repo?.upstream_remote ?? 'upstream')}/${fetched.baseBranch}` : 'FETCH_HEAD',
          files: attempt.files.map((file) => file.path),
          cwd: input.repoRoot,
          limit: 50,
        });
      } else if (revert) {
        gaps.push(`#${revert.number} has no merge commit recorded, so "what happened in those files since" was not measured`);
      }
    } catch (error) {
      gaps.push(`the diff of #${attempt.number} could not be read locally: ${String(error.message ?? error)}`);
    }
  } else if (attempt) {
    gaps.push('no local repository, so the files the attempt touched are unknown');
  }

  return {
    issue: input.issue,
    at: new Date().toISOString(),
    pulls,
    attempt,
    revert,
    rejected,
    open,
    after,
    discussion,
    sinceRevert,
    gaps,
  };
}

/**
 * One pull request, with the fields the history questions need.
 *
 * @param {number} number
 * @param {{config: object, exec?: Function}} options
 * @returns {Promise<object>}
 */
async function detail(number, options) {
  const pull = await gh.pullRequest(number, { ...options, fields: HISTORY_FIELDS });

  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    url: pull.url,
    body: pull.body ?? '',
    author: pull.author,
    createdAt: pull.createdAt,
    mergedAt: pull.mergedAt,
    closedAt: pull.closedAt,
    mergeCommit: pull.mergeCommit?.oid ?? null,
    changedFiles: pull.changedFiles ?? null,
    additions: pull.additions ?? null,
    deletions: pull.deletions ?? null,
    branch: pull.headRefName ?? null,
    livedDays: null,
    files: [],
  };
}

/**
 * What was said on the attempt, with bots folded.
 *
 * Reuses lib/threads.js rather than re-deriving "is this a bot": two answers to
 * that question would eventually disagree, and the one that matters here is the
 * same one /pd:pr-sync uses.
 *
 * @param {number} pr
 * @param {object} config
 * @param {{config: object, exec?: Function}} options
 * @returns {Promise<{changesRequested: Array<object>, threads: Array<object>, comments: Array<object>}>}
 */
async function feedback(pr, config, options) {
  const [discussion, threads] = await Promise.all([gh.discussion(pr, options), gh.reviewThreads(pr, options)]);

  return {
    // A review that asked for changes on a change that later had to be backed
    // out is the highest-value sentence in this whole report.
    changesRequested: discussion.reviews
      .filter((review) => review.state === 'CHANGES_REQUESTED')
      .map((review) => ({ author: review.author, at: review.at, summary: summarise(review.body), url: review.url })),
    threads: threads.map((thread) => ({
      author: thread.author,
      isBot: isBot(thread.author, config),
      path: thread.path,
      line: thread.line,
      resolved: thread.isResolved,
      summary: summarise(thread.body),
      url: thread.url,
    })),
    comments: discussion.comments.map((comment) => ({
      author: comment.author,
      isBot: isBot(comment.author, config),
      at: comment.at,
      summary: summarise(comment.body),
    })),
  };
}

/**
 * Store the facts. Owned here, and written only from a real lookup.
 *
 * @param {Report} report
 * @param {{home?: string}} [options]
 * @returns {Promise<string>} the path written
 */
export async function save(report, options = {}) {
  const file = recordPath(options.home ?? resolveHome(), report.issue);

  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, file);

  return file;
}

/**
 * The stored facts, or null when the lookup has not been done.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<Report|null>}
 */
export async function read(issue, options = {}) {
  try {
    return JSON.parse(await readFile(recordPath(options.home ?? resolveHome(), issue), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {Report} report
 * @returns {string}
 */
export function format(report) {
  const lines = [`archaeology: issue ${report.issue}`, ''];

  if (report.attempt) {
    const attempt = report.attempt;
    lines.push(
      `  attempt   #${attempt.number} ${attempt.title}`,
      `            by ${attempt.author ?? '—'}, merged ${String(attempt.mergedAt ?? '—').slice(0, 10)}` +
        `${attempt.changedFiles ? `, ${attempt.changedFiles} file(s) +${attempt.additions}/-${attempt.deletions}` : ''}`,
    );
    if (attempt.livedDays !== null) lines.push(`            lived ${attempt.livedDays} day(s) in the base branch`);
    for (const file of attempt.files.slice(0, 12)) lines.push(`            ${file.status} ${file.path}`);
    if (attempt.files.length > 12) lines.push(`            … ${attempt.files.length - 12} more`);
  } else {
    lines.push('  attempt   none found');
  }

  if (report.revert) {
    lines.push(
      '',
      `  revert    #${report.revert.number} by ${report.revert.author ?? '—'}, ${String(report.revert.mergedAt ?? report.revert.closedAt ?? '—').slice(0, 10)}`,
    );
    // "names #N", not "names issue(s) #N": the numbers come out of the body,
    // and what a revert body names most reliably is the pull request it undoes.
    if (report.revert.references?.length) lines.push(`            names ${report.revert.references.map((n) => `#${n}`).join(', ')}`);
  }

  if (report.rejected.length > 0) {
    lines.push('', '  closed without merging — approaches already refused once:');
    for (const pull of report.rejected) lines.push(`    #${pull.number} ${pull.title}`);
  }

  if (report.after.length > 0) {
    lines.push('', '  merged after the revert — part of this may already be redone:');
    for (const pull of report.after) lines.push(`    #${pull.number} ${pull.title}`);
  }

  if (report.open.length > 0) {
    lines.push('', '  open right now — somebody may already be redoing this:');
    for (const pull of report.open) lines.push(`    #${pull.number} ${pull.title}`);
  }

  const humanThreads = report.discussion.threads.filter((thread) => !thread.isBot);
  if (report.discussion.changesRequested.length > 0 || humanThreads.length > 0) {
    lines.push('', '  what reviewers said on the attempt:');
    for (const review of report.discussion.changesRequested) {
      lines.push(`    CHANGES_REQUESTED ${review.author}: ${review.summary}`);
    }
    for (const thread of humanThreads.slice(0, 10)) {
      lines.push(`    ${thread.author}${thread.path ? ` on ${thread.path}` : ''}: ${thread.summary}`);
    }
  }

  if (report.sinceRevert.length > 0) {
    lines.push('', `  ${report.sinceRevert.length} commit(s) touched those files after the revert:`);
    for (const commit of report.sinceRevert.slice(0, 10)) {
      lines.push(`    ${commit.sha.slice(0, 9)} ${String(commit.at).slice(0, 10)} ${commit.subject}`);
    }
  }

  if (report.gaps.length > 0) {
    lines.push('', '  not established:');
    for (const gap of report.gaps) lines.push(`    ${gap}`);
  }

  lines.push(
    '',
    '  These are facts. Why it was reverted, and whether that reason still',
    '  applies, are in the sentences above rather than in this table — and',
    '  reading them is the part of a redo that cannot be skipped.',
    '',
  );

  return lines.join('\n');
}
