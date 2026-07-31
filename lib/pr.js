// SPDX-License-Identifier: Apache-2.0

// Pull requests as entities (spec section 2.2).
//
// INVARIANT: this module is the only writer of $PDKIT_HOME/issues/<n>/prs.json,
// and the CI verdict in prs/<k>.md is rendered from it. There is no parameter
// through which an agent hands over "CI is green" — the same shape that made
// receipts and slice verification mean something.
//
// INVARIANT: merge is a fact about a pull request, not about an issue. Upstream
// merges slices one at a time, and `merged` in the state machine is terminal;
// recording the first merged slice on the issue would lock it before the second
// slice could reach preflight-green. The issue moves only on the rollup, and
// only from /pd:close.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { get, issueDir, load, resolveHome } from './config.js';
import * as gh from './gh.js';
import { append as appendJournal } from './journal.js';
import * as slice from './slice.js';

/**
 * @typedef {object} Job
 * @property {string} name
 * @property {string|null} workflow
 * @property {string} conclusion
 * @property {'pass'|'fail'|'inconclusive'|'flake'|'pending'|'cancelled'} verdict
 * @property {number[]} peers     other open PRs where this job is also red
 * @property {string|null} url
 */

/**
 * @typedef {object} Record_
 * @property {number} number
 * @property {number|null} slice        index in the slice graph, null for a single PR
 * @property {string|null} branch
 * @property {string|null} base
 * @property {string|null} url
 * @property {string} registeredAt
 * @property {'open'|'merged'|'closed'} state
 * @property {string|null} mergedAt
 * @property {string|null} closedAt
 * @property {string|null} refreshedAt
 * @property {{decision: string|null, threadsOpen: number, threadsTotal: number, lastActivityAt: string|null}} review
 * @property {{verdict: string, checkedAt: string|null, jobs: Job[]}} ci
 */

/**
 * @typedef {object} Book
 * @property {number} issue
 * @property {string} updatedAt
 * @property {Record_[]} prs
 */

/**
 * @param {string} home
 * @param {number} issue
 * @returns {string}
 */
function bookPath(home, issue) {
  return join(issueDir(home, issue), 'prs.json');
}

/**
 * Read the pull requests recorded for an issue.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<Book|null>} null when nothing has been registered yet
 */
export async function read(issue, options = {}) {
  const home = options.home ?? resolveHome();

  let raw;
  try {
    raw = await readFile(bookPath(home, issue), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const book = JSON.parse(raw);
    return { issue, updatedAt: book.updatedAt ?? null, prs: book.prs ?? [] };
  } catch (error) {
    throw new Error(`${bookPath(home, issue)}: the pull request record is not readable JSON`, { cause: error });
  }
}

/**
 * Persist. Private, like state.js's: every caller goes through a named
 * operation, so what can happen to the file is the list of exports below.
 *
 * @param {Book} book
 * @param {{home?: string}} options
 * @returns {Promise<Book>}
 */
async function save(book, options) {
  const home = options.home ?? resolveHome();
  const file = bookPath(home, book.issue);

  const next = { ...book, updatedAt: new Date().toISOString() };

  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, file);

  return next;
}

/**
 * The record a pull request has before anything has been read about it.
 *
 * @param {{number: number, slice?: number|null, branch?: string|null, base?: string|null, url?: string|null}} input
 * @returns {Record_}
 */
function blank(input) {
  return {
    number: input.number,
    slice: input.slice ?? null,
    branch: input.branch ?? null,
    base: input.base ?? null,
    url: input.url ?? null,
    registeredAt: new Date().toISOString(),
    state: 'open',
    mergedAt: null,
    closedAt: null,
    refreshedAt: null,
    review: { decision: null, threadsOpen: 0, threadsTotal: 0, lastActivityAt: null },
    ci: { verdict: 'pending', checkedAt: null, jobs: [] },
  };
}

/**
 * Record a pull request against an issue.
 *
 * Idempotent by number: re-registering updates the slice, branch and base
 * rather than adding a second record. Opening a PR is not something to be
 * punished for repeating — but two records for one number would make every
 * rollup below ambiguous.
 *
 * @param {{issue: number, number: number, slice?: number|null, branch?: string|null, base?: string|null, url?: string|null, home?: string}} input
 * @returns {Promise<Record_>}
 */
export async function register(input) {
  const book = (await read(input.issue, input)) ?? { issue: input.issue, updatedAt: null, prs: [] };

  const existing = book.prs.find((record) => record.number === input.number);
  const record = existing
    ? {
        ...existing,
        slice: input.slice ?? existing.slice,
        branch: input.branch ?? existing.branch,
        base: input.base ?? existing.base,
        url: input.url ?? existing.url,
      }
    : blank(input);

  const prs = existing
    ? book.prs.map((entry) => (entry.number === input.number ? record : entry))
    : [...book.prs, record].sort((a, b) => a.number - b.number);

  // The graph learns which pull request its slice became — asked for rather
  // than written directly, because slices.json has one writer and it is not
  // this module. Done before the save so a slice number that is not in the
  // graph fails here rather than leaving two files disagreeing: an issue with
  // three slices and a PR registered against #5 is a mistake worth stopping on.
  //
  // An issue with no graph at all is not a mistake — that is every single-PR
  // issue — so there is nothing to point back at and nothing to complain about.
  if (record.slice !== null && (await slice.read(input.issue, input))) {
    await slice.setPullRequest({ issue: input.issue, index: record.slice, pr: record.number, home: input.home });
  }

  await save({ ...book, issue: input.issue, prs }, input);

  if (!existing) {
    await appendJournal(
      { issue: input.issue, slice: record.slice, event: 'pr-registered', detail: `#${record.number} ${record.branch ?? ''}`.trim() },
      input,
    );
  }

  return record;
}

/**
 * Replace one record.
 *
 * @param {number} issue
 * @param {number} number
 * @param {(record: Record_) => Record_} change
 * @param {{home?: string}} options
 * @returns {Promise<Record_>}
 */
async function amend(issue, number, change, options) {
  const book = await read(issue, options);
  const existing = book?.prs.find((record) => record.number === number);
  if (!existing) throw new Error(`issue ${issue} has no pull request #${number} registered`);

  const record = change(existing);
  await save({ ...book, prs: book.prs.map((entry) => (entry.number === number ? record : entry)) }, options);

  return record;
}

/** Conclusions that mean the job did not come back red and did not fail. */
const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** How many other open PRs must share a red job before it stops being ours. */
const PEERS_FOR_INCONCLUSIVE = 2;

/**
 * The verdict for one job.
 *
 * Three outcomes rather than two, for the same reason `slice verify` grew a
 * third on stage 3: a red job either means the change broke it or means the job
 * is red anyway, and blocking on the second teaches people to route around the
 * gate while passing it is a lie.
 *
 * @param {{name: string, status: string, conclusion: string|null}} check
 * @param {{peers?: Map<string, number[]>, runs?: Array<{name: string, conclusion: string|null}>}} context
 * @returns {{verdict: Job['verdict'], peers: number[]}}
 */
export function judge(check, context = {}) {
  const peers = context.peers?.get(check.name) ?? [];
  const conclusion = String(check.conclusion ?? '');

  if (check.status !== 'COMPLETED' || conclusion === '') return { verdict: 'pending', peers };
  if (conclusion === 'CANCELLED') return { verdict: 'cancelled', peers };
  if (GREEN.has(conclusion)) return { verdict: 'pass', peers };

  // A flake is measurable and does not need an opinion: the same job, on the
  // same commit, answering differently in two runs. `pr view` reports only the
  // latest run, so a re-run that went green is exactly what hides this.
  const runs = (context.runs ?? []).filter((run) => run.name === check.name).map((run) => String(run.conclusion ?? ''));
  if (runs.some((result) => GREEN.has(result)) && runs.some((result) => gh.RED.has(result))) {
    return { verdict: 'flake', peers };
  }

  if (peers.length >= PEERS_FOR_INCONCLUSIVE) return { verdict: 'inconclusive', peers };

  return { verdict: 'fail', peers };
}

/** Worst first: the rollup is the most serious thing any job said. */
const SEVERITY = ['fail', 'pending', 'flake', 'inconclusive', 'cancelled', 'pass'];

/**
 * @param {Job[]} jobs
 * @returns {string}
 */
export function rollupOf(jobs) {
  if (jobs.length === 0) return 'pending';
  return SEVERITY.find((verdict) => jobs.some((job) => job.verdict === verdict)) ?? 'pass';
}

/**
 * Read GitHub and write what it said into prs.json.
 *
 * Every peer read is one call for the whole population, so refreshing a PR
 * costs four requests regardless of how many jobs it has.
 *
 * @param {{issue: number, number: number, config?: object, home?: string, exec?: Function, peers?: boolean}} input
 * @returns {Promise<Record_>}
 */
export async function refresh(input) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? (await load({ home }));
  const options = { config, exec: input.exec };

  const pr = await gh.pullRequest(input.number, options);
  const threads = await gh.reviewThreads(input.number, options);
  const discussion = await gh.discussion(input.number, options);

  const red = pr.checks.some((check) => gh.RED.has(String(check.conclusion)));
  // Peers and per-commit runs answer questions only a red job raises, so a
  // green pull request does not pay for them.
  const peers = red && input.peers !== false ? await gh.peerCheckFailures({ ...options, exclude: input.number }) : { red: new Map() };
  const runs = red ? await gh.checkRunsForCommit(pr.headRefOid, options) : [];

  const jobs = pr.checks.map((check) => {
    const { verdict, peers: shared } = judge(check, { peers: peers.red, runs });
    return { name: check.name, workflow: check.workflow, conclusion: check.conclusion ?? '', verdict, peers: shared, url: check.url };
  });

  const activity = [
    pr.updatedAt,
    ...threads.map((thread) => thread.createdAt),
    ...discussion.reviews.map((review) => review.at),
    ...discussion.comments.map((comment) => comment.at),
  ]
    .filter(Boolean)
    .sort();

  return amend(
    input.issue,
    input.number,
    (record) => ({
      ...record,
      branch: pr.headRefName ?? record.branch,
      base: pr.baseRefName ?? record.base,
      url: pr.url ?? record.url,
      state: pr.mergedAt ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
      mergedAt: pr.mergedAt ?? record.mergedAt,
      closedAt: pr.closedAt ?? record.closedAt,
      refreshedAt: new Date().toISOString(),
      review: {
        decision: pr.reviewDecision ?? null,
        threadsOpen: threads.filter((thread) => !thread.isResolved).length,
        threadsTotal: threads.length,
        lastActivityAt: activity.at(-1) ?? null,
      },
      ci: { verdict: rollupOf(jobs), checkedAt: new Date().toISOString(), jobs },
    }),
    { home },
  );
}

/**
 * Record that a pull request was merged. Deliberately does not touch the issue.
 *
 * @param {{issue: number, number: number, at?: string, home?: string}} input
 * @returns {Promise<Record_>}
 */
export async function markMerged(input) {
  const record = await amend(
    input.issue,
    input.number,
    (existing) => ({ ...existing, state: 'merged', mergedAt: input.at ?? new Date().toISOString() }),
    input,
  );

  await appendJournal({ issue: input.issue, slice: record.slice, event: 'pr-merged', detail: `#${record.number}` }, input);
  return record;
}

/**
 * Record that a pull request was closed without merging — scenario 10, and the
 * entry to the redo route.
 *
 * @param {{issue: number, number: number, reason?: string, home?: string}} input
 * @returns {Promise<Record_>}
 */
export async function markClosed(input) {
  const record = await amend(
    input.issue,
    input.number,
    (existing) => ({ ...existing, state: 'closed', closedAt: new Date().toISOString() }),
    input,
  );

  await appendJournal(
    { issue: input.issue, slice: record.slice, event: 'pr-closed', detail: [`#${record.number}`, input.reason].filter(Boolean).join(' ') },
    input,
  );
  return record;
}

/**
 * Whether every pull request of an issue has landed.
 *
 * This is what /pd:close asks before moving the issue to `merged`, and the
 * reason the state machine was left alone: an issue with three slices has three
 * answers to "is it merged", and only their conjunction is about the issue.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{total: number, merged: number[], open: number[], closed: number[], allMerged: boolean}>}
 */
export async function rollup(issue, options = {}) {
  const book = await read(issue, options);
  const prs = book?.prs ?? [];

  const merged = prs.filter((record) => record.state === 'merged').map((record) => record.number);
  const open = prs.filter((record) => record.state === 'open').map((record) => record.number);
  const closed = prs.filter((record) => record.state === 'closed').map((record) => record.number);

  return {
    total: prs.length,
    merged,
    open,
    closed,
    // No pull requests at all is not "all merged": an issue that never opened
    // one has not finished, it has not started. Neither is a closed one — a PR
    // the maintainer closed is work that did not land (scenario 10, the entry
    // to the redo route), and letting it read as done would close the issue on
    // the strength of a rejection.
    allMerged: prs.length > 0 && open.length === 0 && closed.length === 0 && merged.length > 0,
  };
}

/**
 * Placeholder values for templates/pr-tracking.md.
 *
 * The CI table is built here rather than handed in, for the same reason the
 * Standalone column of slices.md is: a verdict that can be typed is a verdict
 * that will be typed. Everything an agent legitimately writes — the thread
 * triage, what was done about each — arrives through `extras`.
 *
 * @param {Record_} record
 * @param {{issue: number, threads?: string, discussion?: string, resolutions?: string}} extras
 * @returns {Record<string, unknown>}
 */
export function renderValues(record, extras) {
  const jobs = record.ci.jobs.map(
    (job) =>
      `| ${job.name} | ${job.workflow ?? '—'} | ${job.conclusion || '—'} | ${job.verdict} | ` +
      `${job.peers.length ? job.peers.map((number) => `#${number}`).join(', ') : '—'} |`,
  );

  return {
    issue: extras.issue,
    number: record.number,
    branch: record.branch ?? '(unknown)',
    base: record.base ?? '(unknown)',
    slice: record.slice === null ? 'single PR' : `#${record.slice}`,
    state: record.state,
    reviewDecision: record.review.decision ?? 'no decision yet',
    threadsOpen: record.review.threadsOpen,
    threadsTotal: record.review.threadsTotal,
    lastActivity: record.review.lastActivityAt ?? 'never',
    refreshedAt: record.refreshedAt ?? 'never',
    ciVerdict: record.ci.verdict,
    // An empty table would render as a header with nothing under it, which
    // reads as "no CI" rather than "not read yet".
    jobs: jobs.length ? jobs : ['| — | — | — | not read yet | — |'],
    threads: extras.threads ?? '_Not read yet._',
    discussion: extras.discussion ?? '_Not read yet._',
    resolutions: extras.resolutions ?? '_Nothing yet._',
  };
}

/**
 * Days since anything happened on a pull request, and whether that is too long.
 *
 * The threshold is a guess and is labelled as one (spec section 13, item L).
 * What is not a guess is which timestamp to measure from: the last activity of
 * any kind, including someone else's comment, because a PR nobody has touched
 * for a month is stale whoever last spoke.
 *
 * @param {Record_} record
 * @param {{config?: object, now?: Date}} [options]
 * @returns {{days: number|null, stale: boolean, since: string|null}}
 */
export function staleness(record, options = {}) {
  const since = record.review?.lastActivityAt ?? record.registeredAt ?? null;
  if (!since) return { days: null, stale: false, since: null };

  const now = options.now ?? new Date();
  const days = Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000);
  const threshold = Number(get(options.config ?? {}, 'review.stale_after_days') ?? 14);

  return { days, stale: record.state === 'open' && days >= threshold, since };
}
